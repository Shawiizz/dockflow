// translate/config-objects.ts (design-02 8, 13; design-07 T-SECRET; DESIGN-CORE 5.3, 5.6, DV1):
// env Secrets, compose secret and config objects, file mounts and the P/config-hash value. Every
// emitted object is validated with support/schema (PD-11 (e)), inside a minimal Deployment when
// the rule set needs a pod to resolve references.

import { describe, expect, test } from 'bun:test';
import type { Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { ANNOTATIONS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { podTemplateLabels, selectorLabels, serviceObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type {
  CanonicalFileSource,
  CanonicalService,
  EnvVar,
  FileMountSpec,
} from '../../../services/orchestrator/kubernetes/model/types';
import type { Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ConfigMap, Secret } from '../../../services/orchestrator/kubernetes/resources/core';
import {
  buildEnvSecret,
  buildFileMounts,
  buildFileObjects,
  configHashFor,
  envChecksum,
  type FileMounts,
  fileVolumeName,
  MAX_CONFIG_OBJECT_BYTES,
} from '../../../services/orchestrator/kubernetes/translate/config-objects';
import type { EnvSecretResult, TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { canonicalFileSource, canonicalService, canonicalStack, identity, translateContext } from '../support/builders';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

const NS = 'dockflow-shop-production';
const ID = identity();
const P = 'dockflow.shawiizz.dev';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

function env(entries: Record<string, string>): EnvVar[] {
  return Object.entries(entries).map(([name, value]) => ({ name, value }));
}

function service(overrides: Parameters<typeof canonicalService>[0] = {}): CanonicalService {
  return canonicalService(overrides);
}

function ctxFor(services: CanonicalService[], files: CanonicalFileSource[] = []): TranslateContext {
  return translateContext(canonicalStack({ services, files }));
}

function fileMount(overrides: Partial<FileMountSpec> = {}): FileMountSpec {
  const kind = overrides.kind ?? 'secret';
  const source = overrides.source ?? 'api_key';
  return {
    kind,
    source,
    target: kind === 'secret' ? `/run/secrets/${source}` : `/${source}`,
    mode: 0o444,
    uid: null,
    gid: null,
    path: `services.web.${kind === 'secret' ? 'secrets' : 'configs'}[0]`,
    ...overrides,
  };
}

function bytesOf(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** A defensive re-check (T6): a DeployError asking for a bug report, never a diagnostic. */
function expectBug(run: () => unknown): DeployError {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeployError);
  const error = caught as DeployError;
  expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
  expect(error.suggestion).toBe('Report this as a Dockflow bug.');
  return error;
}

function expectDiagnostics(sink: DiagnosticSink, expected: Diagnostic[]): void {
  expect(sink.list()).toEqual(expected);
}

/** A minimal, otherwise valid Deployment around what config-objects produces for `svc`. */
function podHost(svc: CanonicalService, envResult: EnvSecretResult | null, files: FileMounts, configHash: string | null): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: svc.name,
      namespace: NS,
      annotations: { [ANNOTATIONS.composeService]: svc.composeName, [ANNOTATIONS.release]: ID.version },
      labels: serviceObjectLabels(ID, 'app', svc.name),
    },
    spec: {
      progressDeadlineSeconds: 240,
      replicas: 1,
      revisionHistoryLimit: 3,
      selector: { matchLabels: selectorLabels(ID, svc.name) },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      template: {
        metadata: {
          annotations: {
            [ANNOTATIONS.composeService]: svc.composeName,
            [ANNOTATIONS.defaultContainer]: svc.name,
            ...(configHash === null ? {} : { [ANNOTATIONS.configHash]: configHash }),
          },
          labels: podTemplateLabels(ID, 'app', svc.name),
        },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: svc.name,
              image: 'nginx:1.27',
              imagePullPolicy: 'IfNotPresent',
              ...(envResult === null ? {} : { envFrom: [{ secretRef: { name: envResult.secret.metadata.name } }] }),
              ...(files.mounts.length === 0 ? {} : { volumeMounts: files.mounts }),
            },
          ],
          enableServiceLinks: false,
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
          terminationGracePeriodSeconds: 10,
          ...(files.volumes.length === 0 ? {} : { volumes: files.volumes }),
        },
      },
    },
  };
}

function expectValidArtifact(objects: readonly unknown[], externalNames: readonly string[] = []): void {
  expect(formatIssues(failures(validateArtifact(objects, { namespace: NS, externalNames })))).toBe('');
}

/** Everything config-objects emits for a one-service stack, in one validated artifact. */
function renderService(svc: CanonicalService, files: CanonicalFileSource[] = []): { ctx: TranslateContext; objects: unknown[] } {
  const ctx = ctxFor([svc], files);
  const envResult = buildEnvSecret(svc, ctx);
  const mounts = buildFileMounts(svc, ctx);
  const objects: unknown[] = [
    ...buildFileObjects(ctx),
    ...(envResult === null ? [] : [envResult.secret]),
    podHost(svc, envResult, mounts, configHashFor(svc, envResult, ctx)),
  ];
  return { ctx, objects };
}

// ---------------------------------------------------------------------------------------------
// Environment Secret (design-02 8.1)

describe('buildEnvSecret (design-02 8.1, DV1)', () => {
  test('T-SECRET-01: content-named, immutable, data only, no type (Opaque)', () => {
    const svc = service({ environment: env({ A: '1', B: 'x y' }) });
    const result = buildEnvSecret(svc, ctxFor([svc]));
    const checksum = sha256Hex(canonicalJson([
      { name: 'A', value: '1' },
      { name: 'B', value: 'x y' },
    ]));
    expect(result).toEqual({
      checksum,
      secret: {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: `web-env-${checksum.slice(0, 8)}`,
          namespace: NS,
          labels: {
            'app.kubernetes.io/instance': NS,
            'app.kubernetes.io/managed-by': 'dockflow',
            'app.kubernetes.io/name': 'web',
            'app.kubernetes.io/part-of': 'shop',
            [`${P}/hashed`]: 'true',
            [`${P}/part`]: 'stack',
            [`${P}/role`]: 'app',
            [`${P}/service`]: 'web',
            [`${P}/stack`]: NS,
          },
        },
        data: { A: 'MQ==', B: 'eCB5' },
        immutable: true,
      },
    });
    expect(result?.secret).not.toHaveProperty('stringData');
    expect(result?.secret).not.toHaveProperty('type');
    expect(envChecksum(svc)).toBe(checksum);
  });

  test('T-SECRET-02: an empty environment has no Secret', () => {
    const svc = service();
    expect(buildEnvSecret(svc, ctxFor([svc]))).toBeNull();
  });

  test('T-SECRET-03: a changed value changes the name', () => {
    const one = service({ environment: env({ A: '1' }) });
    const two = service({ environment: env({ A: '2' }) });
    const first = buildEnvSecret(one, ctxFor([one]));
    const second = buildEnvSecret(two, ctxFor([two]));
    expect(first?.secret.metadata.name).not.toBe(second?.secret.metadata.name);
    expect(first?.checksum).not.toBe(second?.checksum);
  });

  test('T-SECRET-04: name and checksum are stable under every order of the variables', () => {
    const variables = env({ ZETA: 'z', ALPHA: 'a', MIDDLE: 'm' });
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ].map((order) => order.map((i) => variables[i]));
    const results = permutations.map((environment) => {
      const svc = service({ environment });
      return buildEnvSecret(svc, ctxFor([svc]));
    });
    const names = new Set(results.map((r) => r?.secret.metadata.name));
    const checksums = new Set(results.map((r) => r?.checksum));
    expect(names.size).toBe(1);
    expect(checksums.size).toBe(1);
    expect(Object.keys(results[0]?.secret.data ?? {})).toEqual(['ALPHA', 'MIDDLE', 'ZETA']);
  });

  test('values are base64 of their UTF-8 bytes, byte for byte (non-ASCII, CRLF, 100 KB)', () => {
    const big = 'x'.repeat(100 * 1024);
    const values = { EMOJI: 'café \u{1F680} 中文', CRLF: 'line1\r\nline2\r\n', BIG: big, EMPTY: '' };
    const svc = service({ environment: env(values) });
    const data = buildEnvSecret(svc, ctxFor([svc]))?.secret.data ?? {};
    for (const [name, value] of Object.entries(values)) {
      expect(data[name]).toBe(Buffer.from(value, 'utf8').toString('base64'));
      expect(decode(data[name])).toBe(value);
    }
  });

  test('values reach the Secret verbatim: envFrom is not expanded, so nothing is escaped', () => {
    const svc = service({ environment: env({ HOME_REF: '$(HOME)', DOLLARS: '$$x', COST: 'cost $5' }) });
    const data = buildEnvSecret(svc, ctxFor([svc]))?.secret.data ?? {};
    expect(decode(data.HOME_REF)).toBe('$(HOME)');
    expect(decode(data.DOLLARS)).toBe('$$x');
    expect(decode(data.COST)).toBe('cost $5');
  });

  test('a variable named __proto__ stays a data key', () => {
    const svc = service({
      environment: [
        { name: '__proto__', value: 'p' },
        { name: 'A', value: 'a' },
      ],
    });
    const data = buildEnvSecret(svc, ctxFor([svc]))?.secret.data ?? {};
    expect(Object.keys(data)).toEqual(['A', '__proto__']);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  test('an accessory Secret carries role accessory', () => {
    const svc = service({ role: 'accessory', environment: env({ A: '1' }) });
    const ctx = translateContext(canonicalStack({ role: 'accessory', services: [svc] }));
    expect(buildEnvSecret(svc, ctx)?.secret.metadata.labels?.[LABELS.role]).toBe('accessory');
  });

  test('T-SECRET-10: a 52-character service yields a 65-character Secret name', () => {
    const composeName = `s${'a'.repeat(51)}`;
    const svc = service({ composeName, environment: env({ A: '1' }) });
    const name = buildEnvSecret(svc, ctxFor([svc]))?.secret.metadata.name ?? '';
    expect(svc.name.length).toBe(52);
    expect(name.length).toBe(65);
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  test('T6: a name that is not a valid Secret key throws a Dockflow bug without the value', () => {
    for (const name of ['BAD NAME', '..x', 'a=b', '', `${'A'.repeat(254)}`]) {
      const svc = service({ environment: [{ name, value: 'hunter2-secret' }] });
      const error = expectBug(() => buildEnvSecret(svc, ctxFor([svc])));
      expect(error.message).not.toContain('hunter2-secret');
    }
  });

  test('T6: a name defined twice throws instead of silently dropping a value', () => {
    const svc = service({
      environment: [
        { name: 'A', value: '1' },
        { name: 'A', value: '2' },
      ],
    });
    expectBug(() => buildEnvSecret(svc, ctxFor([svc])));
  });

  test('the env Secret and its envFrom reference validate (S08, S20, S22, SEM-051)', () => {
    const svc = service({ environment: env({ DATABASE_URL: 'postgres://db:5432/shop', LOG_LEVEL: 'info', UNICODE: 'é' }) });
    expectValidArtifact(renderService(svc).objects);
  });
});

// ---------------------------------------------------------------------------------------------
// Compose secrets and configs (design-02 8.2, 8.3)

describe('buildFileObjects (design-02 8.2, 8.3)', () => {
  test('a compose secret is one immutable Secret named objectName with the compose key as data key', () => {
    const source = canonicalFileSource();
    const [secret] = buildFileObjects(ctxFor([service()], [source]));
    expect(secret).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: source.objectName,
        namespace: NS,
        labels: {
          'app.kubernetes.io/instance': NS,
          'app.kubernetes.io/managed-by': 'dockflow',
          'app.kubernetes.io/part-of': 'shop',
          [`${P}/hashed`]: 'true',
          [`${P}/part`]: 'stack',
          [`${P}/role`]: 'app',
          [`${P}/stack`]: NS,
        },
      },
      data: { api_key: b64('secret-value') },
      immutable: true,
    });
    expect(source.objectName).toBe(`api-key-secret-${sha256Hex('secret-value').slice(0, 8)}`);
  });

  test('secret bytes are base64 of the raw bytes, binary included', () => {
    const data = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]);
    const source = canonicalFileSource({ key: 'blob', data });
    const [secret] = buildFileObjects(ctxFor([service()], [source])) as Secret[];
    expect(Buffer.from(secret.data?.blob ?? '', 'base64')).toEqual(Buffer.from(data));
  });

  test('T-SECRET-06: a UTF-8 config is ConfigMap data; bytes 0xff 0xfe are binaryData', () => {
    const text = canonicalFileSource({ kind: 'config', key: 'nginx_conf', data: new TextEncoder().encode('server { listen 80; }\n') });
    const binary = canonicalFileSource({ kind: 'config', key: 'logo', data: new Uint8Array([0xff, 0xfe]) });
    const [first, second] = buildFileObjects(ctxFor([service()], [binary, text])) as ConfigMap[];
    expect(first).toEqual({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: binary.objectName,
        namespace: NS,
        labels: {
          'app.kubernetes.io/instance': NS,
          'app.kubernetes.io/managed-by': 'dockflow',
          'app.kubernetes.io/part-of': 'shop',
          [`${P}/hashed`]: 'true',
          [`${P}/part`]: 'stack',
          [`${P}/role`]: 'app',
          [`${P}/stack`]: NS,
        },
      },
      binaryData: { logo: '//4=' },
      immutable: true,
    });
    expect(first).not.toHaveProperty('data');
    expect(second.data).toEqual({ nginx_conf: 'server { listen 80; }\n' });
    expect(second).not.toHaveProperty('binaryData');
    expect(binary.objectName).toMatch(/^logo-config-[0-9a-f]{8}$/);
  });

  test('a UTF-8 config with a byte order mark keeps it, so the content and its checksum agree', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]);
    const source = canonicalFileSource({ kind: 'config', key: 'bom', data: bytes });
    const [config] = buildFileObjects(ctxFor([service()], [source])) as ConfigMap[];
    expect(config.data?.bom).toBe('﻿ab');
    expect(new TextEncoder().encode(config.data?.bom ?? '')).toEqual(bytes);
    expectValidArtifact([config]);
  });

  test('T-SECRET-07: external secrets and configs produce no object', () => {
    const secret = canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls' });
    const config = canonicalFileSource({ kind: 'config', key: 'shared_conf', external: true, objectName: 'shared-conf' });
    expect(buildFileObjects(ctxFor([service()], [secret, config]))).toEqual([]);
  });

  test('T-SECRET-08: a secret mounted by two services is one Secret', () => {
    const source = canonicalFileSource();
    const web = service({ files: [fileMount()] });
    const api = service({ composeName: 'api', files: [fileMount({ path: 'services.api.secrets[0]' })] });
    const objects = buildFileObjects(ctxFor([api, web], [source]));
    expect(objects.map((o) => o.metadata.name)).toEqual([source.objectName]);
  });

  test('T-SECRET-09: hashed objects carry the stack and hashed labels, no service label', () => {
    const objects = buildFileObjects(ctxFor([service()], [canonicalFileSource(), canonicalFileSource({ kind: 'config', key: 'app_conf' })]));
    for (const object of objects) {
      const labels = object.metadata.labels ?? {};
      expect(labels[LABELS.hashed]).toBe('true');
      expect(labels[LABELS.part]).toBe('stack');
      expect(labels[LABELS.role]).toBe('app');
      expect(labels[LABELS.stack]).toBe(NS);
      expect(labels[LABELS.managedBy]).toBe('dockflow');
      expect(labels).not.toHaveProperty(LABELS.service);
      expect(object.immutable).toBe(true);
    }
  });

  test('an accessory source carries role accessory', () => {
    const source = canonicalFileSource({ role: 'accessory' });
    const ctx = translateContext(canonicalStack({ role: 'accessory', services: [service({ role: 'accessory' })], files: [source] }));
    expect(buildFileObjects(ctx)[0].metadata.labels?.[LABELS.role]).toBe('accessory');
  });

  test('files.too-large: 1048576 bytes are accepted, 1048577 refused and not emitted', () => {
    expect(MAX_CONFIG_OBJECT_BYTES).toBe(1048576);
    for (const kind of ['secret', 'config'] as const) {
      const fits = canonicalFileSource({ kind, key: 'fits', data: bytesOf(1048576) });
      const over = canonicalFileSource({ kind, key: 'over', data: bytesOf(1048577) });
      const ctx = ctxFor([service()], [fits, over]);
      const objects = buildFileObjects(ctx);
      expect(objects.map((o) => o.metadata.name)).toEqual([fits.objectName]);
      const section = kind === 'secret' ? 'secrets' : 'configs';
      const word = kind === 'secret' ? 'Secret' : 'Config';
      expectDiagnostics(ctx.sink, [
        {
          severity: 'error',
          code: 'files.too-large',
          path: `${section}.over`,
          message: `${word} over is 1048577 bytes; Kubernetes limits it to 1 MiB`,
          hint: 'Mount large files with a bind mount or bake them into the image.',
        },
      ]);
    }
  });

  test('T7: no diagnostic carries the content of the source', () => {
    const content = 'top-secret-content-'.repeat(60000);
    const source = canonicalFileSource({ key: 'leak', data: new TextEncoder().encode(content) });
    const ctx = ctxFor([service()], [source]);
    buildFileObjects(ctx);
    const text = JSON.stringify(ctx.sink.list());
    expect(text).toContain('files.too-large');
    expect(text).not.toContain('top-secret-content');
  });

  test('T6: an invalid data key or missing content throws a Dockflow bug', () => {
    for (const source of [
      canonicalFileSource({ key: 'bad key' }),
      canonicalFileSource({ key: '..hidden' }),
      canonicalFileSource({ data: null, checksum: null, objectName: 'api-key-secret-00000000' }),
    ]) {
      expectBug(() => buildFileObjects(ctxFor([service()], [source])));
    }
  });

  test('every emitted object validates (S01, S08, S20, SEM-051)', () => {
    const files = [
      canonicalFileSource(),
      canonicalFileSource({ kind: 'config', key: 'nginx_conf', data: new TextEncoder().encode('server { listen 80; }\n') }),
      canonicalFileSource({ kind: 'config', key: 'logo', data: new Uint8Array([0xff, 0xfe, 0x00]) }),
    ];
    expectValidArtifact(buildFileObjects(ctxFor([service()], files)));
  });
});

// ---------------------------------------------------------------------------------------------
// File mounts (design-02 8.4, 5.5)

describe('buildFileMounts (design-02 8.4, 5.5)', () => {
  test('T-SECRET-05: one secret volume with defaultMode and one item, mounted read-only through subPath', () => {
    const source = canonicalFileSource();
    const svc = service({ files: [fileMount({ mode: 0o440 })] });
    expect(buildFileMounts(svc, ctxFor([svc], [source]))).toEqual({
      volumes: [
        {
          name: 'secret-api-key-440',
          secret: { secretName: source.objectName, defaultMode: 288, items: [{ key: 'api_key', path: 'api_key' }] },
        },
      ],
      mounts: [{ name: 'secret-api-key-440', mountPath: '/run/secrets/api_key', readOnly: true, subPath: 'api_key' }],
    });
  });

  test('defaultMode is the model mode in decimal, never masked again and never items[].mode', () => {
    const source = canonicalFileSource();
    for (const [mode, decimal] of [
      [0o444, 292],
      [0o440, 288],
      [0o400, 256],
      [0o555, 365],
    ] as const) {
      const svc = service({ files: [fileMount({ mode })] });
      const [volume] = buildFileMounts(svc, ctxFor([svc], [source])).volumes;
      expect(volume.secret?.defaultMode).toBe(decimal);
      expect(volume.name).toBe(`secret-api-key-${mode.toString(8)}`);
      expect(volume.secret?.items?.every((item) => !('mode' in item))).toBe(true);
    }
  });

  test('one pod volume per mode: the same secret with two modes gives two volumes', () => {
    const source = canonicalFileSource();
    const svc = service({
      files: [
        fileMount({ target: '/etc/app/key-a', mode: 0o440 }),
        fileMount({ target: '/etc/app/key-b', mode: 0o444, path: 'services.web.secrets[1]' }),
      ],
    });
    const { volumes, mounts } = buildFileMounts(svc, ctxFor([svc], [source]));
    expect(volumes.map((v) => [v.name, v.secret?.defaultMode])).toEqual([
      ['secret-api-key-440', 288],
      ['secret-api-key-444', 292],
    ]);
    expect(mounts.map((m) => [m.mountPath, m.name])).toEqual([
      ['/etc/app/key-a', 'secret-api-key-440'],
      ['/etc/app/key-b', 'secret-api-key-444'],
    ]);
  });

  test('two mounts of one source with one mode share a volume', () => {
    const source = canonicalFileSource();
    const svc = service({
      files: [fileMount({ target: '/a/key' }), fileMount({ target: '/b/key', path: 'services.web.secrets[1]' })],
    });
    const { volumes, mounts } = buildFileMounts(svc, ctxFor([svc], [source]));
    expect(volumes.map((v) => v.name)).toEqual(['secret-api-key-444']);
    expect(mounts.map((m) => m.name)).toEqual(['secret-api-key-444', 'secret-api-key-444']);
  });

  test('a config is a configMap volume with the same mount form', () => {
    const source = canonicalFileSource({ kind: 'config', key: 'nginx_conf', data: new TextEncoder().encode('x') });
    const svc = service({ files: [fileMount({ kind: 'config', source: 'nginx_conf', target: '/etc/nginx/nginx.conf' })] });
    expect(buildFileMounts(svc, ctxFor([svc], [source]))).toEqual({
      volumes: [
        {
          name: 'config-nginx-conf-444',
          configMap: { name: source.objectName, defaultMode: 292, items: [{ key: 'nginx_conf', path: 'nginx_conf' }] },
        },
      ],
      mounts: [{ name: 'config-nginx-conf-444', mountPath: '/etc/nginx/nginx.conf', readOnly: true, subPath: 'nginx_conf' }],
    });
  });

  test('T-SECRET-07: an external source is referenced by its own name, item key = compose key', () => {
    const source = canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls' });
    const svc = service({ files: [fileMount({ source: 'shared_tls' })] });
    const { volumes, mounts } = buildFileMounts(svc, ctxFor([svc], [source]));
    expect(volumes[0].secret).toEqual({ secretName: 'shared-tls', defaultMode: 292, items: [{ key: 'shared_tls', path: 'shared_tls' }] });
    expect(mounts[0].subPath).toBe('shared_tls');
  });

  test('volumes are sorted by name and mounts by mountPath (emission rule 4)', () => {
    const files = [canonicalFileSource(), canonicalFileSource({ kind: 'config', key: 'app_conf' })];
    const svc = service({
      files: [
        fileMount({ kind: 'config', source: 'app_conf', target: '/z/app.conf', path: 'services.web.configs[0]' }),
        fileMount({ target: '/a/key' }),
      ],
    });
    const { volumes, mounts } = buildFileMounts(svc, ctxFor([svc], files));
    expect(volumes.map((v) => v.name)).toEqual(['config-app-conf-444', 'secret-api-key-444']);
    expect(mounts.map((m) => m.mountPath)).toEqual(['/a/key', '/z/app.conf']);
  });

  test('T-SECRET-10: pod volume names stay DNS labels of at most 63 characters', () => {
    const key = `k${'_long'.repeat(20)}`;
    const source = canonicalFileSource({ key });
    const svc = service({ files: [fileMount({ source: key })] });
    const [volume] = buildFileMounts(svc, ctxFor([svc], [source])).volumes;
    expect(volume.name.length).toBeLessThanOrEqual(63);
    expect(volume.name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
    expect(fileVolumeName('secret', key, 0o444)).toBe(volume.name);
  });

  test('two sources that need the same pod volume name are an error, never a silent override', () => {
    const first = canonicalFileSource({ key: 'api_key' });
    const second = canonicalFileSource({ key: 'api-key', data: new TextEncoder().encode('other') });
    const svc = service({
      files: [fileMount({ source: 'api_key', target: '/a' }), fileMount({ source: 'api-key', target: '/b', path: 'services.web.secrets[1]' })],
    });
    const ctx = ctxFor([svc], [second, first]);
    const { volumes, mounts } = buildFileMounts(svc, ctx);
    expect(volumes.map((v) => v.secret?.secretName)).toEqual([first.objectName]);
    expect(mounts.map((m) => m.mountPath)).toEqual(['/a']);
    expectDiagnostics(ctx.sink, [
      {
        severity: 'error',
        code: 'volumes.pod-volume-name-collision',
        path: 'secrets.api-key',
        message: 'Volumes api-key and api_key of service web need the same pod volume name',
        hint: 'Rename one of the volumes.',
      },
    ]);
  });

  test('a secret and a config with the same key get different volumes', () => {
    const files = [canonicalFileSource({ key: 'app' }), canonicalFileSource({ kind: 'config', key: 'app' })];
    const svc = service({
      files: [fileMount({ source: 'app', target: '/s' }), fileMount({ kind: 'config', source: 'app', target: '/c', path: 'services.web.configs[0]' })],
    });
    const ctx = ctxFor([svc], files);
    expect(buildFileMounts(svc, ctx).volumes.map((v) => v.name)).toEqual(['config-app-444', 'secret-app-444']);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('T6: a mount of an undefined source or with an impossible mode throws', () => {
    const svc = service({ files: [fileMount({ source: 'ghost' })] });
    expectBug(() => buildFileMounts(svc, ctxFor([svc], [canonicalFileSource()])));
    for (const mode of [-1, 0o1000, 1.5]) {
      const bad = service({ files: [fileMount({ mode })] });
      expectBug(() => buildFileMounts(bad, ctxFor([bad], [canonicalFileSource()])));
    }
  });

  test('a service without file mounts has no volume and no mount', () => {
    const svc = service();
    expect(buildFileMounts(svc, ctxFor([svc]))).toEqual({ volumes: [], mounts: [] });
  });

  test('file volumes, mounts and objects validate inside a pod (S06, S07, S08)', () => {
    const files = [
      canonicalFileSource(),
      canonicalFileSource({ kind: 'config', key: 'nginx_conf', data: new TextEncoder().encode('server {}\n') }),
      canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls' }),
    ];
    const svc = service({
      environment: env({ A: '1' }),
      files: [
        fileMount({ kind: 'config', source: 'nginx_conf', target: '/etc/nginx/nginx.conf', path: 'services.web.configs[0]' }),
        fileMount({ mode: 0o440 }),
        fileMount({ target: '/etc/app/key', path: 'services.web.secrets[1]' }),
        fileMount({ source: 'shared_tls', target: '/etc/tls/cert.pem', path: 'services.web.secrets[2]' }),
      ],
    });
    expectValidArtifact(renderService(svc, files).objects, ['shared-tls']);
  });
});

// ---------------------------------------------------------------------------------------------
// P/config-hash (DESIGN-CORE 5.3)

describe('configHashFor (DESIGN-CORE 5.3, K68)', () => {
  test('T-SECRET-11: env checksum and [target, checksum] of each file', () => {
    const source = canonicalFileSource();
    const svc = service({ environment: env({ A: '1' }), files: [fileMount()] });
    const ctx = ctxFor([svc], [source]);
    const envResult = buildEnvSecret(svc, ctx);
    expect(configHashFor(svc, envResult, ctx)).toBe(
      sha256Hex(canonicalJson({ env: envResult?.checksum, files: [['/run/secrets/api_key', source.checksum]] })),
    );
  });

  test('T-SECRET-12: no environment and no file mounts: no annotation at all', () => {
    const svc = service();
    expect(configHashFor(svc, null, ctxFor([svc]))).toBeNull();
  });

  test('environment only: files is empty; files only: env is null', () => {
    const withEnv = service({ environment: env({ A: '1' }) });
    const envCtx = ctxFor([withEnv]);
    const envResult = buildEnvSecret(withEnv, envCtx);
    expect(configHashFor(withEnv, envResult, envCtx)).toBe(sha256Hex(canonicalJson({ env: envResult?.checksum, files: [] })));

    const source = canonicalFileSource();
    const withFile = service({ files: [fileMount()] });
    expect(configHashFor(withFile, null, ctxFor([withFile], [source]))).toBe(
      sha256Hex(canonicalJson({ env: null, files: [['/run/secrets/api_key', source.checksum]] })),
    );
  });

  test('files keep model order (sorted by target)', () => {
    const files = [canonicalFileSource(), canonicalFileSource({ kind: 'config', key: 'app_conf' })];
    const svc = service({
      files: [
        fileMount({ target: '/a/key' }),
        fileMount({ kind: 'config', source: 'app_conf', target: '/b/app.conf', path: 'services.web.configs[0]' }),
      ],
    });
    expect(configHashFor(svc, null, ctxFor([svc], files))).toBe(
      sha256Hex(canonicalJson({ env: null, files: [['/a/key', files[0].checksum], ['/b/app.conf', files[1].checksum]] })),
    );
  });

  test('T-SECRET-13: an external source contributes null, so its content never rolls the pods', () => {
    const svc = service({ files: [fileMount({ source: 'shared_tls' })] });
    const hashWith = (content: string): string | null => {
      const source = canonicalFileSource({
        key: 'shared_tls',
        external: true,
        objectName: 'shared-tls',
        // content Dockflow never reads: the hash must not depend on it
        data: new TextEncoder().encode(content),
        checksum: sha256Hex(content),
      });
      return configHashFor(svc, null, ctxFor([svc], [source]));
    };
    expect(hashWith('first')).toBe(hashWith('second'));
    expect(hashWith('first')).toBe(sha256Hex(canonicalJson({ env: null, files: [['/run/secrets/shared_tls', null]] })));
  });

  test('a changed file content changes the hash', () => {
    const svc = service({ files: [fileMount()] });
    const one = configHashFor(svc, null, ctxFor([svc], [canonicalFileSource({ data: new TextEncoder().encode('one') })]));
    const two = configHashFor(svc, null, ctxFor([svc], [canonicalFileSource({ data: new TextEncoder().encode('two') })]));
    expect(one).not.toBe(two);
  });

  test('T6: a file mount of a source the stack does not define throws', () => {
    const svc = service({ files: [fileMount({ source: 'ghost' })] });
    expectBug(() => configHashFor(svc, null, ctxFor([svc], [canonicalFileSource()])));
  });
});
