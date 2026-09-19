import { describe, expect, test } from 'bun:test';
import type { HelmManifestObject, HelmPlanEntry, HelmReleaseRecord, HelmReleaseStatus, ResolvedHelmRelease } from '../../../services/orchestrator/interfaces';
import {
  accessoryOrphanWarnings,
  type ObservedRelease,
  pendingStaleAfterS,
  planRecordApply,
  planRelease,
  planRemovals,
  previousRevisionOf,
  type ReleasePlanContext,
  type RemovalInput,
  recoveryWarning,
} from '../../../services/orchestrator/kubernetes/helm/plan';

const NS = 'dockflow-shop-production';
const NOW = new Date('2026-09-17T12:00:00.000Z');
const STALE_S = pendingStaleAfterS(300);

function release(overrides: Partial<ResolvedHelmRelease> = {}): ResolvedHelmRelease {
  return {
    name: 'search',
    role: 'app',
    namespace: NS,
    chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'search' },
    version: '2.4.1',
    values: { replicaCount: 2 },
    valuesSha256: 'a'.repeat(64),
    timeoutS: 300,
    auth: null,
    declaredDigest: 'd'.repeat(64),
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedRelease> = {}): ObservedRelease {
  return {
    name: 'search',
    namespace: NS,
    revision: 4,
    status: 'deployed',
    chart: 'search-2.4.1',
    owner: { kind: 'me' },
    deployedSpecMatches: false,
    lastDeployedRevision: 4,
    pendingSince: null,
    ...overrides,
  };
}

const context = (overrides: Partial<ReleasePlanContext> = {}): ReleasePlanContext => ({
  now: NOW,
  namespaceOwner: 'mine',
  adoptAllowed: false,
  env: 'production',
  ...overrides,
});

/** `seconds` before NOW, as parseHelmTime renders it */
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

describe('pendingStaleAfterS', () => {
  test('twice the mutating guard: 2 640 s for 300 s, 5 040 s for 600 s', () => {
    expect(pendingStaleAfterS(300)).toBe(2640);
    expect(pendingStaleAfterS(600)).toBe(5040);
    expect(pendingStaleAfterS(30)).toBe(480);
  });
});

describe('planRelease (design-04 3.7.1)', () => {
  test('row 1: a namespace owned by another stack is blocked', () => {
    expect(planRelease(release(), null, context({ namespaceOwner: { stackName: 'wiki-production' } }))).toEqual({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: `Helm release search targets namespace ${NS}, which belongs to stack wiki-production`,
      suggestion: 'Omit `namespace`, or use a namespace no Dockflow stack owns.',
    });
  });

  test('row 2: absent or uninstalled -> installed', () => {
    const installed: HelmPlanEntry = { release: 'search', namespace: NS, action: 'installed', reason: 'not installed' };
    expect(planRelease(release(), null, context())).toEqual(installed);
    expect(planRelease(release(), observed({ status: 'uninstalled' }), context({ namespaceOwner: 'free' }))).toEqual(installed);
  });

  test('row 3: a release of another stack is blocked', () => {
    expect(planRelease(release(), observed({ owner: { kind: 'foreign', stackId: 'dockflow-wiki-production' } }), context())).toEqual({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: `Helm release search in namespace ${NS} belongs to stack dockflow-wiki-production`,
      suggestion: 'Rename the release in config.yml, or remove it from the other project first.',
    });
  });

  test('row 4: a stale pending release with a deployed revision is recovered first', () => {
    const pending = observed({ status: 'pending-upgrade', revision: 5, lastDeployedRevision: 4, pendingSince: ago(STALE_S + 1) });
    expect(planRelease(release(), pending, context())).toEqual({ release: 'search', namespace: NS, action: 'upgraded', reason: 'recover', rollbackTo: 4 });
    expect(recoveryWarning(pending, 4)).toEqual({
      code: 'W-HELM-RECOVER',
      message: `Helm release search was left in pending-upgrade since ${ago(STALE_S + 1)}; rolling back to revision 4 before upgrading`,
    });
  });

  test('staleness boundary: exactly the threshold is not stale, one second more is', () => {
    const at = (seconds: number) => planRelease(release(), observed({ status: 'pending-upgrade', pendingSince: ago(seconds) }), context());
    expect(at(STALE_S).action).toBe('blocked');
    expect(at(STALE_S + 1).reason).toBe('recover');
    // the threshold follows the release timeout
    const short = planRelease(release({ timeoutS: 30 }), observed({ status: 'pending-upgrade', pendingSince: ago(481) }), context());
    expect(short.reason).toBe('recover');
  });

  test('row 5: stale pending-install or pending-upgrade without a deployed revision is blocked with the uninstall command', () => {
    for (const status of ['pending-install', 'pending-upgrade'] as const) {
      const since = ago(STALE_S + 60);
      expect(planRelease(release(), observed({ status, revision: 1, lastDeployedRevision: null, pendingSince: since }), context())).toEqual({
        release: 'search',
        namespace: NS,
        action: 'blocked',
        reason: `Helm release search is stuck in ${status} since ${since} with no deployed revision to return to`,
        suggestion: 'Remove it with `dockflow helm uninstall production search`, then deploy again.',
      });
    }
  });

  test('row 6: a fresh pending release is blocked, naming status and rollback', () => {
    const since = ago(60);
    expect(planRelease(release(), observed({ status: 'pending-rollback', pendingSince: since, lastDeployedRevision: 3 }), context())).toEqual({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: `Helm release search has an operation in progress since ${since} (pending-rollback)`,
      suggestion:
        'Wait for it to finish (`dockflow helm status production search`), then deploy again; if nothing is running, return to the last good revision with `dockflow helm rollback production search 3`.',
    });
  });

  test('row 6: an unparseable or unknown pending time is never stale', () => {
    for (const pendingSince of ['not a time', null]) {
      const entry = planRelease(release(), observed({ status: 'pending-upgrade', pendingSince, lastDeployedRevision: null }), context());
      expect(entry.action).toBe('blocked');
      expect(entry.reason).toContain('has an operation in progress since');
    }
    const unknown = planRelease(release(), observed({ status: 'pending-install', pendingSince: null, lastDeployedRevision: null }), context());
    expect(unknown.reason).toBe('Helm release search has an operation in progress since an unknown time (pending-install)');
    expect(unknown.suggestion).toContain('`dockflow helm rollback production search <revision>`');
  });

  test('row 4 never recovers a release Dockflow did not install', () => {
    const entry = planRelease(release(), observed({ owner: { kind: 'none' }, status: 'pending-upgrade', pendingSince: ago(STALE_S + 1) }), context({ adoptAllowed: true }));
    expect(entry.action).toBe('blocked');
    expect(entry.reason).toContain('has an operation in progress');
  });

  test('row 7: an uninstalling release is blocked', () => {
    expect(planRelease(release(), observed({ status: 'uninstalling' }), context())).toEqual({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: 'Helm release search is being uninstalled',
      suggestion: 'Wait for the uninstall to finish, then deploy again.',
    });
  });

  test('row 8: --adopt with the same chart name and version adopts', () => {
    const unowned = observed({ owner: { kind: 'none' }, chart: 'search-v2.4.1' });
    expect(planRelease(release(), unowned, context({ adoptAllowed: true }))).toEqual({ release: 'search', namespace: NS, action: 'upgraded', reason: 'adopt' });
    const oci = release({ chart: { kind: 'oci', ref: 'oci://registry.example.com/charts/search' }, version: 'v2.4.1' });
    expect(planRelease(oci, observed({ owner: { kind: 'none' } }), context({ adoptAllowed: true })).reason).toBe('adopt');
  });

  test('row 8b: --adopt with the same chart and another version is blocked', () => {
    expect(planRelease(release(), observed({ owner: { kind: 'none' }, chart: 'search-2.3.0' }), context({ adoptAllowed: true }))).toEqual({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: `Helm release search in ${NS} runs chart search-2.3.0 and config.yml declares 2.4.1`,
      suggestion: 'Declare the version that is running and adopt that first, or uninstall the release with `dockflow helm uninstall production search` before deploying.',
    });
  });

  test('row 9: an unlabelled release is blocked without --adopt whatever its chart, and with --adopt for another chart', () => {
    const row9 = (chart: string): HelmPlanEntry => ({
      release: 'search',
      namespace: NS,
      action: 'blocked',
      reason: `Helm release search in namespace ${NS} exists and was not installed by Dockflow (chart ${chart})`,
      suggestion:
        'Review its values with `dockflow helm values production search`, then take it over with `dockflow deploy production --adopt search`, or rename the release in config.yml.',
    });
    expect(planRelease(release(), observed({ owner: { kind: 'none' } }), context())).toEqual(row9('search-2.4.1'));
    expect(planRelease(release(), observed({ owner: { kind: 'none' }, status: 'failed' }), context())).toEqual(row9('search-2.4.1'));
    expect(planRelease(release(), observed({ owner: { kind: 'none' }, chart: 'elastic-2.4.1' }), context({ adoptAllowed: true }))).toEqual(row9('elastic-2.4.1'));
  });

  test('row 10: failed -> upgraded', () => {
    expect(planRelease(release(), observed({ status: 'failed', deployedSpecMatches: true }), context())).toEqual({
      release: 'search',
      namespace: NS,
      action: 'upgraded',
      reason: 'failed',
    });
  });

  test('row 11: deployed with the desired spec hash -> skipped, whatever --adopt says', () => {
    const entry: HelmPlanEntry = { release: 'search', namespace: NS, action: 'skipped', reason: 'unchanged' };
    expect(planRelease(release(), observed({ deployedSpecMatches: true }), context())).toEqual(entry);
    expect(planRelease(release(), observed({ deployedSpecMatches: true }), context({ adoptAllowed: true }))).toEqual(entry);
  });

  test('row 12: otherwise -> upgraded, changed', () => {
    expect(planRelease(release(), observed(), context())).toEqual({ release: 'search', namespace: NS, action: 'upgraded', reason: 'changed' });
    expect(planRelease(release(), observed({ status: 'superseded', deployedSpecMatches: true }), context()).reason).toBe('changed');
  });

  test('previousRevisionOf: deployed revision, else the last deployed one', () => {
    expect(previousRevisionOf(observed({ revision: 4 }))).toBe(4);
    expect(previousRevisionOf(observed({ status: 'failed', revision: 5, lastDeployedRevision: 3 }))).toBe(3);
    expect(previousRevisionOf(observed({ status: 'failed', revision: 1, lastDeployedRevision: null }))).toBeNull();
    expect(previousRevisionOf(observed({ status: 'uninstalled' }))).toBeNull();
    expect(previousRevisionOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// planRemovals (3.7.2)
// ---------------------------------------------------------------------------

function owned(name: string, role: 'app' | 'accessory' | null, namespace = NS, status = 'deployed'): HelmReleaseStatus {
  return { name, namespace, role, revision: 1, status, chart: `${name}-1.0.0`, appVersion: '1', updated: null };
}

const pvc = (name: string, keep = false, namespace: string | null = null): HelmManifestObject => ({ kind: 'PersistentVolumeClaim', name, namespace, keep, claimTemplates: [] });
const deployment = (name: string): HelmManifestObject => ({ kind: 'Deployment', name, namespace: null, keep: false, claimTemplates: [] });
const statefulSet = (name: string, claims: string[], namespace: string | null = null): HelmManifestObject => ({
  kind: 'StatefulSet',
  name,
  namespace,
  keep: false,
  claimTemplates: claims,
});

function removals(overrides: Partial<RemovalInput>): ReturnType<typeof planRemovals> {
  return planRemovals({
    mode: 'finalize',
    owned: [],
    declared: new Set(),
    order: [],
    manifests: new Map(),
    livePvcs: new Map(),
    env: 'production',
    ...overrides,
  });
}

describe('planRemovals (design-04 3.7.2)', () => {
  const manifests = new Map<string, HelmManifestObject[]>([
    ['web', [deployment('web')]],
    ['cache', [deployment('cache'), pvc('cache-data')]],
    ['archive', [pvc('archive-data', true), deployment('archive')]],
    ['db', [statefulSet('db', ['data'])]],
  ]);
  const livePvcs = new Map([[NS, ['data-db-0', 'data-db-1', 'data-other-0', 'cache-data']]]);

  test('finalize: undeclared owned app releases; a PVC without keep keeps the release running with W-HELM-DV3', () => {
    const entries = removals({
      owned: [owned('web', 'app'), owned('cache', 'app'), owned('archive', 'app'), owned('db', 'app'), owned('kept', 'app'), owned('queue', 'accessory')],
      declared: new Set(['kept', 'queue']),
      manifests,
      livePvcs,
    });
    expect(entries).toEqual([
      { name: 'web', namespace: NS, role: 'app', action: 'uninstall', deletablePvcs: [], survivingPvcs: [] },
      { name: 'db', namespace: NS, role: 'app', action: 'uninstall', deletablePvcs: [], survivingPvcs: ['data-db-0', 'data-db-1'] },
      {
        name: 'cache',
        namespace: NS,
        role: 'app',
        action: 'keep-owns-volumes',
        deletablePvcs: ['cache-data'],
        survivingPvcs: [],
        warning: {
          code: 'W-HELM-DV3',
          message: 'Helm release cache is no longer in config.yml but owns volumes (cache-data); it keeps running',
          suggestion: 'Remove it with `dockflow helm uninstall production cache --volumes` (deletes the data) or `--keep-volumes`.',
        },
      },
      { name: 'archive', namespace: NS, role: 'app', action: 'uninstall', deletablePvcs: [], survivingPvcs: ['archive-data'] },
    ]);
  });

  test('finalize never takes a name declared by either role, nor an unlabelled or uninstalled release', () => {
    const entries = removals({
      owned: [owned('queue', 'app'), owned('loose', null), owned('gone', 'app', NS, 'uninstalled')],
      declared: new Set(['queue']),
    });
    expect(entries).toEqual([]);
  });

  test('stop: every owned app release; PVC owners kept with W-HELM-STOP-KEPT', () => {
    const entries = removals({ mode: 'stop', owned: [owned('web', 'app'), owned('cache', 'app'), owned('queue', 'accessory')], declared: new Set(['web', 'cache']), order: ['web', 'cache'], manifests });
    expect(entries.map((entry) => [entry.name, entry.action])).toEqual([
      ['cache', 'keep-owns-volumes'],
      ['web', 'uninstall'],
    ]);
    expect(entries[0].warning).toEqual({
      code: 'W-HELM-STOP-KEPT',
      message: 'Helm release cache owns volumes (cache-data) and was not uninstalled',
      suggestion: 'Remove it with `dockflow helm uninstall production cache --volumes` or `--keep-volumes`.',
    });
  });

  test('accessories-remove: owned accessory releases; PVC owners kept with W-HELM-ACC-KEPT', () => {
    const entries = removals({
      mode: 'accessories-remove',
      owned: [owned('web', 'app'), owned('cache', 'accessory'), owned('db', 'accessory')],
      manifests,
      livePvcs,
    });
    expect(entries.map((entry) => [entry.name, entry.action, entry.survivingPvcs])).toEqual([
      ['db', 'uninstall', ['data-db-0', 'data-db-1']],
      ['cache', 'keep-owns-volumes', []],
    ]);
    expect(entries[1].warning).toEqual({
      code: 'W-HELM-ACC-KEPT',
      message: 'Accessory Helm release cache owns volumes (cache-data) and was kept',
      suggestion: 'Re-run with `--volumes` to delete them, or run `dockflow helm uninstall production cache --keep-volumes`.',
    });
  });

  test('accessories-remove-volumes: every owned accessory release is uninstalled with its volumes', () => {
    const entries = removals({ mode: 'accessories-remove-volumes', owned: [owned('cache', 'accessory'), owned('db', 'accessory'), owned('web', 'app')], manifests, livePvcs });
    expect(entries).toEqual([
      { name: 'db', namespace: NS, role: 'accessory', action: 'uninstall-delete-volumes', deletablePvcs: [], survivingPvcs: ['data-db-0', 'data-db-1'] },
      { name: 'cache', namespace: NS, role: 'accessory', action: 'uninstall-delete-volumes', deletablePvcs: ['cache-data'], survivingPvcs: [] },
    ]);
  });

  test('a keep-annotated PVC and StatefulSet templates never block; templates are matched in the object namespace', () => {
    const entries = removals({
      owned: [owned('op', 'app', 'operator')],
      manifests: new Map([['op', [pvc('op-state', true), statefulSet('op-db', ['data'], 'operator-data'), pvc('op-cache', false, 'operator')]]]),
      livePvcs: new Map([
        ['operator-data', ['data-op-db-0']],
        ['operator', ['data-op-db-1']],
      ]),
    });
    expect(entries).toEqual([
      {
        name: 'op',
        namespace: 'operator',
        role: 'app',
        action: 'keep-owns-volumes',
        deletablePvcs: ['op-cache'],
        survivingPvcs: ['data-op-db-0', 'op-state'],
        warning: expect.objectContaining({ code: 'W-HELM-DV3' }),
      },
    ]);
  });

  test('ordering: reverse config order for declared names, then the others in descending code-unit order', () => {
    const entries = removals({
      mode: 'stop',
      owned: ['a', 'B', 'c', 'd', 'e'].map((name) => owned(name, 'app')),
      order: ['c', 'a', 'e'],
      declared: new Set(['c', 'a', 'e']),
    });
    expect(entries.map((entry) => entry.name)).toEqual(['e', 'a', 'c', 'd', 'B']);
  });

  test('accessoryOrphanWarnings: owned accessory releases missing from config.yml', () => {
    expect(
      accessoryOrphanWarnings({
        owned: [owned('db', 'accessory'), owned('cache', 'accessory'), owned('web', 'app'), owned('old', 'accessory', NS, 'uninstalled')],
        declared: new Set(['cache']),
        env: 'production',
      }),
    ).toEqual([
      {
        code: 'W-HELM-ACC-ORPHAN',
        message: 'Helm release db (accessory) is no longer in config.yml and keeps running',
        suggestion: 'Remove it with `dockflow helm uninstall production db`.',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// planRecordApply (3.7.3)
// ---------------------------------------------------------------------------

function record(name: string, overrides: Partial<HelmReleaseRecord> = {}): HelmReleaseRecord {
  const { auth: _auth, declaredDigest: _digest, ...rest } = release({ name });
  return { ...rest, chartSha256: 'c'.repeat(64), ...overrides };
}

describe('planRecordApply (design-04 3.7.3)', () => {
  const apply = (records: HelmReleaseRecord[], observations: [string, ObservedRelease | null][], specs: [string, number[]][] = []) =>
    planRecordApply({ records, observed: new Map(observations), specRevisions: new Map(specs), now: NOW, env: 'production' });

  test('deployed with the recorded spec -> unchanged', () => {
    expect(apply([record('search')], [['search', observed({ deployedSpecMatches: true })]], [['search', [4]]])).toEqual([{ name: 'search', action: 'unchanged' }]);
  });

  test('present with a revision carrying the spec -> native rollback to the newest such revision', () => {
    expect(apply([record('search')], [['search', observed({ revision: 7 })]], [['search', [3, 5, 2]]])).toEqual([{ name: 'search', action: 'native-rollback', revision: 5 }]);
    expect(apply([record('search')], [['search', observed({ status: 'failed', revision: 7 })]], [['search', [6]]])).toEqual([
      { name: 'search', action: 'native-rollback', revision: 6 },
    ]);
  });

  test('present without such a revision -> upgrade from record; absent -> install from record', () => {
    expect(apply([record('search'), record('db')], [['search', observed()], ['db', null]])).toEqual([
      { name: 'search', action: 'upgrade-from-record' },
      { name: 'db', action: 'install-from-record' },
    ]);
    expect(apply([record('db')], [['db', observed({ name: 'db', status: 'uninstalled' })]])).toEqual([{ name: 'db', action: 'install-from-record' }]);
    // a name missing from the map is absent
    expect(apply([record('db')], [])).toEqual([{ name: 'db', action: 'install-from-record' }]);
  });

  test('a record without a chart digest is applied with the unverified warning, on the network paths only', () => {
    const warning = {
      code: 'W-HELM-CHART-UNVERIFIED',
      message: 'Helm release search was recorded without a chart digest, so its content cannot be verified',
      suggestion: 'Deploy again to record it.',
    };
    const legacy = record('search', { chartSha256: null });
    expect(apply([legacy], [['search', observed()]])).toEqual([{ name: 'search', action: 'upgrade-from-record', warning }]);
    expect(apply([legacy], [['search', null]])).toEqual([{ name: 'search', action: 'install-from-record', warning }]);
    expect(apply([legacy], [['search', observed()]], [['search', [2]]])).toEqual([{ name: 'search', action: 'native-rollback', revision: 2 }]);
  });

  test('pending, foreign and unmanaged releases are blocked; a rollback never recovers nor adopts', () => {
    const since = ago(STALE_S + 1);
    const [stale] = apply([record('search')], [['search', observed({ status: 'pending-upgrade', pendingSince: since, lastDeployedRevision: 3 })]], [['search', [3]]]);
    expect(stale).toEqual({
      name: 'search',
      action: 'blocked',
      message: `Helm release search has an operation in progress since ${since} (pending-upgrade)`,
      suggestion:
        'Wait for it to finish (`dockflow helm status production search`), then deploy again; if nothing is running, return to the last good revision with `dockflow helm rollback production search 3`.',
    });
    const [foreign] = apply([record('search')], [['search', observed({ owner: { kind: 'foreign', stackId: 'dockflow-wiki-production' } })]]);
    expect(foreign).toEqual({
      name: 'search',
      action: 'blocked',
      message: `Helm release search in namespace ${NS} belongs to stack dockflow-wiki-production`,
      suggestion: 'Rename the release in config.yml, or remove it from the other project first.',
    });
    const [unmanaged] = apply([record('search')], [['search', observed({ owner: { kind: 'none' } })]], [['search', [4]]]);
    expect(unmanaged.action).toBe('blocked');
    expect(unmanaged.action === 'blocked' && unmanaged.message).toContain('was not installed by Dockflow');
    const [uninstalling] = apply([record('search')], [['search', observed({ status: 'uninstalling' })]]);
    expect(uninstalling.action === 'blocked' && uninstalling.message).toBe('Helm release search is being uninstalled');
  });

  test('entries follow the record order', () => {
    expect(apply([record('b'), record('a')], [['a', null], ['b', null]]).map((entry) => entry.name)).toEqual(['b', 'a']);
  });
});
