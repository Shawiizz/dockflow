// T/commands/accessories.test.ts (P70-accessories-list-commands, design-06 3.16, 3.5, 3.6): accessories
// commands (list, logs, exec, restart, stop, remove) and `list services`/`list images`, over
// `FakeOrchestrator` the way P65/P66's command tests do (no `mock.module`).

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runAccessoriesExec } from '../../../commands/accessories/exec';
import { runAccessoriesList } from '../../../commands/accessories/list';
import { runAccessoriesLogs } from '../../../commands/accessories/logs';
import { runAccessoriesRemove } from '../../../commands/accessories/remove';
import { runAccessoriesRestart } from '../../../commands/accessories/restart';
import { runAccessoriesStop } from '../../../commands/accessories/stop';
import { requireAccessories } from '../../../commands/accessories/utils';
import { runListImages } from '../../../commands/list/images';
import { runListServices } from '../../../commands/list/services';
import { __setOrchestratorOpenerForTests, buildDay2Context } from '../../../commands/shared/day2';
import type { NodeImage, ServiceInfo, VolumeInfo } from '../../../services/orchestrator/interfaces';
import type { DockflowConfig } from '../../../utils/config';
import { DeployError, ErrorCode, ExecExitError } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', ...overrides };
}

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'db',
    nativeName: 'db',
    kind: 'service',
    role: 'accessory',
    mode: 'replicated',
    image: 'shop/db:1.0',
    replicas: { running: 1, desired: 1 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

function volume(overrides: Partial<VolumeInfo> = {}): VolumeInfo {
  return {
    name: 'db-data',
    composeName: 'db',
    role: 'accessory',
    phase: 'Bound',
    capacity: '10Gi',
    storageClass: 'dockflow-local',
    node: 'main',
    reclaimPolicy: 'Retain',
    usedBy: [],
    hostPath: null,
    ...overrides,
  };
}

function nodeImage(overrides: Partial<NodeImage> = {}): NodeImage {
  return { ref: 'shop-web-production:1.0', id: 'sha256:abc', sizeBytes: 1_000_000, inUse: true, ...overrides };
}

function open(orchestrator: FakeOrchestrator, config: DockflowConfig = baseConfig()): void {
  __setOrchestratorOpenerForTests(async () => ({ config, orchestrator }));
}

/** silences a decorative output function for one test, restoring it in `finally`. */
function silence(name: keyof typeof output): ReturnType<typeof spyOn> {
  return spyOn(output, name).mockImplementation(() => {});
}

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
});

// ---------------------------------------------------------------------------
// requireAccessories
// ---------------------------------------------------------------------------

describe('requireAccessories', () => {
  it('throws STACK_NOT_FOUND with the deploy hint when the role does not exist', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', false);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);
    await expect(requireAccessories(ctx)).rejects.toMatchObject({
      message: 'Accessories not deployed yet',
      code: ErrorCode.STACK_NOT_FOUND,
      suggestion: 'Deploy them with: `dockflow deploy production --accessories`.',
    });
  });

  it('returns the accessory services when the role exists', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.getServices', [service()]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);
    await expect(requireAccessories(ctx)).resolves.toEqual([service()]);
  });
});

// ---------------------------------------------------------------------------
// accessories list
// ---------------------------------------------------------------------------

describe('accessories list', () => {
  it('--json emits the shared {stack, namespace, items} shape with services only, no volumes read', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const json = silence('printJSON');

    try {
      await runAccessoriesList('production', { json: true });
      expect(json.mock.calls.length).toBe(1);
      const payload = json.mock.calls[0][0] as { stack: string; namespace: string | null; items: ServiceInfo[] };
      expect(Object.keys(payload).sort()).toEqual(['items', 'namespace', 'stack']);
      expect(payload.items).toEqual([service()]);
      expect(orchestrator.callsTo('volumes.list').length).toBe(0);
    } finally {
      json.mockRestore();
    }
  });

  it('prints a Volumes section when the role owns volumes', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const raw = silence('printRaw');
    const section = silence('printSection');
    const rest = ['printInfo', 'printBlank'].map((name) => silence(name as keyof typeof output));

    try {
      await runAccessoriesList('production', {});
      expect(section.mock.calls.some((call: unknown[]) => call[0] === 'Volumes')).toBe(true);
      const volumesScope = orchestrator.callsTo('volumes.list')[0][0] as { role: string };
      expect(volumesScope.role).toBe('accessory');
    } finally {
      raw.mockRestore();
      section.mockRestore();
      for (const spy of rest) spy.mockRestore();
    }
  });

  it('not deployed: prints info and returns without error or a services read', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', false);
    open(orchestrator);
    const info = silence('printInfo');
    const blank = silence('printBlank');

    try {
      await runAccessoriesList('production', {});
      expect(info.mock.calls.length).toBeGreaterThan(0);
      expect(orchestrator.callsTo('stack.getServices').length).toBe(0);
    } finally {
      info.mockRestore();
      blank.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// accessories logs
// ---------------------------------------------------------------------------

describe('accessories logs', () => {
  it('streams the named accessory over the accessory role', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runAccessoriesLogs('production', 'db', {});

    const calls = orchestrator.callsTo('containers.streamLogs');
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { role: string }).role).toBe('accessory');
    expect(calls[0][1]).toBe('db');
  });

  it('an unknown accessory name is refused with the accessory wording', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', []);
    open(orchestrator);

    await expect(runAccessoriesLogs('production', 'ghost', {})).rejects.toThrow("Accessory 'ghost' not found");
  });
});

// ---------------------------------------------------------------------------
// accessories exec
// ---------------------------------------------------------------------------

describe('accessories exec', () => {
  it('an empty command defaults to the /bin/sh shell, not auto', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.shell', 0);
    open(orchestrator);

    await runAccessoriesExec('production', 'db', [], {});

    const calls = orchestrator.callsTo('containers.shell');
    expect(calls.length).toBe(1);
    expect(calls[0][2]).toBe('/bin/sh');
  });

  it('--user on k3s is refused before openDay2, no remote call made', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.forbidRemoteWork();
    open(orchestrator);

    await expect(runAccessoriesExec('production', 'db', [], { user: 'root' }, () => 'k3s')).rejects.toThrow('dockflow accessories exec --user');
    expect(orchestrator.remoteWorkTripped).toBe(false);
  });

  it('a non-zero exit code becomes ExecExitError, carrying the container code', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.exec', 7);
    open(orchestrator);

    let caught: unknown;
    try {
      await runAccessoriesExec('production', 'db', ['sh', '-c', 'exit 7'], {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecExitError);
    expect((caught as ExecExitError).exitCode).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// accessories restart
// ---------------------------------------------------------------------------

describe('accessories restart', () => {
  it('not deployed: refused before any restart call, no service given', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', false);
    open(orchestrator);

    await expect(runAccessoriesRestart('production', undefined, {})).rejects.toThrow('Accessories not deployed yet');
    expect(orchestrator.callsTo('stack.restart').length).toBe(0);
  });

  it('restarts the whole role with service null when none is named', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runAccessoriesRestart('production', undefined, {});

    const calls = orchestrator.callsTo('stack.restart');
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { role: string }).role).toBe('accessory');
    expect(calls[0][1]).toBeNull();
  });

  it('resumes a stopped accessory and reports the count read back after restart', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.programOnce('stack.getServices', [service({ replicas: { running: 0, desired: 0 } })]);
    orchestrator.programOnce('stack.getServices', [service({ replicas: { running: 1, desired: 1 } })]);
    open(orchestrator);

    await runAccessoriesRestart('production', 'db', {});

    const calls = orchestrator.callsTo('stack.restart');
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('db');
  });

  it('takes no deploy lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    await runAccessoriesRestart('production', undefined, {});

    expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// accessories stop
// ---------------------------------------------------------------------------

describe('accessories stop', () => {
  it('non-TTY without -y cancels before any stop call', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    open(orchestrator);
    const warn = silence('printWarning');
    const info = silence('printInfo');

    try {
      await runAccessoriesStop('production', undefined, {});
      expect(orchestrator.callsTo('stack.stop').length).toBe(0);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('-y stops the named accessory with the delete-wait budget, no lock', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const note = silence('printNote');

    try {
      await runAccessoriesStop('production', 'db', { yes: true });
      const calls = orchestrator.callsTo('stack.stop');
      expect(calls.length).toBe(1);
      expect(calls[0][1]).toEqual(['db']);
      expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
    } finally {
      note.mockRestore();
    }
  });

  it('a whole-role failure warns instead of throwing (today\'s text)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', true);
    orchestrator.program('stack.stop', new Error('one service refused'));
    open(orchestrator);
    const warn = silence('printWarning');
    const note = silence('printNote');

    try {
      await expect(runAccessoriesStop('production', undefined, { yes: true })).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
      note.mockRestore();
    }
  });

  it('a single named service failure still throws', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.stop', new Error('boom'));
    open(orchestrator);

    await expect(runAccessoriesStop('production', 'db', { yes: true })).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// accessories remove
// ---------------------------------------------------------------------------

describe('accessories remove', () => {
  it('not deployed: refused before the lock or any remove call', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.exists', false);
    open(orchestrator);

    await expect(runAccessoriesRemove('production', {})).rejects.toThrow('Accessories not deployed yet');
    expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
    expect(orchestrator.callsTo('stack.remove').length).toBe(0);
  });

  it('non-TTY without -y cancels before the lock (plain removal)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const warn = silence('printWarning');
    const info = silence('printInfo');

    try {
      await runAccessoriesRemove('production', {});
      expect(orchestrator.callsTo('lock.acquire').length).toBe(0);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it('--volumes without -y requires the typed confirmation and cancels non-interactively', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const warn = silence('printWarning');
    const info = silence('printInfo');
    const error = silence('printError');

    try {
      await runAccessoriesRemove('production', { volumes: true });
      expect(orchestrator.callsTo('stack.remove').length).toBe(0);
    } finally {
      warn.mockRestore();
      info.mockRestore();
      error.mockRestore();
    }
  });

  it('-y acquires the lock, removes with volumes retained, and releases it', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);
    const warn = silence('printWarning');
    const note = silence('printNote');

    try {
      await runAccessoriesRemove('production', { yes: true });

      const methodOrder = orchestrator.calls.map((call) => call.method);
      expect(methodOrder).toContain('lock.acquire');
      expect(methodOrder.indexOf('lock.acquire')).toBeLessThan(methodOrder.indexOf('stack.remove'));
      expect(methodOrder.indexOf('stack.remove')).toBeLessThan(methodOrder.indexOf('lock.release'));
      expect(orchestrator.callsTo('stack.remove')[0][1]).toEqual({ volumes: 'retain' });
      expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    } finally {
      warn.mockRestore();
      note.mockRestore();
    }
  });

  it('--volumes -y removes with volumes deleted', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('volumes.list', [volume()]);
    open(orchestrator);
    const warn = silence('printWarning');
    const error = silence('printError');
    const info = silence('printInfo');

    try {
      await runAccessoriesRemove('production', { volumes: true, yes: true });
      expect(orchestrator.callsTo('stack.remove')[0][1]).toEqual({ volumes: 'delete' });
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });

  it('a held lock is reported as DEPLOY_LOCKED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    const held = await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'another deploy' });
    expect(held.success).toBe(true);
    open(orchestrator);
    const warn = silence('printWarning');

    try {
      await expect(runAccessoriesRemove('production', { yes: true })).rejects.toMatchObject({
        code: ErrorCode.DEPLOY_LOCKED,
      });
      expect(orchestrator.callsTo('stack.remove').length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('release runs in finally even when remove throws', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('stack.remove', new DeployError('remove failed'));
    open(orchestrator);
    const warn = silence('printWarning');

    try {
      await expect(runAccessoriesRemove('production', { yes: true })).rejects.toThrow('remove failed');
      expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// list services
// ---------------------------------------------------------------------------

describe('list services', () => {
  it('no services found is STACK_NOT_FOUND with the deploy hint', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', []);
    open(orchestrator);

    await expect(runListServices('production', {})).rejects.toMatchObject({
      code: ErrorCode.STACK_NOT_FOUND,
      suggestion: 'Deploy the stack with: `dockflow deploy production`.',
    });
  });

  it('--json emits the shared {stack, namespace, items} shape', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ role: 'app', name: 'web' })]);
    open(orchestrator);
    const json = silence('printJSON');

    try {
      await runListServices('production', { json: true });
      const payload = json.mock.calls[0][0] as { stack: string; namespace: string | null; items: ServiceInfo[] };
      expect(payload.items.length).toBe(1);
      expect(payload.namespace).toBe(orchestrator.naming.scope({ project: 'shop', env: 'production', role: 'app' }));
    } finally {
      json.mockRestore();
    }
  });

  it('--tasks reads instances per service', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ role: 'app', name: 'web' })]);
    orchestrator.program('stack.listInstances', []);
    open(orchestrator);
    const raw = silence('printRaw');
    const dim = silence('printDim');
    const blank = silence('printBlank');

    try {
      await runListServices('production', { tasks: true });
      const calls = orchestrator.callsTo('stack.listInstances');
      expect(calls.length).toBe(1);
      expect((calls[0][1] as { service: string }).service).toBe('web');
    } finally {
      raw.mockRestore();
      dim.mockRestore();
      blank.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// list images
// ---------------------------------------------------------------------------

describe('list images', () => {
  it('reads nodes from managers and workers', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('images.list', []);
    open(orchestrator);
    const section = silence('printSection');
    const dim = silence('printDim');

    try {
      await runListImages('production', {});
      const calls = orchestrator.callsTo('images.list');
      const nodes = calls[0][0] as { name: string }[];
      expect(nodes.map((n) => n.name)).toEqual(['server_1', 'agent_1']);
    } finally {
      section.mockRestore();
      dim.mockRestore();
    }
  });

  it('without --all, filters rows to images whose repository contains the project name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('images.list', [
      { node: 'server_1', images: [nodeImage({ ref: 'shop-web:1.0' }), nodeImage({ ref: 'nginx:1.27' })], diskUsage: '2G used of 10G, 20%' },
    ]);
    open(orchestrator);
    const raw = silence('printRaw');
    const section = silence('printSection');
    const dim = silence('printDim');
    const blank = silence('printBlank');

    try {
      await runListImages('production', {});
      const lines: string[] = raw.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(lines.some((l) => l.includes('shop-web'))).toBe(true);
      expect(lines.some((l) => l.includes('nginx'))).toBe(false);
    } finally {
      raw.mockRestore();
      section.mockRestore();
      dim.mockRestore();
      blank.mockRestore();
    }
  });

  it('--all shows every image, unfiltered', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('images.list', [{ node: 'server_1', images: [nodeImage({ ref: 'nginx:1.27' })], diskUsage: null }]);
    open(orchestrator);
    const raw = silence('printRaw');
    const section = silence('printSection');
    const dim = silence('printDim');
    const blank = silence('printBlank');

    try {
      await runListImages('production', { all: true });
      const lines: string[] = raw.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(lines.some((l) => l.includes('nginx'))).toBe(true);
      expect(orchestrator.callsTo('releases.currentCompose').length).toBe(0);
    } finally {
      raw.mockRestore();
      section.mockRestore();
      dim.mockRestore();
      blank.mockRestore();
    }
  });
});
