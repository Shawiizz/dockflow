import { describe, expect, test } from 'bun:test';
import { loadFromString } from '../../../services/compose';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import {
  EMPTY_ENVIRONMENT,
  type InterpolationIssue,
  interpolate,
  interpolateDocument,
  interpolationDiagnostic,
  interpolationNameVisible,
  reportInterpolationIssues,
} from '../../../services/orchestrator/kubernetes/normalize/interpolate';
import { parsedCompose } from '../support/builders';

/** Loads `source` through the real loader and interpolates it with the empty environment. */
function run(source: string): { doc: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const sink = new DiagnosticSink();
  const doc = interpolateDocument(parsedCompose(source).raw, sink);
  return { doc, diagnostics: sink.list() };
}

function web(doc: Record<string, unknown>): Record<string, unknown> {
  const services = doc.services as Record<string, Record<string, unknown>>;
  return services.web;
}

function lookup(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => (Object.hasOwn(values, name) ? values[name] : undefined);
}

const UNSET_NAMED_TAIL = 'which has no value: Dockflow does not pass a process environment to Compose interpolation';
const UNSET_HIDDEN = 'contains a $ placeholder that has no value (Dockflow does not pass a process environment)';
const LITERAL_DOLLAR = 'write `$$` for a literal `$` (for inserted values: `{{ value | replace("$", "$$") }}`).';

describe('design-01 2.3 interpolation rows', () => {
  test('INT-01: $$ is a literal $', () => {
    const { doc, diagnostics } = run('image: nginx:1.29\ncommand: ["echo", "$$HOME"]');
    expect(web(doc).command).toEqual(['echo', '$HOME']);
    expect(diagnostics).toEqual([]);
  });

  test('INT-02: an unset placeholder in image is an error naming the variable', () => {
    const { doc, diagnostics } = run('image: "nginx:$TAG"');
    expect(web(doc).image).toBe('nginx:');
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.unset',
        path: 'services.web.image',
        message: `contains the placeholder $TAG, ${UNSET_NAMED_TAIL}`,
        hint: `Use \`{{ current.env.tag }}\` for a Dockflow value, or ${LITERAL_DOLLAR}`,
      },
    ]);
  });

  test('INT-03: an unset placeholder in environment is an error without the variable name', () => {
    const { doc, diagnostics } = run('image: nginx:1.29\nenvironment: {P: "a$b"}');
    expect(web(doc).environment).toEqual({ P: 'a' });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.unset',
        path: 'services.web.environment.P',
        message: UNSET_HIDDEN,
        hint: `Use \`{{ current.env.<name> }}\` for a Dockflow value, or ${LITERAL_DOLLAR}`,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('$b');
  });

  test('INT-04: command hides the name, deploy.replicas names it and leaves an empty string', () => {
    const { doc, diagnostics } = run('image: nginx:1.29\ncommand: "sh -c \'echo ${HOME}\'"\ndeploy:\n  replicas: "${N}"');
    expect(web(doc).command).toBe("sh -c 'echo '");
    expect((web(doc).deploy as Record<string, unknown>).replicas).toBe('');
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['interpolate.unset', 'services.web.command', UNSET_HIDDEN],
      ['interpolate.unset', 'services.web.deploy.replicas', `contains the placeholder $N, ${UNSET_NAMED_TAIL}`],
    ]);
    expect(diagnostics[0].message).not.toContain('HOME');
  });

  test('INT-05: ${VAR:-default} takes the default without a diagnostic', () => {
    const { doc, diagnostics } = run('image: "postgres:${PG:-16}"');
    expect(web(doc).image).toBe('postgres:16');
    expect(diagnostics).toEqual([]);
  });

  test('INT-06: ${VAR-default} takes the default for an unset variable', () => {
    const { doc, diagnostics } = run('image: "postgres:${PG-16}"');
    expect(web(doc).image).toBe('postgres:16');
    expect(diagnostics).toEqual([]);
  });

  test('INT-07: ${VAR:+alt} is empty for an unset variable', () => {
    const { doc, diagnostics } = run('image: nginx:1.29\nenvironment: {X: "${A:+on}", Y: "${A+on}"}');
    expect(web(doc).environment).toEqual({ X: '', Y: '' });
    expect(diagnostics).toEqual([]);
  });

  test('INT-08: ${VAR:?msg} is an error carrying the message', () => {
    const { doc, diagnostics } = run('image: "${IMG:?set IMG}"');
    expect(web(doc).image).toBe('');
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.required',
        path: 'services.web.image',
        message: 'requires variable IMG: set IMG',
        hint: 'Replace the placeholder with a Nunjucks value such as `{{ current.env.img }}`.',
      },
    ]);
  });

  test('INT-09: nested defaults resolve to the innermost value', () => {
    expect(interpolate('${A:-${B:-x}}')).toEqual({ value: 'x', issues: [] });
    const { doc, diagnostics } = run('image: "nginx:${A:-${B:-1.29}}"');
    expect(web(doc).image).toBe('nginx:1.29');
    expect(diagnostics).toEqual([]);
  });

  test('INT-10: an unterminated ${ is invalid', () => {
    expect(interpolate('${')).toEqual({ value: '', issues: [{ kind: 'invalid', variable: null, reason: null }] });
    const { diagnostics } = run('image: nginx:1.29\nworking_dir: "/app/${"');
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.invalid',
        path: 'services.web.working_dir',
        message: 'contains an invalid ${...} placeholder',
        hint: 'Write `$$` for a literal `$`.',
      },
    ]);
  });

  test('INT-11: a braced placeholder that is not a compose form is invalid', () => {
    for (const input of ['${A/b/c}', '${1}', '${A:=b}', '${}', '${A B}']) {
      expect(interpolate(input).issues).toEqual([{ kind: 'invalid', variable: null, reason: null }]);
    }
    const { diagnostics } = run('image: "nginx:${A/b/c}"');
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['interpolate.invalid', 'services.web.image']]);
  });

  test('INT-12: $ before anything but a name, a brace or a $ is kept', () => {
    expect(interpolate('price $5 $(date) $')).toEqual({ value: 'price $5 $(date) $', issues: [] });
    expect(interpolate('a $ b')).toEqual({ value: 'a $ b', issues: [] });
    const { doc, diagnostics } = run('image: nginx:1.29\ncommand: ["echo", "price $5 $(date) $"]');
    expect(web(doc).command).toEqual(['echo', 'price $5 $(date) $']);
    expect(diagnostics).toEqual([]);
  });

  test('INT-13: map keys are not interpolated; list forms are interpolated as whole strings', () => {
    const { doc, diagnostics } = run('image: nginx:1.29\nenvironment: {"$K": v}');
    expect(web(doc).environment).toEqual({ $K: 'v' });
    expect(diagnostics).toEqual([]);

    const list = run('image: nginx:1.29\nenvironment: ["K=$V"]');
    expect(web(list.doc).environment).toEqual(['K=']);
    expect(list.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['interpolate.unset', 'services.web.environment[0]', UNSET_HIDDEN],
    ]);
  });
});

describe('interpolate()', () => {
  const values = lookup({ SET: 'v', EMPTY: '' });

  test('defaults and alternatives distinguish unset from empty', () => {
    expect(interpolate('${SET:-d}|${EMPTY:-d}|${UNSET:-d}', values).value).toBe('v|d|d');
    expect(interpolate('${SET-d}|${EMPTY-d}|${UNSET-d}', values).value).toBe('v||d');
    expect(interpolate('${SET:+a}|${EMPTY:+a}|${UNSET:+a}', values).value).toBe('a||');
    expect(interpolate('${SET+a}|${EMPTY+a}|${UNSET+a}', values).value).toBe('a|a|');
  });

  test('required forms: `:?` refuses empty values, `?` only unset ones', () => {
    expect(interpolate('${SET:?m}', values)).toEqual({ value: 'v', issues: [] });
    expect(interpolate('${EMPTY:?m}', values)).toEqual({ value: '', issues: [{ kind: 'required', variable: 'EMPTY', reason: 'm' }] });
    expect(interpolate('${EMPTY?m}', values)).toEqual({ value: '', issues: [] });
    expect(interpolate('${UNSET?m}', values)).toEqual({ value: '', issues: [{ kind: 'required', variable: 'UNSET', reason: 'm' }] });
    expect(interpolate('${UNSET:?}', values).issues).toEqual([{ kind: 'required', variable: 'UNSET', reason: '' }]);
  });

  test('the reason of a required placeholder is itself interpolated', () => {
    expect(interpolate('${A:?cost $$5 ${B:-now}}').issues).toEqual([{ kind: 'required', variable: 'A', reason: 'cost $5 now' }]);
  });

  test('defined variables are substituted in every form', () => {
    expect(interpolate('$SET-${SET}-$SET_x', lookup({ SET: 'v', SET_x: 'w' }))).toEqual({ value: 'v-v-w', issues: [] });
    expect(interpolate('${_a1}', lookup({ _a1: 'ok' })).value).toBe('ok');
  });

  test('a branch that is not taken reports nothing', () => {
    expect(interpolate('${SET:-$MISSING}', values)).toEqual({ value: 'v', issues: [] });
    expect(interpolate('${UNSET:+$MISSING}', values)).toEqual({ value: '', issues: [] });
  });

  test('every unset placeholder of one string is an issue, in order', () => {
    expect(interpolate('$A and ${B}')).toEqual({
      value: ' and ',
      issues: [
        { kind: 'unset', variable: 'A', reason: null },
        { kind: 'unset', variable: 'B', reason: null },
      ],
    });
  });

  test('a variable name ends at the first character that cannot continue it', () => {
    expect(interpolate('$A.b', lookup({ A: 'x' })).value).toBe('x.b');
    expect(interpolate('$A-b', lookup({ A: 'x' })).value).toBe('x-b');
  });

  test('text after an invalid placeholder is still interpolated', () => {
    expect(interpolate('${A/b}$$x', lookup({}))).toEqual({ value: '$x', issues: [{ kind: 'invalid', variable: null, reason: null }] });
  });

  test('the default lookup is the empty environment', () => {
    expect(EMPTY_ENVIRONMENT('HOME')).toBeUndefined();
    expect(interpolate('$HOME').issues).toEqual([{ kind: 'unset', variable: 'HOME', reason: null }]);
  });
});

describe('interpolateDocument', () => {
  test('TOP-09: top-level x-* subtrees are copied untouched and report nothing', () => {
    const raw = { 'x-common': { image: '$VAR', list: ['${A:?b}'] }, services: { web: { image: 'nginx:1.29' } } };
    const sink = new DiagnosticSink();
    const doc = interpolateDocument(raw, sink);
    expect(doc['x-common']).toEqual({ image: '$VAR', list: ['${A:?b}'] });
    expect(sink.list()).toEqual([]);
  });

  test('service-level x-* fields are interpolated (only top-level x-* holds anchors)', () => {
    const sink = new DiagnosticSink();
    const doc = interpolateDocument({ services: { web: { image: 'nginx:1.29', 'x-note': 'a$$b' } } }, sink);
    expect(web(doc)['x-note']).toBe('a$b');
  });

  test('anchors merged into a service are interpolated where they are merged', () => {
    const text = 'x-common: &common\n  image: "nginx:$TAG"\nservices:\n  web:\n    <<: *common\n';
    const sink = new DiagnosticSink();
    const doc = interpolateDocument(loadFromString(text, 'docker-compose.yml').raw, sink);
    const diagnostics = sink.list();
    expect(web(doc).image).toBe('nginx:');
    expect(doc['x-common']).toEqual({ image: 'nginx:$TAG' });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([['interpolate.unset', 'services.web.image']]);
  });

  test('works on a deep copy and never mutates the input', () => {
    const raw = { services: { web: { image: 'nginx:${T:-1.29}', ports: ['80:80'], deploy: { replicas: 2 } } } };
    const snapshot = structuredClone(raw);
    const doc = interpolateDocument(raw, new DiagnosticSink());
    expect(raw).toEqual(snapshot);
    expect(web(doc).image).toBe('nginx:1.29');
    expect(web(doc).ports).not.toBe(raw.services.web.ports);
    expect(web(doc).deploy).not.toBe(raw.services.web.deploy);
  });

  test('non-string scalars are kept as they are', () => {
    const raw = { services: { web: { image: 'nginx:1.29', tty: true, cpus: 0.5, hostname: null, deploy: { replicas: 3 } } } };
    expect(web(interpolateDocument(raw, new DiagnosticSink()))).toEqual(raw.services.web);
  });

  test('list items and non-identifier keys are reported at their own paths', () => {
    const { diagnostics } = run('image: nginx:1.29\nports: ["80:80", "$P:80"]\nlabels: {"com.example.team": "$T"}');
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['interpolate.unset', 'services.web.labels["com.example.team"]', UNSET_HIDDEN],
      ['interpolate.unset', 'services.web.ports[1]', `contains the placeholder $P, ${UNSET_NAMED_TAIL}`],
    ]);
  });

  test('one diagnostic per code and path: the first placeholder of a scalar is reported', () => {
    const { diagnostics } = run('image: "$A/$B"');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe(`contains the placeholder $A, ${UNSET_NAMED_TAIL}`);
  });

  test('a value can carry an unset, a required and an invalid placeholder at once', () => {
    const { diagnostics } = run('image: "$A${B:?c}${"');
    expect(diagnostics.map((d) => d.code)).toEqual(['interpolate.invalid', 'interpolate.required', 'interpolate.unset']);
  });

  test('an explicit lookup replaces the empty environment', () => {
    const sink = new DiagnosticSink();
    const doc = interpolateDocument({ services: { web: { image: 'nginx:$TAG' } } }, sink, lookup({ TAG: '1.29' }));
    expect(web(doc).image).toBe('nginx:1.29');
    expect(sink.list()).toEqual([]);
  });

  test('a __proto__ key stays an own key of the copy', () => {
    const raw = JSON.parse('{"services": {"web": {"image": "nginx:1.29", "labels": {"__proto__": "$$x"}}}}') as Record<string, unknown>;
    const labels = web(interpolateDocument(raw, new DiagnosticSink())).labels as Record<string, unknown>;
    expect(Object.hasOwn(labels, '__proto__')).toBe(true);
    expect(labels.__proto__).toBe('$x');
    expect(Object.getPrototypeOf(labels)).toBe(Object.prototype);
  });

  test('top-level and volume paths never name the variable except under x-dockflow', () => {
    const { diagnostics } = run(
      'services:\n  web:\n    image: nginx:1.29\n    volumes: [data:/data]\nvolumes:\n  data:\n    labels: {team: "$T"}\n    x-dockflow: {size: "$S"}\nname: "$N"',
    );
    expect(diagnostics.map((d) => [d.path, d.message])).toEqual([
      ['name', UNSET_HIDDEN],
      ['volumes.data.labels.team', UNSET_HIDDEN],
      ['volumes.data.x-dockflow.size', `contains the placeholder $S, ${UNSET_NAMED_TAIL}`],
    ]);
  });
});

describe('variable names in messages (design-01 2.3)', () => {
  const service = (...rest: (string | number)[]): (string | number)[] => ['services', 'web', ...rest];

  test.each([
    'image',
    'ports',
    'expose',
    'volumes',
    'tmpfs',
    'networks',
    'hostname',
    'working_dir',
    'user',
    'platform',
    'pull_policy',
    'dns',
    'dns_search',
    'extra_hosts',
    'x-dockflow',
  ])('named under %s', (key) => {
    expect(interpolationNameVisible(service(key, 0))).toBe(true);
    expect(interpolationNameVisible(service(key))).toBe(true);
  });

  test('named under deploy except deploy.labels, and under healthcheck except test', () => {
    expect(interpolationNameVisible(service('deploy', 'replicas'))).toBe(true);
    expect(interpolationNameVisible(service('deploy', 'resources', 'limits', 'memory'))).toBe(true);
    expect(interpolationNameVisible(service('deploy', 'labels', 'team'))).toBe(false);
    expect(interpolationNameVisible(service('healthcheck', 'interval'))).toBe(true);
    expect(interpolationNameVisible(service('healthcheck', 'test', 1))).toBe(false);
    expect(interpolationNameVisible(service('healthcheck', 'test'))).toBe(false);
    expect(interpolationNameVisible(['volumes', 'data', 'x-dockflow', 'size'])).toBe(true);
  });

  const hidden: (string | number)[][] = [
    ['environment', 'KEY'],
    ['env_file', 0],
    ['labels', 'team'],
    ['label_file', 0],
    ['annotations', 'team'],
    ['command', 0],
    ['entrypoint', 0],
    ['post_start', 0, 'command', 0],
    ['pre_stop', 0, 'command'],
    ['build', 'args', 'TOKEN'],
    ['secrets', 0, 'source'],
    ['configs', 0, 'target'],
    ['sysctls', 'net.core.somaxconn'],
    ['x-note'],
  ];
  for (const segments of hidden) {
    test(`hidden under ${segments.join('.')}`, () => {
      expect(interpolationNameVisible(service(...segments))).toBe(false);
    });
  }

  test('hidden under top-level keys other than volumes.*.x-dockflow', () => {
    expect(interpolationNameVisible(['name'])).toBe(false);
    expect(interpolationNameVisible(['secrets', 'db', 'file'])).toBe(false);
    expect(interpolationNameVisible(['configs', 'app', 'content'])).toBe(false);
    expect(interpolationNameVisible(['networks', 'front', 'name'])).toBe(false);
    expect(interpolationNameVisible(['volumes', 'data', 'name'])).toBe(false);
    expect(interpolationNameVisible(['services', 'web'])).toBe(false);
  });

  test('a hidden required placeholder prints neither the variable nor its message', () => {
    const issue: InterpolationIssue = { kind: 'required', variable: 'DB_PASS', reason: 'set the password' };
    const hidden = interpolationDiagnostic(issue, false);
    expect(hidden).toEqual({
      code: 'interpolate.required',
      message: 'contains a placeholder that requires a variable, which has no value (Dockflow does not pass a process environment)',
      hint: 'Replace the placeholder with a Nunjucks value such as `{{ current.env.<name> }}`.',
    });
    expect(interpolationDiagnostic(issue, true).message).toBe('requires variable DB_PASS: set the password');
    expect(interpolationDiagnostic({ ...issue, reason: '' }, true).message).toBe('requires variable DB_PASS');
  });

  test('the invalid diagnostic never depends on the path', () => {
    const issue: InterpolationIssue = { kind: 'invalid', variable: null, reason: null };
    expect(interpolationDiagnostic(issue, true)).toEqual(interpolationDiagnostic(issue, false));
  });

  test('reportInterpolationIssues writes errors only', () => {
    const sink = new DiagnosticSink();
    reportInterpolationIssues(sink, 'services.web.image', [{ kind: 'unset', variable: 'X', reason: null }], true);
    reportInterpolationIssues(sink, 'services.web.image', [], true);
    expect(sink.hasErrors()).toBe(true);
    expect(sink.list().map((d) => [d.severity, d.code, d.path])).toEqual([['error', 'interpolate.unset', 'services.web.image']]);
  });
});
