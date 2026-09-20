// Orchestrator bundle factory (DESIGN-CORE 6.4; design-07 2.5 U-FACTORY-01): `orchestrator` absent
// builds the Swarm bundle, `k3s` builds the Kubernetes bundle around `k3sDistribution`, every bundle
// carries the capabilities row of its kind, and one bundle shares its kubectl/helm executors across
// every backend that needs them (never one executor per backend).

import { describe, expect, it } from 'bun:test';
import { capabilitiesFor } from '../../../services/orchestrator/capabilities';
import { createOrchestrator } from '../../../services/orchestrator/factory';
import { createKubernetesOrchestrator } from '../../../services/orchestrator/kubernetes/index';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../../../services/orchestrator/kubernetes/naming';
import { swarmScope } from '../../../services/orchestrator/swarm/swarm-naming';
import { Redactor } from '../../../utils/redact';
import { config, stackRef, target } from '../support/builders';
import { FakeClock } from '../fakes/fake-clock';
import { FakeCluster } from '../fakes/fake-cluster';
import { FakeKubeExecutor } from '../fakes/fake-kube-executor';
import { FakeHelmExecutor } from '../fakes/fake-helm-executor';
import { FakeNodeShell } from '../fakes/fake-node-shell';

const APP_REF = stackRef({ project: 'shop', env: 'production', role: 'app' });

describe('createOrchestrator (U-FACTORY-01)', () => {
  it('orchestrator absent builds a Swarm bundle', () => {
    const t = target('server_1', { kind: 'swarm' });
    const orchestrator = createOrchestrator(t, config({ orchestrator: undefined }));

    expect(orchestrator.kind).toBe('swarm');
    expect(orchestrator.capabilities).toEqual(capabilitiesFor('swarm'));
    expect(orchestrator.helm).toBeNull();
    expect(orchestrator.volumes).not.toBeNull();
    expect(orchestrator.naming.scope(APP_REF)).toBe(swarmScope(APP_REF));
  });

  it('k3s builds a Kubernetes bundle around k3sDistribution', () => {
    const t = target('server_1', { kind: 'k3s' });
    const orchestrator = createOrchestrator(t, config({ orchestrator: 'k3s' }));

    expect(orchestrator.kind).toBe('k3s');
    expect(orchestrator.capabilities).toEqual(capabilitiesFor('k3s'));
    expect(orchestrator.helm).not.toBeNull();
    expect(orchestrator.volumes).not.toBeNull();
    // the naming projection is namespace-shaped, which only a k3sDistribution-backed bundle produces
    expect(orchestrator.naming.scope(APP_REF)).toBe(namespaceFor('shop', 'production'));
    expect(orchestrator.naming.describe({ ...APP_REF, role: 'accessory' })).toBe(
      `namespace ${namespaceFor('shop', 'production')} (accessories)`,
    );
  });

  it('returns a capabilities object matching the kind table, not a shared mutable one', () => {
    const swarm = createOrchestrator(target('server_1', { kind: 'swarm' }), config({ orchestrator: undefined }));
    const k3s = createOrchestrator(target('server_1', { kind: 'k3s' }), config({ orchestrator: 'k3s' }));
    expect(swarm.capabilities).not.toBe(k3s.capabilities);
    expect(swarm.capabilities.artifactFormat).toBe('swarm-compose/1');
    expect(k3s.capabilities.artifactFormat).toBe('k8s-manifests/1');
  });
});

describe('createKubernetesOrchestrator: one shared executor per bundle', () => {
  it('every backend that talks kubectl/helm routes through the injected executors', async () => {
    const redactor = new Redactor();
    const clock = new FakeClock();
    const t = target('server_1', { kind: 'k3s' });
    const cluster = new FakeCluster({ clock });
    const kube = new FakeKubeExecutor({ redactor, clock, cluster, node: t.controlPlane });
    const nodeShell = new FakeNodeShell([], { redactor });
    const helmExec = new FakeHelmExecutor({ redactor, node: t.controlPlane, nodeShell, clock });

    const orchestrator = createKubernetesOrchestrator(t, config({ orchestrator: 'k3s' }), k3sDistribution, {
      kubectl: kube,
      helm: helmExec,
      nodeShell: nodeShell.forNode,
      clock,
    });

    // cluster.nodes() (kubectl) and helm.listAll() (helm) sit on different backend instances; both
    // recording on the ONE injected fake proves the bundle shares its executors instead of building
    // a fresh one per backend.
    await orchestrator.cluster.nodes();
    if (orchestrator.helm === null) throw new Error('expected a Helm backend on k3s');
    await orchestrator.helm.listAll(namespaceFor(t.project, t.env));

    expect(kube.calls.length).toBeGreaterThan(0);
    expect(kube.calls.every((call) => call.call.args[0] !== undefined)).toBe(true);
    expect(helmExec.calls.length).toBeGreaterThan(0);
  });
});
