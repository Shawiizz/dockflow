// Image backends (D12, D13, DV5): design-07 10.4 (U-BE-IMG-01..09) and design-03 22.7 (I1..I11)
// for Kubernetes, through FakeNodeShell + FakeLocalEngine + FakeKubeExecutor, plus the Swarm
// backend over a scripted SSH seam. A small in-memory containerd per node answers N1..N4, so every
// row asserts the exact node commands and what the node holds afterwards.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { PassThrough, Writable } from 'stream';
import { gunzipSync } from 'node:zlib';
import type { ClusterNodeRef, OrchestratorTarget, StackRef } from '../../../services/orchestrator/interfaces';
import { capabilityRefusal } from '../../../services/orchestrator/capabilities';
import {
  alreadyPresentLine,
  canonicalImageRef,
  containerImagesOf,
  humanSize,
  IMAGE_PHRASES,
  importedLine,
  isPresent,
  isRemovableRef,
  KubernetesImageBackend,
  type KubernetesImageBackendOptions,
  nodeImageIndex,
  parseDiskUsage,
  parseRuntimeImages,
  parseStoreImages,
  toImportedRef,
} from '../../../services/orchestrator/kubernetes/backends/images';
import { K8S_REGISTRY_SECRET } from '../../../services/orchestrator/kubernetes/constants';
import type { KubernetesBundleDeps } from '../../../services/orchestrator/kubernetes/deps';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { SwarmImageBackend } from '../../../services/orchestrator/swarm/swarm-images';
import type { SwarmChannel, SwarmExecResult, SwarmSsh } from '../../../services/orchestrator/swarm/swarm-utils';
import { canonicalJson } from '../../../utils/hash';
import {
  DeployError,
  ErrorCode,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
} from '../../../utils/errors';
import * as output from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { FakeClock } from '../fakes/fake-clock';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { FakeKubeExecutor, fakeNode, type KubeStep } from '../fakes/fake-kube-executor';
import { fakeImageId, FakeLocalEngine, fakeSavePayload, refsOfFakePayload } from '../fakes/fake-local-engine';
import { FakeNodeShell, type NodeShellCall, type NodeShellResponse, type NodeShellStep, shellWords } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';
import { expectCliError } from '../support/matchers';

const NS = 'dockflow-shop-production';
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const SERVER_1 = fakeNode('server_1');
const AGENT_1 = fakeNode('agent_1');
const AGENT_2 = fakeNode('agent_2');
const TARGET: OrchestratorTarget = {
  kind: 'k3s',
  project: 'shop',
  env: 'production',
  stackName: 'shop-production',
  controlPlane: SERVER_1,
  managers: [SERVER_1],
  workers: [AGENT_1, AGENT_2],
  probes: [],
};

// the exact node commands of design-03 12.2 (N1..N4) and DESIGN-CORE 8.7
const N1 = 'sudo -n /usr/local/bin/k3s crictl images -o json';
const N2 = 'sudo -n /usr/local/bin/k3s ctr -n k8s.io images ls';
const N3 = 'gzip -dc | sudo -n /usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned=pinned -';
const N4 = 'sudo -n /usr/local/bin/k3s ctr -n k8s.io images rm';
const PRUNE = 'sudo -n /usr/local/bin/k3s crictl rmi --prune';
const DF = 'df -Pk /var/lib/rancher/k3s/agent/containerd';
const IN_USE = 'pods,replicasets.apps,controllerrevisions.apps,deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch';
const RERUN_SETUP = 'Re-run `dockflow setup k3s production`.';

const WEB = 'shop-web:1.4.2';
const WEB_IMPORTED = 'dockflow.invalid/shop-web:1.4.2';
const WEB_ID = fakeImageId('shop-web-1.4.2');
const PASSWORD = 'registry-password-7731';

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await turn();
  if (!predicate()) throw new Error(`never reached: ${what}`);
}

// ---------------------------------------------------------------------------
// In-memory containerd, one image store per node
// ---------------------------------------------------------------------------

interface StoredImage {
  ref: string;
  id: string;
  pinned: boolean;
}

/** the manifest digest containerd reports for an image id (N2) */
function manifestDigest(id: string): string {
  return fakeImageId(`manifest-${id.slice(7, 19)}`);
}

class Containerd {
  private readonly stores = new Map<string, StoredImage[]>();
  /** imports that exit 0 without storing these references (I6) */
  readonly dropOnImport = new Set<string>();
  /** imports that store the image without the pinned label */
  unpinnedImports = false;

  constructor(private readonly engine: FakeLocalEngine) {}

  seed(node: string, ...images: StoredImage[]): this {
    this.stores.set(node, [...this.images(node), ...images]);
    return this;
  }

  images(node: string): StoredImage[] {
    return this.stores.get(node) ?? [];
  }

  refs(node: string): string[] {
    return this.images(node).map((image) => image.ref);
  }

  /** `extra` steps are matched first (fault injection) */
  steps(extra: NodeShellStep[] = []): NodeShellStep[] {
    return [
      ...extra,
      { id: 'N1', script: (s) => s === N1, kind: 'run', times: 'any', optional: true, respond: (call) => ({ exitCode: 0, stdout: this.runtimeJson(call.node) }) },
      { id: 'N2', script: (s) => s === N2, kind: 'run', times: 'any', optional: true, respond: (call) => ({ exitCode: 0, stdout: this.storeTable(call.node) }) },
      { id: 'N3', script: (s) => s === N3, kind: 'channel', times: 'any', optional: true, respond: (call) => this.importCall(call) },
      { id: 'N4', script: (s) => s.startsWith(`${N4} `), kind: 'run', times: 'any', optional: true, respond: (call) => this.remove(call) },
      { id: 'df', script: (s) => s === DF, kind: 'run', times: 'any', optional: true, respond: { exitCode: 0, stdout: DF_OUTPUT } },
    ];
  }

  private runtimeJson(node: string): string {
    const byId = new Map<string, StoredImage[]>();
    for (const image of this.images(node)) byId.set(image.id, [...(byId.get(image.id) ?? []), image]);
    const images = [...byId.entries()].map(([id, group]) => ({
      id,
      repoTags: group.map((image) => canonicalImageRef(image.ref)),
      repoDigests: [],
      size: '48213504',
      uid: null,
      username: '',
      spec: null,
      pinned: group.some((image) => image.pinned),
    }));
    return JSON.stringify({ images });
  }

  private storeTable(node: string): string {
    const rows = this.images(node).map(
      (image) =>
        `${canonicalImageRef(image.ref)} application/vnd.oci.image.manifest.v1+json ${manifestDigest(image.id)} 46.0 MiB linux/amd64 io.cri-containerd.image=managed${image.pinned ? ',io.cri-containerd.pinned=pinned' : ''}`,
    );
    return ['REF TYPE DIGEST SIZE PLATFORMS LABELS', ...rows, ''].join('\n');
  }

  /** what `ctr images import` does with the (gzipped) fake archive */
  importCall(call: NodeShellCall): NodeShellResponse {
    const refs = refsOfFakePayload(new Uint8Array(gunzipSync(call.stdin)));
    if (refs === null) return { exitCode: 1, stderr: 'ctr: unrecognized image format' };
    for (const ref of refs) {
      if (this.dropOnImport.has(ref)) continue;
      const kept = this.images(call.node).filter((image) => image.ref !== ref);
      this.stores.set(call.node, [...kept, { ref, id: this.engine.idOf(ref) ?? 'sha256:missing', pinned: !this.unpinnedImports }]);
    }
    return { exitCode: 0, stdout: refs.map((ref) => `unpacking ${ref}...done`).join('\n') };
  }

  private remove(call: NodeShellCall): NodeShellResponse {
    const words = shellWords(call.script);
    const refs = words.slice(words.indexOf('rm') + 1);
    this.stores.set(
      call.node,
      this.images(call.node).filter((image) => !refs.includes(image.ref)),
    );
    return { exitCode: 0, stdout: refs.join('\n') };
  }
}

const DF_OUTPUT = [
  'Filesystem     1024-blocks     Used Available Capacity Mounted on',
  '/dev/sda1         41943040 12582912  29360128      30% /',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  backend: KubernetesImageBackend;
  kube: FakeKubeExecutor;
  helm: FakeHelmExecutor;
  shell: FakeNodeShell;
  engine: FakeLocalEngine;
  containerd: Containerd;
  clock: FakeClock;
  redactor: Redactor;
  info: string[];
  debug: string[];
  namespaces: StackRef[];
}

let current: Harness | null = null;

afterEach(() => {
  const h = current;
  current = null;
  if (!h) return;
  h.kube.assertDone();
  h.shell.assertDone();
  h.helm.assertDone();
  assertExecutorInvariants({ kube: h.kube, helm: h.helm, nodeShell: h.shell, redactor: h.redactor });
});

interface SetupOptions {
  kube?: KubeStep[];
  shell?: NodeShellStep[];
  /** local images, reference -> id */
  images?: Record<string, string>;
  seed?: (containerd: Containerd) => void;
  concurrencyProbe?: boolean;
  backend?: Partial<KubernetesImageBackendOptions>;
}

function setup(options: SetupOptions = {}): Harness {
  const redactor = new Redactor();
  const clock = new FakeClock();
  const engine = new FakeLocalEngine(options.images ?? { [WEB]: WEB_ID });
  const containerd = new Containerd(engine);
  options.seed?.(containerd);
  const kube = new FakeKubeExecutor({ script: options.kube ?? [], redactor, clock });
  const helm = new FakeHelmExecutor({ redactor });
  const shell = new FakeNodeShell(
    containerd.steps(options.shell ?? []),
    options.concurrencyProbe ? { redactor, concurrencyProbe: true } : { redactor },
  );
  const info: string[] = [];
  const debug: string[] = [];
  const namespaces: StackRef[] = [];
  const deps: KubernetesBundleDeps = {
    kubectl: kube,
    helm,
    nodeShell: shell.forNode,
    clock,
    redactor,
    distribution: k3sDistribution,
  };
  const backend = new KubernetesImageBackend(deps, TARGET, {
    ensureNamespace: async (ref) => {
      namespaces.push(ref);
    },
    localEngine: engine,
    events: {
      info: (line) => {
        info.push(line);
      },
      debug: (line) => {
        debug.push(line);
      },
    },
    ...options.backend,
  });
  current = { backend, kube, helm, shell, engine, containerd, clock, redactor, info, debug, namespaces };
  return current;
}

function scripts(h: Harness, node?: string): string[] {
  return h.shell.calls.filter((call) => node === undefined || call.node === node).map((call) => call.script);
}

function channels(h: Harness): NodeShellCall[] {
  return h.shell.calls.filter((call) => call.kind === 'channel');
}

function pod(namespace: string, name: string, image: string): unknown {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace }, spec: { containers: [{ name: 'app', image }] } };
}

function inUseStep(items: unknown[]): KubeStep {
  return {
    id: 'K44',
    method: 'run',
    args: ['get', IN_USE, '--all-namespaces', '-o', 'json'],
    namespace: null,
    mutating: false,
    respond: { json: { apiVersion: 'v1', kind: 'List', items } },
  };
}

const imported = (ref: string, id: string, pinned = true): StoredImage => ({ ref, id, pinned });

// ---------------------------------------------------------------------------
// distribute
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.distribute', () => {
  it('U-BE-IMG-01: tags locally, reads every node and imports only where the image id is missing', async () => {
    const h = setup({ seed: (c) => c.seed('server_1', imported(WEB_IMPORTED, WEB_ID)) });

    await h.backend.distribute([WEB], [SERVER_1, AGENT_1]);

    expect(h.engine.calls[0]).toEqual({ method: 'tag', args: ['tag', WEB, WEB_IMPORTED] });
    expect(h.engine.saves).toEqual([[WEB_IMPORTED]]);
    expect(scripts(h, 'server_1')).toEqual([N1, N2]);
    expect(scripts(h, 'agent_1')).toEqual([N1, N2, N3, N1, N2]);
    expect(h.containerd.images('agent_1')).toEqual([imported(WEB_IMPORTED, WEB_ID)]);
    expect(h.info).toEqual([alreadyPresentLine('server_1', 1), importedLine('agent_1', [WEB_IMPORTED])]);
    expect(h.info).toEqual([
      'images: 1 image(s) already present on server_1',
      'images: dockflow.invalid/shop-web:1.4.2 imported on agent_1',
    ]);
  });

  it('U-BE-IMG-02 / I1: opens no import stream when every node already has the pinned image id', async () => {
    const h = setup({
      seed: (c) => c.seed('server_1', imported(WEB_IMPORTED, WEB_ID)).seed('agent_1', imported(WEB_IMPORTED, WEB_ID)),
    });

    await h.backend.distribute([WEB], [SERVER_1, AGENT_1]);

    expect(channels(h)).toEqual([]);
    expect(h.engine.saves).toEqual([]);
    expect(h.info).toEqual([alreadyPresentLine('server_1', 1), alreadyPresentLine('agent_1', 1)]);
  });

  it('I2: re-imports an image that is present but not pinned (DV5)', async () => {
    const h = setup({ seed: (c) => c.seed('agent_1', imported(WEB_IMPORTED, WEB_ID, false)) });

    await h.backend.distribute([WEB], [AGENT_1]);

    expect(channels(h).map((call) => call.script)).toEqual([N3]);
    expect(h.containerd.images('agent_1')).toEqual([imported(WEB_IMPORTED, WEB_ID)]);
  });

  it('re-imports an image whose id differs from the local build', async () => {
    const h = setup({ seed: (c) => c.seed('agent_1', imported(WEB_IMPORTED, fakeImageId('older-build'))) });

    await h.backend.distribute([WEB], [AGENT_1]);

    expect(channels(h)).toHaveLength(1);
    expect(h.containerd.images('agent_1')).toEqual([imported(WEB_IMPORTED, WEB_ID)]);
  });

  it('I3: saves two references sharing one image id together, one stream per node', async () => {
    const worker = 'shop-worker:1.4.2';
    const h = setup({ images: { [WEB]: WEB_ID, [worker]: WEB_ID } });

    await h.backend.distribute([WEB, worker, WEB], [SERVER_1, AGENT_1]);

    const both = [WEB_IMPORTED, 'dockflow.invalid/shop-worker:1.4.2'];
    expect(h.engine.saves).toEqual([both, both]);
    // both nodes stream a real gzip pipeline concurrently, so which one's node-shell channel
    // settles first is a genuine race; only the unordered set of outcomes is asserted (like I10).
    expect(channels(h).map((call) => call.node).sort()).toEqual(['agent_1', 'server_1']);
    expect(h.containerd.refs('agent_1')).toEqual(both);
    expect([...h.info].sort()).toEqual([importedLine('server_1', both), importedLine('agent_1', both)].sort());
  });

  it('I4: runs the exact import pipeline and streams gzip whose gunzipped bytes equal the save output', async () => {
    const seen: Uint8Array[] = [];
    let model: Containerd | null = null;
    const h = setup({
      shell: [
        {
          id: 'N3-exact',
          script: (s) => s === N3,
          kind: 'channel',
          // FakeNodeShell gunzips the stdin of a `gzip -dc` script before this assertion
          stdin: (bytes) => {
            seen.push(bytes);
          },
          respond: (call) => (model ? model.importCall(call) : { exitCode: 1 }),
        },
      ],
      seed: (c) => {
        model = c;
      },
    });

    await h.backend.distribute([WEB], [AGENT_1]);

    const channel = channels(h)[0];
    expect(channel.script).toBe(
      'gzip -dc | sudo -n /usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned=pinned -',
    );
    expect(Buffer.from(seen[0]).equals(Buffer.from(fakeSavePayload([WEB_IMPORTED])))).toBe(true);
    expect(Buffer.from(gunzipSync(channel.stdin)).equals(Buffer.from(fakeSavePayload([WEB_IMPORTED])))).toBe(true);
  });

  it('I5: a sudo refusal names the node, the refused binary and the setup command', async () => {
    const h = setup({
      shell: [{ id: 'N3-sudo', node: 'agent_1', script: (s) => s === N3, kind: 'channel', respond: { exitCode: 1, stderr: 'sudo: a password is required\n' } }],
    });

    await expectCliError(h.backend.distribute([WEB], [AGENT_1]), {
      type: DeployError,
      code: ErrorCode.DEPLOY_FAILED,
      message: 'Image import on agent_1 failed: sudo refused /usr/local/bin/k3s ctr (the host was provisioned by an older Dockflow)',
      suggestion: RERUN_SETUP,
    });
  });

  it('I6: fails when the node listing after the import lacks the reference', async () => {
    const h = setup();
    h.containerd.dropOnImport.add(WEB_IMPORTED);

    await expectCliError(h.backend.distribute([WEB], [AGENT_1]), {
      type: DeployError,
      message: `Image import on agent_1 did not produce ${WEB_IMPORTED} with id ${WEB_ID.slice(7, 19)}`,
      suggestion: 'Run `dockflow list images production --all` to inspect agent_1, then deploy again.',
    });
    expect(scripts(h, 'agent_1')).toEqual([N1, N2, N3, N1, N2]);
    expect(h.info).toEqual([]);
  });

  it('fails the verification when the import left the image unpinned', async () => {
    const h = setup();
    h.containerd.unpinnedImports = true;

    await expectCliError(h.backend.distribute([WEB], [AGENT_1]), { type: DeployError, message: /did not produce/ });
  });

  it('U-BE-IMG-03: a failed stream names its node and the other nodes still import and report', async () => {
    const h = setup({
      shell: [
        {
          id: 'N3-full',
          node: 'agent_1',
          script: (s) => s === N3,
          kind: 'channel',
          respond: { exitCode: 1, stderr: 'ctr: failed to extract layer: write /var/lib/containerd: no space left on device\n' },
        },
      ],
    });

    await expectCliError(h.backend.distribute([WEB], [SERVER_1, AGENT_1, AGENT_2]), {
      type: DeployError,
      message: 'Image import on agent_1 failed: ctr: failed to extract layer: write /var/lib/containerd: no space left on device',
      suggestion: null,
    });
    // server_1 and agent_2 both stream a real gzip pipeline concurrently: completion order
    // between them is a genuine race, so only the unordered set of outcomes is asserted.
    expect([...h.info].sort()).toEqual([importedLine('server_1', [WEB_IMPORTED]), importedLine('agent_2', [WEB_IMPORTED])].sort());
    expect(h.containerd.refs('agent_2')).toEqual([WEB_IMPORTED]);
  });

  it('names every failed node when several fail', async () => {
    const failing = (node: string): NodeShellStep => ({
      id: `N3-${node}`,
      node,
      script: (s) => s === N3,
      kind: 'channel',
      respond: { exitCode: 1, stderr: 'ctr: content digest mismatch\n' },
    });
    const h = setup({ shell: [failing('agent_1'), failing('agent_2')] });

    await expectCliError(h.backend.distribute([WEB], [SERVER_1, AGENT_1, AGENT_2]), {
      type: DeployError,
      message:
        'Image import failed on 2 nodes: Image import on agent_1 failed: ctr: content digest mismatch; Image import on agent_2 failed: ctr: content digest mismatch',
    });
    expect(h.info).toEqual([importedLine('server_1', [WEB_IMPORTED])]);
  });

  it('U-BE-IMG-04: bounds each node stream with the 900 s import guard on the injected clock', async () => {
    const h = setup({
      shell: [{ id: 'N3-hang', node: 'agent_1', script: (s) => s === N3, kind: 'channel', respond: () => new Promise<NodeShellResponse>(() => {}) }],
    });

    const outcome = h.backend.distribute([WEB], [AGENT_1]).then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor('the import guard', () => h.clock.pending > 0);
    expect(h.clock.sleeps).toEqual([900_000]);
    await h.clock.advance(900_000);

    await expectCliError(await outcome, {
      type: DeployError,
      message: 'Image import on agent_1 did not finish within 900s',
      suggestion: 'Check the connection to agent_1 with `dockflow ssh production`, then deploy again.',
    });
    expect(channels(h)[0].closed).toBe(true);
  });

  it('I10 / U-BE-IMG-09: imports on six nodes through NodeShell with at most four at a time', async () => {
    const nodes = ['server_1', 'server_2', 'server_3', 'agent_1', 'agent_2', 'agent_3'].map((name) => fakeNode(name));
    const h = setup({ concurrencyProbe: true });

    await h.backend.distribute([WEB], nodes);

    expect(channels(h).map((call) => call.node).sort()).toEqual(nodes.map((node) => node.name).sort());
    expect(h.shell.peakConcurrency).toBe(4);
    for (const node of nodes) expect(h.containerd.refs(node.name)).toEqual([WEB_IMPORTED]);
  });

  it('stops at a local save failure and closes the node stream', async () => {
    const h = setup();
    h.engine.fail('save', 'write /dev/stdout: broken pipe');

    await expectCliError(h.backend.distribute([WEB], [AGENT_1]), {
      type: DeployError,
      message: `docker save ${WEB_IMPORTED} failed: write /dev/stdout: broken pipe`,
    });
    expect(channels(h)[0].closed).toBe(true);
    expect(h.containerd.refs('agent_1')).toEqual([]);
  });

  it('fails before any node work when the local image does not exist', async () => {
    const h = setup({ images: {} });

    await expectCliError(h.backend.distribute([WEB], [SERVER_1, AGENT_1]), {
      type: DeployError,
      message: `docker tag ${WEB} ${WEB_IMPORTED} failed: Error response from daemon: No such image: ${WEB}`,
    });
    expect(h.shell.calls).toEqual([]);
  });

  it('does nothing without images or nodes', async () => {
    const h = setup();

    await h.backend.distribute([], [SERVER_1]);
    await h.backend.distribute([WEB], []);

    expect(h.engine.calls).toEqual([]);
    expect(h.shell.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verifyPresence
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.verifyPresence', () => {
  const OLD = 'dockflow.invalid/shop-web-production:1.4.0';
  const OLD_ID = fakeImageId('shop-web-production-1.4.0');

  it('I11: reads N1 and N2 per node, reports the nodes missing an imported reference and never checks pulled ones', async () => {
    const h = setup({
      seed: (c) => c.seed('server_1', imported(OLD, OLD_ID)).seed('agent_1', imported(OLD, OLD_ID, false)),
    });

    const report = await h.backend.verifyPresence(
      [OLD, 'registry.example.com/team/shop-api:1.4.0', 'redis:8-alpine'],
      [SERVER_1, AGENT_1, AGENT_2],
    );

    expect(report).toEqual([{ node: 'agent_2', missing: [OLD] }]);
    for (const node of ['server_1', 'agent_1', 'agent_2']) expect(scripts(h, node)).toEqual([N1, N2]);
    expect(h.engine.calls).toEqual([]);
  });

  it('touches no node when no reference was imported', async () => {
    const h = setup();

    expect(await h.backend.verifyPresence(['registry.example.com/team/shop-api:1.4.0', 'redis:8-alpine'], [SERVER_1])).toEqual([]);
    expect(h.shell.calls).toEqual([]);
  });

  it('fails with the node and the refused binary when the listing is refused', async () => {
    const h = setup({
      shell: [{ id: 'N1-sudo', node: 'agent_1', script: (s) => s === N1, kind: 'run', respond: { exitCode: 1, stderr: 'sudo: a password is required\n' } }],
    });

    await expectCliError(h.backend.verifyPresence([OLD], [SERVER_1, AGENT_1]), {
      type: DeployError,
      message: 'Image check on agent_1 failed: sudo refused /usr/local/bin/k3s crictl (the host was provisioned by an older Dockflow)',
      suggestion: RERUN_SETUP,
    });
  });
});

// ---------------------------------------------------------------------------
// ensurePullSecret
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.ensurePullSecret', () => {
  const CREDENTIALS = { server: 'https://registry.example.com/v2/', username: 'ci', password: PASSWORD };
  const AUTH = Buffer.from(`ci:${PASSWORD}`, 'utf8').toString('base64');

  it('I9 / U-BE-IMG-05: applies the dockerconfigjson Secret over stdin and never puts the password in argv', async () => {
    let applied = '';
    const h = setup({
      kube: [
        {
          id: 'K42',
          method: 'apply',
          args: ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'],
          namespace: NS,
          mutating: true,
          stdin: (text) => {
            applied = text;
          },
          respond: { exitCode: 0, stdout: '', stderr: '' },
        },
      ],
    });

    const name = await h.backend.ensurePullSecret(REF, CREDENTIALS);

    expect(name).toBe(K8S_REGISTRY_SECRET);
    expect(name).toBe('dockflow-registry');
    expect(h.namespaces).toEqual([REF]);
    const secret = JSON.parse(applied);
    expect(secret).toMatchObject({
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'kubernetes.io/dockerconfigjson',
      metadata: { name: 'dockflow-registry', namespace: NS },
    });
    const config = Buffer.from(secret.data['.dockerconfigjson'], 'base64').toString('utf8');
    expect(config).toBe(canonicalJson({ auths: { 'registry.example.com': { auth: AUTH, password: PASSWORD, username: 'ci' } } }));
    const call = h.kube.calls[0];
    expect(call.commandString).not.toContain(PASSWORD);
    expect(call.call.args.join(' ')).not.toContain(PASSWORD);
    expect(h.redactor.redact(`${PASSWORD} ${AUTH}`)).toBe('*** ***');
  });

  it('maps a refused apply to the Dockflow identity error', async () => {
    const h = setup({
      kube: [{ id: 'K42', method: 'apply', args: ['apply', '--server-side', '--field-manager=dockflow', '--force-conflicts', '-f', '-'], respond: { error: 'Forbidden' } }],
    });

    await expectCliError(h.backend.ensurePullSecret(REF, CREDENTIALS), {
      type: OrchestratorUnavailableError,
      message: 'The Dockflow deploy identity is not allowed to apply the registry pull Secret',
      suggestion: RERUN_SETUP,
    });
  });

  it('applies nothing when the namespace cannot be ensured', async () => {
    const h = setup({
      backend: {
        ensureNamespace: async () => {
          throw new DeployError(`Namespace ${NS} exists and belongs to no Dockflow stack; rename project_name or env`);
        },
      },
    });

    await expectCliError(h.backend.ensurePullSecret(REF, CREDENTIALS), { type: DeployError, message: /belongs to no Dockflow stack/ });
    expect(h.kube.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.remove', () => {
  const WEB_P = 'shop-web-production:1.4.2';
  const WORKER_P = 'shop-worker-production:1.4.2';
  const WEB_P_IMPORTED = `dockflow.invalid/${WEB_P}`;
  const WORKER_P_IMPORTED = `dockflow.invalid/${WORKER_P}`;
  const seedBoth = (c: Containerd): void => {
    c.seed('server_1', imported(WEB_P_IMPORTED, fakeImageId('web-p')), imported(WORKER_P_IMPORTED, fakeImageId('worker-p')));
  };

  it('I7: keeps every image a pod of any namespace still uses', async () => {
    const h = setup({ kube: [inUseStep([pod(NS, 'web-7c9f-abcde', WEB_P_IMPORTED)])], seed: seedBoth });

    await h.backend.remove([WEB_P, WORKER_P], [SERVER_1]);

    expect(scripts(h).filter((s) => s.startsWith(N4))).toEqual([`${N4} '${WORKER_P_IMPORTED}'`]);
    expect(h.containerd.refs('server_1')).toEqual([WEB_P_IMPORTED]);
    expect(h.kube.calls[0].commandString).toContain('--request-timeout=60s');
  });

  it('keeps the images of the current release', async () => {
    const reads: string[] = [];
    const h = setup({
      kube: [inUseStep([])],
      seed: seedBoth,
      backend: {
        releases: {
          currentCompose: async (stackName) => {
            reads.push(stackName);
            return `services:\n  web:\n    image: ${WEB_P}\n`;
          },
        },
      },
    });

    await h.backend.remove([WEB_P, WORKER_P], [SERVER_1]);

    expect(reads).toEqual(['shop-production']);
    expect(h.containerd.refs('server_1')).toEqual([WEB_P_IMPORTED]);
  });

  it('U-BE-IMG-06: never names a reference outside the imported registry', async () => {
    const h = setup();

    await h.backend.remove(["shop web:1.4.2", "shop-web:1.4.2'; rm -rf / #"], [SERVER_1]);

    expect(h.kube.calls).toEqual([]);
    expect(h.shell.calls).toEqual([]);
    expect(isRemovableRef(toImportedRef('shop web:1.4.2'))).toBe(false);
    expect(isRemovableRef('docker.io/library/redis:8-alpine')).toBe(false);
    expect(isRemovableRef(WEB_IMPORTED)).toBe(true);
    expect(() => k3sDistribution.removeImagesCommand(['docker.io/library/redis:8-alpine'])).toThrow(DeployError);
  });

  it('is best effort: an unreadable cluster removes nothing and does not throw', async () => {
    const h = setup({ kube: [{ ...inUseStep([]), respond: { error: 'Unreachable' } }], seed: seedBoth });

    await h.backend.remove([WEB_P], [SERVER_1]);

    expect(h.shell.calls).toEqual([]);
    expect(h.debug).toHaveLength(1);
    expect(h.debug[0]).toStartWith('Image cleanup skipped: ');
  });

  it('is best effort per node: a failed removal is reported as debug output only', async () => {
    const h = setup({
      kube: [inUseStep([])],
      seed: seedBoth,
      shell: [{ id: 'N4-busy', node: 'server_1', script: (s) => s.startsWith(N4), kind: 'run', respond: { exitCode: 1, stderr: 'ctr: image is in use\n' } }],
    });

    await h.backend.remove([WORKER_P], [SERVER_1]);

    expect(h.debug).toEqual(['Image cleanup on server_1 failed: ctr: image is in use']);
  });
});

// ---------------------------------------------------------------------------
// collectGarbage
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.collectGarbage', () => {
  const v = (service: string, version: string): string => `shop-${service}:${version}`;
  const i = (service: string, version: string): string => `dockflow.invalid/shop-${service}:${version}`;
  const seed = (c: Containerd): void => {
    c.seed(
      'server_1',
      imported(i('web', '1.4.0'), fakeImageId('web-140')),
      imported(i('web', '1.4.1'), fakeImageId('web-141')),
      imported(i('web', '1.4.2'), fakeImageId('web-142')),
      imported('docker.io/library/redis:8-alpine', fakeImageId('redis'), false),
    );
    c.seed('agent_1', imported(i('worker', '1.4.0'), fakeImageId('worker-140')), imported(i('web', '1.4.2'), fakeImageId('web-142')));
  };

  it('I8 / U-BE-IMG-07: removes the imported images only removed releases used, where the node has them', async () => {
    const h = setup({ kube: [inUseStep([])], seed });

    await h.backend.collectGarbage(
      [SERVER_1, AGENT_1],
      [v('web', '1.4.0'), v('worker', '1.4.0'), 'redis:8-alpine', v('web', '1.4.1')],
      [v('web', '1.4.1'), v('web', '1.4.2'), v('worker', '1.4.2')],
    );

    expect(scripts(h, 'server_1').filter((s) => s.startsWith(N4))).toEqual([`${N4} '${i('web', '1.4.0')}'`]);
    expect(scripts(h, 'agent_1').filter((s) => s.startsWith(N4))).toEqual([`${N4} '${i('worker', '1.4.0')}'`]);
    expect(h.containerd.refs('server_1')).toEqual([i('web', '1.4.1'), i('web', '1.4.2'), 'docker.io/library/redis:8-alpine']);
    expect(h.containerd.refs('agent_1')).toEqual([i('web', '1.4.2')]);
    for (const script of scripts(h).filter((s) => s.startsWith(N4))) {
      for (const word of shellWords(script).slice(shellWords(script).indexOf('rm') + 1)) expect(word).toStartWith('dockflow.invalid/');
    }
  });

  it('keeps an image a workload template still references', async () => {
    const replicaSet = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: { name: 'web-6d4b', namespace: NS },
      spec: { template: { spec: { initContainers: [{ name: 'migrate', image: i('web', '1.4.0') }], containers: [] } } },
    };
    const h = setup({ kube: [inUseStep([replicaSet])], seed });

    await h.backend.collectGarbage([SERVER_1], [v('web', '1.4.0')], []);

    expect(scripts(h, 'server_1').filter((s) => s.startsWith(N4))).toEqual([]);
  });

  it('reads nothing when every removed image is kept', async () => {
    const h = setup({ seed });

    await h.backend.collectGarbage([SERVER_1], [v('web', '1.4.2')], [v('web', '1.4.2')]);

    expect(h.kube.calls).toEqual([]);
    expect(h.shell.calls).toEqual([]);
  });

  it('attempts every node and fails naming the one that could not remove', async () => {
    const h = setup({
      kube: [inUseStep([])],
      seed,
      shell: [{ id: 'N4-agent', node: 'agent_1', script: (s) => s.startsWith(N4), kind: 'run', respond: { exitCode: 1, stderr: 'ctr: permission denied\n' } }],
    });

    await expectCliError(h.backend.collectGarbage([SERVER_1, AGENT_1], [v('web', '1.4.0'), v('worker', '1.4.0')], []), {
      type: DeployError,
      message: 'Image cleanup on agent_1 failed: ctr: permission denied',
    });
    expect(h.containerd.refs('server_1')).not.toContain(i('web', '1.4.0'));
  });

  describe('the repositories named for this environment are swept', () => {
    const e = (service: string, version: string): string => `shop-${service}-production:${version}`;
    const ie = (service: string, version: string): string => `dockflow.invalid/shop-${service}-production:${version}`;
    const seedEnv = (c: Containerd): void => {
      c.seed(
        'server_1',
        // left behind by an earlier cleanup, while a ReplicaSet still referenced it
        imported(ie('web', '1.4.0'), fakeImageId('web-140')),
        imported(ie('web', '1.4.1'), fakeImageId('web-141')),
        imported(ie('web', '1.4.2'), fakeImageId('web-142')),
        imported(ie('web', '1.4.3'), fakeImageId('web-143')),
        // not a name Dockflow gave for this environment
        imported(i('web', '1.3.0'), fakeImageId('web-130')),
      );
    };

    it('an earlier tag no release and no workload references goes with the pruned release', async () => {
      const h = setup({ kube: [inUseStep([])], seed: seedEnv });

      await h.backend.collectGarbage([SERVER_1], [e('web', '1.4.1')], [e('web', '1.4.2'), e('web', '1.4.3')]);

      expect(scripts(h, 'server_1').filter((s) => s.startsWith(N4))).toEqual([`${N4} '${ie('web', '1.4.0')}' '${ie('web', '1.4.1')}'`]);
      expect(h.containerd.refs('server_1')).toEqual([ie('web', '1.4.2'), ie('web', '1.4.3'), i('web', '1.3.0')]);
    });

    it('a swept tag a workload template still references is kept', async () => {
      const replicaSet = {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: { name: 'web-5c8f', namespace: NS },
        spec: { template: { spec: { containers: [{ name: 'web', image: ie('web', '1.4.0') }] } } },
      };
      const h = setup({ kube: [inUseStep([replicaSet])], seed: seedEnv });

      await h.backend.collectGarbage([SERVER_1], [e('web', '1.4.1')], [e('web', '1.4.2'), e('web', '1.4.3')]);

      expect(h.containerd.refs('server_1')).toEqual([ie('web', '1.4.0'), ie('web', '1.4.2'), ie('web', '1.4.3'), i('web', '1.3.0')]);
    });
  });
});

// ---------------------------------------------------------------------------
// list, prune, pruneRuntime
// ---------------------------------------------------------------------------

describe('KubernetesImageBackend.list', () => {
  const REDIS_ID = fakeImageId('redis-8');
  const BUSYBOX_ID = fakeImageId('busybox');
  const RUNTIME = JSON.stringify({
    images: [
      { id: WEB_ID, repoTags: [WEB_IMPORTED], repoDigests: [], size: '48213504', pinned: true },
      { id: REDIS_ID, repoTags: ['docker.io/library/redis:8-alpine'], repoDigests: ['docker.io/library/redis@sha256:1f'], size: '12345', pinned: false },
      { id: BUSYBOX_ID, repoTags: [], repoDigests: ['docker.io/library/busybox@sha256:2e'], size: '4200', pinned: false },
    ],
  });
  const listSteps = (): NodeShellStep[] => [{ id: 'N1-list', script: (s) => s === N1, kind: 'run', times: 'any', respond: { exitCode: 0, stdout: RUNTIME } }];
  const podsStep = (items: unknown[]): KubeStep => ({
    id: 'pods',
    method: 'getJson',
    args: ['get', 'pods', '--all-namespaces', '-o', 'json'],
    namespace: null,
    respond: { json: { apiVersion: 'v1', kind: 'List', items } },
  });

  it('lists each node with in-use flags from the running pods and the image store disk usage', async () => {
    const h = setup({ kube: [podsStep([pod('cache', 'redis-0', 'redis:8-alpine')])], shell: listSteps() });

    const result = await h.backend.list([SERVER_1], { all: false });

    expect(result).toEqual([
      {
        node: 'server_1',
        images: [
          { ref: 'docker.io/library/redis:8-alpine', id: REDIS_ID, sizeBytes: 12345, inUse: true },
          { ref: WEB_IMPORTED, id: WEB_ID, sizeBytes: 48213504, inUse: false },
        ],
        diskUsage: '12G used of 40G, 30%',
      },
    ]);
    expect(scripts(h)).toEqual([N1, DF]);
  });

  it('shows untagged images with --all, under their digest', async () => {
    const h = setup({ kube: [podsStep([])], shell: listSteps() });

    const [row] = await h.backend.list([SERVER_1], { all: true });

    expect(row.images.map((image) => image.ref)).toEqual([
      'docker.io/library/busybox@sha256:2e',
      'docker.io/library/redis:8-alpine',
      WEB_IMPORTED,
    ]);
  });

  it('reports a missing sudo rule as an unavailable orchestrator', async () => {
    const h = setup({
      kube: [podsStep([])],
      shell: [{ id: 'N1-sudo', node: 'agent_1', script: (s) => s === N1, kind: 'run', respond: { exitCode: 1, stderr: 'sudo: a password is required\n' } }],
    });

    await expectCliError(h.backend.list([AGENT_1], { all: false }), {
      type: OrchestratorUnavailableError,
      message: 'Listing images on agent_1 needs the Dockflow sudo rules',
      suggestion: RERUN_SETUP,
    });
  });

  it('leaves the disk usage unknown when df fails', async () => {
    const h = setup({
      kube: [podsStep([])],
      shell: [{ id: 'df-fail', script: (s) => s === DF, kind: 'run', respond: { exitCode: 1, stderr: 'df: permission denied\n' } }, ...listSteps()],
    });

    const [row] = await h.backend.list([SERVER_1], { all: false });

    expect(row.diskUsage).toBeNull();
  });
});

describe('KubernetesImageBackend.prune and pruneRuntime', () => {
  it('U-BE-IMG-08: prune --all runs the runtime prune on every node and reports no figure', async () => {
    const h = setup({ shell: [{ id: 'prune', script: (s) => s === PRUNE, kind: 'run', times: 2, respond: { exitCode: 0, stdout: 'Deleted: sha256:1f\n' } }] });

    const result = await h.backend.prune([SERVER_1, AGENT_1], { all: true });

    expect(result).toEqual([
      { node: 'server_1', reclaimed: null },
      { node: 'agent_1', reclaimed: null },
    ]);
    expect(scripts(h)).toEqual([PRUNE, PRUNE]);
  });

  it('prune without --all has nothing to remove on containerd and runs nothing', async () => {
    const h = setup();

    expect(await h.backend.prune([SERVER_1], { all: false })).toEqual([{ node: 'server_1', reclaimed: null }]);
    expect(h.shell.calls).toEqual([]);
  });

  it('attempts every node before failing with the nodes that could not prune', async () => {
    const h = setup({
      shell: [
        { id: 'prune-agent', node: 'agent_1', script: (s) => s === PRUNE, kind: 'run', respond: { exitCode: 1, stderr: 'sudo: a password is required\n' } },
        { id: 'prune', script: (s) => s === PRUNE, kind: 'run', respond: { exitCode: 0 } },
      ],
    });

    await expectCliError(h.backend.prune([SERVER_1, AGENT_1], { all: true }), {
      type: DeployError,
      message: 'Image prune failed on agent_1: sudo refused /usr/local/bin/k3s crictl (the host was provisioned by an older Dockflow)',
      suggestion: RERUN_SETUP,
    });
    expect(scripts(h, 'server_1')).toEqual([PRUNE]);
  });

  it('pruneRuntime refuses every target on Kubernetes without touching a node', async () => {
    const h = setup();
    const networks = capabilityRefusal('networkPrune', 'dockflow prune --networks');

    await expectCliError(h.backend.pruneRuntime([SERVER_1], 'networks'), {
      type: UnsupportedOperationError,
      code: ErrorCode.UNSUPPORTED_OPERATION,
      message: networks.message,
      suggestion: null,
    });
    await expectCliError(h.backend.pruneRuntime([SERVER_1], 'volumes'), {
      type: UnsupportedOperationError,
      message: 'dockflow prune --volumes is not supported with orchestrator: k3s: volumes are only deleted explicitly',
      suggestion:
        'List them with `dockflow volumes list production`, then delete the ones you no longer need with `dockflow volumes rm production <name>`.',
    });
    await expectCliError(h.backend.pruneRuntime([SERVER_1], 'containers'), {
      type: UnsupportedOperationError,
      message: 'dockflow prune --containers is not supported with orchestrator: k3s: the kubelet removes exited containers itself',
      suggestion: 'Reclaim image space with `dockflow prune production --images --all`.',
    });
    expect(h.shell.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('image references and node listings', () => {
  it('exports the stable distribution phrases (R-S5-01)', () => {
    expect(IMAGE_PHRASES).toEqual({ imported: 'imported on', alreadyPresent: 'already present on' });
    expect(importedLine('agent_1', ['a', 'b'])).toContain(`${IMAGE_PHRASES.imported} agent_1`);
    expect(alreadyPresentLine('agent_1', 2)).toContain(`${IMAGE_PHRASES.alreadyPresent} agent_1`);
  });

  it('canonicalises references the way the runtime stores them', () => {
    expect(canonicalImageRef('redis')).toBe('docker.io/library/redis:latest');
    expect(canonicalImageRef('redis:8-alpine')).toBe('docker.io/library/redis:8-alpine');
    expect(canonicalImageRef('docker.io/redis:7')).toBe('docker.io/library/redis:7');
    expect(canonicalImageRef('bitnami/redis:7')).toBe('docker.io/bitnami/redis:7');
    expect(canonicalImageRef('redis@sha256:1f')).toBe('docker.io/library/redis@sha256:1f');
    expect(canonicalImageRef('registry.example.com:5000/team/api')).toBe('registry.example.com:5000/team/api:latest');
    expect(canonicalImageRef('localhost/api:2')).toBe('localhost/api:2');
    expect(canonicalImageRef(WEB_IMPORTED)).toBe(WEB_IMPORTED);
  });

  it('maps compose references into the imported registry once', () => {
    expect(toImportedRef(WEB)).toBe(WEB_IMPORTED);
    expect(toImportedRef(WEB_IMPORTED)).toBe(WEB_IMPORTED);
    expect(toImportedRef('registry.example.com:5000/team/api:1')).toBe('dockflow.invalid/registry.example.com-5000/team/api:1');
  });

  it('matches the local id against the config digest or the manifest digest, pinned only', () => {
    const index = nodeImageIndex(
      [{ id: WEB_ID, repoTags: [WEB_IMPORTED], repoDigests: [], sizeBytes: null, pinned: true }],
      [{ ref: WEB_IMPORTED, digest: manifestDigest(WEB_ID) }],
    );
    expect(isPresent(index, WEB_IMPORTED, WEB_ID)).toBe(true);
    // the containerd image store of Docker Engine 29 reports the manifest digest as the image id
    expect(isPresent(index, WEB_IMPORTED, manifestDigest(WEB_ID))).toBe(true);
    expect(isPresent(index, WEB_IMPORTED, fakeImageId('other'))).toBe(false);
    // podman reports the bare hex of the same id
    expect(isPresent(index, WEB_IMPORTED, WEB_ID.slice('sha256:'.length))).toBe(true);
    expect(isPresent(index, WEB_IMPORTED, '')).toBe(false);
    const unpinned = nodeImageIndex([{ id: WEB_ID, repoTags: [WEB_IMPORTED], repoDigests: [], sizeBytes: null, pinned: false }], []);
    expect(isPresent(unpinned, WEB_IMPORTED, WEB_ID)).toBe(false);
  });

  it('parses the ctr table by its first three columns and rejects a listing that is not JSON', () => {
    const table = [
      'REF                             TYPE                                       DIGEST        SIZE      PLATFORMS   LABELS',
      'dockflow.invalid/shop-web:1.4.2 application/vnd.oci.image.manifest.v1+json sha256:aa11 46.0 MiB linux/amd64 io.cri-containerd.pinned=pinned',
      'sha256:bb22                     application/vnd.oci.image.index.v1+json    not-a-digest  1.0 KiB   -           -',
    ].join('\n');
    expect(parseStoreImages(table)).toEqual([{ ref: WEB_IMPORTED, digest: 'sha256:aa11' }]);
    expect(parseRuntimeImages('not json')).toBeNull();
    expect(parseRuntimeImages('')).toEqual([]);
  });

  it('collects container, init and ephemeral container images of pods and templates', () => {
    const found = containerImagesOf([
      pod(NS, 'a', 'redis:8-alpine'),
      { kind: 'ControllerRevision', data: { spec: { template: { spec: { containers: [{ image: WEB_IMPORTED }] } } } } },
      { kind: 'Pod', spec: { ephemeralContainers: [{ image: 'busybox' }] } },
    ]);
    expect([...found].sort()).toEqual(['docker.io/library/busybox:latest', 'docker.io/library/redis:8-alpine', WEB_IMPORTED]);
  });

  it('formats disk usage like df -h', () => {
    expect(humanSize(12 * 1024 ** 3)).toBe('12G');
    expect(humanSize(1.5 * 1024 ** 3)).toBe('1.5G');
    expect(humanSize(512)).toBe('512');
    expect(parseDiskUsage(DF_OUTPUT)).toBe('12G used of 40G, 30%');
    expect(parseDiskUsage('Filesystem 1024-blocks Used Available Capacity Mounted on\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Swarm
// ---------------------------------------------------------------------------

interface SwarmCall {
  node: string;
  command: string;
  stdin: Buffer;
}

class ScriptedSwarmSsh implements SwarmSsh {
  readonly execs: { node: string; command: string }[] = [];
  readonly channels: SwarmCall[] = [];

  constructor(
    private readonly onExec: (node: string, command: string) => SwarmExecResult,
    private readonly onChannel: (node: string, command: string, stdin: Buffer) => SwarmExecResult = () => ({ exitCode: 0, stdout: '', stderr: '' }),
  ) {}

  async exec(node: ClusterNodeRef, command: string): Promise<SwarmExecResult> {
    this.execs.push({ node: node.name, command });
    return this.onExec(node.name, command);
  }

  async channel(node: ClusterNodeRef, command: string): Promise<SwarmChannel> {
    const record: SwarmCall = { node: node.name, command, stdin: Buffer.alloc(0) };
    this.channels.push(record);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    let settle: (value: { exitCode: number }) => void = () => {};
    const done = new Promise<{ exitCode: number }>((resolve) => {
      settle = resolve;
    });
    const respond = this.onChannel;
    const stdin = new Writable({
      write(chunk: unknown, _encoding, callback) {
        chunks.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk)));
        callback();
      },
      final(callback) {
        callback();
        record.stdin = Buffer.concat(chunks);
        const result = respond(node.name, command, record.stdin);
        if (result.stdout) stdout.write(result.stdout);
        if (result.stderr) stderr.write(result.stderr);
        stdout.end();
        stderr.end();
        setImmediate(() => settle({ exitCode: result.exitCode }));
      },
    });
    return {
      stdin,
      stdout,
      stderr,
      done,
      close: () => {
        stdout.end();
        stderr.end();
        settle({ exitCode: -1 });
      },
    };
  }

  async interactive(): Promise<number> {
    throw new Error('interactive sessions are not part of the image backend');
  }
}

const ok = (stdout = ''): SwarmExecResult => ({ exitCode: 0, stdout, stderr: '' });

describe('SwarmImageBackend', () => {
  const SWARM_TARGET: OrchestratorTarget = { ...TARGET, kind: 'swarm', workers: [AGENT_1] };

  beforeEach(() => {
    const quiet = (): void => {};
    spyOn(output, 'printSuccess').mockImplementation(quiet);
    spyOn(output, 'printDim').mockImplementation(quiet);
    spyOn(output, 'printDebug').mockImplementation(quiet);
    spyOn(output, 'createTimedSpinner').mockImplementation(() => ({
      start: quiet,
      succeed: quiet,
      fail: quiet,
      warn: quiet,
      info: quiet,
      stop: quiet,
      update: quiet,
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it('distributes over the Swarm transfer, skipping nodes that have the same image id', async () => {
    const idCommand = `docker images --no-trunc -q '${WEB}' 2>/dev/null | head -1`;
    const ssh = new ScriptedSwarmSsh((node, command) => {
      if (command === idCommand) return ok(node === 'server_1' ? `${WEB_ID}\n` : '');
      throw new Error(`unexpected command ${command}`);
    });
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh, containerEngine: 'docker', localEngine: new FakeLocalEngine({ [WEB]: WEB_ID }) });

    await backend.distribute([WEB], [SERVER_1, AGENT_1]);

    expect(ssh.channels.map((call) => [call.node, call.command])).toEqual([['agent_1', 'gunzip | docker load']]);
    expect(Buffer.from(gunzipSync(ssh.channels[0].stdin)).equals(Buffer.from(fakeSavePayload([WEB])))).toBe(true);
  });

  it('uses podman when the manager has it and no engine is configured, as before', async () => {
    const ssh = new ScriptedSwarmSsh((_node, command) => (command === 'which podman 2>/dev/null' ? ok('/usr/bin/podman\n') : ok('')));
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh, localEngine: new FakeLocalEngine({ [WEB]: WEB_ID }, { kind: 'podman' }) });

    await backend.distribute([WEB], [AGENT_1]);

    expect(ssh.execs[0]).toEqual({ node: 'server_1', command: 'which podman 2>/dev/null' });
    expect(ssh.channels.map((call) => call.command)).toEqual(['gunzip | podman load']);
  });

  it('logs in on the manager with the password on stdin and returns no Secret name', async () => {
    const ssh = new ScriptedSwarmSsh(() => ok());
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh, containerEngine: 'docker' });

    const name = await backend.ensurePullSecret(REF, { server: 'registry.example.com', username: 'ci', password: PASSWORD });

    expect(name).toBeNull();
    expect(ssh.channels).toHaveLength(1);
    expect(ssh.channels[0].node).toBe('server_1');
    expect(ssh.channels[0].command).toBe("docker login 'registry.example.com' -u 'ci' --password-stdin");
    expect(ssh.channels[0].stdin.toString('utf8')).toBe(`${PASSWORD}\n`);
  });

  it('reports a refused login with the node', async () => {
    const ssh = new ScriptedSwarmSsh(
      () => ok(),
      () => ({ exitCode: 1, stdout: '', stderr: 'Error response from daemon: unauthorized: incorrect username or password\n' }),
    );
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh, containerEngine: 'docker' });

    await expectCliError(backend.ensurePullSecret(REF, { server: 'registry.example.com', username: 'ci', password: PASSWORD }), {
      type: DeployError,
      message: 'Registry login failed on server_1: Error response from daemon: unauthorized: incorrect username or password',
      suggestion: 'Check registry URL and credentials.',
    });
  });

  it('lists images of every node with in-use flags and the docker disk usage', async () => {
    const usedId = fakeImageId('used');
    const danglingId = fakeImageId('dangling');
    const ssh = new ScriptedSwarmSsh((_node, command) => {
      if (command.startsWith('docker images')) {
        return ok(
          [
            JSON.stringify({ Repository: 'shop-web', Tag: '1.4.2', ID: usedId, Size: '84.1MB', Digest: '<none>' }),
            JSON.stringify({ Repository: '<none>', Tag: '<none>', ID: danglingId, Size: '1.2kB', Digest: '<none>' }),
          ].join('\n'),
        );
      }
      if (command.startsWith('docker ps -aq')) return ok(`${usedId}\n`);
      if (command.startsWith('docker system df')) {
        return ok(
          [
            JSON.stringify({ Active: '1', Reclaimable: '1.2GB (40%)', Size: '3.1GB', TotalCount: '5', Type: 'Images' }),
            JSON.stringify({ Active: '1', Reclaimable: '0B (0%)', Size: '2kB', TotalCount: '1', Type: 'Containers' }),
          ].join('\n'),
        );
      }
      throw new Error(`unexpected command ${command}`);
    });
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh });

    const [plain] = await backend.list([SERVER_1], { all: false });
    const [all] = await backend.list([SERVER_1], { all: true });

    expect(plain).toEqual({
      node: 'server_1',
      images: [{ ref: 'shop-web:1.4.2', id: usedId, sizeBytes: 84_100_000, inUse: true }],
      diskUsage: '3.1GB used by images, 1.2GB (40%) reclaimable',
    });
    expect(all.images.map((image) => image.ref)).toEqual(['shop-web:1.4.2', danglingId]);
    expect(ssh.execs.map((call) => call.command)).toContain("docker images -a --no-trunc --format '{{json .}}'");
  });

  it('prunes images on every node with the reclaimed figure, and fails only after trying them all', async () => {
    const ssh = new ScriptedSwarmSsh((node, command) => {
      if (node === 'agent_1' && command === 'docker image prune -f') {
        return { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' };
      }
      return ok('Deleted Images:\nuntagged: shop-web:1.4.0\n\nTotal reclaimed space: 1.2GB\n');
    });
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh });

    expect(await backend.prune([SERVER_1, AGENT_1], { all: true })).toEqual([
      { node: 'server_1', reclaimed: '1.2GB' },
      { node: 'agent_1', reclaimed: '1.2GB' },
    ]);
    await expectCliError(backend.prune([SERVER_1, AGENT_1], { all: false }), {
      type: DeployError,
      message: 'Image prune failed on agent_1: Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    });
    expect(ssh.execs.map((call) => `${call.node} ${call.command}`)).toEqual([
      'server_1 docker image prune -f -a',
      'agent_1 docker image prune -f -a',
      'server_1 docker image prune -f',
      'agent_1 docker image prune -f',
    ]);
  });

  it('keeps the runtime prunes of today (containers, volumes, networks)', async () => {
    const ssh = new ScriptedSwarmSsh((_node, command) => ok(command.includes('network') ? 'Deleted Networks:\nold\n' : 'Total reclaimed space: 10MB\n'));
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh });

    expect(await backend.pruneRuntime([SERVER_1], 'containers')).toEqual([{ node: 'server_1', reclaimed: '10MB' }]);
    expect(await backend.pruneRuntime([SERVER_1], 'volumes')).toEqual([{ node: 'server_1', reclaimed: '10MB' }]);
    expect(await backend.pruneRuntime([SERVER_1], 'networks')).toEqual([{ node: 'server_1', reclaimed: null }]);
    expect(ssh.execs.map((call) => call.command)).toEqual(['docker container prune -f', 'docker volume prune -f', 'docker network prune -f']);
  });

  it('checks presence with docker images, and leaves removal to dockflow prune', async () => {
    const ssh = new ScriptedSwarmSsh((node) => ok(node === 'server_1' ? 'shop-web:1.4.2\nredis:latest\n' : ''));
    const backend = new SwarmImageBackend(SWARM_TARGET, { ssh });

    expect(await backend.verifyPresence([WEB, 'redis'], [SERVER_1, AGENT_1])).toEqual([{ node: 'agent_1', missing: [WEB, 'redis'] }]);
    const before = ssh.execs.length;
    await backend.remove([WEB], [SERVER_1]);
    await backend.collectGarbage([SERVER_1], [WEB], []);
    expect(ssh.execs).toHaveLength(before);
    expect(ssh.channels).toEqual([]);
  });
});
