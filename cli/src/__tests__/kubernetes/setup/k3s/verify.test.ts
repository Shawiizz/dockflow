import { afterEach, describe, expect, it } from 'bun:test';
import type { Deployment } from '../../../../services/orchestrator/kubernetes/resources/apps';
import type { Node } from '../../../../services/orchestrator/kubernetes/resources/core';
import type { StorageClass } from '../../../../services/orchestrator/kubernetes/resources/storage';
import { Redactor } from '../../../../utils/redact';
import { FakeCluster, type KubeObject } from '../../fakes/fake-cluster';
import { FakeKubeExecutor, fakeNode, REST } from '../../fakes/fake-kube-executor';
import { assertExecutorInvariants } from '../../support/invariants';
import { chooseFirewallTool } from '../../../../commands/setup/k3s/firewall';
import {
  applyNetcheckDaemonSet,
  type ConnectOutcome,
  type DeployIdentityProbe,
  evaluateComponentsList,
  evaluateDeployerObjects,
  evaluateDeployIdentityChecks,
  evaluateEncryptionAcrossServers,
  evaluateEncryptionStatus,
  evaluateEtcdMembers,
  evaluateNodeReadiness,
  evaluateStorageClasses,
  evaluateTraefikAbsence,
  type ExposureProbeNode,
  netcheckDaemonSet,
  netcheckPlan,
  removeNetcheckDaemonSet,
  runExposureProbe,
} from '../../../../commands/setup/k3s/verify';

const KEY = 'server_1';
const ENV = 'production';
const redactor = new Redactor(['not-a-real-secret-value']);
let kubes: FakeKubeExecutor[] = [];

function kubeFor(cluster: FakeCluster): FakeKubeExecutor {
  const executor = new FakeKubeExecutor({ node: fakeNode(KEY), cluster, redactor, order: 'any' });
  kubes.push(executor);
  return executor;
}

afterEach(() => {
  const kube = kubes;
  kubes = [];
  for (const executor of kube) executor.assertDone();
  assertExecutorInvariants({ kube, redactor });
});

function node(overrides: Partial<Node> = {}): Node {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name: 'srv-1', labels: { 'node-role.kubernetes.io/control-plane': 'true' } },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      addresses: [{ type: 'InternalIP', address: '10.0.0.10' }],
      nodeInfo: { kubeletVersion: 'v1.36.4+k3s1' },
    },
    ...overrides,
  };
}

function expectation(overrides: Partial<Parameters<typeof evaluateNodeReadiness>[1]> = {}): Parameters<typeof evaluateNodeReadiness>[1] {
  return {
    key: 'server_1',
    name: 'srv-1',
    kubeletVersion: 'v1.36.4+k3s1',
    nodeIp: '10.0.0.10',
    nodeExternalIp: null,
    controlPlane: true,
    etcdMember: false,
    timeoutS: 180,
    ...overrides,
  };
}

describe('evaluateNodeReadiness (16.1, V1, V2)', () => {
  it('V1 every check passing -> null', () => {
    expect(evaluateNodeReadiness(node(), expectation())).toBeNull();
  });

  it('V2 missing node', () => {
    const problem = evaluateNodeReadiness(undefined, expectation());
    expect(problem?.message).toBe('server_1 did not register as node srv-1 within 180s');
  });

  it('V2 NotReady node', () => {
    const problem = evaluateNodeReadiness(node({ status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'PLEG is not healthy' }] } }), expectation());
    expect(problem?.message).toBe('Node srv-1 is registered but not Ready: KubeletNotReady: PLEG is not healthy');
  });

  it('V2 wrong kubelet version', () => {
    const problem = evaluateNodeReadiness(node({ status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.35.8+k3s1' } } }), expectation());
    expect(problem?.message).toBe('Node srv-1 runs v1.35.8+k3s1, expected v1.36.4+k3s1');
  });

  it('V2 wrong InternalIP', () => {
    const problem = evaluateNodeReadiness(
      node({ status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.36.4+k3s1' }, addresses: [{ type: 'InternalIP', address: '10.0.0.99' }] } }),
      expectation(),
    );
    expect(problem?.message).toBe('Node srv-1 registered with InternalIP 10.0.0.99, expected 10.0.0.10 (private_host)');
  });

  it('missing the control-plane label', () => {
    const problem = evaluateNodeReadiness(node({ metadata: { name: 'srv-1', labels: {} } }), expectation());
    expect(problem?.message).toBe('Node srv-1 is missing the node-role.kubernetes.io/control-plane label');
  });
});

describe('evaluateEncryptionStatus (section 9, V6)', () => {
  it('secretbox enabled and in sync -> no problem', () => {
    const { problem } = evaluateEncryptionStatus(JSON.stringify({ enable: true, activekey: 'XSalsa20-POLY1305 key', hashmatch: true }), KEY);
    expect(problem).toBeNull();
  });

  it('aescbc -> error', () => {
    const { problem } = evaluateEncryptionStatus(JSON.stringify({ enable: true, activekey: 'AES-CBC key', hashmatch: true }), KEY);
    expect(problem?.message).toBe(`Secrets encryption is not active on ${KEY} (active key is AES-CBC key)`);
  });

  it('hashmatch absent -> error', () => {
    const { problem } = evaluateEncryptionStatus(JSON.stringify({ enable: true, activekey: 'XSalsa20-POLY1305 key' }), KEY);
    expect(problem?.message).toBe(`Secrets encryption is not active on ${KEY} (keys are out of sync across servers)`);
  });

  it('"Disabled, no configuration file found" text -> error', () => {
    const { problem } = evaluateEncryptionStatus('Disabled, no configuration file found', KEY);
    expect(problem?.message).toBe(`Secrets encryption is not active on ${KEY} (Disabled, no configuration file found)`);
  });

  it('a three-server fixture where one reports hashmatch: false -> error naming that server', () => {
    const good = { enabled: true, activeKey: 'XSalsa20-POLY1305 key', hashMatch: true };
    const bad = { enabled: true, activeKey: 'XSalsa20-POLY1305 key', hashMatch: false };
    const problem = evaluateEncryptionAcrossServers([
      { key: 'server_1', status: good },
      { key: 'server_2', status: bad },
      { key: 'server_3', status: good },
    ]);
    expect(problem?.message).toContain('server_2');
  });
});

describe('evaluateEtcdMembers (16.2, V3)', () => {
  it('V3 etcd member count mismatch -> error naming both counts', () => {
    const problem = evaluateEtcdMembers(2, 3, ENV);
    expect(problem?.message).toBe(`2 etcd members were found on ${ENV}, expected 3`);
  });

  it('count equal to the expected HA server count -> no problem', () => {
    expect(evaluateEtcdMembers(3, 3, ENV)).toBeNull();
  });

  it('outside HA (expected 0) -> never checked, whatever the count', () => {
    expect(evaluateEtcdMembers(0, 0, ENV)).toBeNull();
    expect(evaluateEtcdMembers(1, 0, ENV)).toBeNull();
  });
});

describe('evaluateComponentsList (16.2, V4)', () => {
  function deployment(name: string, overrides: Partial<Deployment> = {}): Deployment {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, generation: 1 },
      spec: { replicas: 1, selector: { matchLabels: {} }, template: { metadata: {}, spec: { containers: [] } } },
      status: { availableReplicas: 1, observedGeneration: 1 },
      ...overrides,
    };
  }

  it('CoreDNS unavailable -> required, not ready', () => {
    const list = evaluateComponentsList([deployment('coredns', { status: { availableReplicas: 0, observedGeneration: 1 } }), deployment('local-path-provisioner')]);
    const coredns = list.find((c) => c.name === 'coredns');
    expect(coredns?.ready).toBe(false);
    expect(coredns?.required).toBe(true);
  });

  it('metrics-server unavailable -> not required', () => {
    const list = evaluateComponentsList([deployment('coredns'), deployment('local-path-provisioner')]);
    const metrics = list.find((c) => c.name === 'metrics-server');
    expect(metrics?.ready).toBe(false);
    expect(metrics?.required).toBe(false);
    expect(metrics?.detail).toBe('not found');
  });
});

describe('evaluateTraefikAbsence (10.1, V5)', () => {
  // helmcharts.helm.cattle.io is a k3s-bundled CRD FakeCluster does not model generically, so this
  // reads through a scripted executor instead of cluster mode.
  function scriptedTraefikKube(helmCharts: { metadata: { name: string } }[], deployments: { metadata: { name: string } }[]): FakeKubeExecutor {
    const executor = new FakeKubeExecutor({
      node: fakeNode(KEY),
      redactor,
      script: [
        { args: ['get', 'helmcharts.helm.cattle.io', REST], respond: { json: { items: helmCharts } } },
        { args: ['get', 'deployments.apps', REST], respond: { json: { items: deployments } } },
      ],
    });
    kubes.push(executor);
    return executor;
  }

  it('a bundled traefik HelmChart is an error', async () => {
    const kube = scriptedTraefikKube([{ metadata: { name: 'traefik' } }, { metadata: { name: 'traefik-crd' } }], []);
    const problem = await evaluateTraefikAbsence(kube, ENV);
    expect(problem?.message).toBe(`The bundled Traefik is present on ${ENV}`);
  });

  it('absent -> null', async () => {
    const kube = scriptedTraefikKube([], []);
    expect(await evaluateTraefikAbsence(kube, ENV)).toBeNull();
  });

  it('a traefik Deployment without the HelmCharts is still an error', async () => {
    const kube = scriptedTraefikKube([], [{ metadata: { name: 'traefik' } }]);
    expect((await evaluateTraefikAbsence(kube, ENV))?.message).toBe(`The bundled Traefik is present on ${ENV}`);
  });
});

describe('netcheck DaemonSet and ring plan (16.4, V7)', () => {
  it('the manifest golden carries the hardened security context and the /www emptyDir', () => {
    const manifest = netcheckDaemonSet();
    const pod = manifest.spec.template.spec;
    expect((pod.securityContext as { runAsNonRoot?: boolean })?.runAsNonRoot).toBe(true);
    expect(pod.containers[0].securityContext?.readOnlyRootFilesystem).toBe(true);
    expect((pod.containers[0].securityContext as { seccompProfile?: { type: string } })?.seccompProfile?.type).toBe('RuntimeDefault');
    expect(pod.volumes?.[0]).toEqual({ name: 'www', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
  });

  it('ring plan for 1 node: only a self-check and one DNS lookup', () => {
    expect(netcheckPlan(1)).toEqual([
      { podIndex: 0, kind: 'wget-ring', targetIndex: 0 },
      { podIndex: 0, kind: 'nslookup' },
    ]);
  });

  it('ring plan for 2 nodes: the ring already reaches the first server both ways', () => {
    const plan = netcheckPlan(2);
    expect(plan.filter((s) => s.kind === 'wget-first')).toHaveLength(0);
    expect(plan.filter((s) => s.kind === 'wget-ring')).toHaveLength(2);
  });

  it('ring plan for 5 nodes: every non-first pod also checks the first server directly', () => {
    const plan = netcheckPlan(5);
    const firstChecks = plan.filter((s) => s.kind === 'wget-first');
    expect(firstChecks.map((s) => s.podIndex)).toEqual([1, 2, 3]);
  });

  it('finalize removes a pre-existing DaemonSet before applying a fresh one', async () => {
    const cluster = new FakeCluster();
    cluster.seed(netcheckDaemonSet() as unknown as KubeObject);
    const removeExecutor = kubeFor(cluster);
    expect(await removeNetcheckDaemonSet(removeExecutor)).toBe('removed');
    expect(cluster.get('DaemonSet', 'dockflow-netcheck', 'dockflow-system')).toBeUndefined();

    const applyExecutor = kubeFor(cluster);
    await applyNetcheckDaemonSet(applyExecutor);
    expect(cluster.get('DaemonSet', 'dockflow-netcheck', 'dockflow-system')).toBeDefined();

    const secondRemove = kubeFor(cluster);
    expect(await removeNetcheckDaemonSet(secondRemove)).toBe('removed');

    const alreadyAbsent = kubeFor(cluster);
    expect(await removeNetcheckDaemonSet(alreadyAbsent)).toBe('absent');
  });
});

describe('evaluateStorageClasses (16.2, V9)', () => {
  function sc(name: string, isDefault: boolean, reclaimPolicy: 'Retain' | 'Delete' = 'Retain', createdAt = '2026-01-01T00:00:00Z'): StorageClass {
    return {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name, creationTimestamp: createdAt, annotations: { 'storageclass.kubernetes.io/is-default-class': String(isDefault) } },
      provisioner: 'rancher.io/local-path',
      reclaimPolicy,
    };
  }

  it('dockflow-local alone default -> effectively default', () => {
    const { problem, storageClass } = evaluateStorageClasses([sc('dockflow-local', true), sc('local-path', false, 'Delete', '2025-01-01T00:00:00Z')], ENV);
    expect(problem).toBeNull();
    expect(storageClass.effectiveDefault).toBe(true);
  });

  it('local-path still default -> error naming it and its reclaim policy', () => {
    const { problem } = evaluateStorageClasses([sc('dockflow-local', true), sc('local-path', true, 'Delete')], ENV);
    expect(problem?.message).toBe(`StorageClass local-path on ${ENV} is also marked default, so a chart volume without storageClass could bind to it instead of dockflow-local (local-path reclaimPolicy Delete)`);
  });

  it('a foreign default -> error naming it', () => {
    const { problem } = evaluateStorageClasses([sc('dockflow-local', true), sc('fast-ssd', true, 'Delete')], ENV);
    expect(problem?.message).toContain('fast-ssd');
  });

  it('local-path newer than dockflow-local -> error', () => {
    const { problem } = evaluateStorageClasses(
      [sc('dockflow-local', true, 'Retain', '2026-01-01T00:00:00Z'), sc('local-path', false, 'Delete', '2026-02-01T00:00:00Z')],
      ENV,
    );
    expect(problem?.message).toContain('local-path');
    expect(problem?.message).toContain('created after dockflow-local');
  });
});

describe('evaluateDeployerObjects (12.1, V11)', () => {
  it('a ServiceAccount listing the token Secret in .secrets is warned, with the fix', async () => {
    const cluster = new FakeCluster();
    cluster.seed({
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: 'dockflow-deployer', namespace: 'dockflow-system' },
      secrets: [{ name: 'dockflow-deployer-token' }],
    });
    cluster.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dockflow-deployer-token', namespace: 'dockflow-system' },
      type: 'kubernetes.io/service-account-token',
      data: { token: Buffer.from('token-value').toString('base64') },
    });
    cluster.seed({
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: 'dockflow-deployer' },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
    });
    const kube = kubeFor(cluster);
    const result = await evaluateDeployerObjects(kube);
    expect(result.summary).toEqual({ serviceAccount: true, binding: true, token: true });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].severity).toBe('warning');
    expect(result.problems[0].suggestion).toContain('kubectl edit serviceaccount');
  });
});

describe('evaluateDeployIdentityChecks (16.3, V8)', () => {
  function probe(overrides: Partial<DeployIdentityProbe> = {}): DeployIdentityProbe {
    return {
      key: KEY,
      deployUser: 'dockflow',
      server: true,
      sudoUser: true,
      whoami: 'dockflow',
      kubeconfigStat: { owner: 'dockflow', group: 'dockflow', mode: '600' },
      kubeconfigDirStat: { owner: 'dockflow', group: 'dockflow', mode: '700' },
      tokenDirStat: { owner: 'root', group: 'root', mode: '700' },
      authCanI: 'yes',
      readyz: 'ok',
      adminKubeconfigUnreadable: true,
      helmVersion: 'v4.3.0',
      expectedHelmVersion: 'v4.3.0',
      sudoImagesOk: true,
      tokenFileUnreadable: true,
      ...overrides,
    };
  }

  it('every row passing -> no problems', () => {
    expect(evaluateDeployIdentityChecks(probe())).toEqual([]);
  });

  it('wrong login user', () => {
    expect(evaluateDeployIdentityChecks(probe({ whoami: 'someone-else' }))[0].message).toBe(`The deploy key does not log in as dockflow on ${KEY}`);
  });

  it('kubeconfig directory not 0700 (the new stat row)', () => {
    const problems = evaluateDeployIdentityChecks(probe({ kubeconfigDirStat: { owner: 'dockflow', group: 'dockflow', mode: '755' } }));
    expect(problems.some((p) => p.message.includes('kubeconfig directory'))).toBe(true);
  });

  it('token directory not root:root 0700 (the new stat row)', () => {
    const problems = evaluateDeployIdentityChecks(probe({ tokenDirStat: { owner: 'dockflow', group: 'dockflow', mode: '700' } }));
    expect(problems.some((p) => p.message.includes('token directory'))).toBe(true);
  });

  it('the deploy identity cannot administer the cluster', () => {
    expect(evaluateDeployIdentityChecks(probe({ authCanI: 'no' }))[0].message).toContain('cannot administer the cluster');
  });

  it('admin kubeconfig readable by the deploy user', () => {
    const problems = evaluateDeployIdentityChecks(probe({ adminKubeconfigUnreadable: false }));
    expect(problems.some((p) => p.message.includes('admin kubeconfig'))).toBe(true);
  });

  it('token file readable by the deploy user', () => {
    const problems = evaluateDeployIdentityChecks(probe({ tokenFileUnreadable: false }));
    expect(problems.some((p) => p.message.includes('token file'))).toBe(true);
  });

  it('sudo rules missing', () => {
    const problems = evaluateDeployIdentityChecks(probe({ sudoImagesOk: false }));
    expect(problems.some((p) => p.message.includes('sudo rules'))).toBe(true);
  });

  it('Helm version mismatch', () => {
    const problems = evaluateDeployIdentityChecks(probe({ helmVersion: 'v4.2.0' }));
    expect(problems.some((p) => p.message.includes('Helm'))).toBe(true);
  });
});

describe('runExposureProbe (16.5, V10)', () => {
  function connectProbeOf(outcomes: Record<string, ConnectOutcome>): (host: string, port: number) => Promise<ConnectOutcome> {
    return async (host, port) => outcomes[`${host}:${port}`] ?? 'refused';
  }

  it('a connect success warns, naming the port and node', async () => {
    const probes = await runExposureProbe(
      [{ key: KEY, addr: '203.0.113.10', role: 'server', etcdMember: false }],
      connectProbeOf({ '203.0.113.10:6443': 'open' }),
      { env: ENV, isPrivate: () => false },
    );
    expect(probes).toHaveLength(1);
    expect(probes[0].message).toBe(`The Kubernetes API of ${KEY} answers on 203.0.113.10:6443 from outside the cluster`);
  });

  it('refused or timeout is silent', async () => {
    const probes = await runExposureProbe(
      [{ key: KEY, addr: '203.0.113.10', role: 'server', etcdMember: false }],
      connectProbeOf({}),
      { env: ENV, isPrivate: () => false },
    );
    expect(probes).toEqual([]);
  });

  it('EPERM logs a debug line and warns nothing', async () => {
    const debugLines: string[] = [];
    const probes = await runExposureProbe(
      [{ key: KEY, addr: '203.0.113.10', role: 'server', etcdMember: false }],
      connectProbeOf({ '203.0.113.10:6443': 'eperm' }),
      { env: ENV, isPrivate: () => false, onDebug: (line) => debugLines.push(line) },
    );
    expect(probes).toEqual([]);
    expect(debugLines).toHaveLength(1);
  });

  it('a private address is never probed', async () => {
    let called = false;
    const probes = await runExposureProbe(
      [{ key: KEY, addr: '10.0.0.10', role: 'server', etcdMember: false }],
      async () => {
        called = true;
        return 'open';
      },
      { env: ENV, isPrivate: () => true },
    );
    expect(probes).toEqual([]);
    expect(called).toBe(false);
  });

  it('agents are never probed for the API or etcd, only kubelet', async () => {
    const probes = await runExposureProbe(
      [{ key: 'agent_1', addr: '203.0.113.20', role: 'agent', etcdMember: false }],
      connectProbeOf({ '203.0.113.20:6443': 'open', '203.0.113.20:10250': 'open' }),
      { env: ENV, isPrivate: () => false },
    );
    expect(probes).toHaveLength(1);
    expect(probes[0].message).toContain('kubelet');
  });

  it('V10 a node whose ufw is installed but inactive is probed, a node with an active tool is not (16.5 gate)', async () => {
    // the 16.5 pseudocode: `for node in plan.nodes where chooseFirewallTool(inspection[node]) == null`
    const candidates: (ExposureProbeNode & { firewall: { ufw: 'active' | 'inactive'; firewalld: 'absent' } })[] = [
      { key: 'server_1', addr: '203.0.113.10', role: 'server', etcdMember: false, firewall: { ufw: 'inactive', firewalld: 'absent' } },
      { key: 'server_2', addr: '203.0.113.20', role: 'server', etcdMember: false, firewall: { ufw: 'active', firewalld: 'absent' } },
    ];
    const unmanaged = candidates.filter((node) => {
      const chosen = chooseFirewallTool(node.firewall, { skipFirewall: false, key: node.key });
      return chosen.success && chosen.data === null;
    });
    expect(unmanaged.map((n) => n.key)).toEqual(['server_1']);

    const probes = await runExposureProbe(
      unmanaged,
      connectProbeOf({ '203.0.113.10:6443': 'open', '203.0.113.20:6443': 'open' }),
      { env: ENV, isPrivate: () => false },
    );
    expect(probes).toHaveLength(1);
    expect(probes[0].message).toContain('server_1');
  });
});
