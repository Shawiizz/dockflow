// Kinds that can appear in a stack artifact, with what apply, prune and the emitter need to know
// about them (DESIGN-CORE 4.1, C11). Objects Dockflow creates outside artifacts (namespace,
// release/state/registry objects, Leases, helper pods, StorageClass, deployer identity) are typed
// in resources/* but are never ManifestObjects and never prune candidates.

import type { DaemonSet, Deployment, StatefulSet } from './apps';
import type { Job } from './batch';
import type { ConfigMap, PersistentVolumeClaim, Secret, Service } from './core';
import type { IngressRoute, Middleware } from './traefik';

export type ManifestObject =
  | Secret
  | ConfigMap
  | PersistentVolumeClaim
  | Service
  | Deployment
  | StatefulSet
  | DaemonSet
  | Job
  | Middleware
  | IngressRoute;

export type ManifestKind = ManifestObject['kind'];

export type ManifestApiVersion<K extends ManifestKind = ManifestKind> = Extract<ManifestObject, { kind: K }>['apiVersion'];

export type PruneClass =
  /** deleted when absent from the render (full deploys) */
  | 'prune'
  /** content-hashed: deleted when absent from the render AND unreferenced by any retained pod, ReplicaSet or ControllerRevision template */
  | 'prune-hashed'
  /** never deleted by prune (D7, D14) */
  | 'never';

export interface KindInfo {
  apiVersion: ManifestApiVersion;
  kind: ManifestKind;
  /** kubectl resource argument */
  resource: string;
  namespaced: true;
  /** document order in artifacts (ascending) */
  rank: number;
  prune: PruneClass;
}

/** A registry row whose apiVersion is the one the kind's interface declares. */
export type KindInfoOf<K extends ManifestKind> = KindInfo & { apiVersion: ManifestApiVersion<K>; kind: K };

export const KIND_REGISTRY: { readonly [K in ManifestKind]: KindInfoOf<K> } = {
  // Only `P/part=stack` Secrets are candidates: registry, release, state and token Secrets carry
  // another part and are never artifact objects.
  Secret: { apiVersion: 'v1', kind: 'Secret', resource: 'secrets', namespaced: true, rank: 10, prune: 'prune-hashed' },
  ConfigMap: { apiVersion: 'v1', kind: 'ConfigMap', resource: 'configmaps', namespaced: true, rank: 20, prune: 'prune-hashed' },
  PersistentVolumeClaim: {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    resource: 'persistentvolumeclaims',
    namespaced: true,
    rank: 30,
    prune: 'never',
  },
  Service: { apiVersion: 'v1', kind: 'Service', resource: 'services', namespaced: true, rank: 40, prune: 'prune' },
  Deployment: { apiVersion: 'apps/v1', kind: 'Deployment', resource: 'deployments.apps', namespaced: true, rank: 50, prune: 'prune' },
  StatefulSet: { apiVersion: 'apps/v1', kind: 'StatefulSet', resource: 'statefulsets.apps', namespaced: true, rank: 51, prune: 'prune' },
  DaemonSet: { apiVersion: 'apps/v1', kind: 'DaemonSet', resource: 'daemonsets.apps', namespaced: true, rank: 52, prune: 'prune' },
  Job: { apiVersion: 'batch/v1', kind: 'Job', resource: 'jobs.batch', namespaced: true, rank: 53, prune: 'prune' },
  Middleware: {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    resource: 'middlewares.traefik.io',
    namespaced: true,
    rank: 60,
    prune: 'prune',
  },
  IngressRoute: {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    resource: 'ingressroutes.traefik.io',
    namespaced: true,
    rank: 61,
    prune: 'prune',
  },
};

/** Own-property lookup, so inherited names such as `toString` are never taken for a kind. */
export function isManifestKind(kind: string): kind is ManifestKind {
  return Object.hasOwn(KIND_REGISTRY, kind);
}
