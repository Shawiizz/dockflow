import { describe, expect, test } from 'bun:test';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { MiddlewareSpec, PortSpec, RouteSpec } from '../../../services/orchestrator/kubernetes/model/types';
import {
  childPath,
  indexPath,
  type NormalizeContext,
  type NormalizeInput,
  type ServiceDraft,
} from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  collectMiddlewares,
  injectDefaultRoutes,
  type MiddlewareLabel,
  ROUTING_CODES,
  routingLabels,
  walkMiddlewareLabels,
} from '../../../services/orchestrator/kubernetes/normalize/routing';
import { type CrdPropertyNode, MIDDLEWARE_SCHEMA } from '../../../services/orchestrator/kubernetes/traefik-crd-schema.generated';
import { canonicalJson } from '../../../utils/hash';
import { type NormalizeInputOverrides, normalizeContext, serviceDraft } from '../support/builders';

type ProxyConfig = NonNullable<NormalizeInput['proxy']>;

const ACME: ProxyConfig = { enabled: true, acme: true, email: 'ops@example.com', domains: { production: 'shop.example.com' } };
const HTTP: ProxyConfig = { enabled: true, acme: false, domains: { production: 'shop.example.com' } };
const NO_DOMAIN: ProxyConfig = { enabled: true, acme: true, email: 'ops@example.com' };

const R = 'traefik.http.routers.';
const S = 'traefik.http.services.';
const M = 'traefik.http.middlewares.';
const ENABLE = { 'traefik.enable': 'true' };

/** every diagnostic any test produced: the catalogue checks at the end of the file read it */
const reported: Diagnostic[] = [];

interface ServiceSpec {
  labels?: Record<string, string>;
  deploy?: Record<string, string>;
  /** `ports` entries as written (the injection trigger) */
  rawPorts?: unknown[];
  /** target ports as ports.ts stores them */
  ports?: number[];
  expose?: number[];
}

function portSpec(target: number, path: string): PortSpec {
  return { target, published: null, protocol: 'TCP', mode: 'ingress', hostIp: null, name: null, appProtocol: null, path };
}

/** A draft as identity.ts and ports.ts leave it for routing.ts. */
function service(ctx: NormalizeContext, key: string, spec: ServiceSpec = {}): ServiceDraft {
  const d = serviceDraft(key, ctx);
  const labelsPath = childPath(d.path, 'labels');
  for (const [k, value] of Object.entries(spec.labels ?? {})) {
    d.routingLabels.push({ key: k, value, path: childPath(labelsPath, k), source: 'labels' });
  }
  const deployPath = childPath(childPath(d.path, 'deploy'), 'labels');
  for (const [k, value] of Object.entries(spec.deploy ?? {})) {
    d.routingLabels.push({ key: k, value, path: childPath(deployPath, k), source: 'deploy.labels' });
  }
  d.rawPorts = [...(spec.rawPorts ?? [])];
  d.ports = (spec.ports ?? []).map((target, i) => portSpec(target, indexPath(childPath(d.path, 'ports'), i)));
  d.expose = (spec.expose ?? []).map((target, i) => ({ target, protocol: 'TCP', path: indexPath(childPath(d.path, 'expose'), i) }));
  return d;
}

/** Proxy enabled with ACME and a domain, role app, unless overridden. */
function context(overrides: NormalizeInputOverrides = {}): NormalizeContext {
  return normalizeContext({ proxy: ACME, ...overrides });
}

/** The three steps in normalizeStack order. */
function run(ctx: NormalizeContext, drafts: ServiceDraft[]): MiddlewareSpec[] {
  for (const d of drafts) routingLabels(d, ctx);
  const middlewares = collectMiddlewares(drafts, ctx);
  injectDefaultRoutes(drafts, ctx);
  return middlewares;
}

function diagnostics(ctx: NormalizeContext): Diagnostic[] {
  const list = ctx.sink.list();
  reported.push(...list);
  return list;
}

function codes(ctx: NormalizeContext): string[] {
  return diagnostics(ctx).map((d) => d.code);
}

function one(ctx: NormalizeContext, code: string): Diagnostic {
  const found = diagnostics(ctx).filter((d) => d.code === code);
  expect(found.map((d) => d.code)).toEqual([code]);
  return found[0];
}

/** One service `web` with traefik.enable=true and the given deploy.labels; returns its draft. */
function single(labels: Record<string, string>, overrides: NormalizeInputOverrides = {}, spec: ServiceSpec = {}) {
  const ctx = context(overrides);
  const d = service(ctx, 'web', { ...spec, deploy: { ...ENABLE, ...labels } });
  const middlewares = run(ctx, [d]);
  return { ctx, d, middlewares };
}

/** The single middleware built from `traefik.http.middlewares.<labels>` on service `web`. */
function middleware(labels: Record<string, string>, overrides: NormalizeInputOverrides = {}) {
  const prefixed = Object.fromEntries(Object.entries(labels).map(([k, v]) => [`${M}${k}`, v]));
  return single(prefixed, overrides);
}

function deployPath(key: string, label: string): string {
  return childPath(`services.${key}.deploy.labels`, label);
}

// ---------------------------------------------------------------------------
// 7.1 collection and gates
// ---------------------------------------------------------------------------

describe('collection and gates (design-01 7.1)', () => {
  test('RT-01 traefik.enable that is not a boolean is values.invalid-boolean', () => {
    const { ctx, d } = single({ 'traefik.enable': 'maybe' });
    const diag = one(ctx, 'values.invalid-boolean');
    expect(diag).toEqual({
      severity: 'error',
      code: 'values.invalid-boolean',
      path: deployPath('web', 'traefik.enable'),
      message: 'expected true or false, got maybe',
      hint: 'Write `true` or `false`.',
    });
    expect(d.routingEnable).toBeNull();
  });

  test('traefik.enable is read with Go ParseBool, like Traefik on Swarm', () => {
    for (const [value, expected] of [
      ['true', true],
      ['True', true],
      ['TRUE', true],
      ['1', true],
      ['t', true],
      ['false', false],
      ['0', false],
      ['F', false],
    ] as const) {
      const { d } = single({ 'traefik.enable': value });
      expect(d.routingEnable).toBe(expected);
    }
    const { ctx, d } = single({ 'traefik.enable': 'yes' });
    expect(d.routingEnable).toBeNull();
    expect(codes(ctx)).toEqual(['values.invalid-boolean']);
  });

  test('RT-12 proxy disabled: one routing.proxy-disabled warning and nothing parsed, for both roles', () => {
    for (const role of ['app', 'accessory'] as const) {
      const ctx = context({ proxy: undefined, role });
      const d = service(ctx, 'web', {
        rawPorts: ['8080:3000'],
        ports: [3000],
        deploy: {
          'traefik.enable': 'maybe',
          [`${R}api.rule`]: 'Host(`api.example.com`)',
          [`${R}api.entrypoints`]: 'admin',
          [`${M}strip.stripprefixx.prefixes`]: '/a',
          'traefik.tcp.routers.x.rule': 'HostSNI(`*`)',
        },
      });
      const middlewares = run(ctx, [d]);
      expect(middlewares).toEqual([]);
      expect(d.routes).toEqual([]);
      expect(diagnostics(ctx)).toEqual([
        {
          severity: 'warning',
          code: 'routing.proxy-disabled',
          path: 'services.web',
          message: 'Traefik labels have no effect because proxy.enabled is false',
          hint: 'Set `proxy.enabled: true` in config.yml, or remove the labels.',
        },
      ]);
    }
  });

  test('the written traefik.enable is recorded even when the proxy is disabled', () => {
    const ctx = context({ proxy: { enabled: false } });
    const d = service(ctx, 'web', { deploy: { 'traefik.enable': 'false' } });
    run(ctx, [d]);
    expect(d.routingEnable).toBe(false);
  });

  test('RT-13 router labels without traefik.enable and without an injected route: routing.not-enabled', () => {
    const ctx = context();
    const d = service(ctx, 'web', { deploy: { [`${R}api.rule`]: 'Host(`api.example.com`)', [`${R}api.entrypoints`]: 'admin' } });
    run(ctx, [d]);
    expect(d.routes).toEqual([]);
    expect(diagnostics(ctx)).toEqual([
      {
        severity: 'warning',
        code: 'routing.not-enabled',
        path: 'services.web',
        message: 'Traefik labels are ignored because traefik.enable is not true (they are ignored on Swarm too)',
        hint: 'Add `traefik.enable=true` to `deploy.labels`.',
      },
    ]);
  });

  test('traefik.enable=false alone reports nothing; with other labels it reports routing.not-enabled', () => {
    const quiet = context();
    run(quiet, [service(quiet, 'web', { deploy: { 'traefik.enable': 'false' } })]);
    expect(codes(quiet)).toEqual([]);
    const ctx = context();
    run(ctx, [service(ctx, 'web', { deploy: { 'traefik.enable': 'false', [`${M}strip.stripprefix.prefixes`]: '/a' } })]);
    expect(codes(ctx)).toEqual(['routing.not-enabled']);
  });

  test('an accessory needs traefik.enable=true: no route is injected for it', () => {
    const ctx = context({ role: 'accessory' });
    run(ctx, [service(ctx, 'db', { rawPorts: ['5432:5432'], ports: [5432], deploy: { [`${R}db.rule`]: 'Host(`db.example.com`)' } })]);
    expect(codes(ctx)).toEqual(['routing.not-enabled']);
  });

  test('labels in `labels` are honoured with routing.container-labels; deploy.labels win per key (LBL-07)', () => {
    const ctx = context();
    const d = service(ctx, 'web', {
      ports: [3000],
      labels: { 'traefik.enable': 'false', [`${R}web.rule`]: 'Host(`web.example.com`)' },
      deploy: { 'traefik.enable': 'true' },
    });
    run(ctx, [d]);
    expect(d.routingEnable).toBe(true);
    expect(d.routes.map((r) => [r.router, r.rule, r.path])).toEqual([
      ['web', 'Host(`web.example.com`)', 'services.web.labels["traefik.http.routers.web.rule"]'],
    ]);
    expect(diagnostics(ctx)).toEqual([
      {
        severity: 'info',
        code: 'routing.container-labels',
        path: 'services.web.labels',
        message: 'Traefik labels in labels are used on Kubernetes; on Swarm Traefik only reads deploy.labels',
      },
    ]);
  });

  test('a value written in labels and deploy.labels under one key is one label, deploy.labels winning', () => {
    const ctx = context();
    const d = service(ctx, 'web', {
      ports: [3000],
      labels: { [`${R}web.rule`]: 'Host(`old.example.com`)' },
      deploy: { ...ENABLE, [`${R}web.rule`]: 'Host(`new.example.com`)' },
    });
    run(ctx, [d]);
    expect(d.routes.map((r) => r.rule)).toEqual(['Host(`new.example.com`)']);
    expect(codes(ctx)).toEqual([]);
  });

  test('the traefik prefix and field segments match case-insensitively; names keep their case', () => {
    const { ctx, d } = single({ 'Traefik.Http.Routers.Api.RULE': 'Host(`api.example.com`)' }, {}, { ports: [8080] });
    expect(d.routes.map((r) => [r.router, r.rule, r.port])).toEqual([['Api', 'Host(`api.example.com`)', 8080]]);
    expect(codes(ctx)).toEqual([]);
  });

  test('RT-02 Swarm provider keys are ignored with info; TCP/UDP and unknown keys are refused', () => {
    const { ctx } = single({
      'traefik.docker.network': 'traefik-public',
      'traefik.swarm.lbswarm': 'true',
      'traefik.tcp.routers.x.rule': 'HostSNI(`*`)',
      'traefik.udp.services.x.loadbalancer.server.port': '53',
      'traefik.foo': 'bar',
      'traefik.http.serverstransports.st.insecureskipverify': 'true',
      'traefik.tls.stores.default.defaultcertificate.certfile': '/c.pem',
      'traefik.http.routers.api': 'x',
    });
    const list = diagnostics(ctx);
    expect(list.map((d) => [d.severity, d.code, d.path])).toEqual([
      ['info', 'routing.swarm-label-ignored', deployPath('web', 'traefik.docker.network')],
      ['error', 'routing.unsupported-label', deployPath('web', 'traefik.foo')],
      ['error', 'routing.unsupported-label', deployPath('web', 'traefik.http.routers.api')],
      ['error', 'routing.unsupported-label', deployPath('web', 'traefik.http.serverstransports.st.insecureskipverify')],
      ['info', 'routing.swarm-label-ignored', deployPath('web', 'traefik.swarm.lbswarm')],
      ['error', 'routing.tcp-udp-unsupported', deployPath('web', 'traefik.tcp.routers.x.rule')],
      ['error', 'routing.unsupported-label', deployPath('web', 'traefik.tls.stores.default.defaultcertificate.certfile')],
      ['error', 'routing.tcp-udp-unsupported', deployPath('web', 'traefik.udp.services.x.loadbalancer.server.port')],
    ]);
    expect(list[0].message).toBe("traefik.docker.network only applies to Traefik's Swarm provider and is ignored");
    expect(list[1]).toMatchObject({
      message: 'traefik.foo is not a supported Traefik label',
      hint: 'Use a supported label: routers (`rule`, `entrypoints`, `middlewares`, `service`, `priority`, `tls`, `tls.certresolver`), services (`loadbalancer.server.port`) and middlewares.',
    });
    expect(list[5]).toMatchObject({ message: 'TCP and UDP routers are not supported', hint: 'Publish the port with `ports:` instead.' });
  });

  test('a service already marked fatal is skipped', () => {
    const ctx = context();
    const d = service(ctx, 'web', { deploy: { ...ENABLE, [`${R}api.rule`]: '' } });
    ctx.markFatal('services.web');
    run(ctx, [d]);
    expect(codes(ctx)).toEqual([]);
  });

  test('routingLabels is idempotent', () => {
    const ctx = context();
    const d = service(ctx, 'web', { ports: [8080], deploy: { ...ENABLE, [`${R}api.rule`]: 'Host(`api.example.com`)' } });
    routingLabels(d, ctx);
    routingLabels(d, ctx);
    collectMiddlewares([d], ctx);
    injectDefaultRoutes([d], ctx);
    expect(d.routes.map((r) => r.router)).toEqual(['api']);
  });
});

// ---------------------------------------------------------------------------
// 7.2 routers
// ---------------------------------------------------------------------------

describe('routers (design-01 7.2)', () => {
  test('N-RT-06 label routers become RouteSpecs sorted by router, middlewares in declaration order', () => {
    const ctx = context();
    const d = service(ctx, 'web', {
      ports: [8080],
      deploy: {
        ...ENABLE,
        [`${R}api.rule`]: 'Host(`api.example.com`)',
        [`${R}api.entrypoints`]: 'websecure',
        [`${R}api.middlewares`]: 'strip,auth',
        [`${R}api.priority`]: '10',
        [`${R}admin.rule`]: 'Host(`admin.example.com`)',
        [`${M}strip.stripprefix.prefixes`]: '/api',
        [`${M}auth.redirectscheme.scheme`]: 'https',
      },
    });
    run(ctx, [d]);
    expect(d.routes).toEqual([
      {
        router: 'admin',
        rule: 'Host(`admin.example.com`)',
        entryPoints: ['websecure'],
        tls: null,
        middlewares: [],
        priority: null,
        port: 8080,
        origin: 'labels',
        path: deployPath('web', `${R}admin.rule`),
      },
      {
        router: 'api',
        rule: 'Host(`api.example.com`)',
        entryPoints: ['websecure'],
        tls: null,
        middlewares: ['strip', 'auth'],
        priority: 10,
        port: 8080,
        origin: 'labels',
        path: deployPath('web', `${R}api.rule`),
      },
    ] satisfies RouteSpec[]);
    expect(codes(ctx)).toEqual([]);
  });

  test('RT-03 rule: missing, empty, v2 syntax; ruleSyntax v2 refused and v3 silent', () => {
    const missing = single({ [`${R}api.entrypoints`]: 'websecure' }, {}, { ports: [80] });
    expect(one(missing.ctx, 'routing.missing-rule')).toEqual({
      severity: 'error',
      code: 'routing.missing-rule',
      path: deployPath('web', `${R}api.entrypoints`),
      message: 'router api has no rule',
      hint: 'Add traefik.http.routers.api.rule=Host(`app.example.com`).',
    });
    expect(missing.d.routes).toEqual([]);

    const empty = single({ [`${R}api.rule`]: '' }, {}, { ports: [80] });
    expect(one(empty.ctx, 'values.empty')).toMatchObject({ path: deployPath('web', `${R}api.rule`), message: 'must not be empty' });

    const v2 = single({ [`${R}api.rule`]: 'HostRegexp(`{sub:[a-z]+}.example.com`)' }, {}, { ports: [80] });
    expect(one(v2.ctx, 'routing.v2-rule')).toMatchObject({
      path: deployPath('web', `${R}api.rule`),
      message: 'router api uses the Traefik v2 rule syntax {name:regexp}',
      hint: 'Use the Traefik v3 syntax, for example HostRegexp(`^[a-z]+\\.example\\.com$`).',
    });

    const syntax = single({ [`${R}api.rule`]: 'Host(`a.example.com`)', [`${R}api.rulesyntax`]: 'v2' }, {}, { ports: [80] });
    expect(one(syntax.ctx, 'routing.v2-rule')).toMatchObject({
      path: deployPath('web', `${R}api.rulesyntax`),
      message: 'ruleSyntax v2 is deprecated in Traefik v3 and not supported by Dockflow',
      hint: 'Remove `ruleSyntax` and rewrite the rule with the v3 syntax.',
    });
    expect(syntax.d.routes).toEqual([]);

    const v3 = single({ [`${R}api.rule`]: 'Host(`a.example.com`)', [`${R}api.ruleSyntax`]: 'v3' }, {}, { ports: [80] });
    expect(codes(v3.ctx)).toEqual([]);
    expect(v3.d.routes).toHaveLength(1);
  });

  test('RT-04 entry points: sorted unique, web and websecure only, PD-6 warnings', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    const acme = single({ ...rule, [`${R}api.entrypoints`]: 'websecure,web,web' }, {}, { ports: [80] });
    expect(acme.d.routes[0].entryPoints).toEqual(['web', 'websecure']);
    expect(one(acme.ctx, 'routing.web-served-with-acme')).toEqual({
      severity: 'warning',
      code: 'routing.web-served-with-acme',
      path: deployPath('web', `${R}api.entrypoints`),
      message: 'router api is served over plain HTTP on web; on Swarm the HTTPS redirect shadowed it',
      hint: 'Remove `web` from its entry points to keep the redirect.',
    });

    const http = single({ ...rule, [`${R}api.entrypoints`]: 'websecure,web,web' }, { proxy: HTTP }, { ports: [80] });
    expect(http.d.routes[0].entryPoints).toEqual(['web', 'websecure']);
    expect(one(http.ctx, 'routing.entrypoint-not-exposed')).toEqual({
      severity: 'warning',
      code: 'routing.entrypoint-not-exposed',
      path: deployPath('web', `${R}api.entrypoints`),
      message: 'websecure is not reachable from outside when proxy.acme is false',
      hint: 'Set `proxy.acme: true` in config.yml to publish 443 and request certificates, or route this router through `web`.',
    });

    const unknown = single({ ...rule, [`${R}api.entrypoints`]: 'web,admin' }, {}, { ports: [80] });
    expect(one(unknown.ctx, 'routing.unknown-entrypoint')).toMatchObject({
      message: "entrypoint admin does not exist on Dockflow's Traefik (it defines web and websecure)",
      hint: 'Use `web` or `websecure`.',
    });
    expect(unknown.d.routes).toEqual([]);

    const secure = single({ ...rule, [`${R}api.entrypoints`]: 'websecure' }, {}, { ports: [80] });
    expect(secure.d.routes[0].entryPoints).toEqual(['websecure']);
    expect(codes(secure.ctx)).toEqual([]);
  });

  test('PD-6: a router without entrypoints gets [websecure] under ACME and [] without', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    expect(single(rule, {}, { ports: [80] }).d.routes[0].entryPoints).toEqual(['websecure']);
    expect(single(rule, { proxy: HTTP }, { ports: [80] }).d.routes[0].entryPoints).toEqual([]);
    const accessory = single(rule, { role: 'accessory' }, { ports: [80] });
    expect(accessory.d.routes[0].entryPoints).toEqual(['websecure']);
  });

  test('RT-05 middleware references: provider suffixes, other providers, undefined names', () => {
    const defs = { [`${M}auth.redirectscheme.scheme`]: 'https', [`${M}strip.stripprefix.prefixes`]: '/api' };
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    const ok = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'auth@docker,strip' }, {}, { ports: [80] });
    expect(ok.d.routes[0].middlewares).toEqual(['auth', 'strip']);
    expect(codes(ok.ctx)).toEqual([]);

    const suffixes = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'auth@swarm,strip@kubernetescrd,auth@docker' }, {}, { ports: [80] });
    expect(suffixes.d.routes[0].middlewares).toEqual(['auth', 'strip', 'auth']);
    expect(codes(suffixes.ctx)).toEqual([]);

    const file = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'x@file' }, {}, { ports: [80] });
    expect(one(file.ctx, 'routing.middleware-provider')).toEqual({
      severity: 'error',
      code: 'routing.middleware-provider',
      path: deployPath('web', `${R}api.middlewares`),
      message: "middleware x comes from the file provider, which Dockflow's Traefik does not load",
      hint: 'Define the middleware with `traefik.http.middlewares` labels instead.',
    });
    expect(file.d.routes).toEqual([]);

    const ghost = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'strip,ghost' }, {}, { ports: [80] });
    expect(one(ghost.ctx, 'routing.unknown-middleware')).toEqual({
      severity: 'error',
      code: 'routing.unknown-middleware',
      path: deployPath('web', `${R}api.middlewares`),
      message: 'middleware ghost is not defined by any service of this stack',
      hint: 'Define it with `traefik.http.middlewares.ghost.<type>...` on a service of this stack.',
    });
  });

  test('RT-05 a middleware of the sibling role or of another service of the file resolves (SC-08)', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)', [`${R}api.middlewares`]: 'auth,shared' };
    const ctx = context({ sibling: { middlewares: ['shared'] } });
    const api = service(ctx, 'api', { ports: [80], deploy: { ...ENABLE, ...rule } });
    const other = service(ctx, 'other', { deploy: { ...ENABLE, [`${M}auth.redirectscheme.scheme`]: 'https' } });
    const middlewares = run(ctx, [api, other]);
    expect(api.routes[0].middlewares).toEqual(['auth', 'shared']);
    expect(middlewares.map((m) => m.name)).toEqual(['auth']);
    expect(codes(ctx)).toEqual([]);
  });

  test('RT-05 kubernetescrd: the stack namespace prefix is removed, another namespace is refused', () => {
    const defs = { [`${M}auth.redirectscheme.scheme`]: 'https' };
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    const own = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'dockflow-shop-production-auth@kubernetescrd' }, {}, { ports: [80] });
    expect(own.d.routes[0].middlewares).toEqual(['auth']);
    expect(codes(own.ctx)).toEqual([]);

    const other = single({ ...defs, ...rule, [`${R}api.middlewares`]: 'monitoring-auth@kubernetescrd' }, {}, { ports: [80] });
    expect(one(other.ctx, 'routing.middleware-provider').message).toBe(
      "middleware monitoring-auth names a middleware of another namespace through the kubernetescrd provider, which Dockflow's Traefik does not allow",
    );
  });

  test('RT-05 references use the sanitized middleware name', () => {
    const { ctx, d } = single(
      { [`${M}My_Auth.redirectscheme.scheme`]: 'https', [`${R}api.rule`]: 'Host(`api.example.com`)', [`${R}api.middlewares`]: 'My_Auth' },
      {},
      { ports: [80] },
    );
    expect(d.routes[0].middlewares).toEqual(['my-auth']);
    expect(codes(ctx)).toEqual(['names.middleware-sanitized']);
  });

  test('RT-07 priority: a whole number >= 0, else values.invalid-integer', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    expect(single({ ...rule, [`${R}api.priority`]: '10' }, {}, { ports: [80] }).d.routes[0].priority).toBe(10);
    expect(single({ ...rule, [`${R}api.priority`]: '0' }, {}, { ports: [80] }).d.routes[0].priority).toBe(0);
    for (const value of ['high', '-1', '1.5']) {
      const bad = single({ ...rule, [`${R}api.priority`]: value }, {}, { ports: [80] });
      expect(one(bad.ctx, 'values.invalid-integer')).toMatchObject({
        path: deployPath('web', `${R}api.priority`),
        message: `expected an integer between 0 and ${Number.MAX_SAFE_INTEGER}, got ${value}`,
        hint: 'Write a whole number.',
      });
      expect(bad.d.routes).toEqual([]);
    }
  });

  test('RT-08 tls, cert resolvers against proxy.acme, tls.domains and tls.options', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    expect(single({ ...rule, [`${R}api.tls`]: 'true' }, {}, { ports: [80] }).d.routes[0].tls).toEqual({ certResolver: null });
    expect(single({ ...rule, [`${R}api.tls`]: 'false' }, {}, { ports: [80] }).d.routes[0].tls).toBeNull();

    const resolver = single({ ...rule, [`${R}api.tls.certresolver`]: 'letsencrypt' }, {}, { ports: [80] });
    expect(resolver.d.routes[0].tls).toEqual({ certResolver: 'letsencrypt' });
    expect(codes(resolver.ctx)).toEqual([]);

    const noAcme = single({ ...rule, [`${R}api.tls.certresolver`]: 'letsencrypt' }, { proxy: HTTP }, { ports: [80] });
    expect(one(noAcme.ctx, 'routing.unknown-certresolver')).toEqual({
      severity: 'error',
      code: 'routing.unknown-certresolver',
      path: deployPath('web', `${R}api.tls.certresolver`),
      message: "certificate resolver letsencrypt is not configured on Dockflow's Traefik (proxy.acme is false, so no resolver is configured)",
      hint: 'Remove `tls.certresolver`, or set `proxy.acme: true` in config.yml.',
    });
    expect(noAcme.d.routes).toEqual([]);

    const zerossl = single({ ...rule, [`${R}api.tls.certresolver`]: 'zerossl' }, {}, { ports: [80] });
    expect(one(zerossl.ctx, 'routing.unknown-certresolver').message).toBe(
      "certificate resolver zerossl is not configured on Dockflow's Traefik (it provides letsencrypt)",
    );

    const domains = single({ ...rule, [`${R}api.tls.domains[0].main`]: 'example.com', [`${R}api.tls.domains[0].sans`]: 'www.example.com' }, {}, { ports: [80] });
    const warnings = diagnostics(domains.ctx);
    expect(warnings.map((w) => [w.severity, w.code])).toEqual([
      ['warning', 'routing.tls-domains-ignored'],
      ['warning', 'routing.tls-domains-ignored'],
    ]);
    expect(warnings[0].message).toBe('tls.domains is ignored: certificates are requested for the hosts of the rule');
    expect(domains.d.routes).toHaveLength(1);

    const options = single({ ...rule, [`${R}api.tls.options`]: 'modern' }, {}, { ports: [80] });
    expect(one(options.ctx, 'routing.tls-options-unsupported')).toMatchObject({
      severity: 'error',
      message: 'tls.options is not supported',
      hint: 'Remove `tls.options`; TLS options are not configurable in this Dockflow version.',
    });

    const flag = single({ ...rule, [`${R}api.tls`]: 'maybe' }, {}, { ports: [80] });
    expect(one(flag.ctx, 'values.invalid-boolean').path).toBe(deployPath('web', `${R}api.tls`));
  });

  test('RT-09 observability is ignored, unknown router fields refused, one router name per role', () => {
    const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };
    const observed = single({ ...rule, [`${R}api.observability.accesslogs`]: 'false' }, {}, { ports: [80] });
    expect(one(observed.ctx, 'routing.option-ignored')).toMatchObject({
      severity: 'warning',
      message: `${R}api.observability.accesslogs is ignored`,
    });
    expect(observed.d.routes).toHaveLength(1);

    const foo = single({ [`${R}r.foo`]: '1' }, {}, { ports: [80] });
    expect(codes(foo.ctx)).toEqual(['routing.unsupported-label']);

    const ctx = context();
    const api = service(ctx, 'api', { ports: [80], deploy: { ...ENABLE, ...rule } });
    const web = service(ctx, 'web', { ports: [80], deploy: { ...ENABLE, ...rule } });
    run(ctx, [api, web]);
    expect(one(ctx, 'routing.duplicate-router')).toEqual({
      severity: 'error',
      code: 'routing.duplicate-router',
      path: deployPath('web', `${R}api.rule`),
      message: 'router api is also defined by api',
      hint: 'Give each router a unique name.',
    });
  });
});

// ---------------------------------------------------------------------------
// 7.3 services and 7.6 port resolution
// ---------------------------------------------------------------------------

describe('Traefik services (design-01 7.3) and route ports (7.6)', () => {
  const rule = { [`${R}api.rule`]: 'Host(`api.example.com`)' };

  test('RT-06 an explicit service link takes its loadbalancer port', () => {
    const { ctx, d } = single({ ...rule, [`${R}api.service`]: 'api', [`${S}api.loadbalancer.server.port`]: '8080' }, {}, { ports: [80, 443] });
    expect(d.routes[0].port).toBe(8080);
    expect(codes(ctx)).toEqual([]);
  });

  test('RT-10 a single service group is linked implicitly', () => {
    const { ctx, d } = single({ ...rule, [`${S}backend.loadbalancer.server.port`]: '3000' });
    expect(d.routes[0].port).toBe(3000);
    expect(codes(ctx)).toEqual([]);
  });

  test('without a port label the only container port is used, ports and expose together', () => {
    expect(single(rule, {}, { ports: [3000] }).d.routes[0].port).toBe(3000);
    expect(single(rule, {}, { expose: [9000] }).d.routes[0].port).toBe(9000);
    expect(single(rule, {}, { ports: [9000], expose: [9000] }).d.routes[0].port).toBe(9000);
    const unported = single({ ...rule, [`${S}api.loadbalancer.sticky.cookie.name`]: 'sid' }, {}, { ports: [3000] });
    expect(unported.d.routes[0].port).toBe(3000);
  });

  test('RT-20 internal and unknown Traefik services; an ambiguous or missing port', () => {
    const internal = single({ ...rule, [`${R}api.service`]: 'api@internal' }, {}, { ports: [80] });
    expect(one(internal.ctx, 'routing.internal-service')).toEqual({
      severity: 'error',
      code: 'routing.internal-service',
      path: deployPath('web', `${R}api.service`),
      message: 'router api uses the Traefik service api@internal, which Dockflow does not expose this way',
      hint: 'Use `proxy.dashboard` in config.yml for the Traefik dashboard.',
    });

    const ghost = single({ ...rule, [`${R}api.service`]: 'ghost' }, {}, { ports: [80] });
    expect(one(ghost.ctx, 'routing.unknown-service')).toMatchObject({
      message: 'router api uses service ghost, which is not defined in the labels of this service',
      hint: 'Define `traefik.http.services.ghost.loadbalancer.server.port` on the same service.',
    });

    const ctx = context({ role: 'accessory' });
    const d = service(ctx, 'web', { rawPorts: ['8080:80', '8443:443'], ports: [443, 80], deploy: { ...ENABLE, ...rule } });
    run(ctx, [d]);
    expect(one(ctx, 'routing.port-ambiguous')).toEqual({
      severity: 'error',
      code: 'routing.port-ambiguous',
      path: deployPath('web', `${R}api.rule`),
      message: 'router api needs a port: web declares several ports (80, 443)',
      hint: 'Add `traefik.http.services.api.loadbalancer.server.port=<port>`.',
    });
    expect(d.routes).toEqual([]);

    const none = single(rule);
    expect(one(none.ctx, 'routing.port-ambiguous').message).toBe('router api needs a port: web declares no port');
  });

  test('RT-11 backend options: scheme, passhostheader, sticky, health checks, unsupported fields', () => {
    const cases: [string, string, string | null][] = [
      ['loadbalancer.server.scheme', 'http', null],
      ['loadbalancer.server.scheme', 'https', 'routing.backend-scheme-unsupported'],
      ['loadbalancer.server.scheme', 'h2c', 'routing.backend-scheme-unsupported'],
      ['loadbalancer.passhostheader', 'true', null],
      ['loadbalancer.passhostheader', 'false', 'routing.option-ignored'],
      ['loadbalancer.passhostheader', 'maybe', 'values.invalid-boolean'],
      ['loadbalancer.sticky.cookie.name', 'sid', 'routing.option-ignored'],
      ['loadbalancer.responseforwarding.flushinterval', '100ms', 'routing.option-ignored'],
      ['loadbalancer.strategy', 'p2c', 'routing.option-ignored'],
      ['loadbalancer.healthcheck.path', '/h', 'routing.healthcheck-ignored'],
      ['loadbalancer.serverstransport', 'x', 'routing.unsupported-label'],
      ['loadbalancer.server.url', 'http://x', 'routing.unsupported-label'],
      ['loadbalancer.server.port', '99999', 'values.invalid-integer'],
    ];
    for (const [field, value, code] of cases) {
      const { ctx } = single({ ...rule, [`${S}api.loadbalancer.server.port`]: '80', [`${S}api.${field}`]: value });
      expect([field, value, codes(ctx)]).toEqual([field, value, code === null ? [] : [code]]);
    }
    const scheme = single({ ...rule, [`${S}api.loadbalancer.server.port`]: '80', [`${S}api.loadbalancer.server.scheme`]: 'https' });
    expect(one(scheme.ctx, 'routing.backend-scheme-unsupported')).toMatchObject({
      message: 'backend scheme https is not supported: Traefik talks plain HTTP to services',
      hint: 'Serve plain HTTP on the routed port.',
    });
    const health = single({ ...rule, [`${S}api.loadbalancer.server.port`]: '80', [`${S}api.loadbalancer.healthcheck.path`]: '/h' });
    expect(one(health.ctx, 'routing.healthcheck-ignored').message).toBe(
      'Traefik health checks are ignored: Kubernetes only routes to Ready pods (see healthcheck)',
    );
    const port = single({ ...rule, [`${S}api.loadbalancer.server.port`]: 'http' }, {}, { ports: [80] });
    expect(one(port.ctx, 'values.invalid-integer').message).toBe('expected an integer between 1 and 65535, got http');
    expect(port.d.routes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7.5 injected default routes
// ---------------------------------------------------------------------------

describe('injected default routes (design-01 7.5)', () => {
  test('RT-14 an app service with ports gets the injected route of the domain', () => {
    const ctx = context();
    const d = service(ctx, 'web', { rawPorts: ['8080:3000'], ports: [3000] });
    run(ctx, [d]);
    expect(d.routes).toEqual([
      {
        router: 'shop-production-web',
        rule: 'Host(`shop.example.com`)',
        entryPoints: ['websecure'],
        tls: { certResolver: 'letsencrypt' },
        middlewares: [],
        priority: null,
        port: 3000,
        origin: 'injected',
        path: 'services.web.ports',
      },
    ]);
    expect(codes(ctx)).toEqual([]);
  });

  test('ACME off injects on web without TLS; no domain injects nothing', () => {
    const ctx = context({ proxy: HTTP });
    const d = service(ctx, 'web', { rawPorts: ['8080:80'], ports: [80] });
    run(ctx, [d]);
    expect(d.routes.map((r) => [r.entryPoints, r.tls, r.port])).toEqual([[['web'], null, 80]]);

    const bare = context({ proxy: NO_DOMAIN });
    const b = service(bare, 'web', { rawPorts: ['8080:80'], ports: [80] });
    run(bare, [b]);
    expect(b.routes).toEqual([]);
    expect(codes(bare)).toEqual([]);
  });

  test('the injected port is the container port of the first entry as written', () => {
    const cases: [unknown, number][] = [
      ['127.0.0.1:8080:3000/tcp', 3000],
      ['3000-3002:3000-3002', 3000],
      ['3000', 3000],
      [3000, 3000],
      [{ target: 3000, published: 8080 }, 3000],
      [{ target: '4000' }, 4000],
      ['[::1]:8080:80', 80],
    ];
    for (const [entry, port] of cases) {
      const ctx = context();
      const d = service(ctx, 'web', { rawPorts: [entry], ports: [port] });
      run(ctx, [d]);
      expect([entry, d.routes.map((r) => r.port)]).toEqual([entry, [port]]);
    }
  });

  test('RT-15 several ports: the first one is routed, with routing.injected-first-port', () => {
    const ctx = context();
    const d = service(ctx, 'web', { rawPorts: [{ target: 3000, published: 8080 }, '9000:9000'], ports: [3000, 9000] });
    run(ctx, [d]);
    expect(d.routes.map((r) => r.port)).toEqual([3000]);
    expect(one(ctx, 'routing.injected-first-port')).toEqual({
      severity: 'warning',
      code: 'routing.injected-first-port',
      path: 'services.web.ports',
      message: 'only the first port (3000) is routed through Traefik',
      hint: 'Add router labels to route another port.',
    });
  });

  test('RT-16 traefik.enable=false opts out of injection (C4), with info', () => {
    const ctx = context();
    const d = service(ctx, 'web', { rawPorts: ['8080:3000'], ports: [3000], deploy: { 'traefik.enable': 'false' } });
    run(ctx, [d]);
    expect(d.routes).toEqual([]);
    expect(diagnostics(ctx)).toEqual([
      { severity: 'info', code: 'routing.injection-disabled', path: 'services.web', message: 'traefik.enable=false: no default route is injected' },
    ]);
  });

  test('RT-17 labels of the injected router override it field by field (C4)', () => {
    const ctx = context();
    const d = service(ctx, 'web', {
      rawPorts: ['8080:3000'],
      ports: [3000],
      deploy: { [`${R}shop-production-web.rule`]: 'Host(`api.example.com`)' },
    });
    run(ctx, [d]);
    expect(d.routes).toEqual([
      {
        router: 'shop-production-web',
        rule: 'Host(`api.example.com`)',
        entryPoints: ['websecure'],
        tls: { certResolver: 'letsencrypt' },
        middlewares: [],
        priority: null,
        port: 3000,
        origin: 'labels',
        path: deployPath('web', `${R}shop-production-web.rule`),
      },
    ]);
    expect(codes(ctx)).toEqual([]);

    const partial = context();
    const p = service(partial, 'web', {
      rawPorts: ['8080:3000'],
      ports: [3000],
      deploy: { [`${R}shop-production-web.middlewares`]: 'strip', [`${M}strip.stripprefix.prefixes`]: '/api', [`${R}shop-production-web.priority`]: '5' },
    });
    run(partial, [p]);
    expect(p.routes.map((r) => [r.rule, r.middlewares, r.priority, r.origin])).toEqual([['Host(`shop.example.com`)', ['strip'], 5, 'labels']]);
    expect(codes(partial)).toEqual([]);
  });

  test('RT-18 two app services with ports share the host: both routes, a warning on each', () => {
    const ctx = context();
    const api = service(ctx, 'api', { rawPorts: ['8081:8080'], ports: [8080] });
    const web = service(ctx, 'web', { rawPorts: ['8080:3000'], ports: [3000] });
    run(ctx, [api, web]);
    expect([...api.routes, ...web.routes].map((r) => [r.router, r.origin])).toEqual([
      ['shop-production-api', 'injected'],
      ['shop-production-web', 'injected'],
    ]);
    expect(diagnostics(ctx)).toEqual(
      ['api', 'web'].map((key) => ({
        severity: 'warning',
        code: 'routing.duplicate-injected-host',
        path: `services.${key}`,
        message: `${key} and ${key === 'api' ? 'web' : 'api'} all get the injected route Host(\`shop.example.com\`); Traefik sends each request to one of them`,
        hint: 'Add `traefik.enable=false` to `deploy.labels` of the services that must not answer on shop.example.com, or give them their own router rule.',
      })),
    );
  });

  test('RT-19 an accessory never gets an injected route (role first, K02)', () => {
    const ctx = context({ role: 'accessory' });
    const d = service(ctx, 'postgres', { rawPorts: ['5432:5432'], ports: [5432] });
    run(ctx, [d]);
    expect(ctx.proxy).toMatchObject({ domain: null });
    expect(d.routes).toEqual([]);
    expect(codes(ctx)).toEqual([]);
  });

  test('explicit labels of an accessory are validated like the app (C4)', () => {
    for (const role of ['app', 'accessory'] as const) {
      const ctx = context({ role });
      const d = service(ctx, 'admin', {
        ports: [80],
        deploy: {
          ...ENABLE,
          [`${R}a.rule`]: 'Host(`a.example.com`)',
          [`${R}a.entrypoints`]: 'admin',
          [`${R}b.rule`]: 'Host(`b.example.com`)',
          [`${R}b.tls.certresolver`]: 'zerossl',
        },
      });
      run(ctx, [d]);
      expect([role, codes(ctx)]).toEqual([role, ['routing.unknown-entrypoint', 'routing.unknown-certresolver']]);
    }
  });

  test('a service with an injected route parses its labels without traefik.enable', () => {
    const ctx = context();
    const d = service(ctx, 'web', {
      rawPorts: ['8080:3000'],
      ports: [3000],
      deploy: { [`${R}api.rule`]: 'Host(`api.example.com`)', [`${M}strip.stripprefix.prefixes`]: '/a' },
    });
    const middlewares = run(ctx, [d]);
    expect(d.routes.map((r) => [r.router, r.origin])).toEqual([
      ['api', 'labels'],
      ['shop-production-web', 'injected'],
    ]);
    expect(middlewares.map((m) => m.name)).toEqual(['strip']);
    expect(codes(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7.4 middlewares (design-04 2.14.1)
// ---------------------------------------------------------------------------

describe('middlewares (design-01 7.4, design-04 2.14.1)', () => {
  test('MW-01 list option split on commas', () => {
    const { ctx, middlewares } = middleware({ 'strip.stripprefix.prefixes': '/api,/v1' });
    expect(middlewares).toEqual([
      {
        name: 'strip',
        spec: { stripPrefix: { prefixes: ['/api', '/v1'] } },
        users: null,
        errorsService: null,
        path: deployPath('web', `${M}strip.stripprefix.prefixes`),
      },
    ]);
    expect(codes(ctx)).toEqual([]);
  });

  test('MW-02 map keys kept as written, integers and booleans coerced', () => {
    const { ctx, middlewares } = middleware({
      'sec.headers.customrequestheaders.X-Script-Name': 'test',
      'sec.headers.stsseconds': '31536000',
      'sec.headers.framedeny': 'true',
    });
    expect(middlewares[0].spec).toEqual({ headers: { customRequestHeaders: { 'X-Script-Name': 'test' }, stsSeconds: 31536000, frameDeny: true } });
    expect(codes(ctx)).toEqual([]);
  });

  test('MW-03 renamed type, nested object, and no trimming of list elements', () => {
    const { middlewares } = middleware({ 'allow.ipallowlist.sourcerange': '10.0.0.0/8,192.168.0.0/16', 'allow.ipallowlist.ipstrategy.depth': '1' });
    expect(middlewares[0].spec).toEqual({ ipAllowList: { sourceRange: ['10.0.0.0/8', '192.168.0.0/16'], ipStrategy: { depth: 1 } } });
    const spaced = middleware({ 'allow.ipallowlist.sourcerange': '10.0.0.0/8, 192.168.0.0/16' });
    expect(spaced.middlewares[0].spec).toEqual({ ipAllowList: { sourceRange: ['10.0.0.0/8', ' 192.168.0.0/16'] } });
  });

  test('MW-04 integers and int-or-string durations', () => {
    const { ctx } = middleware({ 'limit.ratelimit.average': '100', 'limit.ratelimit.period': '1m', 'limit.ratelimit.burst': 'x' });
    expect(one(ctx, 'routing.middleware-option-type')).toEqual({
      severity: 'error',
      code: 'routing.middleware-option-type',
      path: deployPath('web', `${M}limit.ratelimit.burst`),
      message: 'ratelimit.burst expects a whole number, got "x"',
      hint: 'Write a whole number, without a unit.',
    });
    const ok = middleware({ 'limit.ratelimit.average': '100', 'limit.ratelimit.period': '1m' });
    expect(ok.middlewares[0].spec).toEqual({ rateLimit: { average: 100, period: '1m' } });
    expect(middleware({ 'limit.ratelimit.period': '60' }).middlewares[0].spec).toEqual({ rateLimit: { period: 60 } });
    expect(middleware({ 'limit.ratelimit.period': '1s' }).middlewares[0].spec).toEqual({ rateLimit: { period: '1s' } });
    expect(middleware({ 'limit.ratelimit.period': '500ms' }).middlewares[0].spec).toEqual({ rateLimit: { period: '500ms' } });
    const bad = middleware({ 'limit.ratelimit.period': '1x' });
    expect(one(bad.ctx, 'routing.middleware-option-type').message).toBe(
      'ratelimit.period expects a duration such as 10s or a whole number of seconds, got "1x"',
    );
  });

  test('MW-05 chain.middlewares is one comma list of defined names', () => {
    const defs = { 'strip.stripprefix.prefixes': '/a', 'sec.headers.framedeny': 'true' };
    const { ctx, middlewares } = middleware({ ...defs, 'both.chain.middlewares': 'strip,sec@swarm' });
    expect(middlewares.find((m) => m.name === 'both')?.spec).toEqual({ chain: { middlewares: [{ name: 'strip' }, { name: 'sec' }] } });
    expect(codes(ctx)).toEqual([]);

    const ghost = middleware({ ...defs, 'both.chain.middlewares': 'strip,ghost' });
    expect(one(ghost.ctx, 'routing.unknown-middleware')).toMatchObject({
      path: deployPath('web', `${M}both.chain.middlewares`),
      message: 'middleware ghost is not defined by any service of this stack',
    });
    expect(ghost.middlewares.map((m) => m.name)).toEqual(['sec', 'strip']);

    const indexed = middleware({ ...defs, 'both.chain.middlewares[0].name': 'strip' });
    expect(one(indexed.ctx, 'routing.middleware-option-unknown').hint).toBe(
      'Write the chain as one comma-separated label, for example `...chain.middlewares=a,b`.',
    );

    const provider = middleware({ ...defs, 'both.chain.middlewares': 'strip@file' });
    expect(codes(provider.ctx)).toEqual(['routing.middleware-provider']);
  });

  test('MW-06 plugin refused, ipwhitelist deprecated, CRD fields, Secret names passed through', () => {
    const plugin = middleware({ 'demo.plugin.x.y': '1' });
    expect(one(plugin.ctx, 'routing.middleware-plugin-unsupported')).toEqual({
      severity: 'error',
      code: 'routing.middleware-plugin-unsupported',
      path: deployPath('web', `${M}demo.plugin.x.y`),
      message: 'Traefik plugin middlewares cannot be configured from compose labels',
      hint: "Dockflow's Traefik runs without the experimental plugin configuration, so a plugin middleware would fail at runtime; declare it with a Helm release instead.",
    });
    expect(plugin.middlewares).toEqual([]);

    const white = middleware({ 'allow.ipwhitelist.sourcerange': '10.0.0.0/8' });
    expect(white.middlewares[0].spec).toEqual({ ipWhiteList: { sourceRange: ['10.0.0.0/8'] } });
    expect(one(white.ctx, 'routing.middleware-deprecated')).toMatchObject({
      severity: 'warning',
      message: 'middleware type ipWhiteList is deprecated in Traefik v3',
      hint: 'Use `ipallowlist` with the same options.',
    });

    const cert = middleware({ 'cert.passtlsclientcert.pem': 'true' });
    expect(cert.middlewares[0].spec).toEqual({ passTLSClientCert: { pem: true } });
    expect(codes(cert.ctx)).toEqual([]);

    const forward = middleware({ 'fa.forwardauth.address': 'http://auth:4181', 'fa.forwardauth.tls.certsecret': 'auth-cert' });
    expect(forward.middlewares[0].spec).toEqual({ forwardAuth: { address: 'http://auth:4181', tls: { certSecret: 'auth-cert' } } });
    expect(one(forward.ctx, 'routing.middleware-external-secret')).toEqual({
      severity: 'info',
      code: 'routing.middleware-external-secret',
      path: deployPath('web', `${M}fa.forwardauth.tls.certsecret`),
      message: 'middleware fa references the Secret auth-cert, which Dockflow does not manage',
    });
  });

  test('MW-07 unknown type with the five nearest names; unknown option', () => {
    const type = middleware({ 'm.stripprefixx.prefixes': '/a' });
    const diag = one(type.ctx, 'routing.middleware-unsupported');
    expect(diag.message).toBe('Traefik middleware type "stripprefixx" does not exist in Traefik v3.7.13');
    expect(diag.hint).toStartWith('Check the spelling; the nearest types are `stripPrefix`, ');
    expect(diag.hint?.match(/`[A-Za-z]+`/g)).toHaveLength(5);
    expect(diag.hint).not.toContain('`plugin`');

    const option = middleware({ 'm.stripprefix.prefix': '/v1' });
    expect(one(option.ctx, 'routing.middleware-option-unknown')).toEqual({
      severity: 'error',
      code: 'routing.middleware-option-unknown',
      path: deployPath('web', `${M}m.stripprefix.prefix`),
      message: 'stripprefix.prefix is not an option of the stripPrefix middleware',
      hint: 'Check the spelling; the closest options are `prefixes` and `forceSlash`.',
    });
  });

  test('MW-08 one type per middleware name', () => {
    const { ctx, middlewares } = middleware({ 'm.stripprefix.prefixes': '/a', 'm.addprefix.prefix': '/b' });
    expect(middlewares).toEqual([]);
    expect(one(ctx, 'routing.middleware-several-types')).toEqual({
      severity: 'error',
      code: 'routing.middleware-several-types',
      path: deployPath('web', `${M}m.stripprefix.prefixes`),
      message: 'middleware m mixes types addprefix and stripprefix',
      hint: 'Use one type per middleware and combine them with a `chain`.',
    });
  });

  test('MW-09 identical built definitions merge; different ones collide', () => {
    const ctx = context();
    const api = service(ctx, 'api', { deploy: { ...ENABLE, [`${M}strip.stripprefix.prefixes`]: '/a' } });
    const web = service(ctx, 'web', { labels: { ...ENABLE, [`${M}strip.StripPrefix.Prefixes`]: '/a' } });
    const merged = run(ctx, [api, web]);
    expect(merged).toEqual([
      { name: 'strip', spec: { stripPrefix: { prefixes: ['/a'] } }, users: null, errorsService: null, path: deployPath('api', `${M}strip.stripprefix.prefixes`) },
    ]);
    expect(codes(ctx)).toEqual(['routing.container-labels']);

    const clash = context();
    const a = service(clash, 'api', { deploy: { ...ENABLE, [`${M}strip.stripprefix.prefixes`]: '/a' } });
    const b = service(clash, 'web', { deploy: { ...ENABLE, [`${M}strip.stripprefix.prefixes`]: '/b' } });
    expect(run(clash, [a, b]).map((m) => m.spec)).toEqual([{ stripPrefix: { prefixes: ['/a'] } }]);
    expect(one(clash, 'names.middleware-collision')).toEqual({
      severity: 'error',
      code: 'names.middleware-collision',
      path: deployPath('web', `${M}strip.stripprefix.prefixes`),
      message: 'middleware strip is defined differently by api',
      hint: 'Rename one of the middlewares.',
    });

    const renamed = context();
    const c = service(renamed, 'api', { deploy: { ...ENABLE, [`${M}my-strip.stripprefix.prefixes`]: '/a' } });
    const e = service(renamed, 'web', { deploy: { ...ENABLE, [`${M}My_Strip.stripprefix.prefixes`]: '/b' } });
    run(renamed, [c, e]);
    expect(one(renamed, 'names.middleware-collision').message).toBe(
      'middleware My_Strip is created as my-strip, which middleware my-strip of api defines differently',
    );
  });

  test('a middleware also defined by the sibling role collides (one namespace, DESIGN-CORE 5.4)', () => {
    const { ctx } = middleware({ 'strip.stripprefix.prefixes': '/a' }, { sibling: { middlewares: ['strip'] } });
    expect(one(ctx, 'names.middleware-collision')).toMatchObject({
      message: 'middleware strip is also defined in accessories.yml, and both files would create the Middleware strip',
      hint: 'Define the middleware in one file only; routers of both files can use it.',
    });
    const accessory = middleware({ 'strip.stripprefix.prefixes': '/a' }, { role: 'accessory', sibling: { middlewares: ['strip'] } });
    expect(one(accessory.ctx, 'names.middleware-collision').message).toContain('docker-compose.yml');
  });

  test('MW-10 a sanitized name is reported with info', () => {
    const { ctx, middlewares } = middleware({ 'My_Auth.redirectscheme.scheme': 'https' });
    expect(middlewares.map((m) => [m.name, m.spec])).toEqual([['my-auth', { redirectScheme: { scheme: 'https' } }]]);
    expect(one(ctx, 'names.middleware-sanitized')).toEqual({
      severity: 'info',
      code: 'names.middleware-sanitized',
      path: deployPath('web', `${M}My_Auth.redirectscheme.scheme`),
      message: 'middleware My_Auth is created as my-auth',
    });
  });

  test('MW-11 indices on scalar lists, map keys, coercion edge cases, escapes, one leaf written twice', () => {
    const index = middleware({ 'e.errors.status[0]': '500' });
    expect(one(index.ctx, 'routing.middleware-option-unknown')).toMatchObject({
      message: 'errors.status[0] is not an option of the errors middleware',
      hint: 'Write the values as one comma-separated label, for example `...errors.status=500,502-504`.',
    });

    const header = middleware({ 'h.headers.customrequestheaders.X-Forwarded-Proto': 'https', 'h.headers.customresponseheaders.X-List': 'a,b' });
    expect(header.middlewares[0].spec).toEqual({
      headers: { customRequestHeaders: { 'X-Forwarded-Proto': 'https' }, customResponseHeaders: { 'X-List': 'a,b' } },
    });

    const rewrites = middleware({ 'e.errors.statusrewrites.500': '200', 'e.errors.service': 'web' }, {});
    expect(rewrites.middlewares).toEqual([]);
    const rewritten = single({ [`${M}e.errors.statusrewrites.500`]: '200', [`${M}e.errors.service`]: 'web' }, {}, { expose: [80] });
    expect(rewritten.middlewares[0].spec).toEqual({ errors: { statusRewrites: { '500': 200 } } });

    const attempts = middleware({ 'r.retry.attempts': 'many' });
    expect(one(attempts.ctx, 'routing.middleware-option-type').message).toBe('retry.attempts expects a whole number, got "many"');

    const yes = middleware({ 'c.contenttype.autodetect': 'yes' });
    expect(one(yes.ctx, 'routing.middleware-option-type')).toMatchObject({
      message: 'contenttype.autodetect expects true or false, got "yes"',
      hint: 'Write `true` or `false`.',
    });
    expect(middleware({ 'c.contenttype.autodetect': '1' }).middlewares[0].spec).toEqual({ contentType: { autoDetect: true } });

    const escaped = middleware({ 's.stripprefix.prefixes': '/a\\,b,/c' });
    expect(escaped.middlewares[0].spec).toEqual({ stripPrefix: { prefixes: ['/a,b', '/c'] } });
    expect(one(escaped.ctx, 'routing.middleware-escaped-comma')).toMatchObject({
      severity: 'warning',
      path: deployPath('web', `${M}s.stripprefix.prefixes`),
      hint: 'Avoid commas inside values when the same file is also deployed on Swarm.',
    });
    expect(middleware({ 's.stripprefix.prefixes': 'C:\\\\dir,\\x' }).middlewares[0].spec).toEqual({ stripPrefix: { prefixes: ['C:\\dir', '\\x'] } });

    // labels are taken in code-unit order of keys: `HEADERS` sorts before `headers`
    const twice = middleware({ 'h.headers.framedeny': 'true', 'h.HEADERS.FrameDeny': 'false' });
    expect(one(twice.ctx, 'routing.middleware-duplicate-option')).toMatchObject({
      path: deployPath('web', `${M}h.headers.framedeny`),
      message: 'headers.framedeny is written by two labels',
      hint: 'Keep one of the labels.',
    });
    expect(twice.middlewares).toEqual([]);
  });

  test('design-04 2.14.1 coercion: numbers, booleans, byte sizes, empty lists, paths ending on objects', () => {
    expect(middleware({ 'r.retry.attempts': '4', 'r.retry.initialinterval': '100ms' }).middlewares[0].spec).toEqual({
      retry: { attempts: 4, initialInterval: '100ms' },
    });
    expect(middleware({ 'h.headers.framedeny': 'TRUE' }).middlewares[0].spec).toEqual({ headers: { frameDeny: true } });
    expect(middleware({ 'h.headers.stsseconds': '+10' }).middlewares[0].spec).toEqual({ headers: { stsSeconds: 10 } });
    expect(middleware({ 's.stripprefix.prefixes': '' }).middlewares[0].spec).toEqual({ stripPrefix: { prefixes: [] } });
    const status = middleware({ 'e.errors.status': '500-599,404' });
    expect(status.middlewares[0].spec).toEqual({ errors: { status: ['500-599', '404'] } });
    expect(codes(status.ctx)).toEqual([]);

    const bytes = middleware({ 'b.buffering.maxrequestbodybytes': '2MB' });
    expect(one(bytes.ctx, 'routing.middleware-option-type').message).toBe('buffering.maxrequestbodybytes expects a whole number, got "2MB"');
    expect(middleware({ 'b.buffering.maxrequestbodybytes': '2000000' }).middlewares[0].spec).toEqual({ buffering: { maxRequestBodyBytes: 2000000 } });

    const object = middleware({ 'h.headers.customrequestheaders': 'x' });
    expect(one(object.ctx, 'routing.middleware-option-unknown').hint).toBe(
      'Set one of its entries, for example `...headers.customrequestheaders.<name>=<value>`.',
    );
    const group = middleware({ 'f.forwardauth.tls': 'x' });
    expect(one(group.ctx, 'routing.middleware-option-unknown').hint).toBe('Set one of its options, for example `...forwardauth.tls.caOptional=<value>`.');
    const past = middleware({ 's.stripprefix.prefixes.x': '/a' });
    expect(one(past.ctx, 'routing.middleware-option-unknown').hint).toBe('Remove `.x` from the label.');
    const scalarIndex = middleware({ 's.stripprefix.forceslash[0]': 'true' });
    expect(codes(scalarIndex.ctx)).toEqual(['routing.middleware-option-unknown']);
  });

  test('a middleware without options is declared the Swarm way, `<type>=true`', () => {
    const { ctx, middlewares } = middleware({ 'gzip.compress': 'true' });
    expect(middlewares[0].spec).toEqual({ compress: {} });
    expect(codes(ctx)).toEqual([]);
    const off = middleware({ 'gzip.compress': 'false' });
    expect(one(off.ctx, 'routing.middleware-option-unknown').hint).toBe(
      'Set an option of the compress middleware, or write `...compress=true` when it takes none.',
    );
  });

  test('MW-12 basicauth users are split, unescaped, sorted unique and kept outside the spec', () => {
    const { ctx, middlewares } = middleware({ 'auth.basicauth.users': 'ops:$2y$y,admin:$apr1$x', 'auth.basicauth.realm': 'Private' });
    expect(middlewares).toEqual([
      {
        name: 'auth',
        spec: { basicAuth: { realm: 'Private' } },
        users: ['admin:$apr1$x', 'ops:$2y$y'],
        errorsService: null,
        path: deployPath('web', `${M}auth.basicauth.realm`),
      },
    ]);
    expect(codes(ctx)).toEqual([]);
    const digest = middleware({ 'auth.digestauth.users': 'a:realm:hash' });
    expect(digest.middlewares.map((m) => [m.spec, m.users])).toEqual([[{ digestAuth: {} }, ['a:realm:hash']]]);
  });

  test('MW-13 usersfile refused, missing users, users with secret, secret alone', () => {
    const file = middleware({ 'auth.basicauth.usersfile': '/etc/htpasswd' });
    expect(one(file.ctx, 'routing.users-file')).toEqual({
      severity: 'error',
      code: 'routing.users-file',
      path: deployPath('web', `${M}auth.basicauth.usersfile`),
      message: "basicauth.usersfile names a file on the machine running dockflow, which the cluster's Traefik cannot read",
      hint: 'Inline the users with `...basicauth.users=user:hash`, or create the Secret yourself and reference it with `...basicauth.secret=<name>`.',
    });

    const realm = middleware({ 'auth.basicauth.realm': 'Private' });
    expect(one(realm.ctx, 'routing.middleware-missing-users')).toMatchObject({
      message: 'middleware auth of type basicauth defines no users',
      hint: 'Add `...basicauth.users=user:hash`.',
    });
    expect(codes(middleware({ 'auth.digestauth.users': '' }).ctx)).toEqual(['routing.middleware-missing-users']);

    const both = middleware({ 'auth.basicauth.users': 'a:$apr1$h', 'auth.basicauth.secret': 'mine' });
    expect(one(both.ctx, 'routing.middleware-duplicate-option')).toMatchObject({
      path: deployPath('web', `${M}auth.basicauth.secret`),
      message: 'basicauth.users and basicauth.secret both set the Secret of middleware auth',
    });
    expect(both.middlewares).toEqual([]);

    const secret = middleware({ 'auth.basicauth.secret': 'mine' });
    expect(secret.middlewares.map((m) => [m.spec, m.users])).toEqual([[{ basicAuth: { secret: 'mine' } }, null]]);
    expect(one(secret.ctx, 'routing.middleware-external-secret').message).toBe(
      'middleware auth references the Secret mine, which Dockflow does not manage',
    );
  });

  test('MW-14 errors.service resolved to a Service name and port', () => {
    const errorsOf = (drafts: (ctx: NormalizeContext) => ServiceDraft[]) => {
      const ctx = context();
      return { ctx, middlewares: run(ctx, drafts(ctx)) };
    };
    const label = (value: string) => ({ ...ENABLE, [`${M}errs.errors.status`]: '500-599', [`${M}errs.errors.service`]: value });

    const traefik = errorsOf((ctx) => [
      service(ctx, 'backend', { expose: [80, 81], deploy: { ...ENABLE, [`${S}api.loadbalancer.server.port`]: '8080' } }),
      service(ctx, 'web', { deploy: label('api@swarm') }),
    ]);
    expect(traefik.middlewares).toEqual([
      {
        name: 'errs',
        spec: { errors: { status: ['500-599'] } },
        users: null,
        errorsService: { name: 'backend', port: 8080 },
        path: deployPath('web', `${M}errs.errors.service`),
      },
    ]);
    expect(codes(traefik.ctx)).toEqual([]);

    const compose = errorsOf((ctx) => [service(ctx, 'web_app', { expose: [80], deploy: label('web_app') })]);
    expect(compose.middlewares[0].errorsService).toEqual({ name: 'web-app', port: 80 });

    const ghost = errorsOf((ctx) => [service(ctx, 'web', { expose: [80], deploy: label('ghost') })]);
    expect(one(ghost.ctx, 'routing.service-undefined')).toEqual({
      severity: 'error',
      code: 'routing.service-undefined',
      path: deployPath('web', `${M}errs.errors.service`),
      message: 'middleware errs sends errors to ghost, which is not a service of this file',
      hint: 'Use a compose service name, or declare the port with `traefik.http.services.ghost.loadbalancer.server.port`.',
    });

    const two = errorsOf((ctx) => [service(ctx, 'web', { expose: [81, 80], deploy: label('web') })]);
    expect(one(two.ctx, 'routing.port-ambiguous')).toMatchObject({
      path: deployPath('web', `${M}errs.errors.service`),
      message: 'middleware errs needs a port: web declares several ports (80, 81)',
      hint: 'Add `traefik.http.services.web.loadbalancer.server.port=<port>`.',
    });

    const sub = errorsOf((ctx) => [service(ctx, 'web', { expose: [80], deploy: { ...ENABLE, [`${M}errs.errors.service.port`]: '8080' } })]);
    expect(one(sub.ctx, 'routing.middleware-option-unknown')).toMatchObject({
      message: 'errors.service.port is not an option of the errors middleware',
      hint: 'Name the service with `...errors.service=<service>`.',
    });

    const file = errorsOf((ctx) => [service(ctx, 'web', { expose: [80], deploy: label('web@file') })]);
    expect(one(file.ctx, 'routing.middleware-provider').message).toBe(
      "middleware errs sends errors to web, which comes from the file provider that Dockflow's Traefik does not load",
    );
  });

  test('MW-15 escaped comma inside a user name; duplicate users collapse', () => {
    const escaped = middleware({ 'auth.basicauth.users': 'a\\,b:$apr1$x' });
    expect(escaped.middlewares[0].users).toEqual(['a,b:$apr1$x']);
    expect(codes(escaped.ctx)).toEqual(['routing.middleware-escaped-comma']);
    const dup = middleware({ 'auth.basicauth.users': 'ops:$2y$y,admin:$apr1$x,ops:$2y$y' });
    expect(dup.middlewares[0].users).toEqual(['admin:$apr1$x', 'ops:$2y$y']);
  });

  test('user entries never reach a diagnostic (T7)', () => {
    const { ctx } = middleware({ 'auth.basicauth.users': 'admin:$apr1$secret\\,x', 'auth.basicauth.secret': 'mine', 'auth.basicauth.foo': 'x' });
    const list = diagnostics(ctx);
    expect(list.length).toBeGreaterThan(0);
    for (const d of list) expect(`${d.message} ${d.hint ?? ''}`).not.toContain('$apr1');
  });

  test('middlewares of a service whose labels are ignored are not defined', () => {
    const ctx = context();
    const lib = service(ctx, 'lib', { deploy: { [`${M}strip.stripprefix.prefixes`]: '/a' } });
    const web = service(ctx, 'web', { ports: [80], deploy: { ...ENABLE, [`${R}api.rule`]: 'Host(`a.example.com`)', [`${R}api.middlewares`]: 'strip' } });
    expect(run(ctx, [lib, web])).toEqual([]);
    expect(codes(ctx)).toEqual(['routing.not-enabled', 'routing.unknown-middleware']);
  });

  test('the result, its paths and its diagnostics do not depend on label order (DET-01)', () => {
    const labels: [string, string][] = [
      [`${M}zeta.stripprefix.prefixes`, '/z'],
      [`${M}alpha.headers.customrequestheaders.X-A`, '1'],
      [`${M}alpha.headers.framedeny`, 'true'],
      [`${M}alpha.Headers.FrameDeny`, 'false'],
      [`${M}mixed.addprefix.prefix`, '/m'],
      [`${M}mixed.stripprefix.prefixes`, '/m'],
      [`${R}api.rule`, 'Host(`a.example.com`)'],
      [`${R}api.middlewares`, 'zeta,alpha'],
      [`${R}shop-production-web.priority`, '5'],
      [`${R}shop-production-web.middlewares`, 'zeta'],
    ];
    const render = (order: [string, string][]) => {
      const ctx = context();
      const d = service(ctx, 'web', { rawPorts: ['8080:80'], ports: [80], deploy: { ...ENABLE, ...Object.fromEntries(order) } });
      const middlewares = run(ctx, [d]);
      return canonicalJson({ middlewares, routes: d.routes, diagnostics: diagnostics(ctx) });
    };
    const forward = render(labels);
    expect(render([...labels].reverse())).toBe(forward);
    expect(render([...labels.slice(3), ...labels.slice(0, 3)])).toBe(forward);
    const result = JSON.parse(forward) as { middlewares: MiddlewareSpec[]; routes: RouteSpec[] };
    expect(result.middlewares.map((m) => [m.name, m.path])).toEqual([['zeta', deployPath('web', `${M}zeta.stripprefix.prefixes`)]]);
    expect(result.routes.map((r) => [r.router, r.path])).toEqual([
      ['api', deployPath('web', `${R}api.rule`)],
      ['shop-production-web', deployPath('web', `${R}shop-production-web.middlewares`)],
    ]);
  });
});

describe('walkMiddlewareLabels on arrays of objects (design-04 2.14.1 rule 2)', () => {
  const node: CrdPropertyNode = {
    canonical: 'demo',
    type: 'object',
    properties: {
      servers: {
        canonical: 'servers',
        type: 'array',
        items: {
          canonical: '',
          type: 'object',
          properties: { url: { canonical: 'url', type: 'string' }, weight: { canonical: 'weight', type: 'integer' } },
        },
      },
    },
  };
  const label = (fields: string[], value: string): MiddlewareLabel => ({ type: 'demo', fields, value, path: `services.web.labels[${fields.join('.')}]` });
  const walk = (labels: MiddlewareLabel[]) => {
    const sink = new DiagnosticSink();
    const spec = walkMiddlewareLabels('m', node, labels, sink);
    const list = sink.list();
    reported.push(...list);
    return { spec, codes: list.map((d) => d.code), list };
  };

  test('indexed elements build an array in index order', () => {
    const result = walk([label(['Servers[1]', 'Weight'], '2'), label(['servers[0]', 'url'], 'http://a'), label(['servers[1]', 'url'], 'http://b')]);
    expect(result.spec).toEqual({ servers: [{ url: 'http://a' }, { weight: 2, url: 'http://b' }] });
    expect(result.codes).toEqual([]);
  });

  test('an array of objects needs an index', () => {
    const result = walk([label(['servers', 'url'], 'http://a')]);
    expect(result.spec).toBeNull();
    expect(result.list).toEqual([
      {
        severity: 'error',
        code: 'routing.middleware-index-required',
        path: 'services.web.labels[servers.url]',
        message: 'demo.servers is a list of objects and each element needs an index',
        hint: 'Write each element as `...demo.servers[<i>].<option>=<value>`, counting from 0.',
      },
    ]);
  });

  test('indices count from 0 without gaps', () => {
    const result = walk([label(['servers[0]', 'url'], 'http://a'), label(['servers[2]', 'url'], 'http://c')]);
    expect(result.spec).toBeNull();
    expect(result.list).toEqual([
      {
        severity: 'error',
        code: 'routing.middleware-index-gap',
        path: 'services.web.labels[servers[0].url]',
        message: 'demo.servers indices must count from 0 without gaps, got 0, 2',
        hint: 'Number the elements 0, 1, 2 and so on.',
      },
    ]);
  });

  test('an element is an object, and one element field is written once', () => {
    expect(walk([label(['servers[0]'], 'x')]).codes).toEqual(['routing.middleware-option-unknown']);
    expect(walk([label(['servers[0]', 'url'], 'a'), label(['servers[0]', 'URL'], 'b')]).codes).toEqual(['routing.middleware-duplicate-option']);
    expect(walk([label(['servers[0]', 'weight'], 'heavy')]).codes).toEqual(['routing.middleware-option-type']);
  });

  test('the generated schema has no other array of objects than the two rule-6 cases', () => {
    const found: string[] = [];
    const visit = (n: CrdPropertyNode, path: string) => {
      if (n.type === 'array' && n.items?.type === 'object') found.push(path);
      for (const [k, child] of Object.entries(n.properties ?? {})) visit(child, `${path}.${k}`);
      if (n.items !== undefined) visit(n.items, `${path}[]`);
      if (n.additionalProperties !== undefined) visit(n.additionalProperties, `${path}.*`);
    };
    for (const [type, n] of Object.entries(MIDDLEWARE_SCHEMA)) visit(n, type);
    expect(found.sort()).toEqual(['chain.middlewares', 'errors.service.middlewares']);
  });
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe('routing diagnostics catalogue', () => {
  test('every code of ROUTING_CODES is exercised above, and nothing else is emitted', () => {
    const emitted = new Set(reported.map((d) => d.code));
    expect([...ROUTING_CODES].filter((code) => !emitted.has(code))).toEqual([]);
    expect([...emitted].filter((code) => !(ROUTING_CODES as readonly string[]).includes(code))).toEqual([]);
    expect(new Set(ROUTING_CODES).size).toBe(ROUTING_CODES.length);
  });

  test('message style: one sentence without a trailing period, hints end with a period', () => {
    for (const d of reported) {
      expect([d.code, d.message.endsWith('.')]).toEqual([d.code, false]);
      if (d.hint !== undefined) expect([d.code, d.hint.endsWith('.')]).toEqual([d.code, true]);
    }
  });
});
