// Routing objects (design-02 9, 10; DESIGN-CORE C4): one IngressRoute per router, one Middleware
// per stack middleware and one users Secret per basicAuth/digestAuth middleware that carries inline
// users. Emitted for both roles whenever the stack has a proxy intent; an accessory render gets no
// injected route (the normalizer skips injection by role) but its label routes are translated
// exactly like the app's. Pure (T2); every problem a user can cause is a diagnostic (T1).

import { sha256Hex } from '../../../../utils/hash';
import { ANNOTATIONS } from '../constants';
import { hashedObjectLabels, serviceObjectLabels, stackObjectLabels } from '../labels';
import type { CanonicalService, MiddlewareSpec, RouteSpec } from '../model/types';
import { hashedObjectName, middlewareNameFor } from '../naming';
import type { Secret } from '../resources/core';
import type { ManifestObject } from '../resources/registry';
import type {
  IngressRoute,
  IngressRouteRoute,
  IngressRouteSpec,
  Middleware,
  MiddlewareAuthOptions,
  MiddlewareCrdSpec,
} from '../resources/traefik';
import { secretDataValue } from '../yaml';
import { type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';

const TRAEFIK_API_VERSION = 'traefik.io/v1alpha1';

/** The one data key of a generated users Secret: Traefik reads any other Secret type from exactly one key (design-02 0). */
export const AUTH_SECRET_KEY = 'users';

const AUTH_TYPES = ['basicAuth', 'digestAuth'] as const;

/**
 * Middleware arrays whose order Traefik gives a meaning (design-02 9.4): a chain runs in sequence
 * and the first matching prefix is stripped. Every other array of strings is a set.
 */
const ORDERED_ARRAYS: ReadonlySet<string> = new Set(['chain.middlewares', 'stripPrefix.prefixes', 'stripPrefixRegex.regex']);

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `<service>--<8 hex of the router name>` (<= 52 + 2 + 8 = 62 characters). Named from the router
 * alone so that adding, removing or editing another router never renames this object (K72); no
 * service name contains `--`, so two services can never collide.
 */
export function ingressRouteNameFor(serviceName: string, router: string): string {
  return `${serviceName}--${sha256Hex(router).slice(0, 8)}`;
}

/** Content of the users Secret: sorted unique htpasswd lines, so label order never renames it. */
export function authSecretContent(users: readonly string[]): string {
  return `${[...new Set(users)].sort(compareCodeUnits).join('\n')}\n`;
}

export function authSecretName(middleware: string, content: string): string {
  return hashedObjectName(`${middleware}-auth`, 'secret', sha256Hex(content));
}

interface RoutedEntry {
  service: CanonicalService;
  route: RouteSpec;
}

/** IngressRoutes, Middlewares and users Secrets of the render; `[]` when the proxy is disabled. */
export function buildIngress(ctx: TranslateContext): ManifestObject[] {
  const { stack } = ctx;
  const routed: RoutedEntry[] = stack.services.flatMap((service) => service.routes.map((route) => ({ service, route })));
  if (stack.proxy === null) {
    // the normalizer parses no Traefik label while the proxy is off (routing.proxy-disabled)
    const first = routed[0];
    if (first !== undefined) {
      translatorBug(`Router ${first.route.router} of service ${first.service.composeName} reached the translator with the proxy disabled`);
    }
    if (stack.middlewares.length > 0) {
      translatorBug(`Middleware ${stack.middlewares[0].name} reached the translator with the proxy disabled`);
    }
    return [];
  }

  const secrets: Secret[] = [];
  const middlewares: Middleware[] = [];
  for (const spec of stack.middlewares) {
    const built = buildMiddleware(spec, ctx);
    middlewares.push(built.middleware);
    if (built.secret !== null) secrets.push(built.secret);
  }
  const ingressRoutes = routed.map(({ service, route }) => buildIngressRoute(service, route, ctx));

  checkUnusedMiddlewares(routed, ctx);
  checkDuplicateRules(routed, ctx);

  return [...byName(secrets), ...byName(middlewares), ...byName(ingressRoutes)];
}

function byName<T extends ManifestObject>(objects: T[]): T[] {
  return [...objects].sort((a, b) => compareCodeUnits(a.metadata.name, b.metadata.name));
}

// ---------------------------------------------------------------------------
// IngressRoute (9.2, 9.3)
// ---------------------------------------------------------------------------

function buildIngressRoute(service: CanonicalService, route: RouteSpec, ctx: TranslateContext): IngressRoute {
  const entry: IngressRouteRoute = {
    kind: 'Rule',
    match: route.rule,
    services: [{ name: service.name, port: route.port }],
  };
  if (route.priority !== null) entry.priority = route.priority;
  if (route.middlewares.length > 0) entry.middlewares = route.middlewares.map((name) => ({ name: middlewareNameFor(name).value }));

  const spec: IngressRouteSpec = { routes: [entry] };
  // empty = every default entry point, which is what the router asked for
  if (route.entryPoints.length > 0) spec.entryPoints = [...route.entryPoints];
  if (route.tls !== null) spec.tls = route.tls.certResolver === null ? {} : { certResolver: route.tls.certResolver };

  return {
    apiVersion: TRAEFIK_API_VERSION,
    kind: 'IngressRoute',
    metadata: {
      name: ingressRouteNameFor(service.name, route.router),
      namespace: ctx.namespace,
      labels: serviceObjectLabels(ctx.stack.identity, ctx.stack.role, service.name),
      annotations: { [ANNOTATIONS.composeService]: service.composeName },
    },
    spec,
  };
}

// ---------------------------------------------------------------------------
// Middleware and users Secret (9.4, 9.5)
// ---------------------------------------------------------------------------

/** A copy of the model spec with the array orders of 9.4; map keys stay as written. */
function orderedSpecValue(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => orderedSpecValue(item, `${path}[]`));
    if (ORDERED_ARRAYS.has(path)) return items;
    const strings = items.filter((item): item is string => typeof item === 'string');
    // the only arrays of objects in the CRD are middleware reference lists, whose order is a chain
    if (strings.length !== items.length) return items;
    return [...new Set(strings)].sort(compareCodeUnits);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, orderedSpecValue(entry, path === '' ? key : `${path}.${key}`)]));
  }
  return value;
}

function buildMiddleware(model: MiddlewareSpec, ctx: TranslateContext): { middleware: Middleware; secret: Secret | null } {
  const spec = orderedSpecValue(model.spec, '') as MiddlewareCrdSpec;
  const authTypes = AUTH_TYPES.filter((type) => spec[type] !== undefined);
  let secret: Secret | null = null;

  if (model.users !== null) {
    if (authTypes.length !== 1) {
      translatorBug(`Middleware ${model.name} carries users but is not exactly one basicAuth or digestAuth middleware`);
    }
    if (model.users.length === 0) translatorBug(`Middleware ${model.name} carries an empty users list`);
    const type = authTypes[0];
    const options: MiddlewareAuthOptions = spec[type] ?? {};
    if (options.secret !== undefined) translatorBug(`Middleware ${model.name} carries both users and ${type}.secret`);
    secret = buildAuthSecret(model.name, model.users, ctx);
    spec[type] = { ...options, secret: secret.metadata.name };
  } else {
    // users null is valid only for a user-managed Secret (`...<type>.secret=<name>`)
    for (const type of authTypes) {
      if (typeof spec[type]?.secret !== 'string') {
        translatorBug(`Middleware ${model.name} of type ${type} reached the translator without users or a secret`);
      }
    }
  }

  if (model.errorsService !== null) {
    if (spec.errors === undefined) translatorBug(`Middleware ${model.name} carries an errors service but is not an errors middleware`);
    spec.errors = { ...spec.errors, service: { name: model.errorsService.name, port: model.errorsService.port } };
  }

  checkAddPrefix(model, spec, ctx);

  return {
    middleware: {
      apiVersion: TRAEFIK_API_VERSION,
      kind: 'Middleware',
      metadata: {
        name: model.name,
        namespace: ctx.namespace,
        labels: stackObjectLabels(ctx.stack.identity, ctx.stack.role),
      },
      spec,
    },
    secret,
  };
}

/** Immutable Opaque Secret with the single key `users`; its content never reaches a diagnostic (T7). */
function buildAuthSecret(middleware: string, users: readonly string[], ctx: TranslateContext): Secret {
  const content = authSecretContent(users);
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: authSecretName(middleware, content),
      namespace: ctx.namespace,
      labels: hashedObjectLabels(ctx.stack.identity, ctx.stack.role, null),
    },
    data: { [AUTH_SECRET_KEY]: secretDataValue(content) },
    immutable: true,
  };
}

/** The Middleware CRD's only CEL rule; the API server would refuse the object at deploy time. */
function checkAddPrefix(model: MiddlewareSpec, spec: MiddlewareCrdSpec, ctx: TranslateContext): void {
  const addPrefix = spec.addPrefix;
  if (!isRecord(addPrefix) || !('prefix' in addPrefix)) return;
  const prefix = addPrefix.prefix;
  if (typeof prefix === 'string' && prefix.startsWith('/')) return;
  reportTranslator(ctx.sink, 'routing.middleware-invalid', model.path, { middleware: model.name });
}

// ---------------------------------------------------------------------------
// Render-wide routing checks (9.3, 9.4)
// ---------------------------------------------------------------------------

function chainReferences(spec: Record<string, unknown>): string[] {
  const chain = spec.chain;
  if (!isRecord(chain) || !Array.isArray(chain.middlewares)) return [];
  return chain.middlewares.flatMap((ref) => (isRecord(ref) && typeof ref.name === 'string' ? [ref.name] : []));
}

/**
 * Info only: an app router may use an accessory middleware, which the accessory render cannot see,
 * so an unused middleware is never refused.
 */
function checkUnusedMiddlewares(routed: readonly RoutedEntry[], ctx: TranslateContext): void {
  const used = new Set<string>();
  for (const { route } of routed) {
    for (const name of route.middlewares) used.add(middlewareNameFor(name).value);
  }
  for (const model of ctx.stack.middlewares) {
    for (const name of chainReferences(model.spec)) {
      if (name !== model.name) used.add(name);
    }
  }
  for (const model of ctx.stack.middlewares) {
    if (!used.has(model.name)) reportTranslator(ctx.sink, 'routing.middleware-unused', model.path, { middleware: model.name });
  }
}

/** An empty list attaches the router to every entry point. */
function entryPointsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((entryPoint) => b.includes(entryPoint));
}

/**
 * Two routers with one rule on a shared entry point make Traefik pick one of them arbitrarily.
 * Different priorities settle the order, which is what the hint offers. Two injected routes with one
 * host are the normalizer's `routing.duplicate-injected-host`, so a label router must be involved.
 * Reported at the label router's path (the one the user wrote), pairs in router-name order.
 */
function checkDuplicateRules(routed: readonly RoutedEntry[], ctx: TranslateContext): void {
  const routes = routed
    .map(({ route }) => route)
    .sort((a, b) => compareCodeUnits(a.router, b.router) || compareCodeUnits(a.path, b.path));
  for (let j = 1; j < routes.length; j++) {
    const second = routes[j];
    for (let i = 0; i < j; i++) {
      const first = routes[i];
      if (first.origin !== 'labels' && second.origin !== 'labels') continue;
      if (first.rule !== second.rule || first.priority !== second.priority) continue;
      if (!entryPointsOverlap(first.entryPoints, second.entryPoints)) continue;
      const at = second.origin === 'labels' ? second : first;
      reportTranslator(ctx.sink, 'routing.router-duplicate-rule', at.path, { first: first.router, second: second.router });
    }
  }
}
