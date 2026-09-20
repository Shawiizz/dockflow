// T/commands/helm.test.ts (P66-helm-commands, design-04 3.12): one describe per `dockflow helm`
// subcommand, plus the shared context/target/confirmation helpers of `commands/helm/utils.ts`.
// Every subcommand's core logic is exercised directly (`runHelm*`) against a `HelmCommandContext`
// built around `FakeOrchestrator`, which is how design-07 3.8's harness reaches command code without
// `mock.module` (README: "No test uses real time or mock.module").

import { describe, expect, it, spyOn } from 'bun:test';
import type { DockflowConfig } from '../../../utils/config';
import { UnsupportedOperationError } from '../../../utils/errors';
import type { HelmReleaseStatus } from '../../../services/orchestrator/interfaces';
import { K8S_PROXY_RELEASE, K8S_SYSTEM_NAMESPACE } from '../../../services/orchestrator/kubernetes/constants';
import {
  type DeclaredRelease,
  type HelmCommandContext,
  confirmOrThrow,
  helmHistoryMaxFor,
  openHelmCommand,
  resolveReleaseTarget,
  resolveTimeoutS,
} from '../../../commands/helm/utils';
import { runHelmHistory } from '../../../commands/helm/history';
import { runHelmList } from '../../../commands/helm/list';
import { runHelmRollback } from '../../../commands/helm/rollback';
import { runHelmStatus } from '../../../commands/helm/status';
import { runHelmUninstall } from '../../../commands/helm/uninstall';
import { runHelmValues } from '../../../commands/helm/values';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function baseConfig(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', orchestrator: 'k3s', ...overrides };
}

function declared(overrides: Partial<DeclaredRelease> = {}): DeclaredRelease {
  return { name: 'search', role: 'app', namespace: 'dockflow-shop-production', chart: 'search', version: '2.4.1', timeoutS: 300, ...overrides };
}

function contextFor(orchestrator: FakeOrchestrator, options: { config?: DockflowConfig; declared?: DeclaredRelease[] } = {}): HelmCommandContext {
  const config = options.config ?? baseConfig();
  const stackId = orchestrator.naming.scope({ project: orchestrator.target.project, env: orchestrator.target.env, role: 'app' });
  const helm = orchestrator.helm;
  if (helm === null) throw new Error('test setup: FakeOrchestrator was built without the helm capability');
  return {
    env: orchestrator.target.env,
    config,
    orchestrator,
    helm,
    stackId,
    stackName: orchestrator.target.stackName,
    declared: options.declared ?? [],
  };
}

/** `printJSON` (utils/output.ts) writes one `console.log(JSON.stringify(...))` call; this captures and parses it. */
async function captureJson<T>(run: () => Promise<void>): Promise<T> {
  const spy = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await run();
    const text = spy.mock.calls[0]?.[0] as string | undefined;
    if (text === undefined) throw new Error('test setup: nothing was printed to stdout');
    return JSON.parse(text) as T;
  } finally {
    spy.mockRestore();
  }
}

function statusOf(overrides: Partial<HelmReleaseStatus> = {}): HelmReleaseStatus {
  return { name: 'search', namespace: 'dockflow-shop-production', role: 'app', revision: 7, status: 'deployed', chart: 'search-2.4.1', appVersion: '5.1.0', updated: '2026-09-17T10:11:12Z', ...overrides };
}

function historyEntryOf(overrides: Partial<HelmReleaseStatus> = {}, description: string | null = null): HelmReleaseStatus & { description: string | null } {
  return { ...statusOf(overrides), description };
}

// ---------------------------------------------------------------------------
// openHelmCommand
// ---------------------------------------------------------------------------

describe('openHelmCommand', () => {
  it('U-CMD-REFUSE-03: refuses on Swarm before openOrchestrator', async () => {
    let opened = false;
    await expect(
      openHelmCommand(
        'production',
        {},
        'dockflow helm list',
        {
          loadConfig: () => baseConfig({ orchestrator: 'swarm' }),
          openOrchestrator: async () => {
            opened = true;
            throw new Error('should never be reached');
          },
        },
      ),
    ).rejects.toThrow(UnsupportedOperationError);
    expect(opened).toBe(false);
  });

  it('the refusal message and suggestion match the shared helm capability constant', async () => {
    await expect(
      openHelmCommand('production', {}, 'dockflow helm list', {
        loadConfig: () => baseConfig({ orchestrator: 'swarm' }),
        openOrchestrator: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toMatchObject({ message: 'dockflow helm list requires orchestrator: k3s', suggestion: 'Helm releases are only supported on Kubernetes.' });
  });

  it('builds declared releases from config.yml, defaulting role, namespace and timeout', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const config = baseConfig({
      helm: {
        timeout: '10m',
        releases: [
          { name: 'search', chart: 'search', repo: 'https://charts.example.org', version: '2.4.1' },
          { name: 'metrics', chart: 'metrics', repo: 'https://charts.example.org', version: '1.0.0', role: 'accessory', namespace: 'dockflow-metrics', timeout: '2m' },
        ],
      },
    });
    const ctx = await openHelmCommand('production', {}, 'dockflow helm list', {
      loadConfig: () => config,
      openOrchestrator: async () => ({ config, orchestrator }),
    });
    expect(ctx.declared).toEqual([
      { name: 'search', role: 'app', namespace: 'dockflow-shop-production', chart: 'search', version: '2.4.1', timeoutS: 600 },
      { name: 'metrics', role: 'accessory', namespace: 'dockflow-metrics', chart: 'metrics', version: '1.0.0', timeoutS: 120 },
    ]);
    expect(ctx.stackId).toBe('dockflow-shop-production');
  });
});

// ---------------------------------------------------------------------------
// resolveReleaseTarget
// ---------------------------------------------------------------------------

describe('resolveReleaseTarget', () => {
  it('--system with a release name is refused', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(resolveReleaseTarget(ctx, 'search', { system: true })).rejects.toThrow('--system targets the Dockflow Traefik release; omit the release name');
  });

  it('--system resolves the Traefik release', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, chart: 'traefik-41.6.0' }));
    const ctx = contextFor(orchestrator);
    const target = await resolveReleaseTarget(ctx, undefined, { system: true });
    expect(target).toMatchObject({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, system: true, declared: null });
  });

  it('--system when Traefik is not installed', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(resolveReleaseTarget(ctx, undefined, { system: true })).rejects.toMatchObject({
      message: 'Traefik is not installed on production',
      suggestion: 'It is installed by `dockflow deploy <env>` when `proxy.enabled` is true.',
    });
  });

  it('no name and no --system is refused', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(resolveReleaseTarget(ctx, undefined, {})).rejects.toThrow('A Helm release name is required');
  });

  it('the Traefik release name without --system is refused', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(resolveReleaseTarget(ctx, K8S_PROXY_RELEASE, {})).rejects.toThrow('dockflow-traefik is the Dockflow Traefik release');
  });

  it('an owned release resolves with its declared entry', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    const target = await resolveReleaseTarget(ctx, 'search', {});
    expect(target.declared).toEqual(declared());
    expect(target.status.revision).toBe(7);
  });

  it('declared but not installed', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const ctx = contextFor(orchestrator, { declared: [declared({ name: 'metrics' })] });
    await expect(resolveReleaseTarget(ctx, 'metrics', {})).rejects.toMatchObject({
      message: 'Helm release metrics is declared in config.yml but not installed on production',
      suggestion: 'Deploy it with `dockflow deploy production`.',
    });
  });

  it('neither owned nor declared', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(resolveReleaseTarget(ctx, 'ghost', {})).rejects.toMatchObject({
      message: 'Helm release ghost not found for production',
      suggestion: 'List releases with `dockflow helm list production`.',
    });
  });
});

// ---------------------------------------------------------------------------
// confirmOrThrow / timeouts / history max
// ---------------------------------------------------------------------------

describe('confirmOrThrow', () => {
  it('--yes skips the prompt entirely', async () => {
    await expect(confirmOrThrow({ yes: true, message: 'Uninstall?' })).resolves.toBe(true);
  });

  it('non-TTY without --yes is an error, never a silent cancel', async () => {
    await expect(confirmOrThrow({ message: 'Uninstall?' })).rejects.toMatchObject({
      message: 'Confirmation required',
      suggestion: 'Re-run with `--yes` in non-interactive sessions.',
    });
  });
});

describe('resolveTimeoutS', () => {
  it('--timeout outside 30s..1h is refused', () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    expect(() => resolveTimeoutS(ctx, '5s', null, false)).toThrow('--timeout must be between 30s and 1h');
    expect(() => resolveTimeoutS(ctx, '2h', null, false)).toThrow('--timeout must be between 30s and 1h');
  });

  it('falls back to the declared release timeout, then helm.timeout, then 5m', () => {
    const ctxWithGlobal = contextFor(new FakeOrchestrator('k3s'), { config: baseConfig({ helm: { timeout: '10m' } }) });
    expect(resolveTimeoutS(ctxWithGlobal, undefined, null, false)).toBe(600);
    expect(resolveTimeoutS(ctxWithGlobal, undefined, declared({ timeoutS: 120 }), false)).toBe(120);
    const ctxPlain = contextFor(new FakeOrchestrator('k3s'));
    expect(resolveTimeoutS(ctxPlain, undefined, null, false)).toBe(300);
  });

  it('--system always uses the 300s proxy timeout', () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    expect(resolveTimeoutS(ctx, undefined, null, true)).toBe(300);
  });
});

describe('helmHistoryMaxFor', () => {
  it('is max(5, keep_releases + 2)', () => {
    expect(helmHistoryMaxFor(baseConfig())).toBe(5);
    expect(helmHistoryMaxFor(baseConfig({ stack_management: { keep_releases: 10 } }))).toBe(12);
    expect(helmHistoryMaxFor(baseConfig({ stack_management: { keep_releases: 1 } }))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('helm list', () => {
  it('rejects an unknown --role', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(runHelmList(ctx, { role: 'bogus' })).rejects.toThrow("--role must be 'app' or 'accessory'");
  });

  it('merges owned releases with declared-but-not-installed ones', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ name: 'search' }), statusOf({ name: 'legacy', chart: 'legacy-1.0.0' })]);
    const ctx = contextFor(orchestrator, { declared: [declared({ name: 'search' }), declared({ name: 'metrics', role: 'accessory' })] });

    const rows = await captureJson<{ name: string; declared: boolean; installed: boolean }[]>(() => runHelmList(ctx, { json: true }));
    expect(rows.find((row) => row.name === 'search')).toMatchObject({ declared: true, installed: true });
    expect(rows.find((row) => row.name === 'legacy')).toMatchObject({ declared: false, installed: true });
    expect(rows.find((row) => row.name === 'metrics')).toMatchObject({ declared: true, installed: false });
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('helm status', () => {
  it('assembles the JSON shape with chartSha256 and the Delete reclaim warning', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.manifestObjects', [{ kind: 'PersistentVolumeClaim', name: 'search-cache', namespace: 'dockflow-shop-production', keep: true, claimTemplates: [] }]);
    orchestrator.program('volumes.list', [{ name: 'search-cache', composeName: null, role: null, phase: 'Bound' as const, capacity: '1Gi', storageClass: 'dockflow-local', node: 'main', reclaimPolicy: 'Delete' as const, usedBy: [], hostPath: null }]);
    orchestrator.program('releases.current', { project_name: 'shop', version: '1.4.2', env: 'production', timestamp: '2026-09-17T10:00:00Z', epoch: 1, performer: 'test', branch: 'main', helm: [{ name: 'search', chart: 'search', version: '2.4.1', values_sha256: 'x', chart_sha256: '9f2c' }] });
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    const payload = await captureJson<{ chartSha256: string; volumes: { reclaimPolicy: string }[] }>(() => runHelmStatus(ctx, 'search', { json: true }));
    expect(payload.chartSha256).toBe('9f2c');
    expect(payload.volumes[0].reclaimPolicy).toBe('Delete');
  });
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

describe('helm history', () => {
  it('rejects --max outside 1..256', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(runHelmHistory(ctx, undefined, { system: true, max: '0' })).rejects.toThrow('--max must be an integer between 1 and 256');
    await expect(runHelmHistory(ctx, undefined, { system: true, max: '257' })).rejects.toThrow('--max must be an integer between 1 and 256');
  });

  it('marks the deployed revision and keeps full descriptions in --json', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null }));
    const longDescription = 'x'.repeat(200);
    orchestrator.program('helm.history', [
      historyEntryOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null }, longDescription),
      historyEntryOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, revision: 6, status: 'superseded' }, 'previous'),
    ]);
    const ctx = contextFor(orchestrator);

    const rows = await captureJson<{ revision: number; deployed: boolean; description: string }[]>(() => runHelmHistory(ctx, undefined, { system: true, json: true }));
    expect(rows.find((row) => row.revision === 7)?.deployed).toBe(true);
    expect(rows.find((row) => row.revision === 7)?.description.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

describe('helm values', () => {
  it('masks sensitive leaves by key name', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.deployedValues', { values: { replicaCount: 2, auth: { password: 'hunter2' }, apiKey: 'abc' }, valuesSha256: 'x' });
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    const payload = await captureJson<{ replicaCount: number; auth: { password: string }; apiKey: string }>(() => runHelmValues(ctx, 'search', { json: true }));
    expect(payload.replicaCount).toBe(2);
    expect(payload.auth.password).toBe('***');
    expect(payload.apiKey).toBe('***');
  });

  it('--reveal without a TTY is refused', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmValues(ctx, 'search', { reveal: true })).rejects.toThrow('--reveal prints secret values and needs an interactive terminal');
  });

  it('rejects a non-positive --revision', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmValues(ctx, 'search', { revision: '0' })).rejects.toThrow('--revision must be a positive integer');
  });
});

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

describe('helm uninstall', () => {
  it('--volumes and --keep-volumes cannot be combined', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(runHelmUninstall(ctx, 'search', { volumes: true, keepVolumes: true, yes: true })).rejects.toThrow('--volumes and --keep-volumes cannot be combined');
  });

  it('--force only applies with --system', async () => {
    const ctx = contextFor(new FakeOrchestrator('k3s'));
    await expect(runHelmUninstall(ctx, 'search', { force: true, yes: true })).rejects.toThrow('--force only applies with --system');
  });

  it('refuses without a volume flag when the release owns deletable volumes', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.manifestObjects', [{ kind: 'PersistentVolumeClaim', name: 'search-cache', namespace: 'dockflow-shop-production', keep: false, claimTemplates: [] }]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmUninstall(ctx, 'search', { yes: true })).rejects.toMatchObject({
      message: 'Helm release search owns volumes that an uninstall deletes (search-cache)',
      suggestion: 'Re-run with `--volumes` to delete them with their data, or with `--keep-volumes` to keep the data as released volumes.',
    });
  });

  it('non-TTY without -y is refused (typed confirmation for --volumes)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmUninstall(ctx, 'search', { volumes: true })).rejects.toThrow('Confirmation required');
    expect(orchestrator.callsTo('helm.uninstall')).toHaveLength(0);
  });

  it('-y skips the prompt, acquires the lock, uninstalls and deletes surviving claim-template volumes', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.manifestObjects', [{ kind: 'StatefulSet', name: 'search-index', namespace: 'dockflow-shop-production', keep: false, claimTemplates: ['data'] }]);
    orchestrator.program('volumes.list', [{ name: 'data-search-index-0', composeName: null, role: null, phase: 'Bound' as const, capacity: '10Gi', storageClass: 'dockflow-local', node: 'main', reclaimPolicy: 'Retain' as const, usedBy: [], hostPath: null }]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    await runHelmUninstall(ctx, 'search', { volumes: true, yes: true });

    const methodOrder = orchestrator.calls.map((call) => call.method);
    expect(methodOrder).toContain('lock.acquire');
    expect(methodOrder.indexOf('lock.acquire')).toBeLessThan(methodOrder.indexOf('helm.uninstall'));
    expect(methodOrder.indexOf('helm.uninstall')).toBeLessThan(methodOrder.indexOf('lock.release'));
    expect(orchestrator.callsTo('volumes.remove')[0]).toEqual([{ project: 'shop', env: 'production', role: null, namespace: 'dockflow-shop-production' }, ['data-search-index-0']]);
    expect(orchestrator.lockHolder('dockflow-shop-production')).toBeNull();
  });

  it('a held lock is reported as DEPLOY_LOCKED', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    const held = await orchestrator.lock('dockflow-shop-production').acquire({ message: 'another deploy' });
    expect(held.success).toBe(true);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmUninstall(ctx, 'search', { yes: true })).rejects.toThrow(/Already locked/);
  });

  it('--volumes also deletes the PV a deletable PVC was bound to, alongside surviving volumes', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.manifestObjects', [
      { kind: 'PersistentVolumeClaim', name: 'search-cache', namespace: 'dockflow-shop-production', keep: false, claimTemplates: [] },
      { kind: 'StatefulSet', name: 'search-index', namespace: 'dockflow-shop-production', keep: false, claimTemplates: ['data'] },
    ]);
    orchestrator.program('volumes.list', [
      { name: 'search-cache', composeName: null, role: null, phase: 'Bound' as const, capacity: '1Gi', storageClass: 'dockflow-local', node: 'main', reclaimPolicy: 'Retain' as const, usedBy: [], hostPath: null, boundVolume: 'pvc-abcd' },
      { name: 'data-search-index-0', composeName: null, role: null, phase: 'Bound' as const, capacity: '10Gi', storageClass: 'dockflow-local', node: 'main', reclaimPolicy: 'Retain' as const, usedBy: [], hostPath: null },
    ]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    await runHelmUninstall(ctx, 'search', { volumes: true, yes: true });

    const removed = (orchestrator.callsTo('volumes.remove')[0][1] as string[]).slice().sort();
    expect(removed).toEqual(['data-search-index-0', 'pvc-abcd']);
  });

  it('--keep-volumes patches the deletable PVCs bound PVs to Retain before uninstalling', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf()]);
    orchestrator.program('helm.manifestObjects', [{ kind: 'PersistentVolumeClaim', name: 'search-cache', namespace: 'dockflow-shop-production', keep: false, claimTemplates: [] }]);
    orchestrator.program('volumes.list', [{ name: 'search-cache', composeName: null, role: null, phase: 'Bound' as const, capacity: '1Gi', storageClass: 'dockflow-local', node: 'main', reclaimPolicy: 'Delete' as const, usedBy: [], hostPath: null, boundVolume: 'pvc-1234' }]);
    const retained: string[][] = [];
    orchestrator.volumes.retainVolumes = async (_scope, names) => {
      retained.push(names);
      orchestrator.events.push('volumes.retainVolumes');
      return { changed: names };
    };
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    await runHelmUninstall(ctx, 'search', { keepVolumes: true, yes: true });

    expect(retained).toEqual([['pvc-1234']]);
    expect(orchestrator.events.indexOf('volumes.retainVolumes')).toBeLessThan(orchestrator.events.indexOf('helm.uninstall:search'));
  });

  it('--system without --force refuses while routes still depend on the proxy', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null }));
    orchestrator.proxy.routesInUse = async () => ({ namespaces: ['dockflow-shop-production'], ingressRoutes: 2, ingresses: 0 });
    const ctx = contextFor(orchestrator);

    await expect(runHelmUninstall(ctx, undefined, { system: true, yes: true })).rejects.toMatchObject({
      message: 'Traefik still serves routes in 1 namespace(s): dockflow-shop-production (2 IngressRoute(s), 0 Ingress object(s))',
      suggestion: 'Set `proxy.enabled: false` and deploy those stacks, remove those Ingress objects, or re-run with `--force`.',
    });
    expect(orchestrator.callsTo('helm.uninstall')).toHaveLength(0);
  });

  it('--system --force skips the routes check even when routes remain', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null }));
    let routesChecked = false;
    orchestrator.proxy.routesInUse = async () => {
      routesChecked = true;
      return { namespaces: ['dockflow-shop-production'], ingressRoutes: 1, ingresses: 0 };
    };
    const ctx = contextFor(orchestrator);

    await runHelmUninstall(ctx, undefined, { system: true, force: true, yes: true });

    expect(routesChecked).toBe(false);
    expect(orchestrator.callsTo('helm.uninstall')).toHaveLength(1);
  });

  it('--system forgets the proxy ownership record after Traefik is uninstalled', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null }));
    orchestrator.proxy.forget = async () => {
      orchestrator.events.push('proxy.forget');
    };
    const ctx = contextFor(orchestrator);

    await runHelmUninstall(ctx, undefined, { system: true, yes: true });

    expect(orchestrator.events.indexOf('proxy.forget')).toBeGreaterThan(orchestrator.events.indexOf(`helm.uninstall:${K8S_PROXY_RELEASE}`));
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe('helm rollback', () => {
  it('defaults to the newest superseded revision below the deployed one', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ revision: 7 })]);
    orchestrator.program('helm.history', [
      historyEntryOf({ revision: 7, status: 'deployed' }),
      historyEntryOf({ revision: 6, status: 'superseded' }),
      historyEntryOf({ revision: 5, status: 'superseded', chart: 'search-2.4.0', appVersion: '5.0.3' }),
    ]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });

    await runHelmRollback(ctx, 'search', undefined, { yes: true });

    expect(orchestrator.callsTo('helm.rollback')[0][2]).toBe(6);
  });

  it('no earlier deployed revision', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ revision: 1 })]);
    orchestrator.program('helm.history', [historyEntryOf({ revision: 1, status: 'deployed' })]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmRollback(ctx, 'search', undefined, { yes: true })).rejects.toThrow('Helm release search has no earlier deployed revision');
  });

  it('a failed revision is refused', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ revision: 7 })]);
    orchestrator.program('helm.history', [historyEntryOf({ revision: 7, status: 'deployed' }), historyEntryOf({ revision: 6, status: 'failed' })]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmRollback(ctx, 'search', '6', { yes: true })).rejects.toThrow('Revision 6 of search was never successfully deployed');
  });

  it('rolling back to the currently deployed revision is a no-op', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ revision: 7 })]);
    orchestrator.program('helm.history', [historyEntryOf({ revision: 7, status: 'deployed' })]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await runHelmRollback(ctx, 'search', '7', { yes: true });
    expect(orchestrator.callsTo('helm.rollback')).toHaveLength(0);
  });

  it('--system rolls the Traefik release back with the proxy lease and a 5-revision history max', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.status', statusOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, revision: 3 }));
    orchestrator.program('helm.history', [
      historyEntryOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, revision: 3, status: 'deployed' }),
      historyEntryOf({ name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE, role: null, revision: 2, status: 'superseded' }),
    ]);
    const ctx = contextFor(orchestrator);

    await runHelmRollback(ctx, undefined, '2', { system: true, yes: true });

    const call = orchestrator.callsTo('helm.rollback')[0];
    expect(call).toEqual([K8S_SYSTEM_NAMESPACE, K8S_PROXY_RELEASE, 2, expect.objectContaining({ historyMax: 5 })]);
  });

  it('non-TTY without -y is refused before any backend call', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('helm.listAll', [statusOf({ revision: 7 })]);
    orchestrator.program('helm.history', [historyEntryOf({ revision: 7, status: 'deployed' }), historyEntryOf({ revision: 6, status: 'superseded' })]);
    const ctx = contextFor(orchestrator, { declared: [declared()] });
    await expect(runHelmRollback(ctx, 'search', undefined, {})).rejects.toThrow('Confirmation required');
    expect(orchestrator.callsTo('helm.rollback')).toHaveLength(0);
  });
});
