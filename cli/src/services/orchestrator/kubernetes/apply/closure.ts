// Dependency closure of compose services over a set of manifest objects (design-03 6.2, K46): what
// `--only`, the automatic revert, a restore-mode apply and `rollback <service>` send to the API
// server. One signature for every caller; the PVC filter is an option, never a caller post-filter.
// Pure: no I/O, no clock.

import { ANNOTATIONS } from '../constants';
import { KIND_REGISTRY, type ManifestObject } from '../resources/registry';
import type { Middleware, MiddlewareRef } from '../resources/traefik';
import { compareCodeUnits, isWorkload, podSpecOf, templateRefs } from './snapshot';

export interface ClosureResult {
  /** emitter order */
  objects: ManifestObject[];
  /** compose names asked for that own no object (Helm-only names are expected here) */
  unmatched: string[];
}

export interface ClosureOptions {
  /** drop PersistentVolumeClaims from the result (revert, rollback <service>, apply in restore mode) */
  excludePvcs?: boolean;
}

function keyOf(kind: string, name: string): string {
  return `${kind}/${name}`;
}

/** Artifact document order: kind rank, then name (DESIGN-CORE 4.2). */
export function sortForEmission(objects: readonly ManifestObject[]): ManifestObject[] {
  return [...objects].sort(
    (a, b) => KIND_REGISTRY[a.kind].rank - KIND_REGISTRY[b.kind].rank || compareCodeUnits(a.metadata.name, b.metadata.name),
  );
}

function composeAnnotation(object: ManifestObject): string | undefined {
  return object.metadata.annotations?.[ANNOTATIONS.composeService];
}

/** A reference without a namespace, or naming the referring object's own namespace. */
function sameNamespace(reference: string | undefined, owner: ManifestObject): boolean {
  return reference === undefined || reference === owner.metadata.namespace;
}

function namesInNamespace(references: readonly MiddlewareRef[] | undefined, owner: ManifestObject): string[] {
  return (references ?? []).filter((r) => sameNamespace(r.namespace, owner)).map((r) => r.name);
}

/** Generated users Secrets of a basicAuth / digestAuth Middleware (design-02 9.5). */
export function middlewareSecretNames(middleware: Middleware): string[] {
  const names = [middleware.spec.basicAuth?.secret, middleware.spec.digestAuth?.secret];
  return names.filter((n): n is string => typeof n === 'string' && n !== '');
}

/** The Service an `errors` Middleware sends its error pages to, when it lives in the same namespace. */
export function middlewareServiceNames(middleware: Middleware): string[] {
  const service = middleware.spec.errors?.service;
  return service?.name && sameNamespace(service.namespace, middleware) ? [service.name] : [];
}

/**
 * Steps 2-4 of design-03 6.2 applied to `seeds`: the Secrets, ConfigMaps and claims of their pod
 * templates, the Middlewares of their IngressRoutes (and the members of chain Middlewares), and
 * what those Middlewares point at. The workloads behind an `errors` Service are deliberately not
 * followed: that would silently widen a `--only` filter.
 */
export function closeOver(
  objects: readonly ManifestObject[],
  seeds: readonly ManifestObject[],
  options: ClosureOptions = {},
): ManifestObject[] {
  const byKey = new Map(objects.map((o) => [keyOf(o.kind, o.metadata.name), o]));
  const selected = new Map<string, ManifestObject>();
  const add = (o: ManifestObject | undefined): boolean => {
    if (!o) return false;
    const key = keyOf(o.kind, o.metadata.name);
    if (selected.has(key)) return false;
    selected.set(key, o);
    return true;
  };
  for (const seed of seeds) add(seed);

  // 2. objects referenced by the selected pod templates; claim-template PVCs are created by the
  //    StatefulSet controller and never applied
  for (const workload of [...selected.values()].filter(isWorkload)) {
    const refs = templateRefs(podSpecOf(workload));
    for (const name of refs.secrets) add(byKey.get(keyOf('Secret', name)));
    for (const name of refs.configMaps) add(byKey.get(keyOf('ConfigMap', name)));
    for (const name of refs.claims) add(byKey.get(keyOf('PersistentVolumeClaim', name)));
  }

  // 3. Middlewares referenced by the selected IngressRoutes, then chain members until none is new
  const middlewares: Middleware[] = [];
  const addMiddleware = (name: string): void => {
    const middleware = byKey.get(keyOf('Middleware', name));
    if (middleware?.kind === 'Middleware' && add(middleware)) middlewares.push(middleware);
  };
  for (const o of [...selected.values()]) {
    if (o.kind === 'Middleware') middlewares.push(o);
    if (o.kind !== 'IngressRoute') continue;
    for (const r of o.spec.routes ?? []) {
      for (const name of namesInNamespace(r.middlewares, o)) addMiddleware(name);
    }
  }
  // grows while it is walked: each chain member is visited once
  for (let i = 0; i < middlewares.length; i++) {
    const middleware = middlewares[i];
    for (const name of namesInNamespace(middleware.spec.chain?.middlewares, middleware)) addMiddleware(name);
  }

  // 4. objects a selected Middleware points at (K46)
  for (const middleware of middlewares) {
    for (const name of middlewareSecretNames(middleware)) add(byKey.get(keyOf('Secret', name)));
    for (const name of middlewareServiceNames(middleware)) add(byKey.get(keyOf('Service', name)));
  }

  const result = [...selected.values()];
  return sortForEmission(options.excludePvcs ? result.filter((o) => o.kind !== 'PersistentVolumeClaim') : result);
}

/** The objects of `composeNames` and everything they need (design-03 6.2). */
export function closure(
  objects: readonly ManifestObject[],
  composeNames: readonly string[],
  options: ClosureOptions = {},
): ClosureResult {
  const wanted = new Set(composeNames);
  const seeds = objects.filter((o) => {
    const name = composeAnnotation(o);
    return name !== undefined && wanted.has(name);
  });
  const result = closeOver(objects, seeds, options);
  const matched = new Set(result.map(composeAnnotation));
  return {
    objects: result,
    unmatched: [...wanted].filter((n) => !matched.has(n)).sort(compareCodeUnits),
  };
}
