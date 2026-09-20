// FakeSetupTransport (design-05 3.3, design-07 R-S6-06): the coordinator's transport seam. `inspect`
// (and any operation a test explicitly asks to run "for real") goes through the actual
// `runK3sNodeStep` against that node's `FakeHostRunner`, with `plan.pins` substituted for
// self-consistent fake bytes first: the real `K3S_PIN`/`HELM_PIN` sha256 values are the digests of
// actual published release artefacts, and no test can construct bytes that hash to them, so
// `fakePinsFor`/`seedFakeDownloadCache` below give every node its own self-consistent set (sha256
// computed from the same bytes they seed into the cache) before the plan reaches the real step.
// Every other operation defaults to a plausible successful `NodeStepResult` a test can override per
// node and per operation, plus scriptable connection-level faults (refused, sudo denied, timeout,
// crash, truncated output) that never touch `runK3sNodeStep` at all.

import { Readable } from 'node:stream';
import { spyOn } from 'bun:test';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { systemClock } from '../../../services/orchestrator/kubernetes/deps';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import { HELM_PIN } from '../../../services/orchestrator/kubernetes/versions';
import { K8S_STORAGE_CLASS } from '../../../services/orchestrator/kubernetes/constants';
import { ConnectionError } from '../../../utils/errors';
import { sha256Hex } from '../../../utils/hash';
import type { ExecResult } from '../../../commands/setup/k3s/transport';
import type { SetupTransport } from '../../../commands/setup/k3s/transport';
import type { NodeEvent, NodeStepOutcome } from '../../../commands/setup/remote';
import { archFromMachine } from '../../../commands/setup/k3s/install';
import { runK3sNodeStep, type NodeStepResult } from '../../../commands/setup/k3s/node';
import type { K3sNodePlan, K3sNodeSpec, NodeArch, NodeOperation } from '../../../commands/setup/k3s/plan';
import type { SetupProblem } from '../../../commands/setup/k3s/messages';
import type { HostKeyVerification } from '../../../commands/setup/k3s/host-keys';
import * as output from '../../../utils/output';
import { fakeBinary, fakeTarball, type FakeHostRunner } from './fake-host-runner';
import { fakeHostKey } from './fake-host-keys';

// ---------------------------------------------------------------------------
// Fake download pins (design-05 3.3, 5.1): self-consistent stand-ins for K3S_PIN/HELM_PIN
// ---------------------------------------------------------------------------

const ARCHES: readonly NodeArch[] = ['amd64', 'arm64'];

/** what a "successfully installed" `/usr/local/bin/k3s` looks like: `k3s --version` regex-matches it. */
export const FAKE_K3S_BYTES: Readonly<Record<NodeArch, Buffer>> = Object.fromEntries(ARCHES.map((arch) => [arch, fakeBinary('k3s', K3S_PIN.version)])) as Record<
  NodeArch,
  Buffer
>;

export const FAKE_INSTALL_SCRIPT_BYTES: Buffer = Buffer.from(`#!/bin/sh\n# fake install.sh for ${K3S_PIN.version}\nexit 0\n`, 'utf8');

/** a `.tar.gz` (FakeHostRunner's synthetic tar format) whose `linux-<arch>/helm` member embeds HELM_PIN.version. */
export const FAKE_HELM_ARCHIVE_BYTES: Readonly<Record<NodeArch, Buffer>> = Object.fromEntries(
  ARCHES.map((arch) => [arch, fakeTarball({ [`linux-${arch}/helm`]: `#!/bin/sh\n# fake helm ${HELM_PIN.version}\n` })]),
) as Record<NodeArch, Buffer>;

export interface FakePins {
  k3s: { version: string; binary: { url: string; sha256: string }; installScript: { url: string; sha256: string } };
  helm: { version: string; archive: { url: string; sha256: string } };
}

/**
 * Self-consistent pins for one architecture. The version strings stay the real ones:
 * `finalizeClusterPlan`'s install/upgrade/noop decision (plan.ts) compares the version
 * `k3s --version` reports against the real `K3S_PIN.version`, independently of any download pin,
 * so a "noop" node's installed binary must still claim that exact version text.
 */
export function fakePinsFor(arch: NodeArch): FakePins {
  return {
    k3s: {
      version: K3S_PIN.version,
      binary: { url: `https://fake.invalid/k3s/${arch}`, sha256: sha256Hex(FAKE_K3S_BYTES[arch]) },
      installScript: { url: 'https://fake.invalid/k3s/install.sh', sha256: sha256Hex(FAKE_INSTALL_SCRIPT_BYTES) },
    },
    helm: { version: HELM_PIN.version, archive: { url: `https://fake.invalid/helm/${arch}`, sha256: sha256Hex(FAKE_HELM_ARCHIVE_BYTES[arch]) } },
  };
}

/**
 * Seeds `runner`'s content-addressed cache with every pinned artefact of `fakePinsFor(arch)`, so a
 * fresh `install` never needs a real `curl` call. Does not install the k3s binary itself (a fresh
 * node must not have one yet) nor Helm (installed by `control-plane`, which checks the version
 * first): both happen for real, from this cache, exactly as on a real node.
 */
export function seedFakeDownloadCache(runner: FakeHostRunner, arch: NodeArch): void {
  runner.seedCache(FAKE_K3S_BYTES[arch]);
  runner.seedCache(FAKE_INSTALL_SCRIPT_BYTES);
  runner.seedCache(FAKE_HELM_ARCHIVE_BYTES[arch]);
}

// ---------------------------------------------------------------------------
// Per-node scripting
// ---------------------------------------------------------------------------

export type ScriptedOutcome =
  | { kind: 'timeout' }
  | { kind: 'crash'; exitCode?: number; stderrTail?: string[] }
  /** runs the real `runK3sNodeStep` (pins substituted); the default for `inspect` only */
  | { kind: 'real' }
  /** a plausible successful base, deep-merged with `result` */
  | { kind: 'result'; result: Partial<NodeStepResult> };

export interface FakeSetupNode {
  runner: FakeHostRunner;
  /** default: derived from `runner`'s `uname -m` answer */
  arch?: NodeArch;
  /** the deploy user identity checks (16.3) compare against; must match the plan's `node.deployUser` */
  deployUser?: string;
  /** offered to the host-key verifier when `hostKeys` is configured; default `fakeHostKey(node key)` */
  hostKey?: Buffer;
  /** thrown from `prepareNode` before any host-key check (auth refused, sudo denied, bad arch, ...) */
  prepareFault?: SetupProblem;
  operations?: Partial<Record<NodeOperation, ScriptedOutcome>>;
  /** `execAsDeployUser` answers beyond the identity-check defaults (16.3); return undefined to fall through */
  deploy?: (command: string) => Partial<ExecResult> | undefined;
  /** `execAsRoot` answers beyond the "Ready node" / reset-drain defaults; return undefined to fall through */
  root?: (command: string) => Partial<ExecResult> | undefined;
  clock?: Clock;
}

export interface FakeSetupTransportOptions {
  nodes: Readonly<Record<string, FakeSetupNode>>;
  /** when set, `prepareNode` plays the SSH layer's part and offers each node's key to it (3.5) */
  hostKeys?: HostKeyVerification;
  /** whether the bootstrap identity is password-based (gates `hostKeys.refusalFor`'s password rule) */
  usesPassword?: boolean;
}

export interface RecordedExec {
  node: string;
  kind: 'deploy' | 'root';
  command: string;
}

const DEFAULT_ARCH: NodeArch = 'amd64';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function baseResult(plan: K3sNodePlan): NodeStepResult {
  return {
    schema: 1,
    node: plan.node.key,
    operation: plan.operation,
    status: 'ok',
    steps: [],
    warnings: [],
    error: null,
    inspection: null,
    tokens: null,
    controlPlane: null,
    verification: null,
    reset: null,
  };
}

/** A plausible fully-successful result for `plan.operation`, given what the coordinator reads back. */
function defaultResultFor(plan: K3sNodePlan): NodeStepResult {
  const result = baseResult(plan);
  const cluster = plan.cluster;
  switch (plan.operation) {
    case 'install':
      // the coordinator issues tokens itself only for the bootstrap node of a fresh cluster
      // (index.ts: `server.role === 'server-init' && cluster.fresh`), whatever the cluster size —
      // `cluster.clusterInit` (the *object* field) stays false on a single-server cluster (plan.ts).
      if (plan.node.role === 'server-init' && plan.tokens.server === null) {
        result.tokens = { server: `fake-server-token-${plan.node.key}`, agent: `fake-agent-token-${plan.node.key}` };
      }
      break;
    case 'read-tokens':
      result.tokens = { server: `fake-server-token-${plan.node.key}`, agent: `fake-agent-token-${plan.node.key}` };
      break;
    case 'control-plane':
      result.controlPlane = {
        helmVersion: HELM_PIN.version,
        kubeconfig: 'written',
        encryption: { enabled: true, activeKey: 'XSalsa20-POLY1305 fake-key', hashMatch: true },
        traefikBundled: false,
        storageDefault: { actions: [], defaults: [{ name: K8S_STORAGE_CLASS, createdAt: '2026-01-01T00:00:00Z' }] },
      };
      break;
    case 'finalize': {
      const nodes = cluster?.nodes ?? [{ key: plan.node.key, nodeName: plan.node.nodeName, role: plan.node.role, nodeIp: null, nodeLabels: {} }];
      result.verification = {
        nodes: nodes.map((n) => ({ name: n.nodeName, key: n.key, ready: true, version: cluster?.action.toVersion ?? plan.pins.k3s.version, internalIp: n.nodeIp, roles: [] })),
        expectedNodes: nodes.length,
        readyNodes: nodes.length,
        unknownNodes: [],
        etcdMembers: cluster?.datastore === 'etcd' ? nodes.filter((n) => n.role !== 'agent').length : null,
        components: [],
        storageClass: { present: true, reclaimPolicy: 'Retain', isDefault: true, defaults: [{ name: K8S_STORAGE_CLASS, createdAt: '2026-01-01T00:00:00Z' }], effectiveDefault: true },
        deployer: { serviceAccount: true, binding: true, token: true },
        networkCheck: { ran: nodes.length > 1, ok: true, failures: [] },
        problems: [],
      };
      break;
    }
    case 'reset':
      result.reset = { preserved: { path: null, items: [], bytes: 0 }, removed: ['k3s'], firewallRulesRemoved: 0 };
      break;
    default:
      break;
  }
  return result;
}

function mergeResult(base: NodeStepResult, override: Partial<NodeStepResult>): NodeStepResult {
  return { ...base, ...override };
}

// ---------------------------------------------------------------------------
// The real `runK3sNodeStep` path (inspect, or an explicit `{kind: 'real'}` request)
// ---------------------------------------------------------------------------

function withFakePins(plan: K3sNodePlan, arch: NodeArch): K3sNodePlan {
  const pins = fakePinsFor(arch);
  return {
    ...plan,
    pins: { k3s: { version: pins.k3s.version, binary: pins.k3s.binary, installScript: pins.k3s.installScript }, helm: plan.pins.helm === null ? null : pins.helm },
  };
}

/**
 * `runK3sNodeStep` emits its result through the shared `output.printRaw` (design-05 3.4's protocol
 * is a stdout line, not a return value), so capturing it by spying that one module-level function is
 * inherently process-wide: two nodes' real steps running concurrently — exactly what the
 * coordinator's `forEachLimit(plan.nodes, 4, ...)` does for `inspect` — would otherwise install and
 * restore each other's spy mid-flight and lose output. `runQueue` serializes every real step through
 * this one seam so each capture is exclusive; the coordinator's own concurrency is unaffected (only
 * this in-process bookkeeping is serialized, not the semantics `forEachLimit` exercises).
 */
let runQueue: Promise<unknown> = Promise.resolve();

async function captureRealStep(node: FakeSetupNode, plan: K3sNodePlan, arch: NodeArch): Promise<NodeStepResult> {
  const wire = JSON.stringify(withFakePins(plan, arch));
  const raw = spyOn(output, 'printRaw').mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let line: string | undefined;
  try {
    await runK3sNodeStep(Readable.from([wire]), { runner: node.runner, clock: node.clock ?? systemClock });
    // read call history before mockRestore(), which clears it (unlike a plain implementation swap)
    line = raw.mock.calls.map((call) => String(call[0])).find((entry) => entry.includes('dockflowNodeResult'));
  } finally {
    process.exitCode = previousExitCode;
    raw.mockRestore();
  }
  if (line === undefined) throw new Error(`${plan.node.key}: runK3sNodeStep printed no dockflowNodeResult line (operation ${plan.operation})`);
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed) || !isRecord(parsed.dockflowNodeResult)) throw new Error(`${plan.node.key}: malformed dockflowNodeResult`);
  return parsed.dockflowNodeResult as unknown as NodeStepResult;
}

function runRealStep(node: FakeSetupNode, plan: K3sNodePlan, arch: NodeArch): Promise<NodeStepResult> {
  const turn = runQueue.then(() => captureRealStep(node, plan, arch));
  runQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

// ---------------------------------------------------------------------------
// Default exec answers for the deploy-identity checks (16.3) and root probes (16.1, 18.3)
// ---------------------------------------------------------------------------

function defaultDeployAnswer(deployUser: string, command: string): Partial<ExecResult> {
  if (command === 'whoami') return { stdout: `${deployUser}\n` };
  if (command.startsWith("stat -c '%U %G %a'")) {
    if (command.includes('/etc/rancher/k3s/dockflow')) return { stdout: 'root root 700\n' };
    if (command.endsWith('/config')) return { stdout: `${deployUser} ${deployUser} 600\n` };
    return { stdout: `${deployUser} ${deployUser} 700\n` };
  }
  if (command.includes("auth can-i")) return { stdout: 'yes\n' };
  if (command.includes('get --raw=/readyz')) return { stdout: 'ok\n' };
  // "test ! -r <path>": exit 0 means the path is NOT readable by the deploy user (the secure default)
  if (command.startsWith('test ! -r')) return { exitCode: 0 };
  return { exitCode: 0 };
}

function defaultRootAnswer(command: string): Partial<ExecResult> {
  if (command.startsWith('k3s kubectl get node')) {
    return { stdout: JSON.stringify({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }) };
  }
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// FakeSetupTransport
// ---------------------------------------------------------------------------

export class FakeSetupTransport implements SetupTransport {
  /** `SetupTransportRecorder` shape (support/invariants.ts): every command string, INV-02 checked */
  readonly calls: { command: string }[] = [];
  readonly connections: string[] = [];
  readonly execs: RecordedExec[] = [];
  readonly prepared = new Set<string>();
  cleanupCalls = 0;
  private readonly archByNode = new Map<string, NodeArch>();
  private readonly nodesByKey: Readonly<Record<string, FakeSetupNode>>;
  private readonly hostKeys: HostKeyVerification | undefined;
  private readonly usesPassword: boolean;
  private done = false;

  constructor(options: FakeSetupTransportOptions) {
    this.nodesByKey = options.nodes;
    this.hostKeys = options.hostKeys;
    this.usesPassword = options.usesPassword ?? false;
  }

  /** INV-02 (design-07 3.12): a fake constructed but never checked fails the test like any other. */
  get asserted(): boolean {
    return this.done;
  }

  assertDone(): void {
    this.done = true;
  }

  private record(command: string): void {
    this.calls.push({ command });
  }

  private nodeFor(key: string): FakeSetupNode {
    const node = this.nodesByKey[key];
    if (node === undefined) throw new Error(`FakeSetupTransport: no node configured for ${key}`);
    return node;
  }

  async prepareNode(node: K3sNodeSpec): Promise<void> {
    this.connections.push(node.key);
    this.record(`prepareNode ${node.key}`);
    const testNode = this.nodeFor(node.key);

    if (this.hostKeys !== undefined) {
      const refusal = this.hostKeys.refusalFor(node, { usesPassword: this.usesPassword });
      if (refusal !== null) throw new ConnectionError(refusal.message, refusal.suggestion);
      const verifier = this.hostKeys.verifierFor(node, () => {});
      const offered = testNode.hostKey ?? fakeHostKey(node.key);
      const accepted = await new Promise<boolean>((resolve) => {
        const outcome = verifier(offered, resolve);
        if (outcome !== undefined) resolve(outcome as unknown as boolean);
      });
      if (!accepted) {
        const error = this.hostKeys.takeError();
        throw new ConnectionError(error?.message ?? `Host key of ${node.key} was not accepted`, error?.suggestion ?? '');
      }
    }

    if (testNode.prepareFault !== undefined) {
      throw new ConnectionError(testNode.prepareFault.message, testNode.prepareFault.suggestion);
    }

    const arch = testNode.arch ?? archFromMachine(testNode.runner.machineName) ?? DEFAULT_ARCH;
    this.archByNode.set(node.key, arch);
    this.prepared.add(node.key);
  }

  archOf(node: string): NodeArch {
    const arch = this.archByNode.get(node);
    if (arch === undefined) throw new Error(`FakeSetupTransport: ${node} was never prepared`);
    return arch;
  }

  async runNodeStep(nodeKey: string, plan: K3sNodePlan, _handlers: { onEvent(e: NodeEvent): void }, _guardS: number): Promise<NodeStepOutcome> {
    this.record(`${plan.operation} ${nodeKey}`);
    const testNode = this.nodeFor(nodeKey);
    const scripted = testNode.operations?.[plan.operation];
    if (scripted?.kind === 'timeout') return { kind: 'timeout' };
    if (scripted?.kind === 'crash') return { kind: 'crash', exitCode: scripted.exitCode ?? 1, stderrTail: scripted.stderrTail ?? ['fake crash'] };

    const runsForReal = scripted?.kind === 'real' || (scripted === undefined && plan.operation === 'inspect');
    const result = runsForReal
      ? await runRealStep(testNode, plan, this.archOf(nodeKey))
      : mergeResult(defaultResultFor(plan), scripted?.kind === 'result' ? scripted.result : {});
    return { kind: 'result', result: result as unknown as Record<string, unknown> };
  }

  async execAsDeployUser(nodeKey: string, command: string, _guardS: number): Promise<ExecResult> {
    this.execs.push({ node: nodeKey, kind: 'deploy', command });
    this.record(`deploy@${nodeKey}: ${command}`);
    const testNode = this.nodeFor(nodeKey);
    const override = testNode.deploy?.(command);
    const answer = override ?? defaultDeployAnswer(testNode.deployUser ?? 'dockflow', command);
    return { exitCode: 0, stdout: '', stderr: '', ...answer };
  }

  async execAsRoot(nodeKey: string, command: string, _guardS: number): Promise<ExecResult> {
    this.execs.push({ node: nodeKey, kind: 'root', command });
    this.record(`root@${nodeKey}: ${command}`);
    const testNode = this.nodeFor(nodeKey);
    const override = testNode.root?.(command);
    const answer = override ?? defaultRootAnswer(command);
    return { exitCode: 0, stdout: '', stderr: '', ...answer };
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
}
