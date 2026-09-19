// design-03 8.3 (22.2 `apply/references.test.ts`), DESIGN-CORE C11/C12: every pod-spec path that
// keeps a content-hashed Secret or ConfigMap alive, on every kind K16 lists.

import { describe, expect, it } from 'bun:test';
import { collectReferences, type ReferenceItem } from '../../../services/orchestrator/kubernetes/apply/prune-plan';
import { templateRefs } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import type { PodSpec, PodTemplateSpec } from '../../../services/orchestrator/kubernetes/resources/core';

const NS = 'dockflow-shop-production';

function spec(extra: Partial<PodSpec>): PodSpec {
  return { containers: [{ name: 'app', image: 'registry.example.com/app:1' }], ...extra };
}

const template = (s: PodSpec): PodTemplateSpec => ({ metadata: {}, spec: s });
const metadata = (name: string) => ({ name, namespace: NS });

function everyPath(): PodSpec {
  return spec({
    containers: [
      {
        name: 'app',
        image: 'registry.example.com/app:2',
        envFrom: [{ secretRef: { name: 'web-env-3f9a1c2e' } }, { configMapRef: { name: 'web-settings-config-11111111' } }],
        env: [
          { name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'token-secret-22222222', key: 'token' } } },
          { name: 'MODE', valueFrom: { configMapKeyRef: { name: 'mode-config-33333333', key: 'mode' } } },
          { name: 'PLAIN', value: 'x' },
        ],
      },
    ],
    initContainers: [
      {
        name: 'migrate',
        image: 'registry.example.com/migrate:2',
        envFrom: [{ secretRef: { name: 'init-env-44444444' } }],
        env: [{ name: 'SEED', valueFrom: { configMapKeyRef: { name: 'seed-config-55555555', key: 'seed' } } }],
      },
    ],
    volumes: [
      { name: 'secret-api-key-444', secret: { secretName: 'api-key-secret-66666666' } },
      { name: 'config-app-444', configMap: { name: 'app-conf-config-77777777' } },
      {
        name: 'projected',
        projected: { sources: [{ secret: { name: 'projected-secret-88888888' } }, { configMap: { name: 'projected-config-99999999' } }] },
      },
      { name: 'pvc-data', persistentVolumeClaim: { claimName: 'data' } },
    ],
    imagePullSecrets: [{ name: 'dockflow-registry' }],
  });
}

const EVERY_PATH = [
  'ConfigMap/app-conf-config-77777777',
  'ConfigMap/mode-config-33333333',
  'ConfigMap/projected-config-99999999',
  'ConfigMap/seed-config-55555555',
  'ConfigMap/web-settings-config-11111111',
  'Secret/api-key-secret-66666666',
  'Secret/init-env-44444444',
  'Secret/projected-secret-88888888',
  'Secret/token-secret-22222222',
  'Secret/web-env-3f9a1c2e',
];

const sorted = (set: Set<string>) => [...set].sort();

describe('collectReferences', () => {
  it('reads envFrom, env.valueFrom, volumes.secret, volumes.configMap, projected sources and init containers of a pod', () => {
    const pod: ReferenceItem = { apiVersion: 'v1', kind: 'Pod', metadata: metadata('web-5d8f-abcde'), spec: everyPath() };
    expect(sorted(collectReferences([pod]))).toEqual(EVERY_PATH);
  });

  it('reads spec.template.spec of Deployments, StatefulSets, DaemonSets, Jobs and ReplicaSets', () => {
    const only = (name: string) => spec({ containers: [{ name: 'app', image: 'x', envFrom: [{ secretRef: { name } }] }] });
    const items: ReferenceItem[] = [
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('web'), spec: { selector: {}, template: template(only('d-env')) } },
      { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: metadata('db'), spec: { selector: {}, template: template(only('s-env')) } },
      { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: metadata('agent'), spec: { selector: {}, template: template(only('ds-env')) } },
      { apiVersion: 'batch/v1', kind: 'Job', metadata: metadata('migrate-1'), spec: { template: template(only('j-env')) } },
      { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: metadata('web-5d8f'), spec: { template: template(only('rs-env')) } },
    ];
    expect(sorted(collectReferences(items))).toEqual(['Secret/d-env', 'Secret/ds-env', 'Secret/j-env', 'Secret/rs-env', 'Secret/s-env']);
  });

  it('reads data.spec.template.spec of a ControllerRevision, which keeps an older revision restorable', () => {
    const revision: ReferenceItem = {
      apiVersion: 'apps/v1',
      kind: 'ControllerRevision',
      metadata: metadata('db-7c9d5f'),
      revision: 3,
      data: { spec: { template: template(everyPath()) } },
    };
    expect(sorted(collectReferences([revision]))).toEqual(EVERY_PATH);
  });

  it('tolerates read objects without a template, and never reports claims, images or pull Secrets', () => {
    const items: ReferenceItem[] = [
      { apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata: metadata('web-old') },
      { apiVersion: 'apps/v1', kind: 'ControllerRevision', metadata: metadata('db-old'), data: {} },
      { apiVersion: 'v1', kind: 'Pod', metadata: metadata('p'), spec: everyPath() },
    ];
    const refs = collectReferences(items);
    expect(refs.has('Secret/dockflow-registry')).toBe(false);
    expect([...refs].some((r) => r.includes('data') || r.includes('registry.example.com'))).toBe(false);
  });
});

describe('templateRefs', () => {
  it('returns sorted, unique names per category, images of init containers included', () => {
    const refs = templateRefs(
      spec({
        containers: [
          { name: 'a', image: 'registry.example.com/web:2', envFrom: [{ secretRef: { name: 'b-env' } }, { secretRef: { name: 'a-env' } }] },
          { name: 'b', image: 'registry.example.com/web:2', envFrom: [{ secretRef: { name: 'a-env' } }] },
        ],
        initContainers: [{ name: 'init', image: 'registry.example.com/init:1' }],
        volumes: [{ name: 'pvc-data', persistentVolumeClaim: { claimName: 'data' } }],
      }),
    );
    expect(refs).toEqual({
      secrets: ['a-env', 'b-env'],
      configMaps: [],
      claims: ['data'],
      images: ['registry.example.com/init:1', 'registry.example.com/web:2'],
    });
    expect(templateRefs(undefined)).toEqual({ secrets: [], configMaps: [], claims: [], images: [] });
  });
});
