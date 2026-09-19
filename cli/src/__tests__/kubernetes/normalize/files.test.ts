import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { FileResolver } from '../../../services/orchestrator/interfaces';
import type { FileMountSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { hashedObjectName } from '../../../services/orchestrator/kubernetes/naming';
import type {
  FileSourceDraft,
  FileSourceTable,
  NormalizeContext,
  ServiceDraft,
} from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  DEFAULT_FILE_MODE,
  maskFileMode,
  normalizeTopLevelFiles,
  serviceFiles,
} from '../../../services/orchestrator/kubernetes/normalize/files';
import { sha256Hex } from '../../../utils/hash';
import {
  type FileFixture,
  fileResolver,
  type NormalizeInputOverrides,
  normalizeContext,
  parsedCompose,
  serviceDraft,
} from '../support/builders';

interface Run {
  ctx: NormalizeContext;
  sources: FileSourceTable;
  drafts: Map<string, ServiceDraft>;
  diagnostics: Diagnostic[];
}

/** Top-level secrets and configs, then every service in key order (design-01 1.2). */
function run(source: string | Record<string, unknown>, overrides: NormalizeInputOverrides = {}): Run {
  const compose = parsedCompose(source);
  const ctx = normalizeContext({ ...overrides, compose });
  const sources = normalizeTopLevelFiles(compose.raw.secrets, compose.raw.configs, ctx);
  const drafts = new Map<string, ServiceDraft>();
  for (const key of Object.keys(compose.services).sort()) {
    const draft = serviceDraft(key, ctx);
    serviceFiles(draft, compose.services[key], sources, ctx);
    drafts.set(key, draft);
  }
  return { ctx, sources, drafts, diagnostics: ctx.sink.list() };
}

/** A resolver over `files` that records every path it is asked for. */
function countingResolver(files: Record<string, FileFixture>): { resolver: FileResolver; calls: string[] } {
  const inner = fileResolver(files);
  const calls: string[] = [];
  return {
    calls,
    resolver: (path) => {
      calls.push(path);
      return inner(path);
    },
  };
}

function mounts(r: Run, service = 'web'): FileMountSpec[] {
  return r.drafts.get(service)?.files ?? [];
}

function secret(r: Run, key: string): FileSourceDraft | undefined {
  return r.sources.secrets.get(key);
}

function config(r: Run, key: string): FileSourceDraft | undefined {
  return r.sources.configs.get(key);
}

function withCode(r: Run, code: string): Diagnostic[] {
  return r.diagnostics.filter((d) => d.code === code);
}

function codesAt(r: Run, path: string): string[] {
  return r.diagnostics.filter((d) => d.path === path).map((d) => d.code);
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Service `web` mounting `secrets` and `configs`, with the given top-level tables. */
function webWith(
  mountsOf: { secrets?: unknown[]; configs?: unknown[] },
  topLevel: { secrets?: Record<string, unknown>; configs?: Record<string, unknown> },
): Record<string, unknown> {
  return { services: { web: { image: 'nginx:1.27', ...mountsOf } }, ...topLevel };
}

describe('service secrets and configs (design-01 5.6)', () => {
  test('SEC-01 short secret: default target and mode, content read and named', () => {
    const r = run(webWith({ secrets: ['db_password'] }, { secrets: { db_password: { file: './pw.txt' } } }), {
      files: { 'pw.txt': 'hunter2' },
    });
    expect(mounts(r)).toEqual([
      {
        kind: 'secret',
        source: 'db_password',
        target: '/run/secrets/db_password',
        mode: 292,
        uid: null,
        gid: null,
        path: 'services.web.secrets[0]',
      },
    ]);
    const checksum = sha256Hex(text('hunter2'));
    expect(secret(r, 'db_password')).toEqual({
      kind: 'secret',
      key: 'db_password',
      objectName: hashedObjectName('db_password', 'secret', checksum),
      role: 'app',
      external: false,
      data: text('hunter2'),
      checksum,
      path: 'secrets.db_password',
      file: './pw.txt',
    });
    expect(secret(r, 'db_password')?.objectName).toMatch(/^db-password-secret-[0-9a-f]{8}$/);
    expect(r.diagnostics).toEqual([]);
  });

  test('SEC-02 short config: target /<name>', () => {
    const r = run(webWith({ configs: ['nginx_conf'] }, { configs: { nginx_conf: { content: 'server {}' } } }));
    expect(mounts(r)).toEqual([
      { kind: 'config', source: 'nginx_conf', target: '/nginx_conf', mode: 292, uid: null, gid: null, path: 'services.web.configs[0]' },
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  test('SEC-03 undeclared or missing sources', () => {
    const r = run(webWith({ secrets: [{ source: 'nope' }, 'ghost', { target: '/x' }], configs: ['app'] }, {}));
    expect(withCode(r, 'files.undeclared')).toEqual([
      {
        severity: 'error',
        code: 'files.undeclared',
        path: 'services.web.configs[0]',
        message: 'config app is not declared under top-level configs',
        hint: 'Declare it, for example `configs: {app: {file: ./app.txt}}`.',
      },
      {
        severity: 'error',
        code: 'files.undeclared',
        path: 'services.web.secrets[0].source',
        message: 'secret nope is not declared under top-level secrets',
        hint: 'Declare it, for example `secrets: {nope: {file: ./nope.txt}}`.',
      },
      {
        severity: 'error',
        code: 'files.undeclared',
        path: 'services.web.secrets[1]',
        message: 'secret ghost is not declared under top-level secrets',
        hint: 'Declare it, for example `secrets: {ghost: {file: ./ghost.txt}}`.',
      },
    ]);
    expect(codesAt(r, 'services.web.secrets[2].source')).toEqual(['values.empty']);
    expect(mounts(r)).toEqual([]);
  });

  test('SEC-04 targets', () => {
    const r = run(
      webWith(
        {
          secrets: [
            { source: 'tls', target: 'server.crt' },
            { source: 'tls', target: '/etc/tls/key.pem' },
            { source: 'tls', target: 'certs/' },
            { source: 'tls', target: '/run/secrets/' },
            { source: 'tls', target: '.' },
            { source: 'tls', target: 'nested/../ca.pem' },
          ],
          configs: [
            { source: 'app', target: 'app.yml' },
            { source: 'app', target: '/etc/app//app.yml' },
          ],
        },
        { secrets: { tls: { content_file: null, file: 'tls.pem' } }, configs: { app: { content: 'a: 1' } } },
      ),
      { files: { 'tls.pem': 'cert' } },
    );
    expect(mounts(r).map((m) => [m.path, m.target])).toEqual([
      ['services.web.secrets[0]', '/run/secrets/server.crt'],
      ['services.web.secrets[1]', '/etc/tls/key.pem'],
      ['services.web.secrets[5]', '/run/secrets/ca.pem'],
      ['services.web.configs[1]', '/etc/app/app.yml'],
    ]);
    expect(withCode(r, 'files.relative-config-target')).toEqual([
      {
        severity: 'error',
        code: 'files.relative-config-target',
        path: 'services.web.configs[0].target',
        message: 'config target app.yml must be an absolute path',
        hint: 'Write the full path, for example `/etc/app/app.yml`.',
      },
    ]);
    expect(withCode(r, 'files.invalid-target').map((d) => [d.path, d.message])).toEqual([
      ['services.web.secrets[2].target', 'target certs/ must name a file'],
      ['services.web.secrets[3].target', 'target /run/secrets/ must name a file'],
      ['services.web.secrets[4].target', 'target . must name a file'],
    ]);
  });

  test('SEC-05 modes: octal literals, strings, 0o form, decimal look-alikes, invalid values', () => {
    const r = run(
      `
      services:
        web:
          image: nginx:1.27
          secrets:
            - {source: s, target: a, mode: 0440}
            - {source: s, target: b, mode: "0600"}
            - {source: s, target: c, mode: 0o755}
            - {source: s, target: d, mode: 440}
            - {source: s, target: e, mode: "0999"}
            - {source: s, target: f, mode: 01777}
            - {source: s, target: g, mode: 0700}
            - {source: s, target: h, mode: 0400}
            - {source: s, target: i, mode: 0644}
            - {source: s, target: j, mode: 0640}
            - {source: s, target: k, mode: 0555}
            - {source: s, target: l, mode: 00}
      secrets:
        s: {file: ./s.txt}
      `,
      { files: { 's.txt': 'x' } },
    );
    // the writable bits are dropped here, once (K35); an invalid mode keeps the default
    expect(mounts(r).map((m) => m.mode)).toEqual([
      0o440, 0o400, 0o555, 0o450, 0o444, 0o444, 0o500, 0o400, 0o444, 0o440, 0o555, 0,
    ]);
    expect(mounts(r)[0].mode).toBe(288);
    // a 0-prefixed literal is octal however its digits read in decimal: only `440` warns
    expect(withCode(r, 'files.mode-decimal')).toEqual([
      {
        severity: 'warning',
        code: 'files.mode-decimal',
        path: 'services.web.secrets[3].mode',
        message: 'mode 440 is read as the decimal number 440 (octal 0670)',
        hint: 'Write `0440` for octal permissions.',
      },
    ]);
    expect(withCode(r, 'values.invalid-mode')).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-mode',
        path: 'services.web.secrets[4].mode',
        message: '0999 is not a file mode',
        hint: 'Write an octal mode such as `0440`.',
      },
      {
        severity: 'error',
        code: 'values.invalid-mode',
        path: 'services.web.secrets[5].mode',
        message: '01777 is not a file mode',
        hint: 'Write an octal mode such as `0440`.',
      },
    ]);
  });

  test('SEC-05 maskFileMode is the one masking rule', () => {
    expect(DEFAULT_FILE_MODE).toBe(0o444);
    expect(maskFileMode(0o777)).toBe(0o555);
    expect(maskFileMode(0o644)).toBe(0o444);
    expect(maskFileMode(0o000)).toBe(0);
  });

  test('SEC-06 uid and gid', () => {
    const r = run(
      webWith(
        {
          secrets: [
            { source: 's', target: 'a', uid: '103', gid: '103' },
            { source: 's', target: 'b', uid: '0', gid: '0' },
            { source: 's', target: 'c', uid: 1000 },
            { source: 's', target: 'd', gid: true },
          ],
        },
        { secrets: { s: { file: 's.txt' } } },
      ),
      { files: { 's.txt': 'x' } },
    );
    expect(mounts(r).map((m) => [m.target, m.uid, m.gid])).toEqual([
      ['/run/secrets/a', '103', '103'],
      ['/run/secrets/b', '0', '0'],
      ['/run/secrets/c', '1000', null],
      ['/run/secrets/d', null, null],
    ]);
    expect(withCode(r, 'files.ownership-ignored')).toEqual([
      {
        severity: 'warning',
        code: 'files.ownership-ignored',
        path: 'services.web.secrets[0]',
        message: 'uid and gid are ignored: files mounted from Kubernetes Secrets and ConfigMaps are owned by root',
        hint: 'Make the file readable with `mode`, or set `x-dockflow.fs_group` to give its group to the pod.',
      },
      {
        severity: 'warning',
        code: 'files.ownership-ignored',
        path: 'services.web.secrets[2]',
        message: 'uid and gid are ignored: files mounted from Kubernetes Secrets and ConfigMaps are owned by root',
        hint: 'Make the file readable with `mode`, or set `x-dockflow.fs_group` to give its group to the pod.',
      },
    ]);
    expect(codesAt(r, 'services.web.secrets[3].gid')).toEqual(['values.invalid-type']);
  });

  test('SEC-07 external sources: mounted as is, with a reminder of the data key', () => {
    const r = run(
      webWith({ secrets: ['tls', 'shared'] }, { secrets: { tls: { external: true }, shared: { external: true, name: 'shared-tls' } } }),
    );
    expect(mounts(r).map((m) => [m.source, m.target])).toEqual([
      ['tls', '/run/secrets/tls'],
      ['shared', '/run/secrets/shared'],
    ]);
    expect(withCode(r, 'files.external-key').map((d) => [d.severity, d.path, d.message])).toEqual([
      ['info', 'services.web.secrets[0]', 'the external secret tls must contain a data key named tls'],
      ['info', 'services.web.secrets[1]', 'the external secret shared-tls must contain a data key named shared'],
    ]);
    expect(secret(r, 'shared')).toMatchObject({ external: true, objectName: 'shared-tls', data: null, checksum: null });
  });

  test('SEC-08 entries of another type', () => {
    const r = run(webWith({ secrets: [42] }, { secrets: { s: { file: 's.txt' } } }));
    expect(codesAt(r, 'services.web.secrets[0]')).toEqual(['values.invalid-type']);
    expect(withCode(r, 'values.invalid-type')[0].message).toBe('expected string or mapping, got number');
    const notList = run({ services: { web: { image: 'nginx:1.27', configs: 'app' } }, configs: { app: { content: 'x' } } });
    expect(codesAt(notList, 'services.web.configs')).toEqual(['values.invalid-type']);
  });

  test('secret and config targets share the target space with volumes', () => {
    const r = run(
      webWith(
        { secrets: [{ source: 's', target: '/etc/app/conf' }], configs: [{ source: 'c', target: '/etc/app/conf' }] },
        { secrets: { s: { file: 's.txt' } }, configs: { c: { content: 'x' } } },
      ),
      { files: { 's.txt': 'x' } },
    );
    expect(withCode(r, 'mounts.duplicate-target')).toEqual([
      {
        severity: 'error',
        code: 'mounts.duplicate-target',
        path: 'services.web.configs[0]',
        message: '/etc/app/conf is mounted twice (services.web.secrets[0] and services.web.configs[0])',
        hint: 'Mount each path once.',
      },
    ]);

    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    draft.mounts.push({ type: 'tmpfs', target: '/app', sizeBytes: null, path: 'services.web.tmpfs' });
    const sources = normalizeTopLevelFiles(undefined, { app: { content: 'x' } }, ctx);
    serviceFiles(draft, { configs: ['app'] }, sources, ctx);
    expect(draft.files).toEqual([]);
    expect(ctx.sink.list().map((d) => d.code)).toEqual(['mounts.duplicate-target']);
  });
});

describe('top-level secrets and configs (design-01 6.3)', () => {
  test('TFILE-01 file source: bytes, checksum, content-named object', () => {
    const r = run(webWith({ secrets: ['pw'] }, { secrets: { pw: { file: './pw.txt' } } }), { files: { 'pw.txt': 's3cret' } });
    const pw = secret(r, 'pw');
    expect(pw?.data).toEqual(text('s3cret'));
    expect(pw?.checksum).toBe(sha256Hex(text('s3cret')));
    expect(pw?.objectName).toBe(`pw-secret-${sha256Hex(text('s3cret')).slice(0, 8)}`);
    expect(r.diagnostics).toEqual([]);
  });

  test('TFILE-01 absolute, backslash and missing paths are refused when the entry is used', () => {
    const r = run(
      webWith(
        { secrets: ['abs', 'back', 'gone'] },
        { secrets: { abs: { file: '/run/pw' }, back: { file: 'dir\\pw.txt' }, gone: { file: './gone.txt' } } },
      ),
    );
    expect(r.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      [
        'files.absolute-path',
        'secrets.abs.file',
        'absolute paths are not supported: /run/pw would be read on the machine running dockflow',
      ],
      ['files.backslash-path', 'secrets.back.file', 'path dir\\pw.txt must use / separators'],
      ['files.not-found', 'secrets.gone.file', 'file ./gone.txt was not found in the project'],
    ]);
    // the mount is still recorded; the render fails on the errors
    expect(mounts(r)).toHaveLength(3);
    expect(secret(r, 'gone')).toMatchObject({ data: null, checksum: null, objectName: 'gone' });
  });

  test('TFILE-01 every resolver failure is reported at the file path of the entry', () => {
    const r = run(
      webWith(
        { configs: ['dir', 'outside', 'locked'] },
        { configs: { dir: { file: 'conf.d' }, outside: { file: '../shared/app.yml' }, locked: { file: 'locked.yml' } } },
      ),
      {
        files: {
          'conf.d': { fail: 'directory' },
          '../shared/app.yml': { fail: 'outside-project' },
          'locked.yml': { fail: 'unreadable' },
        },
      },
    );
    expect(r.diagnostics.map((d) => [d.code, d.path, d.message, d.hint])).toEqual([
      ['files.not-a-file', 'configs.dir.file', 'conf.d is a directory', 'Point the key at a file.'],
      ['files.unreadable', 'configs.locked.file', 'locked.yml could not be read', 'Check the file permissions.'],
      [
        'files.outside-project',
        'configs.outside.file',
        '../shared/app.yml is outside the project directory and is not read',
        'Move the file into the project; Dockflow never reads files from the machine running `dockflow` outside it.',
      ],
    ]);
    expect(config(r, 'dir')).toMatchObject({ data: null, checksum: null });
  });

  test('TFILE-01 a file is read once however many services use it (one source, N-FILE-13)', () => {
    const { resolver, calls } = countingResolver({ 'k.txt': 'key' });
    const r = run(
      {
        services: {
          api: { image: 'nginx:1.27', secrets: ['api_key'] },
          web: { image: 'nginx:1.27', secrets: ['api_key', { source: 'api_key', target: 'copy' }] },
        },
        secrets: { api_key: { file: 'k.txt' } },
      },
      { files: resolver },
    );
    expect(calls).toEqual(['k.txt']);
    expect(r.sources.secrets.size).toBe(1);
    expect(mounts(r, 'api').map((m) => m.source)).toEqual(['api_key']);
    expect(mounts(r, 'web').map((m) => m.target)).toEqual(['/run/secrets/api_key', '/run/secrets/copy']);
    expect(r.diagnostics).toEqual([]);
  });

  test('TFILE-01 binary content is carried byte for byte', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const r = run(webWith({ configs: ['keystore'] }, { configs: { keystore: { file: 'keystore.p12' } } }), {
      files: { 'keystore.p12': bytes },
    });
    expect(config(r, 'keystore')?.data).toEqual(bytes);
    expect(config(r, 'keystore')?.checksum).toBe(sha256Hex(bytes));
  });

  test('TFILE-02 inline content', () => {
    const r = run(webWith({ configs: ['app'] }, { configs: { app: { content: 'a: 1' } } }));
    expect(config(r, 'app')?.data).toEqual(text('a: 1'));
    expect(config(r, 'app')?.objectName).toBe(hashedObjectName('app', 'config', sha256Hex(text('a: 1'))));
    expect(r.diagnostics).toEqual([]);
  });

  test('TFILE-02 content is known at once, before any reference', () => {
    const ctx = normalizeContext();
    const sources = normalizeTopLevelFiles(undefined, { app: { content: 'a: 1' } }, ctx);
    expect(sources.configs.get('app')?.checksum).toBe(sha256Hex(text('a: 1')));
  });

  test('TFILE-03 content from the environment is refused', () => {
    const r = run(webWith({ secrets: ['pw'] }, { secrets: { pw: { environment: 'DB_PASSWORD' } } }));
    expect(withCode(r, 'files.environment-unsupported')).toEqual([
      {
        severity: 'error',
        code: 'files.environment-unsupported',
        path: 'secrets.pw.environment',
        message: 'secret content from the environment variable DB_PASSWORD is not supported: Dockflow passes no process environment',
        hint: 'Put the value in a file under `.dockflow/` that renders it with Nunjucks (for example `{{ current.env.db_password }}`) and use `file:`.',
      },
    ]);
  });

  test('TFILE-04 external entries and invalid external names', () => {
    const r = run(
      webWith(
        { secrets: ['tls', 'bad', 'legacy'] },
        { secrets: { tls: { external: true }, bad: { external: true, name: 'Bad_Name' }, legacy: { external: { name: 'old-tls' } } } },
      ),
    );
    expect(secret(r, 'tls')).toEqual({
      kind: 'secret',
      key: 'tls',
      objectName: 'tls',
      role: 'app',
      external: true,
      data: null,
      checksum: null,
      path: 'secrets.tls',
      file: null,
    });
    expect(secret(r, 'legacy')).toMatchObject({ external: true, objectName: 'old-tls' });
    expect(withCode(r, 'files.external-key').map((d) => d.path)).toEqual([
      'services.web.secrets[0]',
      'services.web.secrets[1]',
      'services.web.secrets[2]',
    ]);
    expect(withCode(r, 'files.invalid-external-name')).toEqual([
      {
        severity: 'error',
        code: 'files.invalid-external-name',
        path: 'secrets.bad.name',
        message: 'external secret name Bad_Name is not a valid Kubernetes object name',
        hint: 'Create the object with a lowercase DNS name and use that name.',
      },
    ]);
  });

  test('TFILE-04 external written as a string boolean', () => {
    const r = run(
      webWith({ secrets: ['legacy', 'odd'] }, { secrets: { legacy: { external: 'yes' }, odd: { external: 'maybe', file: 'x' } } }),
      { files: { x: 'content' } },
    );
    expect(secret(r, 'legacy')).toMatchObject({ external: true, objectName: 'legacy' });
    expect(r.diagnostics.map((d) => [d.severity, d.code, d.path, d.message])).toEqual([
      ['warning', 'values.yaml11-boolean', 'secrets.legacy.external', 'yes is read as true; YAML 1.2 only knows true and false'],
      ['error', 'values.invalid-boolean', 'secrets.odd.external', 'expected true or false, got maybe'],
      ['info', 'files.external-key', 'services.web.secrets[0]', 'the external secret legacy must contain a data key named legacy'],
    ]);
    // an unreadable external flag is not external: the file source still applies
    expect(secret(r, 'odd')).toMatchObject({ external: false, data: text('content') });
  });

  test('TFILE-05 name and labels are ignored with warnings', () => {
    const r = run(webWith({ secrets: ['s'] }, { secrets: { s: { file: 'x', name: 'y', labels: { a: 'b' } } } }), {
      files: { x: 'content' },
    });
    const objectName = hashedObjectName('s', 'secret', sha256Hex(text('content')));
    expect(r.diagnostics).toEqual([
      {
        severity: 'warning',
        code: 'files.labels-ignored',
        path: 'secrets.s.labels',
        message: 'labels on secrets are ignored',
      },
      {
        severity: 'warning',
        code: 'files.name-ignored',
        path: 'secrets.s.name',
        message: `name y is ignored: Dockflow names the object from its content (${objectName})`,
      },
    ]);
  });

  test('TFILE-06 template_driver and secret drivers are refused', () => {
    const r = run(
      webWith(
        { secrets: ['a', 'b'] },
        { secrets: { a: { file: 'x', template_driver: 'golang' }, b: { file: 'x', driver: 'vault', driver_opts: { path: 'p' } } } },
      ),
      { files: { x: 'content' } },
    );
    expect(r.diagnostics.map((d) => [d.code, d.path, d.message, d.hint])).toEqual([
      ['files.template-driver-unsupported', 'secrets.a.template_driver', 'template_driver is not supported', 'Render the content with Nunjucks instead.'],
      ['files.driver-unsupported', 'secrets.b.driver', 'driver is not supported for secrets', 'Remove `driver`.'],
      ['files.driver-unsupported', 'secrets.b.driver_opts', 'driver_opts is not supported for secrets', 'Remove `driver_opts`.'],
    ]);
  });

  test('TFILE-07 no source, several sources', () => {
    const r = run(
      webWith({ secrets: ['empty', 'nothing'], configs: ['both'] }, { secrets: { empty: {}, nothing: null }, configs: { both: { file: 'x', content: 'y' } } }),
    );
    expect(r.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['files.several-sources', 'configs.both', 'declares more than one of file, content, environment and external'],
      ['files.no-source', 'secrets.empty', 'declares no file, content or external: true'],
      ['files.no-source', 'secrets.nothing', 'declares no file, content or external: true'],
    ]);
    expect(withCode(r, 'files.no-source')[0].hint).toBe('Add `file:` with a path relative to the compose file.');
  });

  test('TFILE-07 external: false is not a source; content is not a secret source', () => {
    const r = run(webWith({ secrets: ['a', 'b'] }, { secrets: { a: { external: false, file: 'x' }, b: { content: 'y' } } }), {
      files: { x: 'content' },
    });
    expect(secret(r, 'a')?.data).toEqual(text('content'));
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([['files.no-source', 'secrets.b']]);
  });

  test('TFILE-08 content over the Secret size limit is recorded (files.too-large is the translator’s)', () => {
    const r = run(webWith({ secrets: ['big'] }, { secrets: { big: { file: 'big.bin' } } }), {
      files: { 'big.bin': 'x'.repeat(1_000_001) },
    });
    expect(secret(r, 'big')?.data?.length).toBe(1_000_001);
    expect(r.diagnostics).toEqual([]);
  });

  test('TFILE-09 an unused entry is never read and stays in the table for the stack checks', () => {
    const { resolver, calls } = countingResolver({});
    const r = run(webWith({}, { secrets: { unused: { file: './missing.txt' } }, configs: { idle: { content: 'x' } } }), {
      files: resolver,
    });
    expect(calls).toEqual([]);
    // the missing file is never reported; files.unused needs every service and is the stack checks' info
    expect(withCode(r, 'files.unused')).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(secret(r, 'unused')).toMatchObject({ data: null, checksum: null, objectName: 'unused', file: './missing.txt' });
    expect(config(r, 'idle')?.checksum).toBe(sha256Hex(text('x')));
  });

  test('keys that sanitize to one base get one content-named object name (K71); the collision is the stack checks’', () => {
    const r = run(
      webWith({ secrets: ['tls-cert', 'tls_cert'] }, { secrets: { tls_cert: { file: 'a.pem' }, 'tls-cert': { file: 'b.pem' } } }),
      { files: { 'a.pem': 'same', 'b.pem': 'same' } },
    );
    const objectName = hashedObjectName('tls-cert', 'secret', sha256Hex(text('same')));
    expect(objectName).toMatch(/^tls-cert-secret-[0-9a-f]{8}$/);
    expect(secret(r, 'tls_cert')?.objectName).toBe(objectName);
    expect(secret(r, 'tls-cert')?.objectName).toBe(objectName);
    // names.file-collision is claimed once, in code-unit order, by stackChecks (design-01 10 S9)
    expect(withCode(r, 'names.file-collision')).toEqual([]);
    expect(r.ctx.names.ownerOf('file', objectName)).toBeNull();
  });

  test('different content or different kinds get different object names', () => {
    const r = run(
      webWith(
        { secrets: ['tls-cert', 'tls_cert'], configs: ['tls_cert'] },
        { secrets: { tls_cert: { file: 'a.pem' }, 'tls-cert': { file: 'b.pem' } }, configs: { tls_cert: { file: 'a.pem' } } },
      ),
      { files: { 'a.pem': 'one', 'b.pem': 'two' } },
    );
    const names = [secret(r, 'tls_cert'), secret(r, 'tls-cert'), config(r, 'tls_cert')].map((s) => s?.objectName);
    expect(new Set(names).size).toBe(3);
    expect(r.diagnostics).toEqual([]);
  });

  test('keys must also be valid data keys', () => {
    const r = run(webWith({}, { secrets: { '..hidden': { file: 'x' }, 'bad key': { file: 'x' } }, configs: { 'app.yml': { content: 'x' } } }));
    expect(r.diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      ['names.invalid-key', 'secrets["..hidden"]', '..hidden is not a valid secret name'],
      ['names.invalid-key', 'secrets["bad key"]', 'bad key is not a valid secret name'],
    ]);
    expect(withCode(r, 'names.invalid-key')[0].hint).toBe('Use letters, digits, `.`, `_` and `-` only.');
    expect(r.sources.secrets.size).toBe(0);
    expect([...r.sources.configs.keys()]).toEqual(['app.yml']);
  });

  test('extension fields inside an entry', () => {
    const r = run(webWith({ configs: ['app'] }, { configs: { app: { content: 'x', 'x-note': 'n', 'x-dockflow': {} } } }));
    expect(r.diagnostics).toEqual([
      { severity: 'info', code: 'extension.ignored', path: 'configs.app.x-note', message: 'x-note is an extension field and is ignored' },
    ]);
  });

  test('invalid tables and entries', () => {
    const r = run(webWith({}, { secrets: ['a'] as unknown as Record<string, unknown>, configs: { app: 'text', b: { file: 7 } } }));
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['values.invalid-type', 'configs.app'],
      ['values.invalid-type', 'configs.b.file'],
      ['values.invalid-type', 'secrets'],
    ]);
    expect(withCode(r, 'values.invalid-type').map((d) => d.message)).toEqual([
      'expected mapping, got string',
      'expected string, got number',
      'expected mapping, got list',
    ]);
  });

  test('role comes from the context', () => {
    const ctx = normalizeContext({ role: 'accessory' });
    const sources = normalizeTopLevelFiles({ s: { external: true } }, undefined, ctx);
    expect(sources.secrets.get('s')?.role).toBe('accessory');
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped and reads nothing', () => {
    const { resolver, calls } = countingResolver({ 'k.txt': 'key' });
    const ctx = normalizeContext({ files: resolver });
    const sources = normalizeTopLevelFiles({ k: { file: 'k.txt' } }, undefined, ctx);
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    serviceFiles(draft, { secrets: ['k', 'ghost'] }, sources, ctx);
    expect(draft.files).toEqual([]);
    expect(calls).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('absent keys leave the defaults', () => {
    const r = run({ services: { web: { image: 'nginx:1.27', secrets: null, configs: null } } });
    expect(mounts(r)).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
