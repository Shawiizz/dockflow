// Phase ordering, once-per-role diagnostics printing, the release-record invariant helpers (K08,
// PD-8), and the deploy cleanup failover (design-03 3.4, 12, 19.3), over FakeOrchestrator. What each
// backend method does internally is asserted where it is owned (backends/*.test.ts); here, what
// deploy-phases.ts does around the bundle.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { DeployContext } from '../commands/deploy-context';
import { activeNodes } from '../commands/deploy-context';
import {
  buildAccessoriesInput,
  buildAndDistribute,
  cleanupBundle,
  declaredHelmNames,
  deployAccessories,
  deployApp,
  dirBackupPath,
  ensureRegistryAccess,
  fileBackupPath,
  filterUploads,
  hasLiveAccessoryReleases,
  isControlPlaneLoss,
  parseOnly,
  printArtifactDiagnostics,
  recordHistory,
  releaseLock,
  resolveFileDestPath,
  runPostRollbackHealthChecks,
  runWithConcurrency,
  settles,
  uploadName,
  uploadOwnedDir,
} from '../commands/deploy-phases';
import type { Audit } from '../services/audit';
import { HealthCheck } from '../services/health-check';
import * as HistorySync from '../services/history-sync';
import type { Metrics } from '../services/metrics';
import type { DeployReceipt, HelmReleaseStatus, ImageDelivery, ResolvedHelmRelease, StackArtifact, StackRef } from '../services/orchestrator/interfaces';
import { KubeError } from '../services/orchestrator/kubernetes/runtime/errors';
import { err, ok } from '../types/result';
import type { UploadItem } from '../utils/config';
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

describe('the accessory role without accessories.yml', () => {
  const NONE: ImageDelivery = { built: [], mode: 'none', pullSecretName: null };
  const withAccessoryRelease = config({
    helm: { releases: [{ name: 'postgres', chart: 'postgresql', repo: 'https://charts.example.org', version: '16.7.4', role: 'accessory' }] },
  });
  const release = (name: string, role: HelmReleaseStatus['role']): HelmReleaseStatus => ({
    name,
    namespace: 'shop-production',
    role,
    revision: 1,
    status: 'deployed',
    chart: `${name}-1.0.0`,
    appVersion: null,
    updated: null,
  });

  it('runs with no compose service when an accessory Helm release is declared', () => {
    const input = buildAccessoriesInput(fakeContext(new FakeOrchestrator('k3s'), { config: withAccessoryRelease }), NONE);
    expect(input?.ref.role).toBe('accessory');
    expect(input?.compose.services).toEqual({});
    expect(input?.helm.map((r) => r.name)).toEqual(['postgres']);
  });

  it('runs when accessory releases are still installed, so the undeclared ones are reported', () => {
    expect(buildAccessoriesInput(fakeContext(new FakeOrchestrator('k3s')), NONE)).toBeNull();
    expect(buildAccessoriesInput(fakeContext(new FakeOrchestrator('k3s')), NONE, true)?.helmDeclared).toEqual([]);
  });

  it('asks the cluster only when nothing else runs the role, and counts accessory releases only', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.programOnce('helm.listAll', [release('search', 'app')]);
    expect(await hasLiveAccessoryReleases(fakeContext(orchestrator))).toBe(false);
    orchestrator.programOnce('helm.listAll', [release('search', 'app'), release('cache', 'accessory')]);
    expect(await hasLiveAccessoryReleases(fakeContext(orchestrator))).toBe(true);

    const declared = new FakeOrchestrator('k3s');
    expect(await hasLiveAccessoryReleases(fakeContext(declared, { config: withAccessoryRelease }))).toBe(false);
    expect(await hasLiveAccessoryReleases(fakeContext(declared, { skipAccessories: true }))).toBe(false);
    expect(declared.events).toEqual([]);
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

  it('a rejecting finalize becomes a warning, not a thrown error (K33 (a), U-FLOW-12)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.finalize', new Error('prune failed: Forbidden'));
    await deployAccessories(fakeContext(orchestrator), deployInput({ ref: { role: 'accessory' } }));
    expect(recorded.warn).toEqual(['Cleanup after deploy failed: prune failed: Forbidden; the deploy itself succeeded']);
    expect(recorded.success).toEqual(['Accessories deployed']);
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

  it('a rejecting finalize becomes a warning, not a thrown error (K33 (a), U-FLOW-12)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.finalize', new Error('GC failed: Forbidden'));
    const ctx = fakeContext(orchestrator);
    await deployApp(ctx, deployInput()); // must resolve, not reject
    expect(recorded.warn).toEqual(['Cleanup after deploy failed: GC failed: Forbidden; the deploy itself succeeded']);
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

// ---------------------------------------------------------------------------
// Uploads — pure helpers (ClusterConnection/ClusterNode adapted to OrchestratorTarget/ClusterNodeRef)
// ---------------------------------------------------------------------------

describe('filterUploads', () => {
  const uploads: UploadItem[] = [
    { src: 'global.conf', dest: '/etc/global.conf' }, // no service
    { src: 'web.conf', dest: '/etc/web.conf', service: 'web' }, // string service
    { src: 'shared.conf', dest: '/etc/shared.conf', service: ['web', 'api'] }, // array service
  ];

  it('no uploads -> empty list', () => {
    expect(filterUploads(undefined)).toEqual([]);
    expect(filterUploads([])).toEqual([]);
  });

  it('no --only filter -> everything', () => {
    expect(filterUploads(uploads)).toHaveLength(3);
  });

  it('uploads without service always apply', () => {
    const result = filterUploads(uploads, 'worker');
    expect(result.map((u) => u.src)).toEqual(['global.conf']);
  });

  it('string service matches', () => {
    const result = filterUploads(uploads, 'web');
    expect(result.map((u) => u.src)).toEqual(['global.conf', 'web.conf', 'shared.conf']);
  });

  it('array service matches any targeted service', () => {
    const result = filterUploads(uploads, 'api');
    expect(result.map((u) => u.src)).toEqual(['global.conf', 'shared.conf']);
  });

  it('comma-separated filter with spaces', () => {
    expect(filterUploads(uploads, 'worker, web')).toHaveLength(3);
  });
});

describe('resolveFileDestPath', () => {
  it('trailing slash -> dest dir + source basename', () => {
    expect(resolveFileDestPath('/etc/app/', 'config.yml')).toBe('/etc/app/config.yml');
  });

  it('no trailing slash -> dest used verbatim (rename allowed)', () => {
    expect(resolveFileDestPath('/etc/app/renamed.yml', 'config.yml')).toBe('/etc/app/renamed.yml');
  });
});

describe('upload backup paths', () => {
  const base = '/var/lib/dockflow/upload-backups/shop-production/1.4.2';

  it('file backup mirrors the destination path under the backup dir', () => {
    expect(fileBackupPath(base, '/etc/app/config.yml')).toBe(`${base}/etc/app/config.yml`);
  });

  it('dir backup is a tar.gz named after the destination', () => {
    expect(dirBackupPath(base, '/srv/app')).toBe(`${base}/srv/app.tar.gz`);
  });

  it('invariant: rollback reads the exact path upload wrote', () => {
    // uploadFiles writes fileBackupPath(base, destPath); rollbackUploads recomputes it from the
    // same inputs — they must always agree.
    const destPath = resolveFileDestPath('/etc/nginx/', 'site.conf');
    expect(fileBackupPath(base, destPath)).toBe(`${base}/etc/nginx/site.conf`);
  });
});

describe('runWithConcurrency', () => {
  it('runs every task exactly once', async () => {
    const done: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      done.push(i);
    });
    await runWithConcurrency(tasks, 3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 12 }, () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await runWithConcurrency(tasks, 4);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('propagates task errors', async () => {
    const tasks = [
      async () => {},
      async () => {
        throw new Error('boom');
      },
    ];
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('boom');
  });

  it('handles an empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toBeUndefined();
  });
});

describe('uploadOwnedDir', () => {
  it('file destination -> the directory holding it', () => {
    expect(uploadOwnedDir('/var/lib/app/seed/data.sql', false)).toBe('/var/lib/app/seed');
  });

  it('directory upload -> the destination itself', () => {
    expect(uploadOwnedDir('/etc/nginx/conf.d', true)).toBe('/etc/nginx/conf.d');
  });

  it('trailing slash means a directory even for a single file', () => {
    expect(uploadOwnedDir('/etc/nginx/conf.d/', false)).toBe('/etc/nginx/conf.d');
  });

  it('strips the trailing slash of a directory upload', () => {
    expect(uploadOwnedDir('/srv/app/', true)).toBe('/srv/app');
  });

  it('file at the filesystem root', () => {
    expect(uploadOwnedDir('/motd', false)).toBe('/');
  });
});

describe('uploadName', () => {
  it('a project upload is named by its source path', () => {
    expect(uploadName({ src: '.dockflow/services/app.service', dest: '/etc/systemd/system/app.service' })).toBe('.dockflow/services/app.service');
  });

  it('a plugin upload is named by its label, not by its in-memory key', () => {
    expect(uploadName({ src: '.dockflow/plugins/.instances/nginx/plugin/vhost.conf', dest: '/x', label: 'nginx › vhost.conf' })).toBe('nginx › vhost.conf');
  });
});

// ---------------------------------------------------------------------------
// recordHistory (audit + metrics + sync, 19.3)
// ---------------------------------------------------------------------------

function fakeAudit(writeEntry: Audit['writeEntry']): Audit {
  return { writeEntry } as unknown as Audit;
}

function fakeMetrics(writeDeployment: Metrics['writeDeployment']): Metrics {
  return { writeDeployment } as unknown as Metrics;
}

describe('recordHistory', () => {
  it('writes audit + metrics, then syncs both to every active node but the control plane', async () => {
    const orchestrator = new FakeOrchestrator('k3s', { target: { managers: [nodeRef('server_1'), nodeRef('server_2')] } });
    const auditCalls: unknown[][] = [];
    const audit = fakeAudit(async (...args) => {
      auditCalls.push(args);
      return 'audit-line';
    });
    const metrics = fakeMetrics(async () => 'metrics-json');
    const syncSpy = spyOn(HistorySync, 'syncToAllNodes').mockResolvedValue(undefined);

    const ctx = fakeContext(orchestrator, { audit, metrics });
    await recordHistory(ctx, 'success', 1234, 'Deployed 1.4.2 to production successfully');

    expect(auditCalls).toEqual([[ctx.stackName, 'deployed', 'Deployed 1.4.2 to production successfully', ctx.deployVersion]]);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    const [conns, stackName, auditLine, metricsJson] = syncSpy.mock.calls[0] as [unknown[], string, string, string];
    expect(conns).toHaveLength(2); // server_2 + agent_1, never the control plane (server_1)
    expect(stackName).toBe(ctx.stackName);
    expect(auditLine).toBe('audit-line');
    expect(metricsJson).toBe('metrics-json');
    expect(recorded.warn).toEqual([]);

    syncSpy.mockRestore();
  });

  it('a failing audit or metrics write is a warning, never thrown, and history sync still runs', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const audit = fakeAudit(async () => {
      throw new Error('disk full');
    });
    const metrics = fakeMetrics(async () => 'metrics-json');
    const syncSpy = spyOn(HistorySync, 'syncToAllNodes').mockResolvedValue(undefined);

    const ctx = fakeContext(orchestrator, { audit, metrics });
    await recordHistory(ctx, 'failed', 500, 'Deploy 1.4.2 to production failed: boom');

    expect(recorded.warn).toEqual(['Audit write failed: disk full']);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    // the audit line could not be written: history sync still runs, with an empty audit line
    expect(syncSpy.mock.calls[0][2]).toBe('');

    syncSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runPostRollbackHealthChecks — (config, orchestrator), not a full DeployContext, so
// `dockflow rollback <env>` (design-06 3.13) can call it without building one
// ---------------------------------------------------------------------------

describe('runPostRollbackHealthChecks', () => {
  it('no health_checks configured: does nothing', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await runPostRollbackHealthChecks(config(), orchestrator);
    expect(recorded.warn).toEqual([]);
  });

  it('health_checks.enabled: false: does nothing even with endpoints configured', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const cfg = config({ health_checks: { enabled: false, endpoints: [{ url: 'https://shop.example.com/health' }] } });
    await runPostRollbackHealthChecks(cfg, orchestrator);
    expect(recorded.warn).toEqual([]);
  });

  it('a failing endpoint check becomes a warning, never thrown (best-effort, on_failure forced to notify)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const cfg = config({ health_checks: { endpoints: [{ url: 'https://shop.example.com/health' }], on_failure: 'fail' } });
    const spy = spyOn(HealthCheck.prototype, 'checkHTTPEndpoints').mockRejectedValue(new Error('HTTP health checks failed: https://shop.example.com/health'));

    await runPostRollbackHealthChecks(cfg, orchestrator);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].on_failure).toBe('notify'); // never rolls back a rollback
    expect(recorded.warn).toEqual(['Post-rollback health check failed: HTTP health checks failed: https://shop.example.com/health']);

    spy.mockRestore();
  });
});
