// T/commands/lifecycle.test.ts (P69-lifecycle-commands, design-06 3.11-3.15, 3.18, 3.19): scale,
// restart, rollback, stop, prune and the lock commands over `FakeOrchestrator`, driven through
// `__setOrchestratorOpenerForTests` the way P65's `commands/day2.test.ts` does. `rollback` writes an
// audit entry and a metrics line over SSH (design-03 16.1); those calls are answered by a recorded
// `sshExec`/`sshExecChannel` fake so no test opens a real connection.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { Writable } from 'stream';
import { runRestart } from '../../../commands/app/restart';
import { runRollback } from '../../../commands/app/rollback';
import { runScale } from '../../../commands/app/scale';
import { runStop } from '../../../commands/app/stop';
import { runPrune } from '../../../commands/app/prune';
import { registerLockAcquireCommand, runLockAcquire } from '../../../commands/lock/acquire';
import { runLockRelease } from '../../../commands/lock/release';
import { runLockStatus } from '../../../commands/lock/status';
import { __setOrchestratorOpenerForTests } from '../../../commands/shared/day2';
import { Audit } from '../../../services/audit';
import { HealthCheck } from '../../../services/health-check';
import type { OrchestratorKind, ServiceInfo, StackRef, VolumeInfo } from '../../../services/orchestrator/interfaces';
import type { DockflowConfig } from '../../../utils/config';
import * as output from '../../../utils/output';
import * as ssh from '../../../utils/ssh';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', orchestrator: 'k3s', ...overrides };
}

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'web',
    nativeName: 'web',
    kind: 'service',
    role: 'app',
    mode: 'replicated',
    image: 'shop/web:1.0',
    replicas: { running: 2, desired: 2 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

function volume(overrides: Partial<VolumeInfo> = {}): VolumeInfo {
  return {
    name: 'web-data',
    composeName: 'data',
    role: 'app',
    phase: 'Bound',
    capacity: '10Gi',
    storageClass: 'dockflow-local',
    node: 'server-1',
    reclaimPolicy: 'Retain',
    usedBy: [],
    hostPath: null,
    ...overrides,
  };
}

function open(orchestrator: FakeOrchestrator, config: DockflowConfig = baseConfig()): void {
  __setOrchestratorOpenerForTests(async () => ({ config, orchestrator }));
}

// decorative, never asserted on: silenced globally so the test log stays readable
const decorative = ['printIntro', 'printOutro', 'printNote', 'printBlank', 'printInfo', 'printWarning', 'printSection', 'printRaw'] as const;
let decorativeSpies: ReturnType<typeof spyOn>[] = [];
let sshSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  decorativeSpies = decorative.map((name) => spyOn(output, name).mockImplementation(() => {}));
  sshSpies = [
    spyOn(ssh, 'sshExec').mockImplementation(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    spyOn(ssh, 'sshExecChannel').mockImplementation(async () => ({
      stream: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as unknown as Awaited<ReturnType<typeof ssh.sshExecChannel>>['stream'],
      done: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    })),
  ];
});

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
  for (const spy of [...decorativeSpies, ...sshSpies]) spy.mockRestore();
});

// ---------------------------------------------------------------------------
// scale
// ---------------------------------------------------------------------------

describe('scale', () => {
  it('rejects a negative replica count before opening the orchestrator', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runScale('production', 'web', '-1', {})).rejects.toThrow('Replicas must be a non-negative number');
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('R-06: refuses a global service', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ mode: 'global' })]);
    open(orchestrator);

    await expect(runScale('production', 'web', '3', {})).rejects.toMatchObject({
      message: 'Service web runs in global mode (one instance per node) and cannot be scaled',
      suggestion: 'Change `deploy.mode` in docker-compose.yml, or use placement constraints to choose its nodes.',
    });
    expect(orchestrator.callsTo('stack.scale')).toHaveLength(0);
  });

  it('R-07: refuses a job service', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ mode: 'job' })]);
    open(orchestrator);

    await expect(runScale('production', 'web', '3', {})).rejects.toThrow('Service web runs as a job and cannot be scaled');
  });

  it('R-09: refuses a Helm release', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', nativeName: 'search', kind: 'helm' })]);
    open(orchestrator);

    await expect(runScale('production', 'search', '3', {})).rejects.toMatchObject({
      message: 'Helm release search cannot be scaled with dockflow scale',
    });
  });

  it('scales and never takes the deploy lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runScale('production', 'web', '4', {});

    expect(orchestrator.callsTo('stack.scale')[0]).toEqual([{ project: 'shop', env: 'production', role: 'app' }, 'web', 4, { wait: true, timeoutS: 300 }]);
    expect(orchestrator.callsTo('lock.acquire')).toHaveLength(0);
  });

  it('--no-wait is forwarded as wait: false', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runScale('production', 'web', '0', { wait: false });

    const options = orchestrator.callsTo('stack.scale')[0][3] as { wait: boolean };
    expect(options.wait).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

describe('restart', () => {
  it('restarts a running service and never takes the deploy lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runRestart('production', 'web', {});

    expect(orchestrator.callsTo('stack.restart')[0]).toEqual([{ project: 'shop', env: 'production', role: 'app' }, 'web', { wait: true, timeoutS: 300 }]);
    expect(orchestrator.callsTo('lock.acquire')).toHaveLength(0);
  });

  it('reports the resumed replica count of a stopped service, read back from the cluster', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    let call = 0;
    orchestrator.program('stack.getServices', () => {
      call += 1;
      return call === 1 ? [service({ replicas: { running: 0, desired: 0 } })] : [service({ replicas: { running: 3, desired: 3 } })];
    });
    open(orchestrator);

    await runRestart('production', 'web', {});

    expect(orchestrator.callsTo('stack.getServices').length).toBeGreaterThanOrEqual(2);
  });

  it('restarts every service of the role when none is named', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await runRestart('production', undefined, {});

    expect(orchestrator.callsTo('stack.restart')[0][1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('rollback', () => {
  it('refuses upload-only projects before touching the lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator, baseConfig({ no_services: true }));

    await expect(runRollback('production', undefined, {})).rejects.toMatchObject({
      message: 'Rollback is not supported for upload-only projects',
    });
    expect(orchestrator.callsTo('lock.acquire')).toHaveLength(0);
  });

  it('full rollback: acquires the lock before applying and releases it after', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.0.0' }, { current: false });
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.1.0' });
    open(orchestrator);

    await runRollback('production', undefined, {});

    const methodOrder = orchestrator.calls.map((call) => call.method);
    expect(methodOrder.indexOf('lock.acquire')).toBeLessThan(methodOrder.indexOf('stack.apply'));
    expect(methodOrder.indexOf('releases.setCurrent')).toBeLessThan(methodOrder.indexOf('lock.release'));
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.0.0');
  });

  it('full rollback: runs the post-rollback HTTP health checks while the lock is still held (design-03 16.1)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.0.0' }, { current: false });
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.1.0' });
    const config = baseConfig({ health_checks: { endpoints: [{ url: 'https://shop.example.com/health' }] } });
    open(orchestrator, config);
    const spy = spyOn(HealthCheck.prototype, 'checkHTTPEndpoints').mockImplementation(async () => {
      expect(orchestrator.lockHolder(orchestrator.target.stackName)).not.toBeNull();
      return [];
    });

    await runRollback('production', undefined, {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].on_failure).toBe('notify'); // never rolls back a rollback
    spy.mockRestore();
  });

  it('a failing HTTP health check warns but does not fail the rollback (best-effort)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.0.0' }, { current: false });
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.1.0' });
    const config = baseConfig({ health_checks: { endpoints: [{ url: 'https://shop.example.com/health' }] } });
    open(orchestrator, config);
    const spy = spyOn(HealthCheck.prototype, 'checkHTTPEndpoints').mockRejectedValue(new Error('boom'));

    await runRollback('production', undefined, {});

    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    spy.mockRestore();
  });

  it('single-service rollback never runs HTTP health checks (full rollback only, design-06 3.13)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.rollbackService', { toVersion: '1.2.0' });
    const config = baseConfig({ health_checks: { endpoints: [{ url: 'https://shop.example.com/health' }] } });
    open(orchestrator, config);
    const spy = spyOn(HealthCheck.prototype, 'checkHTTPEndpoints').mockResolvedValue([]);

    await runRollback('production', 'web', {});

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('U-FLOW-14: single-service rollback also acquires and releases the lock, and never touches the release store', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.rollbackService', { toVersion: '1.2.0' });
    open(orchestrator);

    await runRollback('production', 'web', {});

    const methodOrder = orchestrator.calls.map((call) => call.method);
    expect(methodOrder.indexOf('lock.acquire')).toBeLessThan(methodOrder.indexOf('stack.rollbackService'));
    expect(methodOrder.indexOf('stack.rollbackService')).toBeLessThan(methodOrder.indexOf('lock.release'));
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    expect(orchestrator.callsTo('releases.setCurrent')).toHaveLength(0);
  });

  it('design-06 3.13: single-service rollback records the audit entry while the lock is still held', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.rollbackService', { toVersion: '1.2.0' });
    open(orchestrator);
    const spy = spyOn(Audit.prototype, 'writeEntry').mockImplementation(async () => {
      expect(orchestrator.lockHolder(orchestrator.target.stackName)).not.toBeNull();
      return 'ok';
    });

    await runRollback('production', 'web', {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    spy.mockRestore();
  });

  it('a held lock is reported as DEPLOY_LOCKED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    const held = await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'another deploy' });
    expect(held.success).toBe(true);
    open(orchestrator);

    await expect(runRollback('production', 'web', {})).rejects.toThrow(/Already locked/);
    expect(orchestrator.callsTo('stack.rollbackService')).toHaveLength(0);
  });

  it('R-12: a name that only exists among accessories is refused, not silently rolled back', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', (ref: StackRef) => (ref.role === 'accessory' ? [service({ name: 'redis' })] : []));
    open(orchestrator);

    await expect(runRollback('production', 'redis', {})).rejects.toMatchObject({
      message: 'Service redis is an accessory; accessories have no release history',
      suggestion: 'Change accessories.yml and run `dockflow deploy <env> --accessories`.',
    });
    expect(orchestrator.callsTo('lock.acquire')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('stop', () => {
  it('U-FLOW-14: takes the lock, removes the app role keeping volumes, and releases the lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await runStop('production', { yes: true });

    const methodOrder = orchestrator.calls.map((call) => call.method);
    expect(methodOrder.indexOf('lock.acquire')).toBeLessThan(methodOrder.indexOf('stack.remove'));
    expect(methodOrder.indexOf('stack.remove')).toBeLessThan(methodOrder.indexOf('lock.release'));
    expect(orchestrator.callsTo('stack.remove')[0][1]).toEqual({ volumes: 'retain', signal: expect.any(AbortSignal) });
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
  });

  it('without -y and no TTY, cancels before acquiring the lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await runStop('production', {});

    expect(orchestrator.callsTo('lock.acquire')).toHaveLength(0);
    expect(orchestrator.callsTo('stack.remove')).toHaveLength(0);
  });

  it('reports kept volumes on k3s after a successful stop', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);

    await runStop('production', { yes: true });

    expect(orchestrator.callsTo('volumes.list')).toHaveLength(1);
  });

  it('a held lock is reported as DEPLOY_LOCKED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const held = await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'another deploy' });
    expect(held.success).toBe(true);
    open(orchestrator);

    await expect(runStop('production', { yes: true })).rejects.toThrow(/Already locked/);
    expect(orchestrator.callsTo('stack.remove')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

describe('prune', () => {
  function kindOf(kind: OrchestratorKind) {
    return () => kind;
  }

  it('R-04: --containers on k3s is refused before any SSH', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runPrune('production', { containers: true }, kindOf('k3s'))).rejects.toMatchObject({
      message: 'dockflow prune --containers is not supported with orchestrator: k3s: the kubelet removes exited containers itself',
    });
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('R-03: --volumes on k3s is refused before any SSH', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runPrune('production', { volumes: true }, kindOf('k3s'))).rejects.toThrow('dockflow prune --volumes is not supported with orchestrator: k3s');
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('R-02: --networks on k3s is refused before any SSH', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runPrune('production', { networks: true }, kindOf('k3s'))).rejects.toThrow('dockflow prune --networks is not supported with orchestrator: k3s');
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('k3s without --all never calls images.prune (documented no-op)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await runPrune('production', { yes: true }, kindOf('k3s'));

    expect(orchestrator.callsTo('images.prune')).toHaveLength(0);
  });

  it('k3s with --all and -y prunes images on every node and reports per-node lines', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('images.prune', [
      { node: 'server-1', reclaimed: null },
      { node: 'agent-1', reclaimed: null },
    ]);
    open(orchestrator);

    await runPrune('production', { all: true, yes: true }, kindOf('k3s'));

    const call = orchestrator.callsTo('images.prune')[0];
    expect((call[0] as { name: string }[]).map((n) => n.name)).toEqual(['server_1', 'agent_1']);
    expect(call[1]).toEqual({ all: true });
    expect(orchestrator.callsTo('images.list')).toHaveLength(1); // Current Disk Usage
  });

  it('swarm with no target flag prunes every target', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    open(orchestrator, baseConfig({ orchestrator: 'swarm' }));

    await runPrune('production', { yes: true }, kindOf('swarm'));

    expect(orchestrator.callsTo('images.prune')).toHaveLength(1);
    expect(orchestrator.callsTo('images.pruneRuntime').map((c) => c[1])).toEqual(['containers', 'volumes', 'networks']);
  });
});

// ---------------------------------------------------------------------------
// lock acquire / release / status
// ---------------------------------------------------------------------------

describe('lock acquire', () => {
  it('registers the acquire subcommand', () => {
    const program = new Command();
    registerLockAcquireCommand(program);
    expect(program.commands.map((c) => c.name())).toEqual(['acquire']);
  });

  it('acquires a free lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await runLockAcquire('production', { message: 'maintenance' });

    expect(orchestrator.lockHolder(orchestrator.target.stackName)?.message).toBe('maintenance');
  });

  it('an existing lock without --force is reported as DEPLOY_LOCKED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'existing' });
    open(orchestrator);

    await expect(runLockAcquire('production', {})).rejects.toThrow('Use --force to override the existing lock.');
  });

  it('--force takes over an existing lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'existing' });
    open(orchestrator);

    await runLockAcquire('production', { force: true, message: 'takeover' });

    expect(orchestrator.lockHolder(orchestrator.target.stackName)?.message).toBe('takeover');
  });
});

describe('lock release', () => {
  it('releases a held lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'x' });
    open(orchestrator);

    await runLockRelease('production', {});

    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
  });

  it('no lock found is not an error', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await expect(runLockRelease('production', {})).resolves.toBeUndefined();
  });
});

describe('lock status', () => {
  it('reports no active lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await expect(runLockStatus('production', {})).resolves.toBeUndefined();
  });

  it('reports a held lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'deploying' });
    open(orchestrator);

    await expect(runLockStatus('production', {})).resolves.toBeUndefined();
  });
});
