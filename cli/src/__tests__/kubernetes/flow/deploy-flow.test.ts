// Deploy flow (design-03 3.3, DESIGN-CORE 2.2) over FakeOrchestrator: phase ordering, the
// release-record invariant (K08, PD-8), lock discipline and the convergence/health failure
// mapping. `resolveSetup` (real config/servers/plugin I/O) is exercised by the CLI, not here;
// `execute(ctx)` is the pure-enough, fully testable surface (mirrors deploy-phases.test.ts's
// approach for the phase functions it owns).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as Build from '../../../services/build';
import * as Hook from '../../../services/hook';
import type { Audit } from '../../../services/audit';
import type { Metrics } from '../../../services/metrics';
import { execute } from '../../../commands/deploy';
import type { DeployContext } from '../../../commands/deploy-context';
import { DeployError, ErrorCode } from '../../../utils/errors';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';
import { config, target } from '../support/builders';

const DEFAULT_COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n';
const ACCESSORIES_KEY = '.dockflow/docker/accessories.yml';
const DEFAULT_ACCESSORIES = 'services:\n  redis:\n    image: redis:7\n';

function fakeAudit(): Audit {
  return { writeEntry: async () => 'audit-line' } as unknown as Audit;
}

function fakeMetrics(): Metrics {
  return { writeDeployment: async () => '{}' } as unknown as Metrics;
}

/**
 * `target()` with no worker and a single manager: `historySyncConns` (deploy-phases.ts) is then
 * empty, so `recordHistory`'s best-effort node sync never opens a real SSH connection.
 */
function soloTarget() {
  return target('server_1', { workers: [] });
}

function fakeContext(orchestrator: FakeOrchestrator, overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    env: 'production',
    config: config(),
    stackName: orchestrator.target.stackName,
    branchName: 'main',
    deployVersion: '1.4.2',
    projectRoot: '/project',
    target: orchestrator.target,
    orchestrator,
    deployApp: true,
    forceAccessories: false,
    skipAccessories: false,
    options: {},
    rendered: new Map(),
    composeContent: DEFAULT_COMPOSE,
    composeDirPath: '/project',
    audit: fakeAudit(),
    metrics: fakeMetrics(),
    revertedTo: null,
    applyStarted: false,
    appSettled: false,
    cleanupOrchestrator: null,
    traefikOnCluster: false,
    ...overrides,
  };
}

function withAccessories(rendered = new Map<string, string>()): Map<string, string> {
  rendered.set(ACCESSORIES_KEY, DEFAULT_ACCESSORIES);
  return rendered;
}

/** Every name of `expected` appears in `events`, in that relative order (extra events allowed between them). */
function assertSubsequence(events: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const name of expected) {
    const at = events.indexOf(name, cursor);
    if (at === -1) {
      throw new Error(`Expected "${name}" at or after index ${cursor} in [${events.join(', ')}]`);
    }
    cursor = at + 1;
  }
}

let recorded: Record<string, string[]>;
let spies: { mockRestore(): void }[];

beforeEach(() => {
  recorded = { warn: [], dim: [], debug: [], info: [], success: [], error: [] };
  spies = [
    spyOn(output, 'printWarning').mockImplementation((m: string) => recorded.warn.push(m)),
    spyOn(output, 'printDim').mockImplementation((m: string) => recorded.dim.push(m)),
    spyOn(output, 'printDebug').mockImplementation((m: string) => recorded.debug.push(m)),
    spyOn(output, 'printInfo').mockImplementation((m: string) => recorded.info.push(m)),
    spyOn(output, 'printSuccess').mockImplementation((m: string) => recorded.success.push(m)),
    spyOn(output, 'printError').mockImplementation((m: string) => recorded.error.push(m)),
    spyOn(output, 'printRaw').mockImplementation(() => {}),
    spyOn(output, 'createSpinner').mockImplementation(
      () => ({ start() {}, succeed() {}, fail() {}, update() {}, info() {}, warn() {} }) as unknown as ReturnType<typeof output.createSpinner>,
    ),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('execute — U-FLOW-01 happy path', () => {
  it('runs the full ordered sequence, including a build + distribute', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    // three prior releases beyond keep=3 so cleanupReleases (releases.prune + images.collectGarbage) actually fires
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.1.0', epoch: 1 }, { current: false });
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.2.0', epoch: 2 }, { current: false });
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.3.0', epoch: 3 }, { current: true });

    const buildAllSpy = spyOn(Build, 'buildAll').mockResolvedValue({ images: ['shop/web:1.4.2'], durationMs: 0 });
    const archSpy = spyOn(await import('../../../utils/ssh'), 'sshExec').mockResolvedValue({ exitCode: 0, stdout: 'x86_64', stderr: '' });

    const ctx = fakeContext(orchestrator, {
      composeContent: 'services:\n  web:\n    build: .\n    image: shop/web:1.4.2\n',
      config: config({ proxy: { enabled: true } }),
      rendered: withAccessories(),
      target: soloTarget(),
    });

    await execute(ctx);

    assertSubsequence(orchestrator.events, [
      'lock.acquire',
      'stack.render:app',
      'stack.render:accessory',
      'images.distribute',
      'proxy.plan',
      'proxy.ensure',
      'releases.create:1.4.2',
      'stack.deploy:accessory',
      'stack.waitConvergence:accessory',
      'stack.finalize:accessory',
      'stack.deploy:app',
      'stack.waitConvergence:app',
      'stack.checkHealth:app',
      'stack.finalize:app',
      'releases.prune',
      'images.collectGarbage',
      'lock.release',
    ]);
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.2');
    expect(recorded.error).toEqual([]);

    buildAllSpy.mockRestore();
    archSpy.mockRestore();
  });
});

describe('execute — U-FLOW-02 accessories skipped / proxy before accessories', () => {
  it('no accessories.yml: no waitConvergence:accessory, no finalize:accessory', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, { target: soloTarget() }); // rendered has no accessories key
    await execute(ctx);
    expect(orchestrator.events).not.toContain('stack.waitConvergence:accessory');
    expect(orchestrator.events).not.toContain('stack.finalize:accessory');
    expect(orchestrator.events).toContain('stack.deploy:app'); // the app role deploys regardless
  });

  it('deploy --accessories with proxy.enabled: proxy.plan + proxy.ensure still run before the accessories apply', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, {
      deployApp: false,
      forceAccessories: true,
      config: config({ proxy: { enabled: true } }),
      rendered: withAccessories(),
      target: soloTarget(),
    });
    await execute(ctx);
    assertSubsequence(orchestrator.events, ['proxy.plan', 'proxy.ensure', 'stack.deploy:accessory']);
  });
});

describe('execute — failure mapping (U-FLOW-MAP-01..05)', () => {
  it('U-FLOW-MAP-01: convergence failed, revert reverted -> HEALTH_CHECK_FAILED with the revert message appended', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.waitConvergence', { status: 'timeout', failures: [{ service: 'web', reason: 'CrashLoopBackOff', message: 'web keeps crashing' }] });
    orchestrator.program('stack.revert', { status: 'reverted', services: ['web'] });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown).toBeInstanceOf(DeployError);
    expect(thrown.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(thrown.message).toContain('web keeps crashing');
  });

  it('U-FLOW-MAP-02: revert failed -> ROLLBACK_FAILED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.waitConvergence', { status: 'timeout', failures: [] });
    orchestrator.program('stack.revert', { status: 'failed', services: [], message: 'revert did not converge' });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown.code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect(thrown.message).toContain('did not converge');
  });

  it('U-FLOW-MAP-03: revert nothing-to-revert (first deploy) -> DEPLOY_FAILED, "left in place for debugging"', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.waitConvergence', { status: 'timeout', failures: [] });
    orchestrator.program('stack.revert', { status: 'nothing-to-revert', services: [], message: 'nothing to roll back to (first deployment of this stack); workloads were left in place for debugging' });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(thrown.message).toContain('nothing to roll back to (first deployment of this stack); workloads were left in place for debugging');
  });

  it('U-FLOW-MAP-04: Swarm reverted status -> HEALTH_CHECK_FAILED (parity)', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.program('stack.waitConvergence', { status: 'reverted', failures: [], message: 'the orchestrator rolled the update back' });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
  });

  it('U-FLOW-MAP-05: other failure (Swarm native, not rolled back) -> DEPLOY_FAILED with the default suggestion', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.program('stack.waitConvergence', { status: 'failed', failures: [], message: 'boom' });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(thrown.message).toBe('boom');
    expect(thrown.suggestion).toBe('Run `dockflow diagnose production`.');
  });
});

describe('execute — U-FLOW-03 health failure with on_failure: rollback, after finalize', () => {
  it('rolls back to the previous release and removes the failed one', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.4.1' }, { current: true });
    orchestrator.program('stack.checkHealth', { healthy: false, rolledBack: false, failures: [{ service: 'web', reason: 'CrashLoopBackOff', message: 'web keeps crashing' }] });
    const ctx = fakeContext(orchestrator, { config: config({ health_checks: { enabled: true, on_failure: 'rollback' } }), target: soloTarget() });

    await expect(execute(ctx)).rejects.toThrow(DeployError);

    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.1');
    expect(orchestrator.storedReleases(orchestrator.target.stackName).versions).not.toContain('1.4.2');
  });
});

describe('execute — U-FLOW-04 failure before anything applied, on_failure: rollback', () => {
  it('no rollbackRelease call; releases.remove restores the previous current', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.4.1' }, { current: true });
    orchestrator.program('stack.deploy', (input) => {
      if (input.ref.role !== 'app') return { success: true, data: { ref: input.ref, version: input.version, startedAt: new Date(), services: null, skipped: false, artifactDigest: 'x', changes: [], helm: [], helmChanges: [], helmDeclared: [], previousVersion: input.previousVersion } };
      return { success: false, error: new DeployError('apply rejected by the API server', ErrorCode.DEPLOY_FAILED) };
    });
    const ctx = fakeContext(orchestrator, { config: config({ health_checks: { enabled: true, on_failure: 'rollback' } }), target: soloTarget() });

    await expect(execute(ctx)).rejects.toThrow(DeployError);

    expect(orchestrator.callsTo('stack.apply')).toHaveLength(0); // rollbackRelease never ran (it uses stack.apply)
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.1');
    expect(orchestrator.storedReleases(orchestrator.target.stackName).versions).not.toContain('1.4.2');
  });
});

describe('execute — U-FLOW-05 accessories failure', () => {
  it('app never deployed, release removed, DEPLOY_FAILED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.deploy', (input) => {
      if (input.ref.role === 'accessory') return { success: false, error: new DeployError('accessory apply rejected', ErrorCode.DEPLOY_FAILED) };
      return { success: true, data: { ref: input.ref, version: input.version, startedAt: new Date(), services: null, skipped: false, artifactDigest: 'x', changes: [], helm: [], helmChanges: [], helmDeclared: [], previousVersion: input.previousVersion } };
    });
    const ctx = fakeContext(orchestrator, { rendered: withAccessories(), target: soloTarget() });

    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown).toBeInstanceOf(DeployError);
    expect(thrown.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(orchestrator.events).not.toContain('stack.deploy:app');
    expect(orchestrator.storedReleases(orchestrator.target.stackName).versions).not.toContain('1.4.2');
  });
});

describe('execute — U-FLOW-06 diagnostics printing (DESIGN-CORE 8.2)', () => {
  it('each warning is printed once per role', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.render', (input) => ({
      format: 'k8s-manifests/1',
      role: input.ref.role,
      content: `# ${input.ref.role}\n`,
      helm: [],
      digest: `d-${input.ref.role}`,
      diagnostics: [{ severity: 'warning', code: 'ports.not-published', path: 'services.web.ports[0]', message: `${input.ref.role} port not published` }],
    }));
    const ctx = fakeContext(orchestrator, { rendered: withAccessories(), target: soloTarget() });
    await execute(ctx);
    const appWarnings = recorded.warn.filter((m) => m.includes('app port not published'));
    const accWarnings = recorded.warn.filter((m) => m.includes('accessory port not published'));
    expect(appWarnings).toHaveLength(1);
    expect(accWarnings).toHaveLength(1);
  });

  it('info diagnostics only reach printDebug, never printWarning', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.render', (input) => ({
      format: 'k8s-manifests/1',
      role: input.ref.role,
      content: '',
      helm: [],
      digest: 'd',
      diagnostics: input.ref.role === 'app' ? [{ severity: 'info', code: 'keys.version-ignored', path: 'version', message: 'version is obsolete and ignored' }] : [],
    }));
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    await execute(ctx);
    expect(recorded.warn.some((m) => m.includes('version is obsolete'))).toBe(false);
    expect(recorded.debug.some((m) => m.includes('version is obsolete'))).toBe(true);
  });
});

describe('execute — U-FLOW-09 lock contention', () => {
  it('DEPLOY_LOCKED with the store message', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await orchestrator.lock(orchestrator.target.stackName).acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    const thrown = (await execute(ctx).catch((e) => e)) as DeployError;
    expect(thrown).toBeInstanceOf(DeployError);
    expect(thrown.code).toBe(ErrorCode.DEPLOY_LOCKED);
    expect(thrown.message).toContain('Already locked');
  });
});

describe('execute — U-FLOW-10 deploy --accessories (K07)', () => {
  it('releases.create is never called; previous comes from currentVersion; releaseCreated stays false', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.seedRelease(orchestrator.target.stackName, { version: '1.4.1' }, { current: true });
    const ctx = fakeContext(orchestrator, { deployApp: false, forceAccessories: true, rendered: withAccessories(), target: soloTarget() });

    await execute(ctx);

    expect(orchestrator.events.filter((e) => e.startsWith('releases.create'))).toHaveLength(0);
    expect(orchestrator.events).toContain('releases.currentVersion');
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.1');
  });
});

describe('execute — U-FLOW-11 failure after the app was applied (K08)', () => {
  async function deployedThenFailAfter(program: (o: FakeOrchestrator) => void, configOverrides: Partial<ReturnType<typeof config>> = {}): Promise<FakeOrchestrator> {
    const orchestrator = new FakeOrchestrator('k3s');
    // realistic apply: the backend reports K11 issued for the app role before anything else runs
    orchestrator.program('stack.deploy', (input) => {
      input.onApplyProgress?.({ kind: 'started' });
      return { success: true, data: { ref: input.ref, version: input.version, startedAt: new Date(), services: input.services, skipped: false, artifactDigest: 'x', changes: [], helm: [], helmChanges: [], helmDeclared: [...input.helmDeclared], previousVersion: input.previousVersion } };
    });
    program(orchestrator);
    const ctx = fakeContext(orchestrator, { config: config(configOverrides), target: soloTarget() });
    await expect(execute(ctx)).rejects.toThrow();
    return orchestrator;
  }

  it('a fatal post-deploy hook: release kept, current stays at the new version', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const hookSpy = spyOn(Hook, 'runHook').mockImplementation(async (phase) => {
      if (phase === 'post-deploy') throw new DeployError('post-deploy hook failed', ErrorCode.DEPLOY_FAILED);
    });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });
    await expect(execute(ctx)).rejects.toThrow(DeployError);
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.2');
    expect(recorded.warn.some((m) => m.includes('Release 1.4.2 is deployed but the deploy reported a failure; current stays 1.4.2'))).toBe(true);
    hookSpy.mockRestore();
  });

  it('an apply whose outcome is unknown (deploy resolves but waitConvergence never settles cleanly, then the process would be killed) — here modelled as a revert that itself fails after a convergence timeout — keeps the record and prints the "state unknown" message only when settlement is unconfirmed', async () => {
    const orchestrator = await deployedThenFailAfter((o) => {
      o.program('stack.waitConvergence', { status: 'timeout', failures: [] });
      o.program('stack.revert', { status: 'failed', services: [], message: 'the API server stopped answering' });
    });
    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.2');
    expect(recorded.warn.some((m) => m.includes('Version 1.4.2 was applied but its state is unknown; run dockflow status production'))).toBe(true);
  });

  it('finalize that rejects: caught, becomes a warning, release record survives (also U-FLOW-12)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.finalize', () => {
      throw new Error('prune forbidden');
    });
    const ctx = fakeContext(orchestrator, { target: soloTarget() });

    await execute(ctx); // must NOT throw: the deploy still succeeds

    expect(orchestrator.storedReleases(orchestrator.target.stackName).current).toBe('1.4.2');
    expect(recorded.warn.some((m) => m.includes('Cleanup after deploy failed'))).toBe(true);
  });
});

describe('execute — U-FLOW-13 hook environment (K33 (f))', () => {
  it('DOCKFLOW_* and k3s-only variables reach every remote hook phase', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const hookSpy = spyOn(Hook, 'runHook').mockResolvedValue(undefined);
    const ctx = fakeContext(orchestrator, { target: soloTarget() });

    await execute(ctx);

    const preDeployCall = hookSpy.mock.calls.find(([phase]) => phase === 'pre-deploy');
    expect(preDeployCall).toBeDefined();
    const remote = preDeployCall?.[4] as { env: Record<string, string>; workingDir: string } | undefined;
    expect(remote?.env).toMatchObject({
      DOCKFLOW_STACK: orchestrator.target.stackName,
      DOCKFLOW_ENV: 'production',
      DOCKFLOW_VERSION: '1.4.2',
      DOCKFLOW_ORCHESTRATOR: 'k3s',
    });
    expect(remote?.env.DOCKFLOW_NAMESPACE).toBeDefined();
    expect(remote?.env.KUBECONFIG).toBeDefined();
    expect(remote?.env.DOCKFLOW_KUBECTL).toBeDefined();
    expect(remote?.workingDir).not.toBe('/tmp');
    hookSpy.mockRestore();
  });
});

describe('execute — U-FLOW-14 deploy lock (K64 (c))', () => {
  it('acquires the lock before mutating and releases it in finally, on both success and failure', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctxOk = fakeContext(orchestrator, { target: soloTarget() });
    await execute(ctxOk);
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();

    orchestrator.program('stack.waitConvergence', { status: 'failed', failures: [], message: 'boom' });
    const ctxFail = fakeContext(orchestrator, { deployVersion: '1.4.3', target: soloTarget() });
    await execute(ctxFail).catch(() => {});
    expect(orchestrator.lockHolder(orchestrator.target.stackName)).toBeNull();
  });
});
