// Pure/unit coverage of the shared day-2 foundations (design-06 2.1, 10.1 `day2.test.ts`):
// `resolveService`, `planExec`, `planPrune`, the `--tail` re-export, `listingJson` and `pickInstance`.
// Orchestrator-neutral: exercised through `FakeOrchestrator`, never a real config or SSH connection.

import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildDay2Context,
  __setOrchestratorOpenerForTests,
  listingJson,
  openDay2,
  parseTailOption,
  pickInstance,
  planExec,
  planPrune,
  resolveService,
} from '../commands/shared/day2';
import { capabilitiesFor } from '../services/orchestrator/capabilities';
import type { InstanceInfo, ServiceInfo } from '../services/orchestrator/interfaces';
import type { DockflowConfig } from '../utils/config';
import { CLIError, UnsupportedOperationError, ValidationError } from '../utils/errors';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';

function baseConfig(): DockflowConfig {
  return { project_name: 'shop' };
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

function instance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: 'web-1',
    label: 'web.1',
    service: 'web',
    node: 'worker-1',
    status: 'Running',
    severity: 'ok',
    ready: true,
    restarts: 0,
    current: true,
    startedAt: null,
    error: null,
    containers: ['web'],
    ...overrides,
  };
}

describe('resolveService', () => {
  it('resolves a compose name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    const resolved = await resolveService(ctx, ctx.appRef, 'web');

    expect(resolved.service.name).toBe('web');
    expect(resolved.workload).toBeUndefined();
  });

  it('resolves the legacy Swarm full name', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.program('stack.getServices', [service()]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    const resolved = await resolveService(ctx, ctx.appRef, 'shop-production_web');

    expect(resolved.service.name).toBe('web');
  });

  it('resolves a Kubernetes sanitized native name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'web_app', nativeName: 'web-app' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    const resolved = await resolveService(ctx, ctx.appRef, 'web-app');

    expect(resolved.service.name).toBe('web_app');
  });

  it('resolves <release>/<workload> and returns the workload when allowed', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', nativeName: 'search', kind: 'helm' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    const resolved = await resolveService(ctx, ctx.appRef, 'search/search-api', { allowWorkload: true });

    expect(resolved.service.name).toBe('search');
    expect(resolved.workload).toBe('search-api');
  });

  it('refuses <release>/<workload> without allowWorkload', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', kind: 'helm' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    await expect(resolveService(ctx, ctx.appRef, 'search/search-api')).rejects.toThrow(ValidationError);
  });

  it('appends the --pick hint when the caller asks for it (logs)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', kind: 'helm' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    let caught: unknown;
    try {
      await resolveService(ctx, ctx.appRef, 'search/search-api', { pickHint: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).suggestion).toContain('--pick');
  });

  it('uses the accessory wording when nothing matches', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'db' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    let caught: unknown;
    try {
      await resolveService(ctx, ctx.accessoryRef, 'cache', { noun: 'accessory' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CLIError);
    expect((caught as CLIError).message).toBe("Accessory 'cache' not found");
    expect((caught as CLIError).suggestion).toBe('Available accessories: db.');
  });

  it('suggests deploying first when the stack has no services', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', []);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    let caught: unknown;
    try {
      await resolveService(ctx, ctx.appRef, 'web');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CLIError);
    expect((caught as CLIError).suggestion).toBe('Deploy first with: `dockflow deploy production`.');
  });

  it('refuses a Helm row when allowHelm is false', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ name: 'search', kind: 'helm' })]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    await expect(resolveService(ctx, ctx.appRef, 'search', { allowHelm: false })).rejects.toThrow(UnsupportedOperationError);
  });

  it('memoises getServices per role and drops it only for the invalidated ref', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    await resolveService(ctx, ctx.appRef, 'web');
    await resolveService(ctx, ctx.accessoryRef, 'web');
    expect(orchestrator.callsTo('stack.getServices').length).toBe(2);

    // repeated lookups of the same ref hit the memo, not the backend
    await resolveService(ctx, ctx.appRef, 'web');
    await resolveService(ctx, ctx.accessoryRef, 'web');
    expect(orchestrator.callsTo('stack.getServices').length).toBe(2);

    ctx.invalidate(ctx.appRef);
    await resolveService(ctx, ctx.appRef, 'web');
    await resolveService(ctx, ctx.accessoryRef, 'web');
    expect(orchestrator.callsTo('stack.getServices').length).toBe(3);
  });
});

describe('pickInstance', () => {
  it('throws CONTAINER_NOT_FOUND when there is nothing to pick', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.listInstances', []);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    await expect(pickInstance(ctx, ctx.appRef, service())).rejects.toThrow(CLIError);
  });

  it('offers the instances in the shared display order (non-TTY picks the first)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.listInstances', [
      instance({ id: 'web-2', label: 'web.2' }),
      instance({ id: 'web-1', label: 'web.1' }),
    ]);
    const ctx = buildDay2Context('production', baseConfig(), orchestrator);

    const picked = await pickInstance(ctx, ctx.appRef, service());

    expect(picked).toBe('web-1');
  });
});

describe('planExec', () => {
  const ttyBoth = { stdin: { isTTY: true }, stdout: { isTTY: true } };

  it('no command opens an auto-detected shell', () => {
    expect(planExec([], {}, ttyBoth)).toEqual({ mode: 'shell', shell: 'auto' });
  });

  it('--sh with no command opens /bin/sh directly', () => {
    expect(planExec([], { sh: true }, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
  });

  it('bash and /bin/bash open the bash shell', () => {
    expect(planExec(['bash'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/bash' });
    expect(planExec(['/bin/bash'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/bash' });
  });

  it('sh and /bin/sh open the sh shell', () => {
    expect(planExec(['sh'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
    expect(planExec(['/bin/sh'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
  });

  it('a single argument with shell metacharacters runs through sh -c', () => {
    const plan = planExec(['ls | wc -l'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['sh', '-c', 'ls | wc -l']);
  });

  it('a single argument containing only spaces also runs through sh -c', () => {
    const plan = planExec(['echo hi'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['sh', '-c', 'echo hi']);
  });

  it('two arguments are passed through untouched', () => {
    const plan = planExec(['echo', 'hi'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['echo', 'hi']);
  });

  it('the tty/stdin matrix follows the local TTYs', () => {
    const cases: { stdio: typeof ttyBoth; tty: boolean; stdin: boolean }[] = [
      { stdio: { stdin: { isTTY: true }, stdout: { isTTY: true } }, tty: true, stdin: true },
      { stdio: { stdin: { isTTY: false }, stdout: { isTTY: false } }, tty: false, stdin: true },
      { stdio: { stdin: { isTTY: true }, stdout: { isTTY: false } }, tty: false, stdin: false },
      { stdio: { stdin: { isTTY: false }, stdout: { isTTY: true } }, tty: false, stdin: true },
    ];
    for (const { stdio, tty, stdin } of cases) {
      const plan = planExec(['id'], {}, stdio);
      if (plan.mode !== 'command') throw new Error('expected mode command');
      expect(plan.request.tty).toBe(tty);
      expect(plan.request.stdin).toBe(stdin);
    }
  });

  it('--no-tty forces a non-interactive session even with two TTYs', () => {
    const plan = planExec(['id'], { noTty: true }, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.tty).toBe(false);
    expect(plan.request.stdin).toBe(false);
  });

  it('refuses a relative --workdir before any SSH', () => {
    expect(() => planExec(['ls'], { workdir: 'relative/path' }, ttyBoth)).toThrow(ValidationError);
  });

  it('refuses a bad --env key without echoing the value', () => {
    let caught: unknown;
    try {
      planExec(['ls'], { env: ['1BAD=supersecret'] }, ttyBoth);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).not.toContain('supersecret');
    expect((caught as ValidationError).suggestion).not.toContain('supersecret');
  });

  it('keeps = characters inside the value', () => {
    const plan = planExec(['ls'], { env: ['KEY=a=b=c'] }, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.env).toEqual({ KEY: 'a=b=c' });
  });
});

describe('planPrune', () => {
  const swarm = capabilitiesFor('swarm');
  const k3s = capabilitiesFor('k3s');

  it('defaults to every target on Swarm', () => {
    expect(planPrune({}, swarm).targets).toEqual(['images', 'containers', 'volumes', 'networks']);
  });

  it('defaults to images only on k3s, with the explanatory note', () => {
    const plan = planPrune({}, k3s);
    expect(plan.targets).toEqual(['images']);
    expect(plan.note).toBe('Targets: images (containers, volumes and networks are managed by Kubernetes)');
  });

  it('honours explicit targets on Swarm, in the order given', () => {
    expect(planPrune({ containers: true, volumes: true }, swarm).targets).toEqual(['containers', 'volumes']);
  });

  it('allows an explicit --images on k3s with no note', () => {
    const plan = planPrune({ images: true }, k3s);
    expect(plan.targets).toEqual(['images']);
    expect(plan.note).toBeUndefined();
  });

  it('refuses --containers on k3s (R-04)', () => {
    let caught: unknown;
    try {
      planPrune({ containers: true }, k3s);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    expect((caught as UnsupportedOperationError).message).toContain('the kubelet removes exited containers itself');
    expect((caught as UnsupportedOperationError).suggestion).toContain('--images --all');
  });

  it('refuses --volumes on k3s (R-03)', () => {
    let caught: unknown;
    try {
      planPrune({ volumes: true }, k3s);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    expect((caught as UnsupportedOperationError).message).toContain('volumes are only deleted explicitly');
    expect((caught as UnsupportedOperationError).suggestion).toContain('dockflow volumes rm');
  });

  it('refuses --networks on k3s through the shared capability catalogue (R-02)', () => {
    let caught: unknown;
    try {
      planPrune({ networks: true }, k3s);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    expect((caught as UnsupportedOperationError).message).toBe(
      'dockflow prune --networks is not supported with orchestrator: k3s: the pod network is managed by the cluster',
    );
  });
});

describe('parseTailOption (re-exported from status/logs)', () => {
  it('accepts all, a default and an explicit count', () => {
    expect(parseTailOption('all', 100)).toBe('all');
    expect(parseTailOption(undefined, 100)).toBe(100);
    expect(parseTailOption('50', 100)).toBe(50);
  });

  it('rejects a negative or non-numeric value', () => {
    expect(() => parseTailOption('-1', 100)).toThrow();
    expect(() => parseTailOption('abc', 100)).toThrow();
  });
});

describe('listingJson', () => {
  it('is null on Swarm and the namespace on k3s', () => {
    const swarmCtx = buildDay2Context('production', baseConfig(), new FakeOrchestrator('swarm'));
    const k3sOrchestrator = new FakeOrchestrator('k3s');
    const k3sCtx = buildDay2Context('production', baseConfig(), k3sOrchestrator);

    expect(listingJson(swarmCtx, swarmCtx.appRef, []).namespace).toBeNull();
    expect(listingJson(k3sCtx, k3sCtx.appRef, []).namespace).toBe(k3sOrchestrator.naming.scope(k3sCtx.appRef));
    expect(listingJson(k3sCtx, k3sCtx.appRef, [1, 2]).items).toEqual([1, 2]);
  });
});

describe('openDay2', () => {
  afterEach(() => {
    __setOrchestratorOpenerForTests(null);
  });

  it('builds a context around the opened orchestrator', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    __setOrchestratorOpenerForTests(async () => ({ config: baseConfig(), orchestrator }));

    const ctx = await openDay2('production', {});

    expect(ctx.stackName).toBe(orchestrator.target.stackName);
    expect(ctx.appRef).toEqual({ project: 'shop', env: 'production', role: 'app' });
    expect(ctx.accessoryRef).toEqual({ project: 'shop', env: 'production', role: 'accessory' });
  });

  it('builds a lock store scoped to the stack', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    __setOrchestratorOpenerForTests(async () => ({ config: baseConfig(), orchestrator }));

    const ctx = await openDay2('production', {});
    await ctx.lock().acquire({ message: 'test' });

    expect(orchestrator.lockHolder(orchestrator.target.stackName)?.message).toBe('test');
  });
});
