import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  compareChartVersions,
  deployedSpecSelector,
  desiredChartName,
  helmStorageSecretName,
  historyFacts,
  isPendingStatus,
  parseDeployedValues,
  parseHelmHistory,
  parseHelmList,
  parseHelmStatus,
  parseHelmTime,
  parseManifestObjects,
  parseReleaseSecretNames,
  releaseOwnerFromLabels,
  sameChartVersion,
  specRevisionsSelector,
  splitChartString,
  statefulSetClaimPattern,
} from '../../../services/orchestrator/kubernetes/helm/parse';
import { DeployError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';

/** Recorded helm output (fixtures/helm, design-07 3.11): read as data, the way the backend receives stdout. */
function helmFixture(scenario: string, file: string): string {
  return readFileSync(join(import.meta.dir, '..', 'fixtures', 'helm', scenario, file), 'utf8');
}

const helmJson = (scenario: string, file: string): unknown => JSON.parse(helmFixture(scenario, file));

describe('parseHelmTime', () => {
  test.each([
    ['2026-09-17 10:11:12.123456789 +0000 UTC', '2026-09-17T10:11:12.123Z'],
    ['2026-01-01 00:00:00 +0000 UTC', '2026-01-01T00:00:00.000Z'],
    ['2026-09-17 10:11:12.5 +0200 CEST', '2026-09-17T08:11:12.500Z'],
    ['2026-09-17 01:00:00 -0130 -0130', '2026-09-17T02:30:00.000Z'],
    ['2026-09-17 10:11:12 +0000', '2026-09-17T10:11:12.000Z'],
    ['2026-01-01T00:02:10.207415839Z', '2026-01-01T00:02:10.207Z'],
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T02:00:00.1+02:00', '2026-01-01T00:00:00.100Z'],
  ])('%p -> %p', (input, expected) => {
    expect(parseHelmTime(input)).toBe(expected);
  });

  test.each([['garbage'], [''], ['2026-02-31 10:00:00 +0000 UTC'], ['2026-13-01T00:00:00Z'], ['2026-09-17 25:00:00 +0000 UTC'], [null], [42]])(
    '%p -> null',
    (input) => {
      expect(parseHelmTime(input)).toBeNull();
    },
  );
});

describe('parseHelmStatus', () => {
  test('known statuses pass, anything else is unknown', () => {
    for (const status of ['deployed', 'failed', 'pending-install', 'pending-upgrade', 'pending-rollback', 'superseded', 'uninstalling', 'uninstalled']) {
      expect(parseHelmStatus(status)).toBe(status as ReturnType<typeof parseHelmStatus>);
    }
    expect(parseHelmStatus('pending-something')).toBe('unknown');
    expect(parseHelmStatus(undefined)).toBe('unknown');
    expect(isPendingStatus('pending-rollback')).toBe(true);
    expect(isPendingStatus('failed')).toBe(false);
  });
});

describe('parseHelmList', () => {
  test('recorded list: revision strings, every status, Go times', () => {
    const rows = parseHelmList(helmJson('helm-list', 'list-all.json'));
    expect(rows.map((row) => [row.name, row.namespace, row.revision, row.status, row.chart])).toEqual([
      ['archive', 'fixture-helm-list', 2, 'uninstalled', 'e2e-web-0.1.0'],
      ['cache', 'fixture-helm-list', 2, 'failed', 'e2e-broken-0.1.0'],
      ['data', 'fixture-helm-list-data', 1, 'deployed', 'e2e-pvc-0.1.0'],
      ['queue', 'fixture-helm-list', 1, 'pending-install', 'e2e-web-0.1.0'],
      ['reports', 'fixture-helm-list', 3, 'pending-upgrade', 'e2e-web-0.2.0'],
      ['search', 'fixture-helm-list', 4, 'deployed', 'e2e-web-0.2.0'],
    ]);
    expect(rows[5]).toEqual({
      name: 'search',
      namespace: 'fixture-helm-list',
      role: null,
      revision: 4,
      status: 'deployed',
      chart: 'e2e-web-0.2.0',
      appVersion: '1.0.0',
      updated: '2026-01-01T00:20:00.528Z',
    });
    expect(rows[2].updated).toBe('2026-01-01T00:00:00.000Z');
  });

  test('an empty list, null output and malformed rows', () => {
    expect(parseHelmList(helmJson('helm-list', 'list-empty.json'))).toEqual([]);
    expect(parseHelmList(null)).toEqual([]);
    expect(
      parseHelmList([
        { name: 'x', namespace: 'ns', revision: '7', status: 'superseded-plus', chart: 'x-1.0.0', app_version: '', updated: 'later' },
        { name: 'no-revision', namespace: 'ns', revision: 'a', status: 'deployed', chart: 'x-1.0.0' },
        { namespace: 'ns', revision: '1' },
        'garbage',
      ]),
    ).toEqual([{ name: 'x', namespace: 'ns', role: null, revision: 7, status: 'unknown', chart: 'x-1.0.0', appVersion: null, updated: null }]);
  });
});

describe('parseHelmHistory', () => {
  test('recorded history, newest first, RFC 3339 times', () => {
    const rows = parseHelmHistory(helmJson('helm-history-rollback', 'history.json'), { name: 'web', namespace: 'fixture-helm-history-rollback' });
    expect(rows.map((row) => [row.revision, row.status, row.chart, row.updated])).toEqual([
      [3, 'deployed', 'e2e-web-0.1.0', '2026-01-01T00:03:11.740Z'],
      [2, 'failed', 'e2e-broken-0.1.0', '2026-01-01T00:02:10.207Z'],
      [1, 'superseded', 'e2e-web-0.1.0', '2026-01-01T00:00:00.000Z'],
    ]);
    expect(rows[0]).toMatchObject({ name: 'web', namespace: 'fixture-helm-history-rollback', role: null, description: 'Rollback to 1' });
  });

  test('descriptions are redacted', () => {
    const json = [{ revision: 2, updated: '2026-01-01T00:00:00Z', status: 'failed', chart: 'db-1.0.0', app_version: '1', description: 'secret "s3cr3t-value" rejected' }];
    const redactor = new Redactor(['s3cr3t-value']);
    const [row] = parseHelmHistory(json, { name: 'db', namespace: 'ns' }, (text) => redactor.redact(text));
    expect(row.description).toBe('secret "***" rejected');
    expect(parseHelmHistory([{ revision: 1, status: 'deployed', description: '' }], { name: 'db', namespace: 'ns' })[0].description).toBeNull();
  });

  test('historyFacts: last deployed revision and pending time', () => {
    const failed = parseHelmHistory(helmJson('helm-status-failed', 'history.json'), { name: 'broken', namespace: 'ns' });
    expect(historyFacts(failed)).toEqual({ lastDeployedRevision: 1, pendingSince: null });
    expect(
      historyFacts([
        { revision: 1, status: 'superseded', updated: '2026-01-01T00:00:00.000Z' },
        { revision: 3, status: 'pending-upgrade', updated: '2026-01-01T03:00:00.000Z' },
        { revision: 2, status: 'deployed', updated: '2026-01-01T02:00:00.000Z' },
      ]),
    ).toEqual({ lastDeployedRevision: 2, pendingSince: '2026-01-01T03:00:00.000Z' });
    expect(historyFacts([{ revision: 1, status: 'pending-install', updated: null }])).toEqual({ lastDeployedRevision: null, pendingSince: null });
    expect(historyFacts([{ revision: 1, status: 'pending-install', updated: '2026-01-01T00:00:00.000Z' }])).toEqual({
      lastDeployedRevision: null,
      pendingSince: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('parseDeployedValues', () => {
  test('null output is no values, a map is kept, anything else is an error', () => {
    expect(parseDeployedValues(helmJson('helm-list', 'values-data.json'))).toEqual({});
    expect(parseDeployedValues(helmJson('helm-list', 'values-search.json'))).toEqual({ message: 'hello from search', replicaCount: 2 });
    expect(() => parseDeployedValues(['a'])).toThrow(DeployError);
    expect(() => parseDeployedValues('secret-text')).toThrow('The deployed values of a Helm release are not a map');
  });
});

describe('chart strings and versions', () => {
  test.each([
    ['traefik-41.6.0', 'traefik', '41.6.0'],
    ['my-chart-v1.18.2', 'my-chart', 'v1.18.2'],
    ['a-1.0.0-rc.1+b.2', 'a', '1.0.0-rc.1+b.2'],
    ['e2e-web-0.2.0', 'e2e-web', '0.2.0'],
    ['nochart', 'nochart', null],
    ['chart-1.0', 'chart-1.0', null],
  ])('splitChartString(%p)', (input, name, version) => {
    expect(splitChartString(input)).toEqual({ name, version });
  });

  test('desiredChartName: the repository chart or the last OCI segment', () => {
    expect(desiredChartName({ kind: 'repo', repo: 'https://charts.example.com', chart: 'postgresql' })).toBe('postgresql');
    expect(desiredChartName({ kind: 'oci', ref: 'oci://registry.example.com/charts/search' })).toBe('search');
  });

  test('compareChartVersions follows SemVer precedence', () => {
    expect(compareChartVersions('41.6.0', '41.6.0')).toBe(0);
    expect(compareChartVersions('v41.6.0', '41.6.0')).toBe(0);
    expect(compareChartVersions('42.0.0', '41.6.0')).toBe(1);
    expect(compareChartVersions('41.10.0', '41.9.9')).toBe(1);
    expect(compareChartVersions('41.6.0', '41.6.1')).toBe(-1);
    expect(compareChartVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareChartVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareChartVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareChartVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareChartVersions('1.0.0+b.1', '1.0.0+b.2')).toBe(0);
    expect(compareChartVersions('latest', '1.0.0')).toBeNull();
  });

  test('sameChartVersion ignores a leading v', () => {
    expect(sameChartVersion('v1.18.2', '1.18.2')).toBe(true);
    expect(sameChartVersion('1.18.2', '1.18.3')).toBe(false);
    expect(sameChartVersion(null, '1.0.0')).toBe(false);
  });
});

describe('Helm storage Secrets', () => {
  test('parseReleaseSecretNames: recorded list, names with dots and dashes, noise lines', () => {
    expect(parseReleaseSecretNames(helmFixture('helm-history-rollback', 'release-secrets.txt'))).toEqual([
      { name: 'web', revision: 1 },
      { name: 'web', revision: 2 },
      { name: 'web', revision: 3 },
    ]);
    const stdout = [
      'secret/sh.helm.release.v1.my-app.v12',
      'secret/sh.helm.release.v1.api.v2.v3',
      '  secret/sh.helm.release.v1.a.b-c.v1  ',
      'secret/sh.helm.release.v1.x.vlatest',
      'secret/dockflow-release-1.0.0',
      'No resources found in shop namespace.',
      '',
    ].join('\r\n');
    expect(parseReleaseSecretNames(stdout)).toEqual([
      { name: 'my-app', revision: 12 },
      { name: 'api.v2', revision: 3 },
      { name: 'a.b-c', revision: 1 },
    ]);
  });

  test('helmStorageSecretName is the storage contract', () => {
    expect(helmStorageSecretName('api.v2', 3)).toBe('sh.helm.release.v1.api.v2.v3');
  });

  test('releaseOwnerFromLabels needs both ownership labels and a known role', () => {
    expect(releaseOwnerFromLabels({ 'dockflow.shawiizz.dev/stack': 'dockflow-shop-production', 'dockflow.shawiizz.dev/role': 'accessory', owner: 'helm' })).toEqual({
      stackId: 'dockflow-shop-production',
      role: 'accessory',
    });
    expect(releaseOwnerFromLabels({ 'dockflow.shawiizz.dev/stack': 'dockflow-shop-production' })).toBeNull();
    expect(releaseOwnerFromLabels({ 'dockflow.shawiizz.dev/stack': 'x', 'dockflow.shawiizz.dev/role': 'job' })).toBeNull();
    expect(releaseOwnerFromLabels(undefined)).toBeNull();
  });

  test('spec-hash selectors of design-04 3.5.4', () => {
    expect(specRevisionsSelector('api', 'a'.repeat(32))).toBe(`owner=helm,name=api,status in (deployed,superseded),dockflow.shawiizz.dev/spec-hash=${'a'.repeat(32)}`);
    expect(deployedSpecSelector(['b2', 'a1', 'b2'])).toBe('owner=helm,status=deployed,dockflow.shawiizz.dev/spec-hash in (a1,b2)');
  });
});

describe('parseManifestObjects', () => {
  test('recorded manifest: a PVC without keep and a Deployment', () => {
    expect(parseManifestObjects(helmFixture('helm-list', 'manifest-data.yaml'))).toEqual([
      { kind: 'PersistentVolumeClaim', name: 'data-e2e-pvc', namespace: null, keep: false, claimTemplates: [] },
      { kind: 'Deployment', name: 'data-e2e-pvc', namespace: null, keep: false, claimTemplates: [] },
    ]);
  });

  test('Source comments, empty documents, keep variants, claim templates and namespaces', () => {
    const manifest = [
      '---',
      '# Source: db/templates/pvc-keep.yaml',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: keep-me',
      '  annotations:',
      '    helm.sh/resource-policy: " Keep "',
      '---',
      '# Source: db/templates/empty.yaml',
      '---',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: keep-upper',
      '  namespace: other',
      '  annotations: {helm.sh/resource-policy: KEEP}',
      '---',
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      '  name: delete-me',
      '  annotations: {helm.sh/resource-policy: delete, other: keep}',
      '---',
      'apiVersion: apps/v1',
      'kind: StatefulSet',
      'metadata: {name: db, namespace: data}',
      'spec:',
      '  volumeClaimTemplates:',
      '    - metadata: {name: data}',
      '    - metadata: {name: wal}',
      '    - spec: {}',
      '---',
      'apiVersion: v1',
      'metadata: {name: kindless}',
      '---',
      'kind: ConfigMap',
      'metadata: {}',
    ].join('\n');
    expect(parseManifestObjects(manifest)).toEqual([
      { kind: 'PersistentVolumeClaim', name: 'keep-me', namespace: null, keep: true, claimTemplates: [] },
      { kind: 'PersistentVolumeClaim', name: 'keep-upper', namespace: 'other', keep: true, claimTemplates: [] },
      { kind: 'PersistentVolumeClaim', name: 'delete-me', namespace: null, keep: false, claimTemplates: [] },
      { kind: 'StatefulSet', name: 'db', namespace: 'data', keep: false, claimTemplates: ['data', 'wal'] },
    ]);
    expect(parseManifestObjects('')).toEqual([]);
  });

  test('invalid YAML throws without quoting the manifest', () => {
    const manifest = 'kind: Secret\nmetadata:\n  name: creds\nstringData:\n  password: hunter2-secret: [unclosed\n';
    let error: unknown;
    try {
      parseManifestObjects(manifest);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).message).toStartWith('A Helm release manifest is not valid YAML (');
    expect((error as DeployError).message).not.toContain('hunter2');
  });

  test('statefulSetClaimPattern escapes both names', () => {
    const pattern = statefulSetClaimPattern('data.v1', 'db+x');
    expect(pattern.test('data.v1-db+x-0')).toBe(true);
    expect(pattern.test('data.v1-db+x-12')).toBe(true);
    expect(pattern.test('dataxv1-db+x-0')).toBe(false);
    expect(pattern.test('data.v1-dbbx-0')).toBe(false);
    expect(pattern.test('data.v1-db+x-')).toBe(false);
    expect(pattern.test('prefix-data.v1-db+x-0')).toBe(false);
  });
});
