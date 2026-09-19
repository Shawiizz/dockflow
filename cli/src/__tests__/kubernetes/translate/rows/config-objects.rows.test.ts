// design-07 5.2 T-SECRET rows (translate/config-objects.ts, D11, DV1): the content-named env Secret,
// compose secret/config objects, the file-mount pod volumes and `P/config-hash` (DESIGN-CORE 5.3).
//
// Object names carry a content checksum (design-02 8), so every dynamic name below is computed with
// the same functions the source uses (`envChecksum`, `hashedObjectName`, `fileVolumeName`,
// `canonicalFileSource`'s own checksum) rather than hand-derived, and used as a plain compile-time
// string in the declarative rows.

import { expect, test } from 'bun:test';
import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { ANNOTATIONS } from '../../../../services/orchestrator/kubernetes/constants';
import { envChecksum, fileVolumeName } from '../../../../services/orchestrator/kubernetes/translate/config-objects';
import { hashedObjectLabels } from '../../../../services/orchestrator/kubernetes/labels';
import { hashedObjectName, namespaceFor } from '../../../../services/orchestrator/kubernetes/naming';
import type { FileMountSpec } from '../../../../services/orchestrator/kubernetes/model/types';
import * as builders from '../../support/builders';
import { type TranslateRow, runTranslateRows, translateRow } from '../../support/rows';

const NAMESPACE = namespaceFor('shop', 'production');
const CONFIG_HASH_POINTER = `/spec/template/metadata/annotations/${ANNOTATIONS.configHash.replace('/', '~1')}`;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function secretFile(source: string, target: string, mode = 0o444): FileMountSpec {
  return { kind: 'secret', source, target, mode, uid: null, gid: null, path: `services.web.secrets.${source}` };
}

// -- T-SECRET-01: env Secret name, data and envFrom -------------------------------------------
const ENV_AB = [
  { name: 'A', value: '1' },
  { name: 'B', value: 'x y' },
];
const ENV_AB_SVC = builders.canonicalService({ environment: ENV_AB });
const ENV_AB_SECRET = hashedObjectName('web', 'env', envChecksum(ENV_AB_SVC));

// -- T-SECRET-03/04: name changes with content, not with declaration order ---------------------
const ENV_A1 = builders.canonicalService({ environment: [{ name: 'A', value: '1' }] });
const ENV_A2 = builders.canonicalService({ environment: [{ name: 'A', value: '2' }] });
const ENV_A1_SECRET = hashedObjectName('web', 'env', envChecksum(ENV_A1));
const ENV_A2_SECRET = hashedObjectName('web', 'env', envChecksum(ENV_A2));

// -- T-SECRET-05: one source mounted twice at different modes -> two distinct pod volumes ------
const API_KEY = builders.canonicalFileSource({ key: 'api_key' });
const VOL_440 = fileVolumeName('secret', 'api_key', 0o440);
const VOL_444 = fileVolumeName('secret', 'api_key', 0o444);

// -- T-SECRET-06: UTF-8 vs binary config content ------------------------------------------------
const CONFIG_TEXT = builders.canonicalFileSource({ kind: 'config', key: 'app_conf', data: new TextEncoder().encode('x=1') });
const CONFIG_BINARY_BYTES = new Uint8Array([0xff, 0xfe]);
const CONFIG_BINARY = builders.canonicalFileSource({ kind: 'config', key: 'app_conf', data: CONFIG_BINARY_BYTES });

// -- T-SECRET-07: external secret is never emitted, only referenced ----------------------------
const SHARED_TLS = builders.canonicalFileSource({ key: 'shared_tls', external: true, objectName: 'shared-tls' });
const SHARED_TLS_VOL = fileVolumeName('secret', 'shared_tls', 0o444);

// -- T-SECRET-08: two services sharing one secret -> one Secret object -------------------------
const SHARED_API_KEY = builders.canonicalFileSource({ key: 'api_key' });

const rows: TranslateRow[] = [
  {
    id: 'T-SECRET-01',
    title: 'environment {A:"1", B:"x y"} -> content-named env Secret, base64 data, envFrom, no env[].value',
    stack: (b) => b.canonicalStack({ services: [b.canonicalService({ environment: ENV_AB })] }),
    expect: [
      { object: `Secret/${ENV_AB_SECRET}`, pointer: '/data', equals: { A: b64('1'), B: b64('x y') } },
      { object: `Secret/${ENV_AB_SECRET}`, pointer: '/immutable', equals: true },
      { object: `Secret/${ENV_AB_SECRET}`, pointer: '/type', absent: true },
      { object: `Secret/${ENV_AB_SECRET}`, pointer: '/stringData', absent: true },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/envFrom', equals: [{ secretRef: { name: ENV_AB_SECRET } }] },
      { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/env', absent: true },
    ],
  },
  {
    id: 'T-SECRET-02',
    title: 'empty environment -> no env Secret, no envFrom',
    compose: 'image: nginx:1.27',
    expect: { object: 'Deployment/web', pointer: '/spec/template/spec/containers/0/envFrom', absent: true },
  },
  {
    id: 'T-SECRET-03',
    title: 'value 1 -> 2 changes the Secret name (and so the pod template, through envFrom)',
    stack: (b) => b.canonicalStack({ services: [ENV_A1] }),
    expect: [
      { object: `Secret/${ENV_A1_SECRET}`, pointer: '/data/A', equals: b64('1') },
      { object: `Secret/${ENV_A2_SECRET}`, absent: true },
    ],
  },
  {
    id: 'T-SECRET-03b',
    title: 'the changed value renders under the other checksum',
    stack: (b) => b.canonicalStack({ services: [ENV_A2] }),
    expect: [
      { object: `Secret/${ENV_A2_SECRET}`, pointer: '/data/A', equals: b64('2') },
      { object: `Secret/${ENV_A1_SECRET}`, absent: true },
    ],
  },
  {
    id: 'T-SECRET-05',
    title: 'one secret mounted twice at modes 288 (0440) and 292 (0444) -> two pod volumes, named after key and mode',
    stack: (b) =>
      b.canonicalStack({
        services: [b.canonicalService({ files: [secretFile('api_key', '/etc/key1', 0o440), secretFile('api_key', '/etc/key2', 0o444)] })],
        files: [API_KEY],
      }),
    expect: [
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/volumes',
        equals: [
          { name: VOL_440, secret: { secretName: API_KEY.objectName, defaultMode: 0o440, items: [{ key: 'api_key', path: 'api_key' }] } },
          { name: VOL_444, secret: { secretName: API_KEY.objectName, defaultMode: 0o444, items: [{ key: 'api_key', path: 'api_key' }] } },
        ],
      },
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/containers/0/volumeMounts',
        equals: [
          { name: VOL_440, mountPath: '/etc/key1', readOnly: true, subPath: 'api_key' },
          { name: VOL_444, mountPath: '/etc/key2', readOnly: true, subPath: 'api_key' },
        ],
      },
    ],
  },
  {
    id: 'T-SECRET-06-utf8',
    title: 'UTF-8 config content -> ConfigMap.data',
    stack: (b) =>
      b.canonicalStack({
        services: [b.canonicalService({ files: [{ kind: 'config', source: 'app_conf', target: '/app_conf', mode: 0o444, uid: null, gid: null, path: 'services.web.configs.app_conf' }] })],
        files: [CONFIG_TEXT],
      }),
    expect: [
      { object: `ConfigMap/${CONFIG_TEXT.objectName}`, pointer: '/data/app_conf', equals: 'x=1' },
      { object: `ConfigMap/${CONFIG_TEXT.objectName}`, pointer: '/binaryData', absent: true },
    ],
  },
  {
    id: 'T-SECRET-06-binary',
    title: 'non-UTF-8 config content -> ConfigMap.binaryData',
    stack: (b) =>
      b.canonicalStack({
        services: [b.canonicalService({ files: [{ kind: 'config', source: 'app_conf', target: '/app_conf', mode: 0o444, uid: null, gid: null, path: 'services.web.configs.app_conf' }] })],
        files: [CONFIG_BINARY],
      }),
    expect: [
      { object: `ConfigMap/${CONFIG_BINARY.objectName}`, pointer: '/binaryData/app_conf', equals: Buffer.from(CONFIG_BINARY_BYTES).toString('base64') },
      { object: `ConfigMap/${CONFIG_BINARY.objectName}`, pointer: '/data', absent: true },
    ],
  },
  {
    id: 'T-SECRET-07',
    title: 'external secret shared-tls -> not emitted; the pod volume references it directly',
    stack: (b) =>
      b.canonicalStack({
        services: [b.canonicalService({ files: [secretFile('shared_tls', '/etc/tls')] })],
        files: [SHARED_TLS],
      }),
    expect: [
      { object: 'Secret/shared-tls', absent: true },
      {
        object: 'Deployment/web',
        pointer: '/spec/template/spec/volumes',
        equals: [{ name: SHARED_TLS_VOL, secret: { secretName: 'shared-tls', defaultMode: 0o444, items: [{ key: 'shared_tls', path: 'shared_tls' }] } }],
      },
    ],
  },
  {
    id: 'T-SECRET-08',
    title: 'two services mounting api_key -> exactly one Secret object',
    stack: (b) =>
      b.canonicalStack({
        services: [
          b.canonicalService({ composeName: 'web', files: [secretFile('api_key', '/run/secrets/api_key')] }),
          b.canonicalService({ composeName: 'worker', files: [secretFile('api_key', '/run/secrets/api_key')] }),
        ],
        files: [SHARED_API_KEY],
      }),
    expect: {
      kinds: [
        'Deployment/web',
        'Deployment/worker',
        `Secret/${SHARED_API_KEY.objectName}`,
        'Service/web',
        'Service/worker',
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    },
  },
  {
    id: 'T-SECRET-09',
    title: 'hashed objects carry P/hashed: "true" and the stack/role/service labels',
    stack: (b) => b.canonicalStack({ services: [ENV_A1] }),
    expect: {
      object: `Secret/${ENV_A1_SECRET}`,
      pointer: '/metadata/labels',
      equals: hashedObjectLabels({ project: 'shop', namespace: NAMESPACE }, 'app', 'web'),
    },
  },
  {
    id: 'T-SECRET-12',
    title: 'no environment and no file mounts -> no P/config-hash annotation at all',
    compose: 'image: nginx:1.27',
    expect: { object: 'Deployment/web', pointer: CONFIG_HASH_POINTER, absent: true },
  },
];

runTranslateRows('translate/config-objects (T-SECRET)', rows);

test('T-SECRET-10 a 52-character service name: env Secret name is 65 characters, every pod volume name is <= 63', () => {
  const longName = 'a'.repeat(52);
  const longSvc = builders.canonicalService({
    composeName: longName,
    environment: [{ name: 'A', value: '1' }],
    files: [secretFile('api_key', '/run/secrets/api_key')],
  });
  const expectedSecretName = hashedObjectName(longName, 'env', envChecksum(longSvc));
  expect(expectedSecretName.length).toBe(65);

  const { objects } = translateRow({
    id: 'long-name',
    title: 'long name',
    stack: (b) => b.canonicalStack({ services: [longSvc], files: [API_KEY] }),
    expect: [],
  });
  const secret = objects.find((o) => o.kind === 'Secret' && o.metadata.name === expectedSecretName);
  if (secret === undefined) throw new Error(`expected Secret/${expectedSecretName} among ${objects.map((o) => `${o.kind}/${o.metadata.name}`)}`);
  const deployment = objects.find((o) => o.kind === 'Deployment');
  if (deployment === undefined || deployment.kind !== 'Deployment') throw new Error('no Deployment object was produced');
  for (const volume of deployment.spec.template.spec.volumes ?? []) {
    expect(volume.name.length).toBeLessThanOrEqual(63);
  }
});

test('T-SECRET-11 P/config-hash is sha256Hex(canonicalJson({env, files})) over the env checksum and [target, checksum] pairs', () => {
  const svc = builders.canonicalService({
    environment: [{ name: 'A', value: '1' }],
    files: [secretFile('api_key', '/run/secrets/api_key')],
  });
  const expectedHash = sha256Hex(canonicalJson({ env: envChecksum(svc), files: [['/run/secrets/api_key', API_KEY.checksum]] }));

  const { objects } = translateRow({
    id: 'config-hash',
    title: 'config-hash',
    stack: (b) => b.canonicalStack({ services: [svc], files: [API_KEY] }),
    expect: [],
  });
  const deployment = objects.find((o) => o.kind === 'Deployment');
  if (deployment === undefined || deployment.kind !== 'Deployment') throw new Error('no Deployment object was produced');
  expect(deployment.spec.template.metadata.annotations?.[ANNOTATIONS.configHash]).toBe(expectedHash);
});

test('T-SECRET-13 an external file source contributes null to the files part of the hash', () => {
  const svc = builders.canonicalService({ files: [secretFile('shared_tls', '/etc/tls')] });
  const expectedHash = sha256Hex(canonicalJson({ env: null, files: [['/etc/tls', null]] }));

  const { objects } = translateRow({
    id: 'external-hash',
    title: 'external-hash',
    stack: (b) => b.canonicalStack({ services: [svc], files: [SHARED_TLS] }),
    expect: [],
  });
  const deployment = objects.find((o) => o.kind === 'Deployment');
  if (deployment === undefined || deployment.kind !== 'Deployment') throw new Error('no Deployment object was produced');
  expect(deployment.spec.template.metadata.annotations?.[ANNOTATIONS.configHash]).toBe(expectedHash);
});
