// Phase ordering, once-per-role diagnostics printing, the release-record invariant helpers (K08,
// PD-8), and the deploy cleanup failover (design-03 3.4, 12, 19.3), over FakeOrchestrator. What each
// backend method does internally is asserted where it is owned (backends/*.test.ts); here, what
// deploy-phases.ts does around the bundle.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { DeployContext } from '../commands/deploy-context';
import { activeNodes } from '../commands/deploy-context';
import {
  buildAndDistribute,
  cleanupBundle,
  declaredHelmNames,
  deployAccessories,
  deployApp,
  ensureRegistryAccess,
  isControlPlaneLoss,
  parseOnly,
  printArtifactDiagnostics,
  releaseLock,
  settles,
} from '../commands/deploy-phases';
import type { Audit } from '../services/audit';
import type { Metrics } from '../services/metrics';
import type { DeployReceipt, ResolvedHelmRelease, StackArtifact, StackRef } from '../services/orchestrator/interfaces';
import { KubeError } from '../services/orchestrator/kubernetes/runtime/errors';
import { err, ok } from '../types/result';
import { DeployError, ErrorCode, OrchestratorUnavailableError } from '../utils/errors';
import * as output from '../utils/output';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';
import { config, deployInput, nodeRef, parsedCompose, target } from './kubernetes/support/builders';

const APP_REF: StackRef = { project: 'shop', env: 'production', role: 'app' };

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
    composeContent: 'services:\n  web:\n    image: nginx:1.27\n',
    composeDirPath: '/project',
    audit: {} as Audit,
    metrics: {} as Metrics,
    revertedTo: null,
    applyStarted: false,
    appSettled: false,
    cleanupOrchestrator: null,
    traefikOnCluster: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<DeployReceipt> = {}): DeployReceipt {
  return {
    ref: APP_REF,
    version: '1.4.2',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    services: null,
    skipped: false,
    artifactDigest: 'digest',
    changes: [],
    helm: [],
    helmChanges: [],
    helmDeclared: [],
    previousVersion: null,
    ...overrides,
  };
}

const HELM_APP_RELEASE: ResolvedHelmRelease = {
  name: 'search',
  role: 'app',
  namespace: 'dockflow-shop-production',
  chart: { kind: 'repo', repo: 'https://charts.example.org', chart: 'search' },
  version: '2.4.1',
  values: {},
  valuesSha256: 'a'.repeat(64),
  timeoutS: 300,
  auth: null,
  declaredDigest: null,
};

let recorded: Record<string, string[]>;
let spies: { mockRestore(): void }[];

beforeEach(() => {
  recorded = { warn: [], dim: [], debug: [], info: [], success: [] };
  spies = [
    spyOn(output, 'printWarning').mockImplementation((m: string) => recorded.warn.push(m)),
    spyOn(output, 'printDim').mockImplementation((m: string) => recorded.dim.push(m)),
    spyOn(output, 'printDebug').mockImplementation((m: string) => recorded.debug.push(m)),
    spyOn(output, 'printInfo').mockImplementation((m: string) => recorded.info.push(m)),
    spyOn(output, 'printSuccess').mockImplementation((m: string) => recorded.success.push(m)),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

// ---------------------------------------------------------------------------
// activeNodes
// ---------------------------------------------------------------------------

describe('activeNodes', () => {
  it('every manager, then every worker, servers.yml order', () => {
    expect(activeNodes(target('server_1')).map((n) => n.name)).toEqual(['server_1', 'agent_1']);
  });
});

// ---------------------------------------------------------------------------
// settles (K08, design-03 3.4)
// ---------------------------------------------------------------------------

describe('settles', () => {
  it('native revert that actually rolled back -> settled', () => {
    expect(settles({ status: 'native', services: [] }, '1.4.1', true)).toBe(true);
  });

  it('native "revert" that did not roll back (a non-fatal health check) -> not settled', () => {
    expect(settles({ status: 'native', services: [] }, '1.4.1', false)).toBe(false);
  });

  it('a confirmed backend revert -> always settled', () => {
    expect(settles({ status: 'reverted', services: ['web'] }, '1.4.1', false)).toBe(true);
  });

  it('nothing to revert on a first deploy (no previous version) -> settled (D15)', () => {
    expect(settles({ status: 'nothing-to-revert', services: [] }, null, false)).toBe(true);
  });

  it('nothing to revert although a previous version existed -> not settled (the real cause is elsewhere)', () => {
    expect(settles({ status: 'nothing-to-revert', services: [] }, '1.4.1', false)).toBe(false);
  });

  it('a failed revert is never settled', () => {
    expect(settles({ status: 'failed', services: [] }, null, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// declaredHelmNames / parseOnly (pure helpers)
// ---------------------------------------------------------------------------

describe('declaredHelmNames', () => {
  it('filters by role; app is the default when role is omitted', () => {
    const cfg = config({
      helm: {
        releases: [
          { name: 'search', chart: 'search', repo: 'https://charts.example.org', version: '2.4.1' },
          { name: 'postgres', chart: 'postgresql', repo: 'https://charts.example.org', version: '16.7.4', role: 'accessory' },
        ],
      },
    });
    expect(declaredHelmNames(cfg, 'app')).toEqual(['search']);
    expect(declaredHelmNames(cfg, 'accessory')).toEqual(['postgres']);
  });

  it('no helm config at all -> empty', () => {
    expect(declaredHelmNames(config(), 'app')).toEqual([]);
  });
});

describe('parseOnly', () => {
  it('splits on commas and trims surrounding whitespace', () => {
    expect(parseOnly('web, api ,worker')).toEqual(['web', 'api', 'worker']);
  });

  it('drops empty entries from a trailing or doubled comma', () => {
    expect(parseOnly('web,,api,')).toEqual(['web', 'api']);
  });
});

// ---------------------------------------------------------------------------
// printArtifactDiagnostics (DESIGN-CORE 8.2 printing rules)
// ---------------------------------------------------------------------------

describe('printArtifactDiagnostics', () => {
  it('warnings and errors print with printWarning, then the hint dim-indented; info only with printDebug', () => {
    const artifact: StackArtifact = {
      format: 'k8s-manifests/1',
      role: 'app',
      content: '',
      helm: [],
      digest: 'x',
      diagnostics: [
        { severity: 'warning', code: 'ports.not-published', path: 'services.web.ports[0]', message: 'the port is not published', hint: 'Add a host port.' },
        { severity: 'error', code: 'volumes.rwo-replicas', path: 'services.web', message: 'replicas > 1 with a ReadWriteOnce volume' },
        { severity: 'info', code: 'keys.version-ignored', path: 'version', message: 'version is obsolete and ignored' },
      ],
    };
    printArtifactDiagnostics('docker-compose.yml', artifact);
    expect(recorded.warn).toEqual([
      'docker-compose.yml services.web.ports[0]: the port is not published',
      'docker-compose.yml services.web: replicas > 1 with a ReadWriteOnce volume',
    ]);
    expect(recorded.dim).toEqual(['  Add a host port.']);
    expect(recorded.debug).toEqual(['docker-compose.yml version: version is obsolete and ignored']);
  });

  it('no diagnostics -> prints nothing', () => {
    printArtifactDiagnostics('docker-compose.yml', { format: 'k8s-manifests/1', role: 'app', content: '', helm: [], digest: 'x', diagnostics: [] });
    expect(recorded.warn).toEqual([]);
    expect(recorded.dim).toEqual([]);
    expect(recorded.debug).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deployAccessories
// ---------------------------------------------------------------------------

describe('deployAccessories', () => {
  it('no accessories.yml (null input): touches the bundle not at all', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await deployAccessories(fakeContext(orchestrator), null);
    expect(orchestrator.events).toEqual([]);
  });

  it('change detection skip: prints "unchanged", never waits for convergence or finalizes', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.deploy', ok(receipt({ ref: { ...APP_REF, role: 'accessory' }, skipped: true })));
    await deployAccessories(fakeContext(orchestrator), deployInput({ ref: { role: 'accessory' } }));
    expect(orchestrator.events).toEqual(['stack.deploy:accessory']);
    expect(recorded.info).toEqual(['Accessories unchanged, skipping']);
  });

  it('deploy -> waitConvergence -> finalize, in order, on success', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await deployAccessories(fakeContext(orchestrator), deployInput({ ref: { role: 'accessory' } }));
    expect(orchestrator.events).toEqual(['stack.deploy:accessory', 'stack.waitConvergence:accessory', 'stack.finalize:accessory']);
    expect(recorded.success).toEqual(['Accessories deployed']);
  });

  it('convergence failure on k3s (backend revert): calls stack.revert, never finalize, and throws', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.waitConvergence', { status: 'timeout', failures: [{ service: 'redis', reason: 'CrashLoopBackOff', message: 'redis keeps crashing' }] });
    orchestrator.program('stack.revert', { status: 'reverted', services: ['redis'] });
    await expect(deployAccessories(fakeContext(orchestrator), deployInput({ ref: { role: 'accessory' } }))).rejects.toThrow(DeployError);
    expect(orchestrator.callsTo('stack.revert')).toHaveLength(1);
    expect(orchestrator.events).not.toContain('stack.finalize:accessory');
  });

  it('Swarm native revert (status "reverted"): no backend stack.revert call', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    orchestrator.program('stack.waitConvergence', { status: 'reverted', failures: [], message: 'the orchestrator rolled the update back' });
    await expect(deployAccessories(fakeContext(orchestrator), deployInput({ ref: { role: 'accessory' } }))).rejects.toThrow(DeployError);
    expect(orchestrator.callsTo('stack.revert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deployApp
// ---------------------------------------------------------------------------

describe('deployApp', () => {
  it('ctx.deployApp = false (deploy --accessories): touches the bundle not at all (K07, U-SWARM-11)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await deployApp(fakeContext(orchestrator, { deployApp: false }), deployInput());
    expect(orchestrator.events).toEqual([]);
  });

  it('no compose services and no Helm releases: nothing to deploy', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const input = deployInput({ compose: { services: {} } });
    await deployApp(fakeContext(orchestrator), input);
    expect(orchestrator.events).toEqual([]);
  });

  it('Helm-only project (empty compose, Helm releases present) still deploys (design-04 3.11)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const input = deployInput({ compose: { services: {} }, helm: [HELM_APP_RELEASE] });
    await deployApp(fakeContext(orchestrator), input);
    expect(orchestrator.events).toContain('stack.deploy:app');
  });

  it('healthy deploy: deploy -> waitConvergence -> checkHealth -> finalize, in that order', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await deployApp(fakeContext(orchestrator), deployInput());
    expect(orchestrator.events).toEqual(['stack.deploy:app', 'stack.waitConvergence:app', 'stack.checkHealth:app', 'stack.finalize:app']);
  });

  it('onApplyProgress("started") marks ctx.applyStarted true (K08)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.deploy', (input) => {
      input.onApplyProgress?.({ kind: 'started' });
      return ok(receipt({ ref: input.ref, previousVersion: input.previousVersion }));
    });
    const ctx = fakeContext(orchestrator);
    await deployApp(ctx, deployInput());
    expect(ctx.applyStarted).toBe(true);
  });

  it('health_checks.enabled: false skips checkHealth and finalizes anyway', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, { config: config({ health_checks: { enabled: false } }) });
    await deployApp(ctx, deployInput());
    expect(orchestrator.events).not.toContain('stack.checkHealth:app');
    expect(orchestrator.events).toContain('stack.finalize:app');
  });

  it('convergence failure on k3s: reverts, records ctx.appSettled and ctx.revertedTo, throws', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.waitConvergence', { status: 'timeout', failures: [] });
    orchestrator.program('stack.revert', { status: 'reverted', services: ['web'] });
    const ctx = fakeContext(orchestrator);
    await expect(deployApp(ctx, deployInput({ previousVersion: '1.4.1' }))).rejects.toThrow(DeployError);
    expect(orchestrator.callsTo('stack.revert')).toHaveLength(1);
    expect(ctx.appSettled).toBe(true);
    expect(ctx.revertedTo).toBe('1.4.1');
    expect(orchestrator.events).not.toContain('stack.finalize:app');
  });

  it('failed health check on k3s: reverts and throws HEALTH_CHECK_FAILED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.checkHealth', { healthy: false, rolledBack: false, failures: [{ service: 'web', reason: 'CrashLoopBackOff', message: 'web keeps crashing' }] });
    orchestrator.program('stack.revert', { status: 'reverted', services: ['web'] });
    const ctx = fakeContext(orchestrator);
    const thrown: unknown = await deployApp(ctx, deployInput({ previousVersion: '1.4.1' })).catch((e) => e);
    expect(thrown).toBeInstanceOf(DeployError);
    expect((thrown as DeployError).code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(ctx.appSettled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureRegistryAccess (12.3)
// ---------------------------------------------------------------------------

describe('ensureRegistryAccess', () => {
  it('no registry configured: returns null, touches nothing', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const result = await ensureRegistryAccess(fakeContext(orchestrator), APP_REF);
    expect(result).toBeNull();
    expect(orchestrator.events).toEqual([]);
  });

  it('registry enabled with full credentials: forwards them to images.ensurePullSecret', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, {
      config: config({ registry: { type: 'custom', enabled: true, url: 'registry.example.com', username: 'deploy', password: 's3cret' } }),
    });
    const result = await ensureRegistryAccess(ctx, APP_REF);
    expect(result).toBe('dockflow-registry');
    expect(orchestrator.callsTo('images.ensurePullSecret')).toEqual([[APP_REF, { server: 'registry.example.com', username: 'deploy', password: 's3cret' }]]);
  });

  it('enabled + url, no password: returns null (import mode, no Secret to apply)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, { config: config({ registry: { type: 'custom', enabled: true, url: 'registry.example.com' } }) });
    const result = await ensureRegistryAccess(ctx, APP_REF);
    expect(result).toBeNull();
    expect(orchestrator.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildAndDistribute guard clauses (12.2)
// ---------------------------------------------------------------------------

describe('buildAndDistribute guard clauses', () => {
  const delivery = { built: [], mode: 'import' as const, pullSecretName: null };

  it('--skip-build: no build, returns null', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, { options: { skipBuild: true } });
    expect(await buildAndDistribute(ctx, parsedCompose({ build: '.', image: 'shop/web:1.0' }), delivery)).toBeNull();
    expect(orchestrator.events).toEqual([]);
  });

  it('ctx.deployApp = false: no build, returns null', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator, { deployApp: false });
    expect(await buildAndDistribute(ctx, parsedCompose({ build: '.', image: 'shop/web:1.0' }), delivery)).toBeNull();
  });

  it('no compose services at all (Helm-only project): nothing to build', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator);
    expect(await buildAndDistribute(ctx, parsedCompose({ services: {} }), delivery)).toBeNull();
    expect(orchestrator.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isControlPlaneLoss / cleanupBundle (19.3)
// ---------------------------------------------------------------------------

describe('isControlPlaneLoss', () => {
  it('OrchestratorUnavailableError from a KubeError "Unreachable" -> true', () => {
    const cause = new KubeError('Unreachable', 'The Kubernetes API is not answering', 'server_1', -1, '');
    expect(isControlPlaneLoss(new OrchestratorUnavailableError('x', undefined, cause))).toBe(true);
  });

  it('OrchestratorUnavailableError from a KubeError "Timeout" -> true', () => {
    const cause = new KubeError('Timeout', 'apply timed out', 'server_1', -1, '');
    expect(isControlPlaneLoss(new OrchestratorUnavailableError('x', undefined, cause))).toBe(true);
  });

  it('OrchestratorUnavailableError from a KubeError "Forbidden" (a real refusal, not a lost node) -> false', () => {
    const cause = new KubeError('Forbidden', 'not allowed', 'server_1', 1, '');
    expect(isControlPlaneLoss(new OrchestratorUnavailableError('x', undefined, cause))).toBe(false);
  });

  it('a bare OrchestratorUnavailableError (SSH transport failure, no KubeError cause) -> true', () => {
    expect(isControlPlaneLoss(new OrchestratorUnavailableError('SSH connection refused'))).toBe(true);
  });

  it('a DeployError is never a control-plane loss', () => {
    expect(isControlPlaneLoss(new DeployError('boom'))).toBe(false);
  });

  it('a plain Error is never a control-plane loss', () => {
    expect(isControlPlaneLoss(new Error('boom'))).toBe(false);
  });
});

describe('cleanupBundle', () => {
  it('not a control-plane loss: same bundle, no re-resolution attempted', async () => {
    const orchestrator = new FakeOrchestrator('k3s', { target: { managers: [nodeRef('server_1'), nodeRef('server_2')] } });
    const bundle = await cleanupBundle(fakeContext(orchestrator), new DeployError('boom'));
    expect(bundle).toBe(orchestrator);
  });

  it('a single manager: same bundle even on control-plane loss (nothing to fail over to)', async () => {
    const orchestrator = new FakeOrchestrator('k3s'); // one manager by default
    const cause = new KubeError('Unreachable', 'x', 'server_1', -1, '');
    const bundle = await cleanupBundle(fakeContext(orchestrator), new OrchestratorUnavailableError('x', undefined, cause));
    expect(bundle).toBe(orchestrator);
  });

  it('--no-failover: same bundle', async () => {
    const orchestrator = new FakeOrchestrator('k3s', { target: { managers: [nodeRef('server_1'), nodeRef('server_2')] } });
    const cause = new KubeError('Timeout', 'x', 'server_1', -1, '');
    const ctx = fakeContext(orchestrator, { options: { noFailover: true } });
    const bundle = await cleanupBundle(ctx, new OrchestratorUnavailableError('x', undefined, cause));
    expect(bundle).toBe(orchestrator);
  });
});

// ---------------------------------------------------------------------------
// releaseLock (19.3)
// ---------------------------------------------------------------------------

describe('releaseLock', () => {
  it('release succeeds on the first try: the lock is gone, nothing else runs', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = fakeContext(orchestrator);
    const lock = orchestrator.lock(ctx.stackName);
    const acquired = await lock.acquire({ version: '1.4.2' });
    if (!acquired.success) throw new Error('setup failed');
    await releaseLock(ctx, lock, acquired.data);
    expect(orchestrator.lockHolder(ctx.stackName)).toBeNull();
    expect(recorded.warn).toEqual([]);
  });

  it('release fails and there is no cleanup bundle: warns and gives up', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.programOnce('lock.release', err(new Error('connection refused')));
    const ctx = fakeContext(orchestrator);
    const lock = orchestrator.lock(ctx.stackName);
    await releaseLock(ctx, lock, { performer: 'test', started_at: '2026-01-01T00:00:00.000Z', timestamp: 1, version: '1.4.2', stack: ctx.stackName });
    expect(recorded.warn).toEqual(['Lock release failed: connection refused']);
  });

  it('release fails, but a cleanup bundle holds the same lock: releases it there instead', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.programOnce('lock.release', err(new Error('connection refused')));
    const other = new FakeOrchestrator('k3s', { target: orchestrator.target });
    const ctx = fakeContext(orchestrator, { cleanupOrchestrator: other });
    const lock = orchestrator.lock(ctx.stackName);
    const acquired = await other.lock(ctx.stackName).acquire({ version: '1.4.2' });
    if (!acquired.success) throw new Error('setup failed');

    await releaseLock(ctx, lock, acquired.data);

    expect(other.lockHolder(ctx.stackName)).toBeNull();
  });

  it('release fails on both bundles: warns with the second failure', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.programOnce('lock.release', err(new Error('connection refused')));
    const other = new FakeOrchestrator('k3s', { target: orchestrator.target });
    other.programOnce('lock.release', err(new Error('also unreachable')));
    const ctx = fakeContext(orchestrator, { cleanupOrchestrator: other });
    const lock = orchestrator.lock(ctx.stackName);
    const acquired = await other.lock(ctx.stackName).acquire({ version: '1.4.2' });
    if (!acquired.success) throw new Error('setup failed');

    await releaseLock(ctx, lock, acquired.data);

    expect(recorded.warn).toEqual(['Lock release failed: also unreachable']);
  });
});
