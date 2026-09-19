// design-03 2.3 and 5.7 (K18), design-07 U-REVERT-08: `stateFor` is the only constructor of
// ReceiptState and fills every field, so a partial receipt handed to revert() never carries an
// undefined `previous`, `targets` or snapshot.

import { describe, expect, it } from 'bun:test';
import type { HelmReleaseRecord, ResolvedHelmRelease, StackRef } from '../../../services/orchestrator/interfaces';
import type { DisruptiveSwitch } from '../../../services/orchestrator/kubernetes/apply/pre-apply';
import type { PreviousRelease } from '../../../services/orchestrator/kubernetes/apply/revert-plan';
import { emptySnapshot, type LbWatchTarget, type Snapshot } from '../../../services/orchestrator/kubernetes/apply/snapshot';
import { pullSecretOf, type ReceiptState, stateFor } from '../../../services/orchestrator/kubernetes/backends/stack-state';
import type { Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Secret, Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';

const P = 'dockflow.shawiizz.dev';
const NS = 'dockflow-shop-production';
const REF: StackRef = { project: 'shop', env: 'production', role: 'app' };
const NOW = new Date('2026-09-17T10:00:00.000Z');

/** Every field of ReceiptState; the Record type makes the compiler reject a missing or extra key. */
const FIELDS: Record<keyof ReceiptState, true> = {
  origin: true,
  ref: true,
  namespace: true,
  objects: true,
  applied: true,
  targets: true,
  prune: true,
  before: true,
  after: true,
  previous: true,
  failureActions: true,
  helmInputs: true,
  helmDeclared: true,
  helmApplied: true,
  pullSecretName: true,
  disruptive: true,
  lbWatch: true,
};

type OptionalKeys<T> = { [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? never : K }[keyof T];
type UndefinedKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];

function deployment(name: string, pullSecret: string | null): Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: NS, annotations: { [`${P}/compose-service`]: name } },
    spec: {
      selector: {},
      template: {
        metadata: {},
        spec: {
          containers: [{ name, image: `registry.example.com/shop/${name}:1.4.2` }],
          imagePullSecrets: pullSecret === null ? undefined : [{ name: pullSecret }],
        },
      },
    },
  };
}

function service(name: string): Service {
  return { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: NS }, spec: { ports: [{ port: 80, protocol: 'TCP' }] } };
}

function envSecret(name: string): Secret {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: NS }, immutable: true, data: { KEY: 'dmFsdWU=' } };
}

function resolved(name: string, version: string): ResolvedHelmRelease {
  return {
    name,
    role: 'app',
    namespace: NS,
    chart: { kind: 'repo', repo: 'https://charts.example.com', chart: name },
    version,
    values: { replicaCount: 1 },
    valuesSha256: name.charAt(0).repeat(64),
    timeoutS: 300,
    auth: { username: 'deploy', password: 'chart-repo-password' },
    declaredDigest: null,
  };
}

function record(name: string, version: string): HelmReleaseRecord {
  const { auth: _auth, declaredDigest: _digest, ...rest } = resolved(name, version);
  return { ...rest, chartSha256: 'f'.repeat(64) };
}

const render = (): ManifestObject[] => [envSecret('web-env-3f9a1c2e'), service('web'), deployment('web', 'dockflow-registry')];

describe('stateFor', () => {
  it('K18: the receipt of a Helm failure inside deploy() (5.7) has every field, field by field', () => {
    const objects = render();
    const helmInputs = [resolved('search', '1.3.0'), resolved('metrics', '2.0.0')];
    const helmApplied = [{ release: record('search', '1.3.0'), replaced: record('search', '1.2.0') }];
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects,
      now: NOW,
      origin: 'deploy',
      failureActions: { web: 'rollback' },
      helmInputs,
      helmDeclared: ['metrics', 'search'],
      pullSecretName: 'dockflow-registry',
      applied: [],
      helmApplied,
    });
    expect(state.origin).toBe('deploy');
    expect(state.ref).toBe(REF);
    expect(state.namespace).toBe(NS);
    expect(state.objects).toBe(objects);
    expect(state.applied).toEqual([]);
    expect(state.targets).toBeNull();
    expect(state.prune).toBe(false);
    expect(state.before).toEqual(emptySnapshot(NOW));
    expect(state.after).toEqual(emptySnapshot(NOW));
    expect(state.previous).toBeNull();
    expect(state.failureActions).toEqual({ web: 'rollback' });
    expect(state.helmInputs).toBe(helmInputs);
    expect(state.helmDeclared).toEqual(['metrics', 'search']);
    expect(state.helmApplied).toBe(helmApplied);
    expect(state.pullSecretName).toBe('dockflow-registry');
    expect(state.disruptive).toEqual([]);
    expect(state.lbWatch).toEqual([]);
    expect(Object.keys(state).sort()).toEqual(Object.keys(FIELDS).sort());
  });

  it('fills the defaults of design-03 2.3 for every field it is not given', () => {
    const objects = render();
    const state = stateFor({ ref: REF, namespace: NS, objects, now: NOW });
    expect(state).toEqual({
      origin: 'deploy',
      ref: REF,
      namespace: NS,
      objects,
      applied: [],
      targets: null,
      prune: false,
      before: { takenAt: NOW, workloads: [], services: [] },
      after: { takenAt: NOW, workloads: [], services: [] },
      previous: null,
      failureActions: {},
      helmInputs: [],
      helmDeclared: [],
      helmApplied: [],
      pullSecretName: 'dockflow-registry',
      disruptive: [],
      lbWatch: [],
    });
  });

  it('U-REVERT-08: no field is optional, none admits undefined, and none is ever left undefined', () => {
    const noOptionalField: [OptionalKeys<ReceiptState>] extends [never] ? true : false = true;
    const noUndefinedField: [UndefinedKeys<ReceiptState>] extends [never] ? true : false = true;
    expect(noOptionalField).toBe(true);
    expect(noUndefinedField).toBe(true);

    const explicitUndefined = stateFor({
      ref: REF,
      namespace: NS,
      objects: [],
      now: NOW,
      origin: undefined,
      applied: undefined,
      targets: undefined,
      prune: undefined,
      before: undefined,
      after: undefined,
      previous: undefined,
      failureActions: undefined,
      helmInputs: undefined,
      helmDeclared: undefined,
      helmApplied: undefined,
      pullSecretName: undefined,
      disruptive: undefined,
      lbWatch: undefined,
    });
    for (const field of Object.keys(FIELDS) as (keyof ReceiptState)[]) {
      expect(field in explicitUndefined).toBe(true);
      expect(explicitUndefined[field]).not.toBeUndefined();
    }
    expect(explicitUndefined.previous).toBeNull();
    expect(explicitUndefined.targets).toBeNull();
    expect(explicitUndefined.pullSecretName).toBeNull();
  });

  it('stamps two distinct empty snapshots with the time the caller passes, never its own clock', () => {
    const state = stateFor({ ref: REF, namespace: NS, objects: [], now: NOW });
    expect(state.before).not.toBe(state.after);
    expect(state.before.workloads).not.toBe(state.after.workloads);
    expect(state.before.takenAt.getTime()).toBe(NOW.getTime());
    expect(state.after.takenAt.getTime()).toBe(NOW.getTime());
  });

  it('keeps every value it is given, explicit nulls included', () => {
    const objects = render();
    const before: Snapshot = { takenAt: new Date('2026-09-17T09:59:00.000Z'), workloads: [], services: [] };
    const after: Snapshot = { takenAt: new Date('2026-09-17T10:00:30.000Z'), workloads: [], services: [] };
    const previous: PreviousRelease = { version: '1.4.1', objects: [deployment('web', null)], helm: [record('search', '1.2.0')] };
    const disruptive: DisruptiveSwitch[] = [
      { service: 'db', from: 'Deployment', to: 'StatefulSet', deleted: { kind: 'Deployment', name: 'db' } },
    ];
    const lbWatch: LbWatchTarget[] = [{ service: 'web', name: 'web-lb', ports: [{ port: 8080, protocol: 'TCP' }] }];
    const state = stateFor({
      ref: REF,
      namespace: NS,
      objects,
      now: NOW,
      applied: objects,
      targets: ['web'],
      prune: false,
      before,
      after,
      previous,
      disruptive,
      lbWatch,
      pullSecretName: null,
    });
    expect(state.applied).toBe(objects);
    expect(state.targets).toEqual(['web']);
    expect(state.before).toBe(before);
    expect(state.after).toBe(after);
    expect(state.previous).toBe(previous);
    expect(state.disruptive).toBe(disruptive);
    expect(state.lbWatch).toBe(lbWatch);
    // null means "no credentials configured", even when the stored templates still name the Secret
    expect(state.pullSecretName).toBeNull();
    expect(stateFor({ ref: REF, namespace: NS, objects, now: NOW, targets: [] }).targets).toEqual([]);
  });

  it('apply receipts (16.2): helmDeclared follows the stored records and the pull Secret the stored templates', () => {
    const objects = render();
    const records = [record('search', '1.2.0'), record('metrics', '2.0.0')];
    const state = stateFor({
      origin: 'apply',
      ref: REF,
      namespace: NS,
      objects,
      now: NOW,
      prune: true,
      helmInputs: records.map((r) => ({ ...r, auth: null, declaredDigest: null })),
    });
    expect(state.origin).toBe('apply');
    expect(state.prune).toBe(true);
    expect(state.failureActions).toEqual({});
    expect(state.helmDeclared).toEqual(['search', 'metrics']);
    expect(state.pullSecretName).toBe('dockflow-registry');
  });
});

describe('pullSecretOf', () => {
  it('returns the first pull Secret a stored workload template names', () => {
    expect(pullSecretOf([service('web'), deployment('worker', null), deployment('web', 'dockflow-registry')])).toBe('dockflow-registry');
  });

  it('returns null when no workload pulls with a Secret', () => {
    expect(pullSecretOf([envSecret('web-env-3f9a1c2e'), service('web'), deployment('web', null)])).toBeNull();
    expect(pullSecretOf([])).toBeNull();
  });
});
