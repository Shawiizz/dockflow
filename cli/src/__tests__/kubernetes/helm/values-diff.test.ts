import { describe, expect, test } from 'bun:test';
import {
  CHART_DEFAULT,
  type DiffLine,
  formatValuesDiff,
  MASK,
  valuesDiff,
} from '../../../services/orchestrator/kubernetes/helm/values-diff';

const changed = (path: string, before: string, after: string, masked = false): DiffLine => ({ path, kind: 'changed', before, after, masked });
const added = (path: string, after: string, masked = false): DiffLine => ({ path, kind: 'added', before: '', after, masked });
const removed = (path: string, before: string, masked = false): DiffLine => ({ path, kind: 'removed', before, after: CHART_DEFAULT, masked });

// design-04 3.7.4: the operator's values of an adopted postgres release against config.yml
const DEPLOYED = {
  auth: { password: 'operator-password-1' },
  primary: { persistence: { size: '20Gi' } },
  metrics: { enabled: true },
  replicaCount: 1,
};
const DESIRED = {
  auth: { password: 'dockflow-password-2' },
  primary: { persistence: { size: '8Gi', storageClass: 'dockflow-local' } },
  replicaCount: 1,
};

describe('valuesDiff', () => {
  test('changed, added and removed leaves as sorted dotted paths; removed leaves fall back to the chart default', () => {
    expect(valuesDiff(DEPLOYED, DESIRED)).toEqual([
      changed('auth.password', MASK, MASK, true),
      removed('metrics.enabled', 'true'),
      changed('primary.persistence.size', '20Gi', '8Gi'),
      added('primary.persistence.storageClass', 'dockflow-local'),
    ]);
  });

  test('identical values give no line; a release without user values adds every leaf', () => {
    expect(valuesDiff(DESIRED, structuredClone(DESIRED))).toEqual([]);
    expect(valuesDiff(null, { replicaCount: 2, image: { tag: 'v2' } })).toEqual([added('image.tag', 'v2'), added('replicaCount', '2')]);
    expect(valuesDiff(null, {})).toEqual([]);
  });

  test('sensitive paths are masked on both sides while the change is still reported', () => {
    const lines = valuesDiff(
      { auth: { password: 'old-secret-value' }, apiKey: 'old-api-key-123', tokenTtl: 60 },
      { auth: { password: 'new-secret-value' }, apiKey: 'new-api-key-456', registry: { token: 'fresh-token-789' } },
    );
    expect(lines).toEqual([
      changed('apiKey', MASK, MASK, true),
      changed('auth.password', MASK, MASK, true),
      added('registry.token', MASK, true),
      removed('tokenTtl', MASK, true),
    ]);
    const printed = JSON.stringify(lines) + formatValuesDiff(lines).join('\n');
    for (const secret of ['old-secret-value', 'new-secret-value', 'old-api-key-123', 'new-api-key-456', 'fresh-token-789']) {
      expect(printed).not.toContain(secret);
    }
  });

  test('an unchanged secret is not listed and a non-sensitive key is never masked', () => {
    expect(valuesDiff({ auth: { password: 'same-secret' }, replicaCount: 1 }, { auth: { password: 'same-secret' }, replicaCount: 3 })).toEqual([
      changed('replicaCount', '1', '3'),
    ]);
  });

  test('lists are compared as whole values', () => {
    expect(valuesDiff({ list: [1, 2] }, { list: [1, 2] })).toEqual([]);
    expect(valuesDiff({ list: [1, 2] }, { list: [2, 1] })).toEqual([changed('list', '[1,2]', '[2,1]')]);
    expect(
      valuesDiff({ env: [{ name: 'MODE', value: 'a' }] }, { env: [{ name: 'MODE', value: 'b' }] }),
    ).toEqual([changed('env', '[{"name":"MODE","value":"a"}]', '[{"name":"MODE","value":"b"}]')]);
  });

  test('nested maps are recursed; a subtree present on one side is listed leaf by leaf', () => {
    expect(valuesDiff({ a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 1, d: 3 } } })).toEqual([changed('a.b.d', '2', '3')]);
    expect(valuesDiff({ metrics: { enabled: true, port: 9090 } }, {})).toEqual([removed('metrics.enabled', 'true'), removed('metrics.port', '9090')]);
    expect(valuesDiff({}, { ingress: { enabled: true, hosts: ['shop.example.com'] } })).toEqual([
      added('ingress.enabled', 'true'),
      added('ingress.hosts', '["shop.example.com"]'),
    ]);
  });

  test('a map replacing a scalar is one changed line, and empty maps only count where nothing else is', () => {
    expect(valuesDiff({ a: 1 }, { a: { x: 1 } })).toEqual([changed('a', '1', '{"x":1}')]);
    expect(valuesDiff({ a: {} }, { a: { x: 1 } })).toEqual([added('a.x', '1')]);
    expect(valuesDiff({ a: {} }, { a: {} })).toEqual([]);
    expect(valuesDiff({ a: {} }, {})).toEqual([removed('a', '{}')]);
  });

  test('values print as they read: strings bare unless they would read as something else', () => {
    expect(
      valuesDiff(
        { replicas: '3', flag: 'yes', note: 'a\nb', empty: 'x', pad: 'x', nothing: null },
        { replicas: 3, flag: true, note: 'ab', empty: '', pad: ' x', nothing: 'set' },
      ),
    ).toEqual([
      changed('empty', 'x', '""'),
      changed('flag', '"yes"', 'true'),
      changed('note', '"a\\nb"', 'ab'),
      changed('nothing', 'null', 'set'),
      changed('pad', 'x', '" x"'),
      changed('replicas', '"3"', '3'),
    ]);
  });

  test('keys that would make a path ambiguous are quoted, and paths sort by code unit', () => {
    expect(
      valuesDiff(
        { ingress: { annotations: { 'traefik.io/router': 'a' } } },
        { ingress: { annotations: { 'traefik.io/router': 'b' } }, Zeta: 1, alpha: 1 },
      ).map((line) => line.path),
    ).toEqual(['Zeta', 'alpha', 'ingress.annotations["traefik.io/router"]']);
  });
});

describe('formatValuesDiff', () => {
  test('one line per leaf with the design-04 3.7.4 markers and kind labels, columns aligned', () => {
    const out = formatValuesDiff(valuesDiff(DEPLOYED, DESIRED));
    expect(out.map((line) => line.replace(/\s+/g, ' ').trim())).toEqual([
      '- auth.password *** -> *** (changed)',
      '- metrics.enabled true -> (chart default) (removed by --reset-values)',
      '- primary.persistence.size 20Gi -> 8Gi (changed)',
      '+ primary.persistence.storageClass -> dockflow-local (added)',
    ]);
    for (const line of out) expect(line.startsWith('  ')).toBe(true);
    expect(new Set(out.map((line) => line.indexOf(' -> '))).size).toBe(1);
    expect(new Set(out.map((line) => line.lastIndexOf(' ('))).size).toBe(1);
  });

  test('no lines, no output', () => {
    expect(formatValuesDiff([])).toEqual([]);
  });
});
