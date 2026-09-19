import { describe, expect, test } from 'bun:test';
import { ANNOTATIONS, LABELS } from '../../../services/orchestrator/kubernetes/constants';
import { hashedObjectLabels, selectorLabels, serviceObjectLabels, stackObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type {
  CanonicalService,
  CanonicalStack,
  MiddlewareSpec,
  RouteSpec,
} from '../../../services/orchestrator/kubernetes/model/types';
import { hashedObjectName } from '../../../services/orchestrator/kubernetes/naming';
import type { Service } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import type { TranslateContext } from '../../../services/orchestrator/kubernetes/translate/context';
import { isTranslatorCode } from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import {
  AUTH_SECRET_KEY,
  authSecretContent,
  authSecretName,
  buildIngress,
  ingressRouteNameFor,
} from '../../../services/orchestrator/kubernetes/translate/ingress';
import { emitManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { sha256Hex } from '../../../utils/hash';
import { canonicalService, canonicalStack, proxyIntent, type ServiceOverrides, translateContext } from '../support/builders';
import { failures, formatIssues, validateArtifact } from '../support/schema/semantic';

const NS = 'dockflow-shop-production';
const P = 'dockflow.shawiizz.dev';
const HOST = 'Host(`shop.example.com`)';

// ---------------------------------------------------------------------------
// Builders local to routing: the canonical model as the normalizer hands it over
// ---------------------------------------------------------------------------

function route(overrides: Partial<RouteSpec> = {}): RouteSpec {
  const router = overrides.router ?? 'web';
  return {
    router,
    rule: HOST,
    entryPoints: ['websecure'],
    tls: { certResolver: 'letsencrypt' },
    middlewares: [],
    priority: null,
    port: 80,
    origin: 'labels',
    path: `services.web.deploy.labels.traefik.http.routers.${router}`,
    ...overrides,
  };
}

function middleware(name: string, spec: Record<string, unknown>, overrides: Partial<MiddlewareSpec> = {}): MiddlewareSpec {
  return {
    name,
    spec,
    users: null,
    errorsService: null,
    path: `services.web.deploy.labels.traefik.http.middlewares.${name}`,
    ...overrides,
  };
}

function service(composeName: string, routes: RouteSpec[], overrides: ServiceOverrides = {}): CanonicalService {
  return canonicalService({ composeName, name: composeName.replace(/_/g, '-'), routes, ...overrides });
}

/** Role app, ACME proxy intent with the domain, services and middlewares as given. */
function routedStack(services: CanonicalService[], middlewares: MiddlewareSpec[] = [], overrides: Partial<CanonicalStack> = {}): CanonicalStack {
  return canonicalStack({ services, middlewares, proxy: proxyIntent(), ...overrides });
}

function contextFor(stack: CanonicalStack): TranslateContext {
  return translateContext(stack, { traefikOnCluster: stack.proxy !== null });
}

function build(stack: CanonicalStack): { objects: ManifestObject[]; ctx: TranslateContext } {
  const ctx = contextFor(stack);
  return { objects: buildIngress(ctx), ctx };
}

function ofKind<K extends ManifestObject['kind']>(objects: readonly ManifestObject[], kind: K): Extract<ManifestObject, { kind: K }>[] {
  return objects.filter((o): o is Extract<ManifestObject, { kind: K }> => o.kind === kind);
}

function named<K extends ManifestObject['kind']>(objects: readonly ManifestObject[], kind: K, name: string): Extract<ManifestObject, { kind: K }> {
  const found = ofKind(objects, kind).find((o) => o.metadata.name === name);
  if (found === undefined) throw new Error(`${kind}/${name} is not in ${objects.map((o) => `${o.kind}/${o.metadata.name}`).join(', ')}`);
  return found;
}

function codes(ctx: TranslateContext): string[] {
  return ctx.sink.list().map((d) => d.code);
}

function decode(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

/**
 * The routing objects are validated with the Service backends they point at: a minimal ClusterIP
 * Service per routed service and per `errors` target stands in for services.ts, and its own
 * findings (no workload in this artifact) are not this module's.
 */
function backendServices(stack: CanonicalStack): Service[] {
  const ports = new Map<string, Set<number>>();
  const add = (name: string, port: number): void => {
    const set = ports.get(name) ?? new Set<number>();
    set.add(port);
    ports.set(name, set);
  };
  for (const svc of stack.services) for (const r of svc.routes) add(svc.name, r.port);
  for (const mw of stack.middlewares) if (mw.errorsService !== null) add(mw.errorsService.name, mw.errorsService.port);
  return [...ports].map(([name, set]) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: stack.identity.namespace, labels: serviceObjectLabels(stack.identity, stack.role, name) },
    spec: {
      ports: [...set].sort((a, b) => a - b).map((port) => ({ name: `tcp-${port}`, port, protocol: 'TCP' })),
      selector: selectorLabels(stack.identity, name),
    },
  }));
}

function expectValid(objects: readonly ManifestObject[], stack: CanonicalStack, options: { externalNames?: string[] } = {}): void {
  const issues = failures(
    validateArtifact([...objects, ...backendServices(stack)], {
      namespace: stack.identity.namespace,
      externalNames: options.externalNames ?? [],
      strictMiddlewares: true,
    }),
  ).filter((issue) => issue.kind !== 'Service');
  expect(formatIssues(issues)).toBe('');
}

function expectBug(run: () => unknown, fragment: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeployError);
  const error = caught as DeployError;
  expect(error.message).toContain(fragment);
  expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
  expect(error.suggestion).toBe('Report this as a Dockflow bug.');
}

// ---------------------------------------------------------------------------
// Emission condition (9.1, C4)
// ---------------------------------------------------------------------------

describe('emission condition (9.1, C4)', () => {
  test('proxy disabled and nothing routed: no objects, no diagnostic', () => {
    const stack = canonicalStack({ services: [service('web', [])], proxy: null });
    const { objects, ctx } = build(stack);
    expect(objects).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('proxy enabled without routes or middlewares: no objects', () => {
    const { objects, ctx } = build(routedStack([service('web', [])]));
    expect(objects).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
  });

  test('a route arriving with a null proxy intent is a Dockflow bug (T6)', () => {
    const stack = canonicalStack({ services: [service('web', [route({ router: 'api' })])], proxy: null });
    expectBug(() => buildIngress(contextFor(stack)), 'Router api of service web reached the translator with the proxy disabled');
  });

  test('a middleware arriving with a null proxy intent is a Dockflow bug (T6)', () => {
    const stack = canonicalStack({ services: [service('web', [])], middlewares: [middleware('strip', { stripPrefix: { prefixes: ['/api'] } })], proxy: null });
    expectBug(() => buildIngress(contextFor(stack)), 'Middleware strip reached the translator with the proxy disabled');
  });

  test('role app with a domain: the injected route and the label routes are both translated', () => {
    const injected = route({ router: 'shop-production-web', origin: 'injected', port: 3000, path: 'services.web.ports' });
    const labels = route({ router: 'admin', rule: 'Host(`admin.example.com`)', port: 3000 });
    const stack = routedStack([service('web', [labels, injected])]);
    const { objects } = build(stack);
    expect(ofKind(objects, 'IngressRoute').map((o) => o.metadata.name)).toEqual(
      [ingressRouteNameFor('web', 'admin'), ingressRouteNameFor('web', 'shop-production-web')].sort(),
    );
    expectValid(objects, stack);
  });

  test('accessory with domain: null translates its label routes like the app (K02)', () => {
    const adminRoute = route({
      router: 'admin',
      rule: 'Host(`admin.example.com`)',
      middlewares: ['strip-admin'],
      port: 8080,
      path: 'services.admin.deploy.labels',
    });
    const admin = service('admin', [adminRoute], { role: 'accessory' });
    const strip = middleware('strip-admin', { stripPrefix: { prefixes: ['/admin'] } });
    const stack = routedStack([admin], [strip], { role: 'accessory', proxy: proxyIntent({ domain: null }) });
    const { objects, ctx } = build(stack);

    const ingress = named(objects, 'IngressRoute', ingressRouteNameFor('admin', 'admin'));
    expect(ingress.metadata.labels?.[LABELS.role]).toBe('accessory');
    expect(ingress.metadata.labels).toEqual(serviceObjectLabels(stack.identity, 'accessory', 'admin'));
    expect(named(objects, 'Middleware', 'strip-admin').metadata.labels?.[LABELS.role]).toBe('accessory');
    expect(ctx.sink.list()).toEqual([]);
    expectValid(objects, stack);
  });

  test('accessory output does not depend on the release version', () => {
    const make = (version: string): string => {
      const svc = service('admin', [route({ router: 'admin', port: 8080 })], { role: 'accessory' });
      const stack = routedStack([svc], [], { role: 'accessory', proxy: proxyIntent({ domain: null }), identity: { ...canonicalStack().identity, version } });
      return emitManifests(buildIngress(contextFor(stack)), { format: 'k8s-manifests/1', stackName: 'shop-production', role: 'accessory', version: '-' });
    };
    expect(make('1.4.2')).toBe(make('2.0.0'));
  });
});

// ---------------------------------------------------------------------------
// One IngressRoute per router (9.2, K72)
// ---------------------------------------------------------------------------

describe('one IngressRoute per router (9.2, K72)', () => {
  test('the name is <service>--<8 hex of sha256(router name)>', () => {
    expect(ingressRouteNameFor('web', 'api')).toBe(`web--${sha256Hex('api').slice(0, 8)}`);
    expect(ingressRouteNameFor('web', 'shop-production-web')).toMatch(/^web--[0-9a-f]{8}$/);
  });

  test('the name depends on the router name only', () => {
    const a = ofKind(build(routedStack([service('web', [route({ router: 'api' })])])).objects, 'IngressRoute')[0];
    const edited = route({ router: 'api', rule: 'Host(`other.example.com`)', entryPoints: ['web'], tls: null, priority: 7, port: 81 });
    const b = ofKind(build(routedStack([service('web', [edited])])).objects, 'IngressRoute')[0];
    expect(a.metadata.name).toBe(b.metadata.name);
    expect(a.spec).not.toEqual(b.spec);
  });

  test('adding a router leaves every existing name and object unchanged', () => {
    const api = route({ router: 'api', rule: 'Host(`api.example.com`)' });
    const internal = route({ router: 'api-internal', rule: 'Host(`internal.example.com`)', entryPoints: ['web'], tls: null, priority: 10 });
    const before = build(routedStack([service('web', [api])])).objects;
    const after = build(routedStack([service('web', [api, internal])])).objects;

    expect(ofKind(after, 'IngressRoute')).toHaveLength(2);
    const name = ingressRouteNameFor('web', 'api');
    expect(named(after, 'IngressRoute', name)).toEqual(named(before, 'IngressRoute', name));
    expect(named(after, 'IngressRoute', ingressRouteNameFor('web', 'api-internal')).spec).toEqual({
      entryPoints: ['web'],
      routes: [{ kind: 'Rule', match: 'Host(`internal.example.com`)', priority: 10, services: [{ name: 'web', port: 80 }] }],
    });
  });

  test('routers of several services never collide, and the result is independent of model order', () => {
    const web = service('web', [route({ router: 'web-a' }), route({ router: 'web-b', rule: 'Host(`b.example.com`)' })]);
    const api = service('api', [route({ router: 'api', rule: 'Host(`api.example.com`)', port: 8080, path: 'services.api.deploy.labels' })]);
    const mws = [middleware('a-strip', { stripPrefix: { prefixes: ['/a'] } }), middleware('b-strip', { stripPrefix: { prefixes: ['/b'] } })];
    const stack = routedStack([api, web], mws);
    const reversed = routedStack(
      [service('web', [...web.routes].reverse()), api],
      [...mws].reverse(),
    );

    const first = build(stack).objects;
    expect(first.map((o) => `${o.kind}/${o.metadata.name}`)).toEqual([
      'Middleware/a-strip',
      'Middleware/b-strip',
      ...[ingressRouteNameFor('api', 'api'), ingressRouteNameFor('web', 'web-a'), ingressRouteNameFor('web', 'web-b')].sort().map((n) => `IngressRoute/${n}`),
    ]);
    expect(build(reversed).objects).toEqual(first);
  });

  test('a 52-character service name yields a 62-character name', () => {
    const long = 'a'.repeat(52);
    const stack = routedStack([service(long, [route({ router: 'r', path: `services.${long}.deploy.labels` })])]);
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.metadata.name).toHaveLength(62);
    expectValid(build(stack).objects, stack);
  });
});

// ---------------------------------------------------------------------------
// IngressRoute fields (9.3, 9.6)
// ---------------------------------------------------------------------------

describe('IngressRoute fields (9.3, 9.6)', () => {
  test('reference output: injected route with ACME', () => {
    const injected = route({ router: 'shop-production-web', origin: 'injected', port: 3000, path: 'services.web.ports' });
    const stack = routedStack([service('web', [injected])]);
    const { objects, ctx } = build(stack);
    expect(objects).toEqual([
      {
        apiVersion: 'traefik.io/v1alpha1',
        kind: 'IngressRoute',
        metadata: {
          name: ingressRouteNameFor('web', 'shop-production-web'),
          namespace: NS,
          labels: {
            'app.kubernetes.io/managed-by': 'dockflow',
            'app.kubernetes.io/part-of': 'shop',
            'app.kubernetes.io/instance': NS,
            'app.kubernetes.io/name': 'web',
            [`${P}/stack`]: NS,
            [`${P}/role`]: 'app',
            [`${P}/part`]: 'stack',
            [`${P}/service`]: 'web',
          },
          annotations: { [`${P}/compose-service`]: 'web' },
        },
        spec: {
          entryPoints: ['websecure'],
          routes: [{ kind: 'Rule', match: HOST, services: [{ name: 'web', port: 3000 }] }],
          tls: { certResolver: 'letsencrypt' },
        },
      },
    ]);
    expect(ctx.sink.list()).toEqual([]);
    expectValid(objects, stack);
  });

  test('ACME off: entry point web and no tls', () => {
    const injected = route({ router: 'shop-production-web', origin: 'injected', entryPoints: ['web'], tls: null, port: 3000 });
    const stack = routedStack([service('web', [injected])], [], { proxy: proxyIntent({ acme: false, entryPoint: 'web', certResolver: null }) });
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.spec).toEqual({ entryPoints: ['web'], routes: [{ kind: 'Rule', match: HOST, services: [{ name: 'web', port: 3000 }] }] });
    expect('tls' in ingress.spec).toBe(false);
  });

  test.each([
    ['tls null', null, undefined],
    ['tls without resolver', { certResolver: null }, {}],
    ['tls with resolver', { certResolver: 'letsencrypt' }, { certResolver: 'letsencrypt' }],
  ] as const)('%s', (_label, tls, expected) => {
    const stack = routedStack([service('web', [route({ tls: tls === null ? null : { ...tls } })])]);
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.spec.tls).toEqual(expected);
    expect('tls' in ingress.spec).toBe(expected !== undefined);
    expectValid(build(stack).objects, stack);
  });

  test('kind: Rule is always present and the rule is emitted verbatim, never escaped', () => {
    const rule = 'Host(`shop.example.com`) && PathRegexp(`^/$(v[0-9]+)/`) || Header(`X-A`, `$$b`)';
    const [ingress] = ofKind(build(routedStack([service('web', [route({ rule })])])).objects, 'IngressRoute');
    expect(ingress.spec.routes).toHaveLength(1);
    expect(ingress.spec.routes[0].kind).toBe('Rule');
    expect(ingress.spec.routes[0].match).toBe(rule);
  });

  test('priority only when set; entryPoints omitted when empty', () => {
    const stack = routedStack([
      service('web', [route({ router: 'a', priority: 0 }), route({ router: 'b', rule: 'Host(`b.example.com`)', entryPoints: [], priority: null })]),
    ]);
    const objects = build(stack).objects;
    const a = named(objects, 'IngressRoute', ingressRouteNameFor('web', 'a'));
    const b = named(objects, 'IngressRoute', ingressRouteNameFor('web', 'b'));
    expect(a.spec.routes[0].priority).toBe(0);
    expect('priority' in b.spec.routes[0]).toBe(false);
    expect(a.spec.entryPoints).toEqual(['websecure']);
    expect('entryPoints' in b.spec).toBe(false);
    expectValid(objects, stack);
  });

  test('the backend is the service ClusterIP Service on the route port', () => {
    const stack = routedStack([service('web_app', [route({ port: 8080, path: 'services.web_app.deploy.labels' })])]);
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.spec.routes[0].services).toEqual([{ name: 'web-app', port: 8080 }]);
    expect(ingress.metadata.annotations).toEqual({ [ANNOTATIONS.composeService]: 'web_app' });
    expect(ingress.metadata.labels).toEqual(serviceObjectLabels(stack.identity, 'app', 'web-app'));
    expectValid(build(stack).objects, stack);
  });

  test('labels with routers api (websecure, letsencrypt, strip-api) and api-internal (web, priority 10) give two IngressRoutes', () => {
    const api = service('api', [
      route({ router: 'api', rule: 'Host(`api.example.com`)', middlewares: ['strip-api'], port: 8080, path: 'services.api.deploy.labels' }),
      route({ router: 'api-internal', rule: 'Host(`api.internal`)', entryPoints: ['web'], tls: null, priority: 10, port: 8080, path: 'services.api.deploy.labels' }),
    ]);
    const stack = routedStack([api], [middleware('strip-api', { stripPrefix: { prefixes: ['/api'] } })]);
    const objects = build(stack).objects;
    expect(ofKind(objects, 'IngressRoute').map((o) => o.metadata.name).sort()).toEqual(
      [ingressRouteNameFor('api', 'api'), ingressRouteNameFor('api', 'api-internal')].sort(),
    );
    expect(named(objects, 'IngressRoute', ingressRouteNameFor('api', 'api')).spec).toEqual({
      entryPoints: ['websecure'],
      routes: [{ kind: 'Rule', match: 'Host(`api.example.com`)', middlewares: [{ name: 'strip-api' }], services: [{ name: 'api', port: 8080 }] }],
      tls: { certResolver: 'letsencrypt' },
    });
    expectValid(objects, stack);
  });
});

// ---------------------------------------------------------------------------
// Middleware references (9.3)
// ---------------------------------------------------------------------------

describe('middleware references (9.3)', () => {
  test('declaration order is kept and names go through middlewareNameFor', () => {
    const mws = [middleware('auth', { redirectScheme: { scheme: 'https' } }), middleware('strip', { stripPrefix: { prefixes: ['/api'] } })];
    const stack = routedStack([service('web', [route({ middlewares: ['strip', 'auth'] })])], mws);
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.spec.routes[0].middlewares).toEqual([{ name: 'strip' }, { name: 'auth' }]);
    expectValid(build(stack).objects, stack);
  });

  test('a name the normalizer left unsanitized is sanitized, a sanitized one is unchanged', () => {
    const stack = routedStack([service('web', [route({ middlewares: ['My_Auth', 'my-auth', 'strip'] })])], [middleware('my-auth', { redirectScheme: { scheme: 'https' } })]);
    const [ingress] = ofKind(build(stack).objects, 'IngressRoute');
    expect(ingress.spec.routes[0].middlewares).toEqual([{ name: 'my-auth' }, { name: 'my-auth' }, { name: 'strip' }]);
  });

  test('a middleware of the sibling role is referenced by name without a local object', () => {
    const stack = routedStack([service('web', [route({ middlewares: ['db-admin-auth'] })])]);
    const objects = build(stack).objects;
    expect(ofKind(objects, 'Middleware')).toEqual([]);
    expect(ofKind(objects, 'IngressRoute')[0].spec.routes[0].middlewares).toEqual([{ name: 'db-admin-auth' }]);
    expectValid(objects, stack, { externalNames: ['db-admin-auth'] });
  });

  test('no middlewares: the key is omitted', () => {
    const [ingress] = ofKind(build(routedStack([service('web', [route()])])).objects, 'IngressRoute');
    expect('middlewares' in ingress.spec.routes[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Middlewares (9.4)
// ---------------------------------------------------------------------------

describe('Middlewares (9.4)', () => {
  test('one object per model entry, stack labels, the spec in CRD shape', () => {
    const strip = middleware('strip-api', { stripPrefix: { prefixes: ['/api'] } });
    const stack = routedStack([service('web', [route({ middlewares: ['strip-api'] })])], [strip]);
    const mw = named(build(stack).objects, 'Middleware', 'strip-api');
    expect(mw).toEqual({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'Middleware',
      metadata: { name: 'strip-api', namespace: NS, labels: stackObjectLabels(stack.identity, 'app') },
      spec: { stripPrefix: { prefixes: ['/api'] } },
    });
    expect('annotations' in mw.metadata).toBe(false);
  });

  test('set arrays are sorted by code unit without duplicates; ordered arrays keep declaration order', () => {
    const spec = {
      ipAllowList: { sourceRange: ['192.168.0.0/16', '10.0.0.0/8', '192.168.0.0/16'], ipStrategy: { depth: 1, excludedIPs: ['10.0.0.9', '10.0.0.10'] } },
    };
    const mws = [
      middleware('allow', spec),
      middleware('strip', { stripPrefix: { prefixes: ['/api/v1', '/api', '/api/v1'], forceSlash: false } }),
      middleware('strip-regex', { stripPrefixRegex: { regex: ['^/b', '^/a'] } }),
      middleware('chain', { chain: { middlewares: [{ name: 'strip' }, { name: 'allow' }] } }),
      middleware('cors', {
        headers: {
          accessControlAllowMethods: ['PUT', 'GET', 'DELETE'],
          accessControlAllowHeaders: ['X-B', 'X-A'],
          customRequestHeaders: { 'X-Forwarded-Proto': 'https', 'X-A': 'a,b' },
          frameDeny: true,
          stsSeconds: 31536000,
        },
      }),
      middleware('errors', { errors: { status: ['502', '500-599', '404'], query: '/{status}.html', statusRewrites: { '500': 200 } } }),
    ];
    const stack = routedStack([service('web', [route({ middlewares: ['chain', 'cors'] })])], mws);
    const snapshot = structuredClone(mws);
    const objects = build(stack).objects;

    expect(named(objects, 'Middleware', 'allow').spec).toEqual({
      ipAllowList: { sourceRange: ['10.0.0.0/8', '192.168.0.0/16'], ipStrategy: { depth: 1, excludedIPs: ['10.0.0.10', '10.0.0.9'] } },
    });
    expect(named(objects, 'Middleware', 'strip').spec).toEqual({ stripPrefix: { prefixes: ['/api/v1', '/api', '/api/v1'], forceSlash: false } });
    expect(named(objects, 'Middleware', 'strip-regex').spec).toEqual({ stripPrefixRegex: { regex: ['^/b', '^/a'] } });
    expect(named(objects, 'Middleware', 'chain').spec).toEqual({ chain: { middlewares: [{ name: 'strip' }, { name: 'allow' }] } });
    expect(named(objects, 'Middleware', 'cors').spec).toEqual({
      headers: {
        accessControlAllowMethods: ['DELETE', 'GET', 'PUT'],
        accessControlAllowHeaders: ['X-A', 'X-B'],
        customRequestHeaders: { 'X-Forwarded-Proto': 'https', 'X-A': 'a,b' },
        frameDeny: true,
        stsSeconds: 31536000,
      },
    });
    expect(named(objects, 'Middleware', 'errors').spec).toEqual({
      errors: { status: ['404', '500-599', '502'], query: '/{status}.html', statusRewrites: { '500': 200 } },
    });
    // the model is never mutated
    expect(mws).toEqual(snapshot);
    expectValid(objects, stack);
  });

  test('a label-order permutation of a set array produces the same object', () => {
    const one = routedStack([service('web', [route({ middlewares: ['allow'] })])], [middleware('allow', { ipAllowList: { sourceRange: ['10.0.0.0/8', '172.16.0.0/12'] } })]);
    const two = routedStack([service('web', [route({ middlewares: ['allow'] })])], [middleware('allow', { ipAllowList: { sourceRange: ['172.16.0.0/12', '10.0.0.0/8'] } })]);
    expect(build(one).objects).toEqual(build(two).objects);
  });

  test('unused middleware: info, still emitted; a chain member or a route reference counts as used', () => {
    const mws = [
      middleware('chain', { chain: { middlewares: [{ name: 'member' }] } }),
      middleware('member', { stripPrefix: { prefixes: ['/m'] } }),
      middleware('orphan', { stripPrefix: { prefixes: ['/o'] } }),
      middleware('routed', { stripPrefix: { prefixes: ['/r'] } }),
    ];
    const stack = routedStack([service('web', [route({ middlewares: ['routed'] })])], mws);
    const { objects, ctx } = build(stack);
    expect(ofKind(objects, 'Middleware').map((m) => m.metadata.name)).toEqual(['chain', 'member', 'orphan', 'routed']);
    expect(ctx.sink.list()).toEqual([
      {
        severity: 'info',
        code: 'routing.middleware-unused',
        path: 'services.web.deploy.labels.traefik.http.middlewares.chain',
        message: 'Middleware chain is not used by any router',
      },
      {
        severity: 'info',
        code: 'routing.middleware-unused',
        path: 'services.web.deploy.labels.traefik.http.middlewares.orphan',
        message: 'Middleware orphan is not used by any router',
      },
    ]);
  });

  test('a chain naming itself does not count as a use of itself', () => {
    const stack = routedStack([service('web', [route()])], [middleware('loop', { chain: { middlewares: [{ name: 'loop' }] } })]);
    expect(codes(build(stack).ctx)).toEqual(['routing.middleware-unused']);
  });

  test('CEL rule: addPrefix.prefix must start with / (routing.middleware-invalid)', () => {
    const bad = middleware('prefix', { addPrefix: { prefix: 'v1' } });
    const stack = routedStack([service('web', [route({ middlewares: ['prefix'] })])], [bad]);
    const { objects, ctx } = build(stack);
    expect(ctx.sink.list()).toEqual([
      {
        severity: 'error',
        code: 'routing.middleware-invalid',
        path: bad.path,
        message: 'Middleware prefix: addPrefix.prefix must start with /',
        hint: 'Start the prefix with `/`.',
      },
    ]);
    // still built: render stops on the error before anything is emitted (T1)
    expect(named(objects, 'Middleware', 'prefix').spec).toEqual({ addPrefix: { prefix: 'v1' } });

    const good = routedStack([service('web', [route({ middlewares: ['prefix'] })])], [middleware('prefix', { addPrefix: { prefix: '/v1' } })]);
    const result = build(good);
    expect(result.ctx.sink.list()).toEqual([]);
    expectValid(result.objects, good);
  });
});

// ---------------------------------------------------------------------------
// Label-shaped fields: users Secret and errors.service (9.5)
// ---------------------------------------------------------------------------

describe('basicAuth / digestAuth users Secret (9.5)', () => {
  const USERS = ['ops:$2y$05$hash/two', 'admin:$apr1$Qx1$hash', 'ops:$2y$05$hash/two'];
  const CONTENT = 'admin:$apr1$Qx1$hash\nops:$2y$05$hash/two\n';

  function authStack(type: 'basicAuth' | 'digestAuth', users: string[], options: Record<string, unknown> = {}): CanonicalStack {
    return routedStack([service('web', [route({ middlewares: ['auth'] })])], [middleware('auth', { [type]: options }, { users })]);
  }

  test('content is the sorted unique lines, one trailing newline', () => {
    expect(authSecretContent(USERS)).toBe(CONTENT);
    expect(authSecretContent(['b', 'a'])).toBe('a\nb\n');
  });

  test.each(['basicAuth', 'digestAuth'] as const)('%s: one immutable Secret with the single key users, the spec points at it', (type) => {
    const stack = authStack(type, USERS, { realm: 'Private', removeHeader: true });
    const { objects, ctx } = build(stack);
    const name = hashedObjectName('auth-auth', 'secret', sha256Hex(CONTENT));
    expect(authSecretName('auth', CONTENT)).toBe(name);

    const secret = named(objects, 'Secret', name);
    expect(secret).toEqual({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace: NS, labels: hashedObjectLabels(stack.identity, 'app', null) },
      data: { [AUTH_SECRET_KEY]: Buffer.from(CONTENT, 'utf8').toString('base64') },
      immutable: true,
    });
    expect(Object.keys(secret.data ?? {})).toEqual(['users']);
    expect(decode(secret.data?.users ?? '')).toBe(CONTENT);
    expect(secret.metadata.labels?.[LABELS.hashed]).toBe('true');
    expect('type' in secret).toBe(false);

    expect(named(objects, 'Middleware', 'auth').spec).toEqual({ [type]: { realm: 'Private', removeHeader: true, secret: name } });
    expect(ctx.sink.list()).toEqual([]);
    expectValid(objects, stack);
  });

  test('the Secret name follows the content, never the label order', () => {
    const nameOf = (users: string[]): string => ofKind(build(authStack('basicAuth', users)).objects, 'Secret')[0].metadata.name;
    expect(nameOf(['b:x', 'a:y'])).toBe(nameOf(['a:y', 'b:x', 'a:y']));
    expect(nameOf(['a:y'])).not.toBe(nameOf(['a:z']));
  });

  test('the users never appear in a diagnostic (T7)', () => {
    const stack = routedStack(
      [service('web', [route()])],
      [middleware('auth', { basicAuth: {} }, { users: ['admin:$apr1$secret-hash'] }), middleware('prefix', { addPrefix: { prefix: 'x' } })],
    );
    const { ctx } = build(stack);
    expect(codes(ctx).sort()).toEqual(['routing.middleware-invalid', 'routing.middleware-unused', 'routing.middleware-unused']);
    expect(JSON.stringify(ctx.sink.list())).not.toContain('secret-hash');
  });

  test('a user-managed Secret (users null, secret set) passes through without a generated Secret', () => {
    const stack = routedStack([service('web', [route({ middlewares: ['auth'] })])], [middleware('auth', { basicAuth: { secret: 'mine' } })]);
    const objects = build(stack).objects;
    expect(ofKind(objects, 'Secret')).toEqual([]);
    expect(named(objects, 'Middleware', 'auth').spec).toEqual({ basicAuth: { secret: 'mine' } });
    expectValid(objects, stack, { externalNames: ['mine'] });
  });

  test('model invariant violations throw (T6)', () => {
    const withMiddleware = (mw: MiddlewareSpec): (() => unknown) => () => buildIngress(contextFor(routedStack([service('web', [route()])], [mw])));
    expectBug(withMiddleware(middleware('auth', { basicAuth: { realm: 'x' } })), 'Middleware auth of type basicAuth reached the translator without users or a secret');
    expectBug(withMiddleware(middleware('auth', { stripPrefix: { prefixes: ['/a'] } }, { users: ['a:b'] })), 'Middleware auth carries users but is not exactly one basicAuth or digestAuth middleware');
    expectBug(withMiddleware(middleware('auth', { basicAuth: { secret: 'mine' } }, { users: ['a:b'] })), 'Middleware auth carries both users and basicAuth.secret');
    expectBug(withMiddleware(middleware('auth', { basicAuth: {} }, { users: [] })), 'Middleware auth carries an empty users list');
    expectBug(
      withMiddleware(middleware('page', { stripPrefix: { prefixes: ['/a'] } }, { errorsService: { name: 'web', port: 80 } })),
      'Middleware page carries an errors service but is not an errors middleware',
    );
  });
});

describe('errors.service (9.5)', () => {
  test('points at the resolved Service and port, next to the other errors options', () => {
    const pages = service('error_pages', [], { expose: [{ target: 8080, protocol: 'TCP', path: 'services.error_pages.expose[0]' }] });
    const errors = middleware('errors', { errors: { status: ['502', '500-599'], query: '/{status}.html' } }, { errorsService: { name: 'error-pages', port: 8080 } });
    const stack = routedStack([pages, service('web', [route({ middlewares: ['errors'] })])], [errors]);
    const { objects, ctx } = build(stack);
    expect(named(objects, 'Middleware', 'errors').spec).toEqual({
      errors: { query: '/{status}.html', service: { name: 'error-pages', port: 8080 }, status: ['500-599', '502'] },
    });
    expect(ofKind(objects, 'Secret')).toEqual([]);
    expect(ctx.sink.list()).toEqual([]);
    expectValid(objects, stack);
  });

  test('a sibling-role Service is named the same way', () => {
    const errors = middleware('errors', { errors: { status: ['500-599'] } }, { errorsService: { name: 'pages', port: 80 } });
    const stack = routedStack([service('web', [route({ middlewares: ['errors'] })])], [errors]);
    expect(named(build(stack).objects, 'Middleware', 'errors').spec.errors?.service).toEqual({ name: 'pages', port: 80 });
  });
});

// ---------------------------------------------------------------------------
// routing.router-duplicate-rule (9.3)
// ---------------------------------------------------------------------------

describe('routing.router-duplicate-rule (9.3)', () => {
  function duplicates(routesByService: Record<string, RouteSpec[]>): { code: string; path: string; message: string }[] {
    const services = Object.entries(routesByService).map(([name, routes]) => service(name, routes));
    return build(routedStack(services))
      .ctx.sink.list()
      .filter((d) => d.code === 'routing.router-duplicate-rule')
      .map(({ code, path, message }) => ({ code, path, message }));
  }

  test('two label routers with one rule on one entry point: warning at the later router', () => {
    const found = duplicates({
      web: [route({ router: 'b', path: 'services.web.deploy.labels.b' })],
      api: [route({ router: 'a', port: 8080, path: 'services.api.deploy.labels.a' })],
    });
    expect(found).toEqual([{ code: 'routing.router-duplicate-rule', path: 'services.web.deploy.labels.b', message: 'Routers a and b have the same rule and entry points' }]);
    const [diagnostic] = build(routedStack([service('web', [route({ router: 'b' })]), service('api', [route({ router: 'a', port: 8080 })])])).ctx.sink.list();
    expect(diagnostic.severity).toBe('warning');
    expect(diagnostic.hint).toBe('Give one of them a different rule or a `priority`.');
  });

  test('two injected routes with one host are not reported here (normalizer duplicate-injected-host)', () => {
    expect(
      duplicates({
        web: [route({ router: 'shop-production-web', origin: 'injected' })],
        api: [route({ router: 'shop-production-api', origin: 'injected', port: 8080 })],
      }),
    ).toEqual([]);
  });

  test('an injected and a label route: reported at the label router', () => {
    const found = duplicates({
      web: [route({ router: 'shop-production-web', origin: 'injected', path: 'services.web.ports' })],
      api: [route({ router: 'api', port: 8080, path: 'services.api.deploy.labels.api' })],
    });
    expect(found).toEqual([
      { code: 'routing.router-duplicate-rule', path: 'services.api.deploy.labels.api', message: 'Routers api and shop-production-web have the same rule and entry points' },
    ]);
  });

  test('disjoint entry points, different rules or different priorities are not duplicates', () => {
    expect(duplicates({ web: [route({ router: 'a', entryPoints: ['web'] }), route({ router: 'b', entryPoints: ['websecure'] })] })).toEqual([]);
    expect(duplicates({ web: [route({ router: 'a' }), route({ router: 'b', rule: 'Host(`b.example.com`)' })] })).toEqual([]);
    expect(duplicates({ web: [route({ router: 'a', priority: 10 }), route({ router: 'b' })] })).toEqual([]);
  });

  test('an empty entry point list overlaps every entry point', () => {
    expect(duplicates({ web: [route({ router: 'a', entryPoints: [] }), route({ router: 'b', entryPoints: ['web'] })] })).toHaveLength(1);
  });

  test('the report does not depend on model order', () => {
    const a = route({ router: 'a', path: 'services.web.deploy.labels.a' });
    const b = route({ router: 'b', path: 'services.web.deploy.labels.b' });
    expect(duplicates({ web: [a, b] })).toEqual(duplicates({ web: [b, a] }));
  });
});

// ---------------------------------------------------------------------------
// Catalogue, determinism
// ---------------------------------------------------------------------------

describe('catalogue and determinism', () => {
  function kitchenSink(): CanonicalStack {
    return routedStack(
      [
        service('web', [
          route({ router: 'shop-production-web', origin: 'injected', port: 3000, path: 'services.web.ports' }),
          route({ router: 'web-api', rule: HOST, port: 3000, middlewares: ['chain', 'auth'] }),
        ]),
        service('pages', [], { expose: [{ target: 8080, protocol: 'TCP', path: 'services.pages.expose[0]' }] }),
      ],
      [
        middleware('auth', { digestAuth: { realm: 'r' } }, { users: ['b:1', 'a:2'] }),
        middleware('chain', { chain: { middlewares: [{ name: 'strip' }, { name: 'errors' }] } }),
        middleware('errors', { errors: { status: ['503', '500'] } }, { errorsService: { name: 'pages', port: 8080 } }),
        middleware('prefix', { addPrefix: { prefix: 'nope' } }),
        middleware('strip', { stripPrefix: { prefixes: ['/b', '/a'] } }),
      ],
    );
  }

  test('every code emitted here is in TRANSLATOR_CODES', () => {
    const { ctx } = build(kitchenSink());
    const emitted = codes(ctx);
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(isTranslatorCode(code)).toBe(true);
    expect([...new Set(emitted)].sort()).toEqual(['routing.middleware-invalid', 'routing.middleware-unused', 'routing.router-duplicate-rule']);
  });

  test('translating twice emits byte-identical manifests', () => {
    const header = { format: 'k8s-manifests/1', stackName: 'shop-production', role: 'app', version: '1.4.2' } as const;
    const first = emitManifests(build(kitchenSink()).objects, header);
    const second = emitManifests(build(kitchenSink()).objects, header);
    expect(first).toBe(second);
    expect(first).toContain('kind: IngressRoute');
  });

  test('the Secret a Middleware points at and the Service of errors are the pair closure follows (K46)', () => {
    const stack = kitchenSink();
    const objects = build(stack).objects;
    const auth = named(objects, 'Middleware', 'auth');
    const secret = named(objects, 'Secret', auth.spec.digestAuth?.secret ?? '');
    expect(Object.keys(secret.data ?? {})).toEqual([AUTH_SECRET_KEY]);
    expect(named(objects, 'Middleware', 'errors').spec.errors?.service).toEqual({ name: 'pages', port: 8080 });
    expect(ofKind(objects, 'IngressRoute')).toHaveLength(2);
    // `prefix` breaks the CEL rule on purpose (routing.middleware-invalid); render would stop there
    expectValid(
      objects.filter((o) => o.metadata.name !== 'prefix'),
      stack,
    );
  });
});
