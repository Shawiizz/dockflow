// traefik.io/v1alpha1 IngressRoute and Middleware, typed from the CRDs of the pinned chart
// (DESIGN-CORE 4.1 rule 1; design-02 9, design-04 2.14).

import type { IntOrString, KubeObjectBase } from './meta';

export interface MiddlewareRef {
  name: string;
  namespace?: string;
}

/** A Kubernetes Service backend; TraefikServices are refused by the normalizer. */
export interface IngressRouteService {
  name: string;
  port: IntOrString;
  namespace?: string;
}

export interface IngressRouteRoute {
  /** always emitted: earlier Traefik v3 CRDs require it (emission rule 8) */
  kind: 'Rule';
  match: string;
  priority?: number;
  /** declaration order */
  middlewares?: MiddlewareRef[];
  services: IngressRouteService[];
}

/** `{}` enables TLS with the default certificate; certResolver requests an ACME certificate. */
export interface IngressRouteTls {
  certResolver?: string;
}

export interface IngressRouteSpec {
  /** omitted = every default entry point */
  entryPoints?: string[];
  routes: IngressRouteRoute[];
  tls?: IngressRouteTls;
}

export interface IngressRoute extends KubeObjectBase<'traefik.io/v1alpha1', 'IngressRoute'> {
  spec: IngressRouteSpec;
}

/** Options of basicAuth/digestAuth; `secret` names the generated users Secret (design-02 9.5). */
export interface MiddlewareAuthOptions {
  secret?: string;
  [option: string]: unknown;
}

export interface MiddlewareErrorsOptions {
  service?: { name: string; port?: IntOrString; namespace?: string };
  [option: string]: unknown;
}

/**
 * Middleware CRD spec in camelCase, one key per middleware type. Only the fields that point at
 * other objects are typed (closure and revert follow them); the rest is emitted as the normalizer
 * built it from the labels.
 */
export interface MiddlewareCrdSpec {
  basicAuth?: MiddlewareAuthOptions;
  digestAuth?: MiddlewareAuthOptions;
  errors?: MiddlewareErrorsOptions;
  chain?: { middlewares?: MiddlewareRef[] };
  [type: string]: unknown;
}

export interface Middleware extends KubeObjectBase<'traefik.io/v1alpha1', 'Middleware'> {
  spec: MiddlewareCrdSpec;
}
