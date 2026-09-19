import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { FileResolver } from '../../../services/orchestrator/interfaces';
import type { EnvVar } from '../../../services/orchestrator/kubernetes/model/types';
import type { NormalizeContext, ServiceDraft } from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  containsToken,
  decodeUtf8,
  ENV_MAX_BYTES,
  interpolateEnvValue,
  env as normalizeEnv,
  parseDotenv,
  parseKvFile,
} from '../../../services/orchestrator/kubernetes/normalize/env';
import { type NormalizeInputOverrides, normalizeContext, serviceDraft } from '../support/builders';

/** design-01 codes env.ts may emit (5.3, 10 S8, 2.11, the value layer it reads through, 1.5 file reads) */
const ENV_CODES = new Set([
  'env.unset-variable',
  'env.invalid-name',
  'env.too-large',
  'env.swarm-service-name',
  'env.renamed-service-name',
  'env_file.optional-missing',
  'env_file.parse-error',
  'env_file.unsupported-format',
  'interpolate.unset',
  'interpolate.required',
  'interpolate.invalid',
  'files.not-found',
  'files.not-a-file',
  'files.outside-project',
  'files.unreadable',
  'files.absolute-path',
  'files.backslash-path',
  'values.invalid-type',
  'values.invalid-boolean',
  'values.yaml11-boolean',
  'values.empty',
  'values.empty-key',
  'values.duplicate-key',
]);

const emitted = new Set<string>();

interface Run {
  draft: ServiceDraft;
  diagnostics: Diagnostic[];
  ctx: NormalizeContext;
}

function run(node: Record<string, unknown>, overrides: NormalizeInputOverrides = {}, key = 'web'): Run {
  const ctx = normalizeContext(overrides);
  const draft = serviceDraft(key, ctx);
  normalizeEnv(draft, node, ctx);
  const diagnostics = ctx.sink.list();
  for (const d of diagnostics) emitted.add(d.code);
  return { draft, diagnostics, ctx };
}

const brief = (ds: Diagnostic[]): [string, string, string][] => ds.map((d) => [d.severity, d.code, d.path]);
const vars = (pairs: Record<string, string>): EnvVar[] => Object.entries(pairs).map(([name, value]) => ({ name, value }));
const none = (): undefined => undefined;

/** A resolver that records every path it is asked for. */
function spyResolver(files: Record<string, string>): { resolver: FileResolver; calls: string[] } {
  const calls: string[] = [];
  const resolver: FileResolver = (path) => {
    calls.push(path);
    const content = files[path];
    return content === undefined ? { ok: false, reason: 'missing' } : { ok: true, bytes: new TextEncoder().encode(content), rendered: true };
  };
  return { resolver, calls };
}

describe('environment (design-01 5.3)', () => {
  test('ENV-01: map form, values as strings, sorted by name', () => {
    const { draft, diagnostics } = run({ environment: { B: '2', A: 1 } });
    expect(draft.environment).toEqual(vars({ A: '1', B: '2' }));
    expect(diagnostics).toEqual([]);
  });

  test('ENV-02: list form splits at the first =; an empty value is kept', () => {
    const { draft, diagnostics } = run({ environment: ['A=1', 'B=', 'C=x=y'] });
    expect(draft.environment).toEqual(vars({ A: '1', B: '', C: 'x=y' }));
    expect(diagnostics).toEqual([]);
  });

  test('ENV-03: a variable without a value is not set, with a warning', () => {
    const map = run({ environment: { A: null, KEEP: 'x' } });
    expect(map.draft.environment).toEqual(vars({ KEEP: 'x' }));
    expect(map.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'env.unset-variable',
        path: 'services.web.environment.A',
        message: 'A has no value, so it is not set in the container: Dockflow does not pass its own environment to the service',
        hint: 'Give it a value, for example `A: "{{ current.env.a }}"`.',
      },
    ]);
    const list = run({ environment: ['B'] });
    expect(list.draft.environment).toEqual([]);
    expect(brief(list.diagnostics)).toEqual([['warning', 'env.unset-variable', 'services.web.environment[0]']]);
  });

  test('ENV-04: env files in list order, then environment; a variable without a value removes a file value', () => {
    const files = { 'a.env': 'X=a\nZ=from-a\n', 'b.env': 'X=b\nY=1\n' };
    const { draft, diagnostics } = run({ env_file: ['a.env', 'b.env'], environment: { Y: 2, Z: null } }, { files });
    expect(draft.environment).toEqual(vars({ X: 'b', Y: '2' }));
    expect(brief(diagnostics)).toEqual([['warning', 'env.unset-variable', 'services.web.environment.Z']]);
  });

  test('environment: later list entries win, with an info; empty names and invalid types are refused', () => {
    const duplicate = run({ environment: ['A=1', 'A=2'] });
    expect(duplicate.draft.environment).toEqual(vars({ A: '2' }));
    expect(duplicate.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'values.duplicate-key',
        path: 'services.web.environment[1]',
        message: 'A is set more than once; the last value wins',
      },
    ]);
    expect(run({ environment: ['=v'] }).diagnostics).toEqual([
      { severity: 'error', code: 'values.empty-key', path: 'services.web.environment[0]', message: 'an entry has an empty name' },
    ]);
    expect(run({ environment: 'A=1' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.environment',
        message: 'expected list or mapping, got string',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
    const nested = run({ environment: { A: ['x'], B: true, C: 'ok' } });
    expect(nested.draft.environment).toEqual(vars({ B: 'true', C: 'ok' }));
    expect(brief(nested.diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.environment.A']]);
  });

  test('ENV-05: names must be Secret data keys', () => {
    const rows: [string, string][] = [
      ['my var', 'services.web.environment["my var"]'],
      ['A:B', 'services.web.environment["A:B"]'],
      ['..x', 'services.web.environment["..x"]'],
    ];
    for (const [name, path] of rows) {
      const { draft, diagnostics } = run({ environment: { [name]: 1, OK: 'y' } });
      expect(draft.environment).toEqual(vars({ OK: 'y' }));
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'env.invalid-name',
          path,
          message: `environment variable ${name} cannot be stored in a Kubernetes Secret: names may only contain letters, digits, '-', '_' and '.'`,
          hint: 'Rename the variable.',
        },
      ]);
    }
    const accepted = run({ environment: { '1ST': 1, 'a.b-c': 2 } });
    expect(accepted.draft.environment).toEqual(vars({ '1ST': '1', 'a.b-c': '2' }));
    expect(accepted.diagnostics).toEqual([]);
  });

  test('ENV-05: a variable from an env file names the file in the message', () => {
    const { draft, diagnostics } = run({ env_file: 'app.env' }, { files: { 'app.env': 'A[0]=1\nB=2\n' } });
    expect(draft.environment).toEqual(vars({ B: '2' }));
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'env.invalid-name',
        path: 'services.web.env_file',
        message: "app.env: environment variable A[0] cannot be stored in a Kubernetes Secret: names may only contain letters, digits, '-', '_' and '.'",
        hint: 'Rename the variable.',
      },
    ]);
  });

  test('ENV-06: the environment is limited to 1 MiB of names and values (UTF-8 bytes)', () => {
    expect(ENV_MAX_BYTES).toBe(1_000_000);
    const { diagnostics } = run({ environment: { BIG: 'x'.repeat(1_000_001) } });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'env.too-large',
        path: 'services.web',
        message: 'the environment of web is 1000004 bytes; Kubernetes Secrets are limited to 1 MiB',
        hint: 'Move large values to a config or secret file.',
      },
    ]);
    expect(run({ environment: { A: 'x'.repeat(999_999) } }).diagnostics).toEqual([]);
    expect(brief(run({ environment: { A: 'é'.repeat(500_000) } }).diagnostics)).toEqual([['error', 'env.too-large', 'services.web']]);
  });
});

describe('service names inside values (design-01 10 S8)', () => {
  const minecraft = { services: [{ key: 'minecraft', name: 'minecraft', aliases: [], published: [] }] };

  test('ENV-07: a Swarm service name of the sibling file', () => {
    const { diagnostics } = run({ environment: { RCON_HOST: 'shop-production_minecraft' } }, { sibling: minecraft });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'env.swarm-service-name',
        path: 'services.web.environment.RCON_HOST',
        message: 'the value of RCON_HOST mentions shop-production_minecraft, a Swarm service name that does not resolve on Kubernetes',
        hint: 'Use the service name `minecraft` instead.',
      },
    ]);
  });

  test('ENV-07: tasks.<svc>, own services and env files are scanned; longer tokens are not', () => {
    const tasks = run({ environment: { PEERS: 'tasks.minecraft' } }, { sibling: minecraft });
    expect(tasks.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ['env.swarm-service-name', 'the value of PEERS mentions tasks.minecraft, a Swarm service name that does not resolve on Kubernetes'],
    ]);
    expect(brief(run({ environment: { SELF: 'http://shop-production_web:80' } }).diagnostics)).toEqual([
      ['warning', 'env.swarm-service-name', 'services.web.environment.SELF'],
    ]);
    const fromFile = run({ env_file: 'app.env' }, { sibling: minecraft, files: { 'app.env': 'HOST=shop-production_minecraft\n' } });
    expect(brief(fromFile.diagnostics)).toEqual([['warning', 'env.swarm-service-name', 'services.web.env_file']]);
    expect(run({ environment: { X: 'shop-production_minecraft2', Y: 'minecraft' } }, { sibling: minecraft }).diagnostics).toEqual([]);
  });

  test('ENV-07b: a compose key that sanitizing renames, as a whole token only', () => {
    const { diagnostics } = run(
      { environment: { DB_HOST: 'web_app', URL: 'http://web_app:8080/x', OTHER: 'my_web_appliance', PLAIN: 'api' } },
      {
        compose: { services: { api: { image: 'nginx:1.27' } } },
        sibling: { services: [{ key: 'web_app', name: 'web-app', aliases: [], published: [] }] },
      },
      'api',
    );
    expect(diagnostics).toEqual(
      ['DB_HOST', 'URL'].map((name) => ({
        severity: 'warning',
        code: 'env.renamed-service-name',
        path: `services.api.environment.${name}`,
        message: `the value of ${name} mentions web_app, which is deployed as Kubernetes service web-app`,
        hint: 'Use `web-app`; the compose name does not resolve in DNS.',
      })),
    );
  });

  test('ENV-07b: renamed keys of the own file are scanned too; the value is never printed', () => {
    const { diagnostics } = run(
      { environment: { QUEUE: 'amqp://user:s3cret@Queue_1:5672' } },
      { compose: { services: { api: { image: 'nginx:1.27' }, Queue_1: { image: 'rabbitmq:4' } } } },
      'api',
    );
    expect(diagnostics.map((d) => [d.code, d.message, d.hint])).toEqual([
      [
        'env.renamed-service-name',
        'the value of QUEUE mentions Queue_1, which is deployed as Kubernetes service queue-1',
        'Use `queue-1`; the compose name does not resolve in DNS.',
      ],
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('s3cret');
  });

  test('containsToken: delimited by string ends or characters outside [A-Za-z0-9._-]', () => {
    expect(containsToken('web_app', 'web_app')).toBe(true);
    expect(containsToken('http://web_app:8080', 'web_app')).toBe(true);
    expect(containsToken('my_web_appliance', 'web_app')).toBe(false);
    expect(containsToken('xweb_app', 'web_app')).toBe(false);
    expect(containsToken('web_app.internal', 'web_app')).toBe(false);
    expect(containsToken('aweb_app web_app', 'web_app')).toBe(true);
  });
});

describe('env_file (design-01 5.3)', () => {
  test('ENV-08: the string form reads one required file, the path as the resolver expects it', () => {
    const { resolver, calls } = spyResolver({ '.env': 'A=1\n', 'conf/app.env': 'B=2\n' });
    expect(run({ env_file: '.env' }, { files: resolver }).draft.environment).toEqual(vars({ A: '1' }));
    expect(run({ env_file: './conf//app.env' }, { files: resolver }).draft.environment).toEqual(vars({ B: '2' }));
    expect(calls).toEqual(['.env', 'conf/app.env']);
  });

  test('ENV-09: list of strings and mappings in order; a mapping needs a path', () => {
    const files = { 'a.env': 'X=a\n', 'b.env': 'X=b\n' };
    expect(run({ env_file: [{ path: 'a.env' }, 'b.env'] }, { files }).draft.environment).toEqual(vars({ X: 'b' }));
    expect(run({ env_file: ['b.env', { path: 'a.env' }] }, { files }).draft.environment).toEqual(vars({ X: 'a' }));
    expect(run({ env_file: [{ required: false }] }).diagnostics).toEqual([
      { severity: 'error', code: 'values.empty', path: 'services.web.env_file[0].path', message: 'must not be empty' },
    ]);
    expect(brief(run({ env_file: [''] }).diagnostics)).toEqual([['error', 'values.empty', 'services.web.env_file[0]']]);
    expect(brief(run({ env_file: [{ path: 3 }] }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.env_file[0].path']]);
  });

  test('env_file: required is a boolean; other forms are refused', () => {
    const files = { 'a.env': 'X=a\n' };
    const yes = run({ env_file: [{ path: 'a.env', required: 'yes' }] }, { files });
    expect(yes.draft.environment).toEqual(vars({ X: 'a' }));
    expect(brief(yes.diagnostics)).toEqual([['warning', 'values.yaml11-boolean', 'services.web.env_file[0].required']]);
    const bad = run({ env_file: [{ path: 'a.env', required: 'maybe' }] }, { files });
    expect(bad.draft.environment).toEqual([]);
    expect(brief(bad.diagnostics)).toEqual([['error', 'values.invalid-boolean', 'services.web.env_file[0].required']]);
    expect(run({ env_file: 3 }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.env_file',
        message: 'expected string or list, got number',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
    expect(brief(run({ env_file: [true] }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.env_file[0]']]);
  });

  test('ENV-10: a missing optional file is skipped with an info; a missing required file is refused', () => {
    const optional = run({ env_file: [{ path: 'x.env', required: false }] });
    expect(optional.draft.environment).toEqual([]);
    expect(optional.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'env_file.optional-missing',
        path: 'services.web.env_file[0].path',
        message: 'optional env file x.env was not found and is skipped',
      },
    ]);
    expect(run({ env_file: 'x.env' }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'files.not-found',
        path: 'services.web.env_file',
        message: 'file x.env was not found in the project',
        hint: 'Paths are relative to the directory of the compose file and must stay inside the project.',
      },
    ]);
  });

  test('env_file: required: false only tolerates a missing file', () => {
    const files = { 'dir.env': { fail: 'directory' as const } };
    expect(brief(run({ env_file: [{ path: 'dir.env', required: false }] }, { files }).diagnostics)).toEqual([
      ['error', 'files.not-a-file', 'services.web.env_file[0].path'],
    ]);
    const other = run(
      { env_file: ['out.env', 'locked.env'] },
      { files: { 'out.env': { fail: 'outside-project' }, 'locked.env': { fail: 'unreadable' } } },
    );
    expect(brief(other.diagnostics)).toEqual([
      ['error', 'files.outside-project', 'services.web.env_file[0]'],
      ['error', 'files.unreadable', 'services.web.env_file[1]'],
    ]);
  });

  test('ENV-11: absolute and home paths would be read on the machine running dockflow', () => {
    for (const path of ['/etc/app.env', '~/app.env', 'C:/app.env']) {
      const { resolver, calls } = spyResolver({});
      expect(run({ env_file: path }, { files: resolver }).diagnostics).toEqual([
        {
          severity: 'error',
          code: 'files.absolute-path',
          path: 'services.web.env_file',
          message: `absolute paths are not supported: ${path} would be read on the machine running dockflow`,
          hint: 'Put the file in the project and use a path relative to the compose file.',
        },
      ]);
      expect(calls).toEqual([]);
    }
    expect(brief(run({ env_file: 'conf\\app.env' }).diagnostics)).toEqual([['error', 'files.backslash-path', 'services.web.env_file']]);
  });

  test('ENV-12: dotenv values are interpolated; an unset variable is refused without its name', () => {
    const { draft, diagnostics } = run({ env_file: '.env' }, { files: { '.env': 'A=1\nB="${A}-x"\nC=$UNSET\n' } });
    expect(draft.environment.find((v) => v.name === 'B')).toEqual({ name: 'B', value: '1-x' });
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.unset',
        path: 'services.web.env_file',
        message: '.env: contains a $ placeholder that has no value (Dockflow does not pass a process environment)',
        hint: 'Use `{{ current.env.<name> }}` for a Dockflow value, or write `$$` for a literal `$` (for inserted values: `{{ value | replace("$", "$$") }}`).',
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('UNSET');
  });

  test('env files see the variables of earlier files, and required and invalid placeholders are refused', () => {
    const files = {
      'a.env': 'HOST=db\n',
      'b.env': 'URL=postgres://${HOST}/app\nHOST\n',
      'required.env': 'A=${B:?set B}\n',
      'invalid.env': 'A=${\n',
    };
    expect(run({ env_file: ['a.env', 'b.env'] }, { files }).draft.environment).toEqual(vars({ HOST: 'db', URL: 'postgres://db/app' }));
    expect(run({ env_file: 'required.env' }, { files }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.required',
        path: 'services.web.env_file',
        message: 'required.env: contains a ${...:?} placeholder whose variable has no value (Dockflow does not pass a process environment)',
        hint: 'Replace the placeholder with a Nunjucks value such as `{{ current.env.<name> }}`.',
      },
    ]);
    expect(run({ env_file: 'invalid.env' }, { files }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'interpolate.invalid',
        path: 'services.web.env_file',
        message: 'invalid.env: contains an invalid ${...} placeholder',
        hint: 'Write `$$` for a literal `$`.',
      },
    ]);
  });

  test('ENV-13: format raw reads values verbatim, without interpolation', () => {
    const { draft, diagnostics } = run({ env_file: [{ path: 'raw.env', format: 'raw' }] }, { files: { 'raw.env': 'P="a$b"\n' } });
    expect(draft.environment).toEqual(vars({ P: '"a$b"' }));
    expect(diagnostics).toEqual([]);
  });

  test('ENV-14: another format is refused and the file is not read', () => {
    const { resolver, calls } = spyResolver({ 'a.env': 'A=1\n' });
    const { draft, diagnostics } = run({ env_file: [{ path: 'a.env', format: 'json' }] }, { files: resolver });
    expect(draft.environment).toEqual([]);
    expect(calls).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'env_file.unsupported-format',
        path: 'services.web.env_file[0].format',
        message: 'format json is not supported',
        hint: 'Remove `format`, or use `format: raw`.',
      },
    ]);
  });

  test('ENV-15: a parse error names the file and the line, never the content', () => {
    expect(run({ env_file: '.env' }, { files: { '.env': 'BAD KEY=1\n' } }).diagnostics).toEqual([
      {
        severity: 'error',
        code: 'env_file.parse-error',
        path: 'services.web.env_file',
        message: '.env line 1: key cannot contain a space',
        hint: 'Fix the line; the env file format is described in the Compose specification.',
      },
    ]);
    const third = run({ env_file: '.env' }, { files: { '.env': '# c\nA=1\nQ="open secret\n' } });
    expect(third.diagnostics.map((d) => d.message)).toEqual(['.env line 3: unterminated quoted value']);
    const bytes = new Uint8Array([...new TextEncoder().encode('A=1\nB='), 0xff, 0x0a]);
    expect(run({ env_file: '.env' }, { files: { '.env': bytes } }).diagnostics.map((d) => d.message)).toEqual([
      '.env line 2: the file is not valid UTF-8',
    ]);
  });
});

describe('env file parsers (design-01 2.11)', () => {
  test('UNIT-13: dotenv quotes, escapes, comments, export and inherited keys', () => {
    expect(parseDotenv('A=1\nB="x\\ty"\nC=\'$A\'\nD=$A # c\nexport E=2\nF\n', none)).toEqual({
      vars: [
        ['A', '1'],
        ['B', 'x\ty'],
        ['C', '$A'],
        ['D', '1'],
        ['E', '2'],
      ],
      issues: [],
    });
  });

  test('UNIT-14: dotenv multi-line double quotes, escaped $ and # inside a word', () => {
    expect(parseDotenv('A="multi\nline"\nB="a\\$b"\nC=a#b\n', none)).toEqual({
      vars: [
        ['A', 'multi\nline'],
        ['B', 'a$b'],
        ['C', 'a#b'],
      ],
      issues: [],
    });
  });

  test('UNIT-15: dotenv errors: space in a key, required variable, unterminated quote', () => {
    expect(parseDotenv('MY KEY=1\n', none)).toEqual({ error: 'key cannot contain a space', line: 1 });
    expect(parseDotenv('A=${B:?no}\n', none)).toEqual({ vars: [['A', '']], issues: [{ kind: 'required' }] });
    expect(parseDotenv('Q="open', none)).toEqual({ error: 'unterminated quoted value', line: 1 });
  });

  test('UNIT-16: kvfile keeps quotes and trailing spaces; a bare key is inherited', () => {
    expect(parseKvFile('A="q" \n #c\nB', none)).toEqual({ vars: [['A', '"q" ']], issues: [] });
    expect(parseKvFile('A="q" \n #c\nB', (k) => (k === 'B' ? 'from-earlier' : undefined))).toEqual({
      vars: [
        ['A', '"q" '],
        ['B', 'from-earlier'],
      ],
      issues: [],
    });
  });

  test('dotenv: single quotes are literal except an escaped quote; colon separator; BOM and CRLF', () => {
    expect(parseDotenv("A='a\\'b'\nB='x\\ny'\n", none)).toEqual({
      vars: [
        ['A', "a'b"],
        ['B', 'x\\ny'],
      ],
      issues: [],
    });
    expect(parseDotenv('\ufeffK: v\r\nL=w\r\n', none)).toEqual({
      vars: [
        ['K', 'v'],
        ['L', 'w'],
      ],
      issues: [],
    });
    expect(parseDotenv('A="\\101\\0101\\q"\n', none)).toEqual({ vars: [['A', '\\101A\\q']], issues: [] });
    expect(parseDotenv('A=1\nB!=2\n', none)).toEqual({ error: 'unexpected character "!" in variable name', line: 2 });
    expect(parseDotenv('=1\n', none)).toEqual({ error: 'key cannot be empty', line: 1 });
  });

  test('dotenv: earlier lines win over the lookup, and a bare key inherits', () => {
    const lookup = (k: string): string | undefined => (k === 'A' ? 'outer' : k === 'I' ? 'inherited' : undefined);
    expect(parseDotenv('B=$A\nA=inner\nC=$A\nI\n', lookup)).toEqual({
      vars: [
        ['B', 'outer'],
        ['A', 'inner'],
        ['C', 'inner'],
        ['I', 'inherited'],
      ],
      issues: [],
    });
  });

  test('kvfile: BOM, CRLF, whitespace in a key, empty name', () => {
    expect(parseKvFile('\ufeffA=1\r\nB=2\r\n', none)).toEqual({
      vars: [
        ['A', '1'],
        ['B', '2'],
      ],
      issues: [],
    });
    expect(parseKvFile('A=1\nMY KEY=1\n', none)).toEqual({ error: 'variable MY KEY contains whitespace', line: 2 });
    expect(parseKvFile('=1\n', none)).toEqual({ error: 'no variable name on the line', line: 1 });
  });

  test('interpolation inside env files (design-01 2.3 grammar)', () => {
    const lookup = (k: string): string | undefined => ({ A: 'a', E: '' })[k];
    const value = (input: string): string => interpolateEnvValue(input, lookup).value;
    expect(value('$$A')).toBe('$A');
    expect(value('${A}-$A')).toBe('a-a');
    expect(value('${U:-d}|${E:-d}|${E-d}|${U-d}')).toBe('d|d||d');
    expect(value('${A:+x}|${E:+x}|${E+x}|${U+x}')).toBe('x||x|');
    expect(value('${U:-${A:-x}}')).toBe('a');
    expect(value('price $5 $(date) $')).toBe('price $5 $(date) $');
    expect(interpolateEnvValue('${U}', lookup).issues).toEqual([{ kind: 'unset' }]);
    expect(interpolateEnvValue('${E:?m}', lookup).issues).toEqual([{ kind: 'required' }]);
    expect(interpolateEnvValue('${E?m}', lookup)).toEqual({ value: '', issues: [] });
    expect(interpolateEnvValue('${A/b/c}', lookup).issues).toEqual([{ kind: 'invalid' }]);
    expect(interpolateEnvValue('${', lookup).issues).toEqual([{ kind: 'invalid' }]);
  });

  test('decodeUtf8 reports the line of the first invalid sequence', () => {
    expect(decodeUtf8(new TextEncoder().encode('A=é\n'))).toEqual({ text: 'A=é\n' });
    expect(decodeUtf8(new Uint8Array([0x41, 0x0a, 0x42, 0x0a, 0xc3, 0x28]))).toEqual({ badLine: 3 });
  });
});

describe('handler contract', () => {
  test('absent keys leave an empty environment', () => {
    const { draft, diagnostics } = run({ image: 'nginx:1.27' });
    expect(draft.environment).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test('a service marked fatal is skipped', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    normalizeEnv(draft, { environment: { A: null }, env_file: '/etc/x.env' }, ctx);
    expect(ctx.sink.list()).toEqual([]);
    expect(draft.environment).toEqual([]);
  });

  test('every code emitted in this file is a design-01 code of env.ts, and every such code is exercised', () => {
    expect([...emitted].filter((code) => !ENV_CODES.has(code))).toEqual([]);
    expect([...ENV_CODES].filter((code) => !emitted.has(code))).toEqual([]);
  });
});
