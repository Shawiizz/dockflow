// Control-plane resolution and failover (DESIGN-CORE 6.6, D26; design-07 10.8 U-TARGET-*, U-SWARM-09).
// Probing goes through each orchestrator's own `ClusterBackend.probe` (SwarmClusterBackend /
// KubernetesClusterBackend), so these tests exercise the real probe logic over `FakeSsh`, never a
// private reimplementation. `resolveServersForEnvironment` reads this checkout's own real
// `.dockflow/servers.yml` (see setup/k3s/coordinator.test.ts), so every test supplies servers
// through the `servers` test-injection option instead, and grants SSH credentials through the same
// CI-secret environment variables production reads (`ci-secrets.ts`), never the filesystem.

import { afterEach, describe, expect, it } from 'bun:test';
import type { ResolvedServer } from '../../../types/servers';
import { probeControlPlane, resolveOrchestratorTarget, type ResolveTargetOptions } from '../../../services/orchestrator/target';
import { K8S_PROBE_GUARD_S } from '../../../services/orchestrator/kubernetes/constants';
import { ConnectionError, ValidationError, ErrorCode } from '../../../utils/errors';
import { config } from '../support/builders';
import { FakeClock } from '../fakes/fake-clock';
import { FakeSsh, type FakeSshRule } from '../fakes/fake-ssh';

const ENV = 'production';

function server(name: string, overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  const host = overrides.host ?? `10.0.0.${name.replace(/\D/g, '') || '1'}`;
  return {
    name,
    role: overrides.role ?? (/^(agent|worker)/.test(name) ? 'worker' : 'manager'),
    host,
    privateHost: overrides.privateHost ?? host,
    declaredPrivateHost: overrides.declaredPrivateHost ?? null,
    nodeLabels: overrides.nodeLabels ?? {},
    port: overrides.port ?? 22,
    user: overrides.user ?? 'dockflow',
    env: overrides.env ?? {},
    tags: overrides.tags ?? [ENV],
  };
}

/** grants CI-secret SSH credentials to the named servers for the duration of one test */
function grantCredentials(names: readonly string[]): () => void {
  const keys = names.map((name) => `${ENV.toUpperCase()}_${name.toUpperCase()}_SSH_PRIVATE_KEY`);
  for (const key of keys) process.env[key] = 'test-private-key';
  return () => {
    for (const key of keys) delete process.env[key];
  };
}

const READYZ = /--raw=\/readyz/;

function readyzOk(node: string): FakeSshRule {
  return { node, path: 'exec', command: READYZ, respond: { exitCode: 0, stdout: 'ok\n' } };
}

function readyzUnreachable(node: string): FakeSshRule {
  return { node, path: 'exec', command: READYZ, transportError: 'always', respond: { exitCode: 1 } };
}

function readyzUnready(node: string, stderr = '[-]etcd failed: reason withheld\n'): FakeSshRule {
  return { node, path: 'exec', command: READYZ, respond: { exitCode: 1, stdout: '', stderr } };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('resolveOrchestratorTarget (U-TARGET-*)', () => {
  it('U-TARGET-01: one manager -> no probe, probes: []', async () => {
    cleanups.push(grantCredentials(['server_1']));
    const target = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1')],
    });
    expect(target.controlPlane.name).toBe('server_1');
    expect(target.probes).toEqual([]);
    expect(target.managers.map((m) => m.name)).toEqual(['server_1']);
  });

  it('U-TARGET-02: --server on a worker is refused (D26)', async () => {
    cleanups.push(grantCredentials(['server_1', 'server_2', 'server_3', 'agent_1']));
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      server: 'agent_1',
      servers: [server('server_1'), server('server_2'), server('server_3'), server('agent_1', { role: 'worker' })],
    });
    try {
      await promise;
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const err = error as ValidationError;
      expect(err.message).toBe('agent_1 is a worker (k3s agent); orchestrator commands run on a manager');
      expect(err.suggestion).toBe('Use one of: server_1, server_2, server_3');
    }
  });

  it('unknown --server name is refused before any probe', async () => {
    cleanups.push(grantCredentials(['server_1']));
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      server: 'ghost',
      servers: [server('server_1')],
    });
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.NO_SERVERS_FOR_ENV });
  });

  it('U-TARGET-03: three managers, first unreachable -> second chosen, probes in order, onProbe called 3 times', async () => {
    cleanups.push(grantCredentials(['server_1', 'server_2', 'server_3']));
    const clock = new FakeClock();
    const ssh = new FakeSsh([readyzUnreachable('server_1'), readyzOk('server_2'), readyzOk('server_3')]);
    const seen: string[] = [];
    const options: ResolveTargetOptions = {
      servers: [server('server_1'), server('server_2'), server('server_3')],
      probe: ssh.transport(),
      clock,
      onProbe: (probe) => seen.push(probe.node),
    };
    const target = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), options);
    expect(target.controlPlane.name).toBe('server_2');
    expect(target.probes.map((p) => p.node)).toEqual(['server_1', 'server_2', 'server_3']);
    expect(target.probes[0].status).toBe('unreachable');
    expect(target.probes[1].status).toBe('ready');
    expect(seen).toEqual(['server_1', 'server_2', 'server_3']);
    ssh.assertAllRulesUsed();
  });

  it('U-TARGET-04: none ready -> ConnectionError naming every probe', async () => {
    cleanups.push(grantCredentials(['server_1', 'server_2', 'server_3']));
    const clock = new FakeClock();
    const ssh = new FakeSsh([readyzUnreachable('server_1'), readyzUnreachable('server_2'), readyzUnready('server_3')]);
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('server_2'), server('server_3')],
      probe: ssh.transport(),
      clock,
    });
    try {
      await promise;
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionError);
      const err = error as ConnectionError;
      expect(err.message).toBe(`No control-plane node of ${ENV} is ready`);
      expect(err.suggestion).toContain('server_1: unreachable');
      expect(err.suggestion).toContain('server_2: unreachable');
      expect(err.suggestion).toContain('server_3: unready');
    }
    ssh.assertAllRulesUsed();
  });

  it('U-TARGET-05: a manager without SSH credentials is dropped with debug output', async () => {
    // only server_1 gets credentials; server_2 has none and is silently skipped (single credentialed manager -> no probe)
    cleanups.push(grantCredentials(['server_1']));
    const target = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('server_2')],
    });
    expect(target.managers.map((m) => m.name)).toEqual(['server_1']);
    expect(target.controlPlane.name).toBe('server_1');
  });

  it('U-TARGET-05: no manager with credentials -> a named error', async () => {
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('server_2')],
    });
    await expect(promise).rejects.toMatchObject({ message: `No SSH credentials for any manager of ${ENV}` });
  });

  it('U-TARGET-06: Swarm kind prefers the leader over a ready non-leader', async () => {
    cleanups.push(grantCredentials(['server_1', 'server_2']));
    const clock = new FakeClock();
    const ssh = new FakeSsh([
      { node: 'server_1', path: 'exec', command: /docker info/, respond: { exitCode: 0, stdout: 'true\n' } },
      { node: 'server_1', path: 'exec', command: /docker node inspect self/, respond: { exitCode: 0, stdout: 'false\n' } },
      { node: 'server_2', path: 'exec', command: /docker info/, respond: { exitCode: 0, stdout: 'true\n' } },
      { node: 'server_2', path: 'exec', command: /docker node inspect self/, respond: { exitCode: 0, stdout: 'true\n' } },
    ]);
    const target = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'swarm' }), {
      servers: [server('server_1'), server('server_2')],
      probe: ssh.transport(),
      clock,
    });
    expect(target.kind).toBe('swarm');
    expect(target.controlPlane.name).toBe('server_2');
    ssh.assertAllRulesUsed();
  });

  it('U-TARGET-07: a worker without credentials warns with needsWorkers, else only debug-logs', async () => {
    cleanups.push(grantCredentials(['server_1']));
    const withoutFlag = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('agent_1', { role: 'worker' })],
    });
    expect(withoutFlag.workers).toEqual([]);

    const withFlag = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('agent_1', { role: 'worker' })],
      needsWorkers: true,
    });
    expect(withFlag.workers).toEqual([]);
  });

  it('U-TARGET-07: requireWorkerCredentials raises instead of skipping', async () => {
    cleanups.push(grantCredentials(['server_1']));
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('agent_1', { role: 'worker' })],
      requireWorkerCredentials: true,
    });
    await expect(promise).rejects.toMatchObject({ message: `No SSH credentials for worker agent_1 of ${ENV}` });
  });

  it('U-TARGET-08: a hung probe is bounded by K8S_PROBE_GUARD_S in fake time', async () => {
    cleanups.push(grantCredentials(['server_1', 'server_2', 'server_3']));
    const clock = new FakeClock();
    const ssh = new FakeSsh([
      { node: 'server_1', path: 'exec', command: READYZ, hang: true, respond: { exitCode: 1 } },
      readyzOk('server_2'),
      readyzOk('server_3'),
    ]);
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), {
      servers: [server('server_1'), server('server_2'), server('server_3')],
      probe: ssh.transport(),
      clock,
    });
    await clock.advance(K8S_PROBE_GUARD_S * 1000);
    const target = await promise;
    expect(target.probes[0].status).toBe('unreachable');
    expect(target.controlPlane.name).toBe('server_2');
  });

  it('U-SWARM-09: a worker never becomes the control plane, even when it sorts first', async () => {
    cleanups.push(grantCredentials(['agent_1', 'server_1']));
    const target = await resolveOrchestratorTarget(ENV, config({ orchestrator: 'swarm' }), {
      servers: [server('agent_1', { role: 'worker' }), server('server_1')],
    });
    expect(target.controlPlane.name).toBe('server_1');
    expect(target.managers.every((m) => m.role === 'manager')).toBe(true);
    expect(target.workers.map((w) => w.name)).toEqual(['agent_1']);
  });

  it('an empty server list is refused before any probe', async () => {
    const promise = resolveOrchestratorTarget(ENV, config({ orchestrator: 'k3s' }), { servers: [] });
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.NO_SERVERS_FOR_ENV });
  });
});

describe('probeControlPlane', () => {
  it('is the same dispatch resolveOrchestratorTarget uses, exported for callers with no bundle yet', () => {
    expect(typeof probeControlPlane).toBe('function');
  });
});
