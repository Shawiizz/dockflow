import { describe, expect, test } from 'bun:test';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import {
  dockflowStorageClass,
  LOCAL_PATH_PROVISIONER,
  nonDefaultStorageClassPatch,
} from '../../../services/orchestrator/kubernetes/k3s/storage-class';

// Kubernetes metadata grammar (apimachinery validation), checked by hand: support/schema belongs
// to a package this one does not depend on.
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const QUALIFIED_NAME = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

describe('dockflowStorageClass (U-SC-01)', () => {
  test('is the object of design-05 11.1, exactly', () => {
    expect(dockflowStorageClass()).toEqual({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: 'dockflow-local',
        labels: {
          'app.kubernetes.io/managed-by': 'dockflow',
          'dockflow.shawiizz.dev/part': 'system',
        },
        annotations: {
          defaultVolumeType: 'local',
          'storageclass.kubernetes.io/is-default-class': 'true',
        },
      },
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
    });
  });

  test('is the default class of the k3s traits', () => {
    expect(dockflowStorageClass().metadata.name).toBe(k3sDistribution.traits.defaultStorageClass);
    expect(dockflowStorageClass().provisioner).toBe(LOCAL_PATH_PROVISIONER);
  });

  test('carries the default annotation as the string "true"', () => {
    const annotations = dockflowStorageClass().metadata.annotations ?? {};
    expect(annotations['storageclass.kubernetes.io/is-default-class']).toBe('true');
  });

  test('is structurally valid for the API server', () => {
    const sc = dockflowStorageClass();
    expect(Object.keys(sc).sort()).toEqual(
      ['apiVersion', 'kind', 'metadata', 'provisioner', 'reclaimPolicy', 'volumeBindingMode'].sort(),
    );
    expect(Object.keys(sc.metadata).sort()).toEqual(['annotations', 'labels', 'name']);
    expect(sc.metadata.name.length).toBeLessThanOrEqual(253);
    expect(sc.metadata.name).toMatch(DNS_SUBDOMAIN);
    expect(sc.provisioner).toMatch(QUALIFIED_NAME);
    expect(['Retain', 'Delete']).toContain(sc.reclaimPolicy ?? '');
    expect(['Immediate', 'WaitForFirstConsumer']).toContain(sc.volumeBindingMode ?? '');
    for (const [key, value] of Object.entries(sc.metadata.labels ?? {})) {
      expect(key).toMatch(QUALIFIED_NAME);
      expect(key.split('/').at(-1)?.length ?? 0).toBeLessThanOrEqual(63);
      expect(value).toMatch(LABEL_VALUE);
      expect(value.length).toBeLessThanOrEqual(63);
    }
    for (const [key, value] of Object.entries(sc.metadata.annotations ?? {})) {
      expect(key).toMatch(QUALIFIED_NAME);
      expect(typeof value).toBe('string');
    }
  });

  test('returns a fresh object on every call', () => {
    const first = dockflowStorageClass();
    first.reclaimPolicy = 'Delete';
    if (first.metadata.labels) first.metadata.labels.extra = 'x';
    expect(dockflowStorageClass().reclaimPolicy).toBe('Retain');
    expect(dockflowStorageClass().metadata.labels).not.toHaveProperty('extra');
  });
});

describe('nonDefaultStorageClassPatch (C18)', () => {
  test('is the exact merge patch of design-05 11.2', () => {
    expect(JSON.stringify(nonDefaultStorageClassPatch())).toBe(
      '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}',
    );
  });

  test('touches nothing but the default annotation', () => {
    expect(nonDefaultStorageClassPatch()).toEqual({
      metadata: { annotations: { 'storageclass.kubernetes.io/is-default-class': 'false' } },
    });
  });
});
