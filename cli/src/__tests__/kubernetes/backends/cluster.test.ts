// KubernetesClusterBackend (design-03 5.3, 19.1): probe, preflight, nodes, serverVersion.

import { afterEach, describe, expect, it } from 'bun:test';
import type { ClusterNodeRef, OrchestratorTarget } from '../../../services/orchestrator/interfaces';
import { compareKubeVersions, KubernetesClusterBackend } from '../../../services/orchestrator/kubernetes/backends/cluster';
import { createSharedMemo, systemClock, type SharedMemo } from '../../../services/orchestrator/kubernetes/deps';
import { K3S_PIN } from '../../../services/orchestrator/kubernetes/k3s/versions';
import type { KubeExecutor } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { DeployError, OrchestratorUnavailableError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeCluster } from '../fakes/fake-cluster';
import { fakeNode, FakeKubeExecutor, type KubeStep } from '../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../support/invariants';

const redactor = new Redactor([]);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  kube: FakeKubeExecutor;
  cluster: FakeCluster | null;
}

let harnesses: Harness[] = [];

afterEach(() => {
  const current = harnesses;
  harnesses = [];
  for (const { kube, cluster } of current) {
    kube.assertDone();
    assertExecutorInvariants({ kube, redactor });
    cluster?.assertNoProblems();
  }
});

function onCluster(options: { nodes?: readonly string[]; serverVersion?: string; systemNamespace?: boolean; traefikCrds?: boolean; storageClasses?: boolean } = {}): {
  cluster: FakeCluster;
  kube: FakeKubeExecutor;
} {
  const cluster = new FakeCluster(options);
  const kube = new FakeKubeExecutor({ redactor, cluster });
  harnesses.push({ kube, cluster });
  return { cluster, kube };
}

function scripted(script: KubeStep[], node?: ClusterNodeRef): FakeKubeExecutor {
  const kube = new FakeKubeExecutor({ redactor, script, node });
  harnesses.push({ kube, cluster: null });
  return kube;
}

const TARGET: Pick<OrchestratorTarget, 'env' | 'managers' | 'workers'> = {
  env: 'production',
  managers: [fakeNode('server_1')],
  workers: [fakeNode('agent_1')],
};

function backendOf(
  kubectl: FakeKubeExecutor,
  options: { memo?: SharedMemo; target?: Pick<OrchestratorTarget, 'env' | 'managers' | 'workers'>; executorFor?: (node: ClusterNodeRef) => KubeExecutor } = {},
): KubernetesClusterBackend {
  return new KubernetesClusterBackend(
    { kubectl, distribution: kubectl.distribution, redactor, clock: systemClock },
    options.memo ?? createSharedMemo(),
    options.target ?? TARGET,
    options.executorFor ? { executorFor: options.executorFor } : {},
  );
}

// ---------------------------------------------------------------------------
// compareKubeVersions
// ---------------------------------------------------------------------------

describe('compareKubeVersions', () => {
  it('compares major.minor.patch, ignoring build metadata', () => {
    expect(compareKubeVersions('v1.34.0', 'v1.34.0')).toBe(0);
    expect(compareKubeVersions('v1.36.4+k3s1', 'v1.36.4+k3s2')).toBe(0);
    expect(compareKubeVersions('v1.33.9+k3s1', 'v1.34.0')).toBeLessThan(0);
    expect(compareKubeVersions('v1.35.0', 'v1.34.9')).toBeGreaterThan(0);
    expect(compareKubeVersions('v1.34.1', 'v1.34.0')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

describe('probe', () => {
  it('ready: exit 0 and body ok', async () => {
    const { kube } = onCluster();
    const backend = backendOf(kube);
    const probe = await backend.probe(fakeNode('server_1'));
    expect(probe).toEqual({ node: 'server_1', status: 'ready' });
  });

  it('unready: the API answers but readyz fails (etcd quorum lost)', async () => {
    const { cluster, kube } = onCluster();
    cluster.apiReady = false;
    const backend = backendOf(kube);
    const probe = await backend.probe(fakeNode('server_1'));
    expect(probe.status).toBe('unready');
    expect(probe.detail).toContain('etcd');
  });

  it('unreachable: SSH/kubeconfig failures map to a short detail', async () => {
    const executor = scripted([{ id: 'K45', args: ['get', '--raw=/readyz'], respond: { error: 'Unreachable' } }]);
    const backend = backendOf(executor);
    const probe = await backend.probe(executor.node);
    expect(probe).toEqual({ node: executor.node.name, status: 'unreachable', detail: 'API not answering' });
  });

  it('unreachable: a lost transport never throws', async () => {
    const executor = scripted([{ id: 'K45', args: ['get', '--raw=/readyz'], respond: { transportError: true } }]);
    const backend = backendOf(executor);
    const probe = await backend.probe(executor.node);
    expect(probe.status).toBe('unreachable');
  });

  it('probes an arbitrary node through the injected executor factory, not the bound control-plane one', async () => {
    const controlPlane = scripted([], fakeNode('server_1'));
    const other = scripted([{ id: 'K45', args: ['get', '--raw=/readyz'], respond: { exitCode: 0, stdout: 'ok', stderr: '' } }], fakeNode('server_2'));
    const backend = backendOf(controlPlane, {
      executorFor: (node) => (node.name === 'server_2' ? other : controlPlane),
    });
    const probe = await backend.probe(fakeNode('server_2'));
    expect(probe).toEqual({ node: 'server_2', status: 'ready' });
    expect(controlPlane.calls).toHaveLength(0); // the control-plane executor was never touched
  });
});

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

describe('preflight', () => {
  it('refuses a server older than the minimum', async () => {
    const { kube } = onCluster({ serverVersion: 'v1.33.9+k3s1' });
    const backend = backendOf(kube);
    await expect(backend.preflight({ routes: false, volumes: false, helm: false })).rejects.toMatchObject({
      message: expect.stringContaining('is older than'),
    });
  });

  it('refuses a missing dockflow-system namespace', async () => {
    const { kube } = onCluster({ systemNamespace: false });
    const backend = backendOf(kube);
    const error = await backend.preflight({ routes: false, volumes: false, helm: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrchestratorUnavailableError);
    expect((error as Error).message).toContain('dockflow-system is missing');
  });

  it('refuses missing Traefik CRDs when routes are needed', async () => {
    const { kube } = onCluster({ traefikCrds: false });
    const backend = backendOf(kube);
    await expect(backend.preflight({ routes: true, volumes: false, helm: false })).rejects.toBeInstanceOf(DeployError);
  });

  it('does not check CRDs when routes are not needed', async () => {
    const { kube } = onCluster({ traefikCrds: false });
    const backend = backendOf(kube);
    await backend.preflight({ routes: false, volumes: false, helm: false });
  });

  it('refuses a missing default storage class when volumes are needed', async () => {
    const { kube } = onCluster({ storageClasses: false });
    const backend = backendOf(kube);
    await expect(backend.preflight({ routes: false, volumes: true, helm: false })).rejects.toBeInstanceOf(DeployError);
  });

  it('passes on a healthy cluster and memoizes per need-set', async () => {
    const { kube } = onCluster();
    const memo = createSharedMemo();
    const backend = backendOf(kube, { memo });
    await backend.preflight({ routes: true, volumes: true, helm: false });
    const versionCallsAfterFirst = kube.calls.filter((call) => call.call.args[0] === 'version').length;
    await backend.preflight({ routes: true, volumes: true, helm: false });
    const versionCallsAfterSecond = kube.calls.filter((call) => call.call.args[0] === 'version').length;
    expect(versionCallsAfterSecond).toBe(versionCallsAfterFirst); // memoized: no repeated server-version read
  });

  it('re-checks for a different need-set', async () => {
    const { kube } = onCluster({ traefikCrds: false });
    const memo = createSharedMemo();
    const backend = backendOf(kube, { memo });
    await backend.preflight({ routes: false, volumes: false, helm: false });
    await expect(backend.preflight({ routes: true, volumes: false, helm: false })).rejects.toBeInstanceOf(DeployError);
  });
});

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

describe('nodes', () => {
  it('maps native node names back to servers.yml keys and reports role/pressure/version', async () => {
    const { kube } = onCluster();
    const backend = backendOf(kube);
    const nodes = await backend.nodes();
    const server = nodes.find((n) => n.name === 'server-1');
    const agent = nodes.find((n) => n.name === 'agent-1');
    expect(server).toMatchObject({ server: 'server_1', role: 'manager', ready: true, schedulable: true });
    expect(agent).toMatchObject({ server: 'agent_1', role: 'worker', ready: true, schedulable: true });
    expect(server?.version).toBe(K3S_PIN.version);
    expect(server?.internalIp).toBeTruthy();
    expect(server?.pressure).toEqual([]);
  });

  it('reports an unmappable node as server: null', async () => {
    const { kube } = onCluster({ nodes: ['server-9'] });
    const backend = backendOf(kube, { target: { env: 'production', managers: [fakeNode('server_1')], workers: [] } });
    const nodes = await backend.nodes();
    expect(nodes[0]?.server).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// serverVersion
// ---------------------------------------------------------------------------

describe('serverVersion', () => {
  it('reads serverVersion.gitVersion from version -o json', async () => {
    const { kube } = onCluster();
    const backend = backendOf(kube);
    expect(await backend.serverVersion()).toBe(K3S_PIN.version);
  });
});
