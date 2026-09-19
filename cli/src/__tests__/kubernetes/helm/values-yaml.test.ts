import { describe, expect, test } from 'bun:test';
import {
  goYamlV2Resolve,
  type HelmValuesOrigin,
  helmValuesStdin,
  inlineHelmValuesReader,
  isSensitiveKeyPath,
  joinKeyPath,
  mergeHelmValues,
  parseHelmValues,
} from '../../../services/orchestrator/kubernetes/helm/values-yaml';

const FILE = '.dockflow/helm/web.yaml';
const ORIGIN: HelmValuesOrigin = { path: 'helm.releases[0].values_files[0]', file: FILE };

const parse = (text: string) => parseHelmValues(text, ORIGIN);

/** value of `v: <src>` read the way Helm reads a values file */
function valueOf(src: string): unknown {
  const result = parse(`v: ${src}\n`);
  expect(result.diagnostics).toEqual([]);
  return result.values.v;
}

describe('design-04 3.4.2 table: plain scalars read as Helm reads them', () => {
  test.each(['yes', 'Yes', 'YES', 'y', 'Y', 'on', 'On', 'ON', 'true', 'True', 'TRUE'])('%s -> true', (src) => {
    expect(valueOf(src)).toBe(true);
  });

  test.each(['no', 'No', 'NO', 'n', 'N', 'off', 'Off', 'OFF', 'false', 'False', 'FALSE'])('%s -> false', (src) => {
    expect(valueOf(src)).toBe(false);
  });

  test.each(['', '~', 'null', 'Null', 'NULL'])('"%s" -> null', (src) => {
    expect(valueOf(src)).toBeNull();
  });

  test.each([
    ['0644', 420],
    ['0o644', 420],
    ['0O644', 420],
    ['0x1F', 31],
    ['0X1F', 31],
    ['0b101', 5],
    ['-0b101', -5],
    ['1_000', 1000],
    ['08', 8],
    ['1e3', 1000],
    ['.5', 0.5],
    ['+1.5', 1.5],
  ])('%s -> %p (number)', (src, expected) => {
    const value = valueOf(src);
    expect(typeof value).toBe('number');
    expect(value).toBe(expected);
  });

  test.each(['12:30:00', '2026-09-17', '2026-09-17T10:00:00Z'])('%s stays a string (no base 60, no timestamps)', (src) => {
    expect(valueOf(src)).toBe(src);
  });

  test.each(['.inf', '-.Inf', '.nan'])('%s is a helm.values-non-finite error', (src) => {
    const result = parse(`limits:\n  ratio: ${src}\n`);
    expect(result.values).toEqual({});
    expect(result.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'helm.values-non-finite',
        path: 'helm.releases[0].values_files[0]',
        message: `limits.ratio in ${FILE} is ${src}, which Helm values cannot carry through JSON`,
        hint: 'Quote it if a string was meant.',
      },
    ]);
  });

  test('quoted and block scalars stay strings', () => {
    expect(valueOf('"yes"')).toBe('yes');
    expect(valueOf("'0644'")).toBe('0644');
    const result = parse('v: |\n  0644\nw: >-\n  on\n');
    expect(result.values).toEqual({ v: '0644\n', w: 'on' });
  });

  test('!!str 0644 -> "0644"', () => {
    expect(valueOf('!!str 0644')).toBe('0644');
  });
});

describe('goYamlV2Resolve beyond the table', () => {
  test.each([
    ['-0x1F', -31],
    ['1__000', 1000],
    ['09.5', 9.5],
    ['1.', 1],
    ['0', 0],
    ['+0b101', 5],
    // go-yaml's 0b fallback runs ParseInt(rest, 2), which takes a sign
    ['0b-101', -5],
    ['18446744073709551615', 18446744073709551615],
    ['99999999999999999999', 1e20],
  ])('%s -> %p', (src, expected) => {
    expect(goYamlV2Resolve(src)).toBe(expected);
  });

  test('-0 is 0, not negative zero', () => {
    expect(Object.is(goYamlV2Resolve('-0'), 0)).toBe(true);
  });

  test.each(['0b2', '0o8', '0x', '+', '-', '1e400', 'tRUE', 'yes please', '0xZZ', '1_000.5.5'])('%s stays a string', (src) => {
    expect(goYamlV2Resolve(src)).toBe(src);
  });

  test.each(['2026-9-7', '2026-09-17 10:11:12', '2026-09-17t10:11:12.5+02:00'])('timestamp shape %s stays a string', (src) => {
    expect(goYamlV2Resolve(src)).toBe(src);
    expect(valueOf(src)).toBe(src);
  });

  test.each(['.inf', '.Inf', '.INF', '+.inf', '-.inf', '.nan', '.NaN', '.NAN'])('%s is reported as non-finite', (src) => {
    expect(goYamlV2Resolve(src)).toEqual({ nonFinite: src });
  });
});

describe('parseHelmValues', () => {
  test('anchors and << merge follow Helm rules inside the merged map', () => {
    const result = parse(['base: &base', '  image: nginx', '  debug: yes', 'web:', '  <<: *base', '  debug: off', 'copy: *base', ''].join('\n'));
    expect(result.diagnostics).toEqual([]);
    expect(result.values).toEqual({
      base: { image: 'nginx', debug: true },
      web: { image: 'nginx', debug: false },
      copy: { image: 'nginx', debug: true },
    });
  });

  test('a duplicate key is helm.values-yaml with its line', () => {
    const result = parse('a: 1\nb: 2\na: 3\n');
    expect(result.values).toEqual({});
    expect(result.diagnostics).toEqual([
      { severity: 'error', code: 'helm.values-yaml', path: 'helm.releases[0].values_files[0]', message: `${FILE}: duplicate key at line 3` },
    ]);
  });

  test('several documents are merged in order', () => {
    const result = parse('a: 1\nb: {x: 1, list: [1, 2]}\n---\nb: {z: 2, list: [3]}\na: 2\n');
    expect(result.values).toEqual({ a: 2, b: { x: 1, z: 2, list: [3] } });
  });

  test.each(['', '---\n', '# comment only\n', '~\n', '---\n---\na: 1\n'])('empty documents contribute {} (%p)', (text) => {
    const result = parse(text);
    expect(result.diagnostics).toEqual([]);
    expect(result.values).toEqual(text.includes('a: 1') ? { a: 1 } : {});
  });

  test.each(['- a\n- b\n', 'just a string\n', '42\n'])('a top-level %p is helm.values-not-map', (text) => {
    expect(parse(text).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'helm.values-not-map',
        path: 'helm.releases[0].values_files[0]',
        message: `${FILE} must contain a mapping at the top level`,
      },
    ]);
  });

  test('!!binary is helm.values-tag', () => {
    expect(parse('v: !!binary aGVsbG8=\n').diagnostics).toEqual([
      {
        severity: 'error',
        code: 'helm.values-tag',
        path: 'helm.releases[0].values_files[0]',
        message: `v in ${FILE} uses the YAML tag !!binary, which is not supported in Helm values`,
      },
    ]);
  });

  test.each([
    ['!foo x', '!foo'],
    ['!!set {a, b}', '!!set'],
    ['!!omap [{a: 1}]', '!!omap'],
    ['!!timestamp 2026-09-17', '!!timestamp'],
  ])('%s is helm.values-tag naming %s', (src, tag) => {
    const [diagnostic] = parse(`v: ${src}\n`).diagnostics;
    expect(diagnostic.code).toBe('helm.values-tag');
    expect(diagnostic.message).toBe(`v in ${FILE} uses the YAML tag ${tag}, which is not supported in Helm values`);
  });

  test('explicitly tagged scalars keep the standard tag semantics', () => {
    const result = parse(
      'a: !!int "12"\nb: !!float 1\nc: !!bool yes\nd: !!null ~\ne: !!map {x: 1}\nf: !!seq [1]\ng: !!int 0x1F\nh: !!str yes\n!!int 7: key\n',
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.values).toEqual({ a: 12, b: 1, c: true, d: null, e: { x: 1 }, f: [1], g: 31, h: 'yes', 7: 'key' });
  });

  test.each(['!!int abc', '!!int 1.5', '!!bool 1', '!!null 0', '!!float yes', '!!map x'])(
    'a tagged scalar of another type (%s) is helm.values-yaml',
    (src) => {
      expect(parse(`a: 1\nb: ${src}\n`).diagnostics).toEqual([
        { severity: 'error', code: 'helm.values-yaml', path: 'helm.releases[0].values_files[0]', message: `${FILE}: value does not match its tag at line 2` },
      ]);
    },
  );

  test('!!float .inf is non-finite too', () => {
    expect(parse('v: !!float .inf\n').diagnostics.map((d) => d.code)).toEqual(['helm.values-non-finite']);
  });

  test('integers beyond 2^53 warn and keep the float64 value Helm computes', () => {
    const result = parse('exact: 9007199254740992\nbig: 9007199254740993\nneg: -9007199254740993\n');
    expect(result.values).toEqual({ exact: 9007199254740992, big: 9007199254740992, neg: -9007199254740992 });
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'helm.values-large-int',
        path: 'helm.releases[0].values_files[0]',
        message: `big in ${FILE} (9007199254740993) loses precision: Helm decodes numbers as float64`,
        hint: 'Quote it if the chart expects a string.',
      },
      {
        severity: 'warning',
        code: 'helm.values-large-int',
        path: 'helm.releases[0].values_files[0]',
        message: `neg in ${FILE} (-9007199254740993) loses precision: Helm decodes numbers as float64`,
        hint: 'Quote it if the chart expects a string.',
      },
    ]);
  });

  test('keys resolve like values and are spelled as JSON spells them', () => {
    const result = parse('yes: a\n0644: b\nname: c\n"on": d\n');
    expect(result.values).toEqual({ true: 'a', 420: 'b', name: 'c', on: 'd' });
  });

  test('list items and flow collections follow the same rules', () => {
    expect(parse('v: [yes, 0644, "0644", off]\n').values).toEqual({ v: [true, 420, '0644', false] });
  });

  test('key paths name list items', () => {
    const [diagnostic] = parse('env:\n  - name: A\n    value: .nan\n').diagnostics;
    expect(diagnostic.message).toBe(`env[0].value in ${FILE} is .nan, which Helm values cannot carry through JSON`);
  });

  test('a collection used as a mapping key is refused without printing it', () => {
    const result = parse('? [a, b]\n: x\n');
    expect(result.diagnostics).toEqual([
      { severity: 'error', code: 'helm.values-yaml', path: 'helm.releases[0].values_files[0]', message: `${FILE}: a mapping key must be a scalar at line 1` },
    ]);
  });

  test('error messages never contain the source line', () => {
    const secret = 'sk-live-0123456789abcdef';
    const cases = [
      `token: ${secret}\ntoken: other\n`,
      `password: "${secret}\n`,
      `auth:\n  password: ${secret}\n bad: indent\n`,
      `key: !!int ${secret}\n`,
      `- ${secret}\n`,
    ];
    for (const text of cases) {
      const { diagnostics } = parse(text);
      expect(diagnostics.length).toBeGreaterThan(0);
      for (const d of diagnostics) {
        expect(d.message).not.toContain(secret);
        expect(d.hint ?? '').not.toContain(secret);
      }
    }
  });

  test('a `__proto__` key stays an own key and pollutes nothing', () => {
    const result = parse('__proto__:\n  polluted: yes\n');
    expect(Object.hasOwn(result.values, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('inlineHelmValuesReader', () => {
  const CONFIG = [
    'project_name: shop',
    'orchestrator: k3s',
    'x-common: &common',
    '  pullPolicy: yes',
    'other: !!int not-a-number',
    'helm:',
    '  releases:',
    '    - name: web',
    '      chart: web',
    '      values:',
    '        enabled: yes',
    '        mode: 0644',
    '        name: "yes"',
    '        limits:',
    '          ratio: 1.5',
    '    - name: api',
    '      chart: api',
    '    - name: shared',
    '      chart: shared',
    '      values: *common',
    '    - name: broken',
    '      chart: broken',
    '      values:',
    '        ratio: .inf',
    '        blob: !!binary aGVsbG8=',
    '',
  ].join('\n');
  const read = inlineHelmValuesReader(CONFIG);
  const origin = (i: number): HelmValuesOrigin => ({ path: `helm.releases[${i}].values`, file: null });

  test('values are re-read with Helm rules; warnings elsewhere in config.yml are not theirs', () => {
    expect(read(0, origin(0))).toEqual({ values: { enabled: true, mode: 420, name: 'yes', limits: { ratio: 1.5 } }, diagnostics: [] });
  });

  test('a release without values has no node', () => {
    expect(read(1, origin(1))).toBeNull();
    expect(read(9, origin(9))).toBeNull();
  });

  test('an alias to an anchor outside helm.releases is resolved with Helm rules too', () => {
    expect(read(2, origin(2))).toEqual({ values: { pullPolicy: true }, diagnostics: [] });
  });

  test('inline diagnostics point at the key', () => {
    expect(read(3, origin(3))?.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'helm.values-non-finite',
        path: 'helm.releases[3].values.ratio',
        message: 'ratio is .inf, which Helm values cannot carry through JSON',
        hint: 'Quote it if a string was meant.',
      },
      {
        severity: 'error',
        code: 'helm.values-tag',
        path: 'helm.releases[3].values.blob',
        message: 'blob uses the YAML tag !!binary, which is not supported in Helm values',
      },
    ]);
  });

  test('a key duplicated only under Helm rules is helm.values-yaml; the same outside the values is not theirs', () => {
    const text = ['other: {on: 1, true: 2}', 'helm:', '  releases:', '    - name: web', '      values:', '        on: 1', '        true: 2', ''].join('\n');
    expect(inlineHelmValuesReader(text)(0, origin(0))).toEqual({
      values: {},
      diagnostics: [
        { severity: 'error', code: 'helm.values-yaml', path: 'helm.releases[0].values', message: 'helm.releases[0].values: duplicate key at line 7' },
      ],
    });
    const clean = ['other: {on: 1, true: 2}', 'helm:', '  releases:', '    - name: web', '      values:', '        on: 1', ''].join('\n');
    expect(inlineHelmValuesReader(clean)(0, origin(0))).toEqual({ values: { true: 1 }, diagnostics: [] });
  });

  test('a source that does not parse yields no node', () => {
    const broken = inlineHelmValuesReader('helm: [\n');
    expect(broken(0, origin(0))).toBeNull();
  });
});

describe('mergeHelmValues', () => {
  test('maps merge, lists and scalars replace, null is kept (I3)', () => {
    const merged = mergeHelmValues(
      { image: { repository: 'a', tag: '1' }, list: [1, 2], keep: 'x', drop: 'chart' },
      { image: { tag: '2' }, list: [3], drop: null },
      { image: { pullPolicy: 'Always' } },
    );
    expect(merged).toEqual({ image: { repository: 'a', tag: '2', pullPolicy: 'Always' }, list: [3], keep: 'x', drop: null });
    expect(Object.hasOwn(merged, 'drop')).toBe(true);
  });

  test('a map replaces a scalar and a scalar replaces a map', () => {
    expect(mergeHelmValues({ a: 1, b: { x: 1 } }, { a: { y: 2 }, b: 'flat' })).toEqual({ a: { y: 2 }, b: 'flat' });
  });

  test('layers are not aliased into the result', () => {
    const layer = { nested: { list: [1] } };
    const merged = mergeHelmValues(layer);
    (merged.nested as { list: number[] }).list.push(2);
    expect(layer.nested.list).toEqual([1]);
  });

  test('a `__proto__` layer key never reaches Object.prototype', () => {
    const layer = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const merged = mergeHelmValues({}, layer, layer);
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('helpers', () => {
  test('helmValuesStdin is canonical JSON plus a newline, so every string stays a string', () => {
    expect(helmValuesStdin({ b: 'yes', a: { d: '0644', c: null } })).toBe('{"a":{"c":null,"d":"0644"},"b":"yes"}\n');
  });

  test('joinKeyPath quotes keys that would make a path ambiguous', () => {
    expect(joinKeyPath('', 'a')).toBe('a');
    expect(joinKeyPath('a', 'b')).toBe('a.b');
    expect(joinKeyPath('ingress.annotations', 'traefik.io/x')).toBe('ingress.annotations["traefik.io/x"]');
    expect(joinKeyPath('a', '')).toBe('a[""]');
  });

  test.each([
    ['auth.password', true],
    ['apiKey', true],
    ['global.postgresql.postgresPassword', true],
    ['tls.secretName', true],
    ['registry.token', true],
    ['credentials[0]', true],
    ['replicaCount', false],
    ['image.tag', false],
  ])('isSensitiveKeyPath(%s) = %p', (path, expected) => {
    expect(isSensitiveKeyPath(path)).toBe(expected);
  });
});
