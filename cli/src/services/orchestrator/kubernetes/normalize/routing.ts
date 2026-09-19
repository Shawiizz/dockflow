// Traefik labels -> RouteSpec and MiddlewareSpec (design-01 7; design-04 2.14 and its normative
// label algorithm 2.14.1; PD-6). normalizeStack calls three steps, in this order:
// - routingLabels(draft) for each service: gates, routers, Traefik services, middleware labels;
// - collectMiddlewares(drafts): the Middleware objects and every check that needs the whole file
//   (middleware references, duplicate routers, errors.service, merging identical definitions);
// - injectDefaultRoutes(drafts): the Swarm injectTraefikLabels parity, role app only.
// Every diagnostic here is normalizer-owned (design-01 1.6). Pure: no I/O, no clock.

import { canonicalJson } from '../../../../utils/hash';
import type { DiagnosticSink } from '../../diagnostics';
import type { MiddlewareSpec, ProxyIntent, RouteSpec } from '../model/types';
import { middlewareNameFor } from '../naming';
import { type CrdPropertyNode, MIDDLEWARE_SCHEMA, MIDDLEWARE_SCHEMA_SOURCE } from '../traefik-crd-schema.generated';
import {
  childPath,
  compareCodeUnits,
  isPlainMap,
  type NormalizeContext,
  type RoutingLabel,
  type ServiceDraft,
  sortedUnique,
} from './context';

/** Every code this handler emits; the `routing` rows of KEY_REGISTRY list the same set. */
export const ROUTING_CODES = [
  'names.middleware-collision',
  'names.middleware-sanitized',
  'routing.backend-scheme-unsupported',
  'routing.container-labels',
  'routing.duplicate-injected-host',
  'routing.duplicate-router',
  'routing.entrypoint-not-exposed',
  'routing.healthcheck-ignored',
  'routing.injected-first-port',
  'routing.injection-disabled',
  'routing.internal-service',
  'routing.middleware-deprecated',
  'routing.middleware-duplicate-option',
  'routing.middleware-escaped-comma',
  'routing.middleware-external-secret',
  'routing.middleware-index-gap',
  'routing.middleware-index-required',
  'routing.middleware-missing-users',
  'routing.middleware-option-type',
  'routing.middleware-option-unknown',
  'routing.middleware-plugin-unsupported',
  'routing.middleware-provider',
  'routing.middleware-several-types',
  'routing.middleware-unsupported',
  'routing.missing-rule',
  'routing.not-enabled',
  'routing.option-ignored',
  'routing.port-ambiguous',
  'routing.proxy-disabled',
  'routing.service-undefined',
  'routing.swarm-label-ignored',
  'routing.tcp-udp-unsupported',
  'routing.tls-domains-ignored',
  'routing.tls-options-unsupported',
  'routing.unknown-certresolver',
  'routing.unknown-entrypoint',
  'routing.unknown-middleware',
  'routing.unknown-service',
  'routing.unsupported-label',
  'routing.users-file',
  'routing.v2-rule',
  'routing.web-served-with-acme',
  'values.empty',
  'values.invalid-boolean',
  'values.invalid-integer',
] as const;

const TRAEFIK_PREFIX = 'traefik.';
/** the two entry points Dockflow's Traefik release always defines (design-04 2.4) */
const ENTRY_POINTS: readonly string[] = ['web', 'websecure'];
/** the only certificate resolver, rendered only when proxy.acme is on */
const CERT_RESOLVER = 'letsencrypt';
/** providers whose names mean an object of the stack namespace (design-04 2.14) */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set(['docker', 'swarm', 'kubernetescrd']);
const SWARM_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  'docker.network',
  'docker.lbswarm',
  'docker.allownonrunning',
  'swarm.network',
  'swarm.lbswarm',
]);
const ROUTER_FIELDS: ReadonlySet<string> = new Set(['rule', 'rulesyntax', 'entrypoints', 'middlewares', 'service', 'priority', 'tls', 'tls.certresolver']);
const SERVICE_FIELDS: ReadonlySet<string> = new Set(['loadbalancer.server.port', 'loadbalancer.server.scheme', 'loadbalancer.passhostheader']);
const V2_RULE = /\{[A-Za-z_][A-Za-z0-9_]*:/;
const TLS_DOMAIN = /^tls\.domains\[[0-9]+\]\.(main|sans)$/;
const INDEXED = /^(.+)\[([0-9]+)\]$/;
const INTEGER = /^[+-]?[0-9]+$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const DURATION = /^[0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h)$/;
/** CRD options that name a Secret Dockflow neither creates nor prunes (design-01 7.4 item 5) */
const SECRET_OPTIONS: ReadonlySet<string> = new Set(['secret', 'certSecret', 'caSecret']);
const CHAIN_MIDDLEWARES = /^middlewares(\[[0-9]+\])?$/;
const NEAREST_COUNT = 5;

// ---------------------------------------------------------------------------
// Scalars and lists
// ---------------------------------------------------------------------------

/** Go strconv.ParseBool: Traefik parses every label boolean with it (Swarm parity). */
function goParseBool(value: string): boolean | null {
  if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(value)) return true;
  if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(value)) return false;
  return null;
}

/** design-04 2.14.1 rule 3: split on commas, `\,` and `\\` unescaped, nothing trimmed, '' -> []. */
function splitLabelList(value: string): { items: string[]; escaped: boolean } {
  if (value === '') return { items: [], escaped: false };
  const items: string[] = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const next = value[i + 1];
    if (c === '\\' && (next === ',' || next === '\\')) {
      current += next;
      escaped = true;
      i++;
    } else if (c === ',') {
      items.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  items.push(current);
  return { items, escaped };
}

/** Optimal string alignment distance (Damerau-Levenshtein without repeated edits of one substring). */
function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1);
      rows[i][j] = best;
    }
  }
  return rows[a.length][b.length];
}

function nearest(word: string, candidates: readonly string[]): string[] {
  const target = word.toLowerCase();
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate.toLowerCase()) }))
    .sort((x, y) => x.distance - y.distance || compareCodeUnits(x.candidate, y.candidate))
    .slice(0, NEAREST_COUNT)
    .map((x) => x.candidate);
}

/** `a`, `b` and `c` */
function codeList(items: readonly string[]): string {
  const quoted = items.map((item) => `\`${item}\``);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

function numericUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Target ports of the service, `ports` and `expose` together: the candidates of design-01 7.6. */
function containerPorts(d: ServiceDraft): number[] {
  return numericUnique([...d.ports.map((p) => p.target), ...d.expose.map((e) => e.target)]);
}

/**
 * The container port of the first `ports` entry as written, like Swarm's parseContainerPort: short
 * form `[ip:][host:]container[/proto]` (first port of a range), long form `target`.
 */
function firstPortTarget(entry: unknown): number | null {
  let text: string;
  if (typeof entry === 'number') text = String(entry);
  else if (typeof entry === 'string') {
    const parts = entry.split('/')[0].split(':');
    text = parts[parts.length - 1];
  } else if (isPlainMap(entry) && (typeof entry.target === 'number' || typeof entry.target === 'string')) text = String(entry.target);
  else return null;
  const match = /^([0-9]+)(-[0-9]+)?$/.exec(text);
  if (match === null) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? port : null;
}

// ---------------------------------------------------------------------------
// Per-service parse (design-01 7.1-7.3, 7.6)
// ---------------------------------------------------------------------------

interface RouterLabels {
  /** lower-case field -> label; deploy.labels win over labels */
  fields: Map<string, RoutingLabel>;
  /** path of the router's first label in key order */
  firstPath: string;
}

interface TraefikService {
  fields: Map<string, RoutingLabel>;
  /** loadbalancer.server.port: null when absent, 'invalid' once reported */
  port: number | null | 'invalid';
}

/** One `traefik.http.middlewares.<m>.<type>[.<option>...]` label. */
export interface MiddlewareLabel {
  /** type segment as written, e.g. `StripPrefix` */
  type: string;
  /** option segments after the type, as written, e.g. `['customrequestheaders', 'X-Script-Name']` */
  fields: string[];
  value: string;
  /** compose path of the label */
  path: string;
}

interface MiddlewareReference {
  /** Middleware object name (middlewareNameFor of the written name) */
  name: string;
  /** name as written, provider suffix removed */
  written: string;
  provider: string | null;
  path: string;
}

interface ParsedRouting {
  /** the gates passed: the maps below hold this service's labels */
  active: boolean;
  routers: Map<string, RouterLabels>;
  services: Map<string, TraefikService>;
  /** label name -> its labels, in key order */
  middlewares: Map<string, MiddlewareLabel[]>;
  /** router middleware references, resolved once every definition of the file is known */
  references: MiddlewareReference[];
}

const parsedDrafts = new WeakMap<ServiceDraft, ParsedRouting>();

interface InjectedRoute {
  router: string;
  rule: string;
  entryPoints: string[];
  tls: RouteSpec['tls'];
  port: number;
}

/** deploy.labels win over labels (design-01 7.1); between two labels of one source the later wins */
function prefer(existing: RoutingLabel | undefined, label: RoutingLabel): boolean {
  return existing === undefined || !(existing.source === 'deploy.labels' && label.source === 'labels');
}

/**
 * The `traefik.*` labels identity.ts collected (prefix in any case), one per label key, in code-unit
 * order of keys: every path the model keeps (a middleware's first label, a router without `rule`)
 * and every "second label" diagnostic must not depend on the key order of the labels mapping (DET-01).
 */
function mergedLabels(labels: readonly RoutingLabel[]): RoutingLabel[] {
  const byKey = new Map<string, RoutingLabel>();
  for (const label of labels) {
    if (prefer(byKey.get(label.key), label)) byKey.set(label.key, label);
  }
  return [...byKey.values()].sort((a, b) => compareCodeUnits(a.key, b.key));
}

function segmentsOf(label: RoutingLabel): string[] {
  return label.key.slice(TRAEFIK_PREFIX.length).split('.');
}

function setField(fields: Map<string, RoutingLabel>, field: string, label: RoutingLabel): void {
  if (prefer(fields.get(field), label)) fields.set(field, label);
}

function invalidBoolean(label: RoutingLabel, ctx: NormalizeContext): void {
  ctx.sink.error('values.invalid-boolean', label.path, `expected true or false, got ${label.value}`, 'Write `true` or `false`.');
}

function invalidInteger(label: RoutingLabel, min: number, max: number, ctx: NormalizeContext): void {
  ctx.sink.error('values.invalid-integer', label.path, `expected an integer between ${min} and ${max}, got ${label.value}`, 'Write a whole number.');
}

function unsupportedLabel(label: RoutingLabel, ctx: NormalizeContext): void {
  ctx.sink.error(
    'routing.unsupported-label',
    label.path,
    `${label.key} is not a supported Traefik label`,
    'Use a supported label: routers (`rule`, `entrypoints`, `middlewares`, `service`, `priority`, `tls`, `tls.certresolver`), services (`loadbalancer.server.port`) and middlewares.',
  );
}

/**
 * The route Swarm's injectTraefikLabels would add (design-01 7.5): role app, a domain for the
 * environment, non-empty `ports`, `traefik.enable` not false.
 */
function injectionFor(d: ServiceDraft, ctx: NormalizeContext): InjectedRoute | null {
  const p = ctx.proxy;
  // role first (K02): a null intent means proxy.enabled is false, never "accessory"
  if (ctx.input.role !== 'app' || p === null || p.domain === null) return null;
  if (d.rawPorts.length === 0 || d.routingEnable === false) return null;
  const port = firstPortTarget(d.rawPorts[0]);
  if (port === null) return null;
  return {
    router: `${ctx.input.identity.stackName}-${d.composeName}`,
    rule: `Host(\`${p.domain}\`)`,
    entryPoints: [p.entryPoint],
    tls: p.certResolver === null ? null : { certResolver: p.certResolver },
    port,
  };
}

function parse(d: ServiceDraft, ctx: NormalizeContext): ParsedRouting {
  const done = parsedDrafts.get(d);
  if (done !== undefined) return done;
  const state: ParsedRouting = { active: false, routers: new Map(), services: new Map(), middlewares: new Map(), references: [] };
  parsedDrafts.set(d, state);

  const labels = mergedLabels(d.routingLabels);
  let enableLabel: RoutingLabel | undefined;
  const rest: RoutingLabel[] = [];
  for (const label of labels) {
    if (segmentsOf(label).join('.').toLowerCase() !== 'enable') rest.push(label);
    else if (prefer(enableLabel, label)) enableLabel = label;
  }
  const enable = enableLabel === undefined ? null : goParseBool(enableLabel.value);
  d.routingEnable = enable;
  if (labels.length === 0 || ctx.isFatal(d.path)) return state;

  // gate 2: labels that cannot take effect are not parsed, so they report nothing else
  const proxy = ctx.proxy;
  if (proxy === null) {
    ctx.sink.warn(
      'routing.proxy-disabled',
      d.path,
      'Traefik labels have no effect because proxy.enabled is false',
      'Set `proxy.enabled: true` in config.yml, or remove the labels.',
    );
    return state;
  }
  if (enableLabel !== undefined && enable === null) invalidBoolean(enableLabel, ctx);

  // gate 3: Swarm parity, the injected route implies traefik.enable=true
  const effective = enable ?? (injectionFor(d, ctx) !== null);
  if (!effective) {
    if (rest.length > 0) {
      ctx.sink.warn(
        'routing.not-enabled',
        d.path,
        'Traefik labels are ignored because traefik.enable is not true (they are ignored on Swarm too)',
        'Add `traefik.enable=true` to `deploy.labels`.',
      );
    }
    return state;
  }
  state.active = true;
  // gate 1, reported only for labels that are actually used
  if (labels.some((l) => l.source === 'labels')) {
    ctx.sink.info(
      'routing.container-labels',
      childPath(d.path, 'labels'),
      'Traefik labels in labels are used on Kubernetes; on Swarm Traefik only reads deploy.labels',
    );
  }

  for (const label of rest) classify(label, state, ctx);
  for (const service of state.services.values()) checkService(service, ctx);
  const injected = injectionFor(d, ctx);
  for (const [name, router] of state.routers) {
    const route = buildRoute(name, router, state, d, proxy, injected?.router === name ? injected : null, ctx);
    if (route !== null) d.routes.push(route);
  }
  d.routes.sort((a, b) => compareCodeUnits(a.router, b.router));
  return state;
}

function classify(label: RoutingLabel, state: ParsedRouting, ctx: NormalizeContext): void {
  const segments = segmentsOf(label);
  const lower = segments.map((s) => s.toLowerCase());
  if (SWARM_PROVIDER_KEYS.has(lower.join('.'))) {
    ctx.sink.info('routing.swarm-label-ignored', label.path, `${label.key} only applies to Traefik's Swarm provider and is ignored`);
    return;
  }
  if (lower[0] === 'tcp' || lower[0] === 'udp') {
    ctx.sink.error('routing.tcp-udp-unsupported', label.path, 'TCP and UDP routers are not supported', 'Publish the port with `ports:` instead.');
    return;
  }
  const name = segments[2] ?? '';
  if (lower[0] === 'http' && name !== '' && segments.length >= 4) {
    const field = lower.slice(3).join('.');
    if (lower[1] === 'routers') return routerLabel(name, field, label, state, ctx);
    if (lower[1] === 'services') return serviceLabel(name, field, label, state, ctx);
    if (lower[1] === 'middlewares' && segments[3] !== '') {
      const labels = state.middlewares.get(name) ?? [];
      labels.push({ type: segments[3], fields: segments.slice(4), value: label.value, path: label.path });
      state.middlewares.set(name, labels);
      return;
    }
  }
  unsupportedLabel(label, ctx);
}

function routerLabel(name: string, field: string, label: RoutingLabel, state: ParsedRouting, ctx: NormalizeContext): void {
  if (ROUTER_FIELDS.has(field)) {
    const router = state.routers.get(name) ?? { fields: new Map(), firstPath: label.path };
    setField(router.fields, field, label);
    state.routers.set(name, router);
  } else if (TLS_DOMAIN.test(field)) {
    ctx.sink.warn('routing.tls-domains-ignored', label.path, 'tls.domains is ignored: certificates are requested for the hosts of the rule');
  } else if (field === 'tls.options') {
    ctx.sink.error(
      'routing.tls-options-unsupported',
      label.path,
      'tls.options is not supported',
      'Remove `tls.options`; TLS options are not configurable in this Dockflow version.',
    );
  } else if (field === 'observability' || field.startsWith('observability.')) {
    ctx.sink.warn('routing.option-ignored', label.path, `${label.key} is ignored`);
  } else {
    unsupportedLabel(label, ctx);
  }
}

function serviceLabel(name: string, field: string, label: RoutingLabel, state: ParsedRouting, ctx: NormalizeContext): void {
  // a service named only by ignored options still exists for `service=` references
  const service = state.services.get(name) ?? { fields: new Map(), port: null };
  state.services.set(name, service);
  if (SERVICE_FIELDS.has(field)) {
    setField(service.fields, field, label);
  } else if (
    field === 'loadbalancer.strategy' ||
    field === 'loadbalancer.responseforwarding.flushinterval' ||
    field === 'loadbalancer.sticky' ||
    field.startsWith('loadbalancer.sticky.')
  ) {
    ctx.sink.warn('routing.option-ignored', label.path, `${label.key} is ignored`);
  } else if (field === 'loadbalancer.healthcheck' || field.startsWith('loadbalancer.healthcheck.')) {
    ctx.sink.warn(
      'routing.healthcheck-ignored',
      label.path,
      'Traefik health checks are ignored: Kubernetes only routes to Ready pods (see healthcheck)',
    );
  } else {
    unsupportedLabel(label, ctx);
  }
}

function checkService(service: TraefikService, ctx: NormalizeContext): void {
  const port = service.fields.get('loadbalancer.server.port');
  if (port !== undefined) {
    const value = INTEGER.test(port.value) ? Number(port.value) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= 1 && value <= 65535) service.port = value;
    else {
      invalidInteger(port, 1, 65535, ctx);
      service.port = 'invalid';
    }
  }
  const scheme = service.fields.get('loadbalancer.server.scheme');
  if (scheme !== undefined && scheme.value.toLowerCase() !== 'http') {
    ctx.sink.error(
      'routing.backend-scheme-unsupported',
      scheme.path,
      `backend scheme ${scheme.value} is not supported: Traefik talks plain HTTP to services`,
      'Serve plain HTTP on the routed port.',
    );
  }
  const passHost = service.fields.get('loadbalancer.passhostheader');
  if (passHost !== undefined) {
    const value = goParseBool(passHost.value);
    if (value === null) invalidBoolean(passHost, ctx);
    else if (!value) ctx.sink.warn('routing.option-ignored', passHost.path, `${passHost.key} is ignored`);
  }
}

// ---------------------------------------------------------------------------
// Routers (design-01 7.2, 7.6; PD-6)
// ---------------------------------------------------------------------------

function routerPath(router: RouterLabels): string {
  return router.fields.get('rule')?.path ?? router.firstPath;
}

/**
 * One label router. `own` is the injected route when this router carries the injected name: its
 * fields fill whatever the labels do not write (design-01 C4), and the result has origin 'labels'.
 */
function buildRoute(
  name: string,
  router: RouterLabels,
  state: ParsedRouting,
  d: ServiceDraft,
  proxy: ProxyIntent,
  own: InjectedRoute | null,
  ctx: NormalizeContext,
): RouteSpec | null {
  const path = routerPath(router);
  let valid = true;
  const rule = ruleOf(name, router, own, path, ctx);
  const syntax = router.fields.get('rulesyntax');
  if (syntax !== undefined && syntax.value.toLowerCase() !== 'v3') {
    ctx.sink.error(
      'routing.v2-rule',
      syntax.path,
      `ruleSyntax ${syntax.value} is deprecated in Traefik v3 and not supported by Dockflow`,
      'Remove `ruleSyntax` and rewrite the rule with the v3 syntax.',
    );
    valid = false;
  }
  const entryPoints = entryPointsOf(name, router, proxy, own, ctx);
  const middlewares = middlewaresOf(router, state, ctx);
  const priority = priorityOf(router, ctx);
  const tls = tlsOf(router, proxy, own, ctx);
  const port = routePort(name, router, state, d, own?.port ?? null, path, ctx);
  if (!valid || rule === null || entryPoints === null || middlewares === null || priority === undefined || tls === undefined || port === null) {
    return null;
  }
  return { router: name, rule, entryPoints, tls, middlewares, priority, port, origin: 'labels', path };
}

function ruleOf(name: string, router: RouterLabels, own: InjectedRoute | null, path: string, ctx: NormalizeContext): string | null {
  const label = router.fields.get('rule');
  if (label === undefined) {
    if (own !== null) return own.rule;
    ctx.sink.error('routing.missing-rule', path, `router ${name} has no rule`, `Add traefik.http.routers.${name}.rule=Host(\`app.example.com\`).`);
    return null;
  }
  if (label.value === '') {
    ctx.sink.error('values.empty', label.path, 'must not be empty');
    return null;
  }
  if (V2_RULE.test(label.value)) {
    ctx.sink.error(
      'routing.v2-rule',
      label.path,
      `router ${name} uses the Traefik v2 rule syntax {name:regexp}`,
      'Use the Traefik v3 syntax, for example HostRegexp(`^[a-z]+\\.example\\.com$`).',
    );
    return null;
  }
  return label.value;
}

/** K37 and PD-6: validated against the entry points design-04 2.4 renders. */
function entryPointsOf(name: string, router: RouterLabels, proxy: ProxyIntent, own: InjectedRoute | null, ctx: NormalizeContext): string[] | null {
  const label = router.fields.get('entrypoints');
  if (label === undefined) {
    if (own !== null) return [...own.entryPoints];
    // under ACME an all-entry-points router would be served over HTTP past the priority-1 redirect
    return proxy.acme ? ['websecure'] : [];
  }
  const names = sortedUnique(label.value.split(',').filter((e) => e !== ''));
  const unknown = names.filter((e) => !ENTRY_POINTS.includes(e));
  if (unknown.length > 0) {
    ctx.sink.error(
      'routing.unknown-entrypoint',
      label.path,
      `entrypoint ${unknown[0]} does not exist on Dockflow's Traefik (it defines web and websecure)`,
      'Use `web` or `websecure`.',
    );
    return null;
  }
  if (names.includes('websecure') && !proxy.acme) {
    ctx.sink.warn(
      'routing.entrypoint-not-exposed',
      label.path,
      'websecure is not reachable from outside when proxy.acme is false',
      'Set `proxy.acme: true` in config.yml to publish 443 and request certificates, or route this router through `web`.',
    );
  }
  if (names.includes('web') && proxy.acme) {
    ctx.sink.warn(
      'routing.web-served-with-acme',
      label.path,
      `router ${name} is served over plain HTTP on web; on Swarm the HTTPS redirect shadowed it`,
      'Remove `web` from its entry points to keep the redirect.',
    );
  }
  return names;
}

function middlewareProvider(written: string, provider: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.error(
    'routing.middleware-provider',
    path,
    `middleware ${written} comes from the ${provider} provider, which Dockflow's Traefik does not load`,
    'Define the middleware with `traefik.http.middlewares` labels instead.',
  );
}

/**
 * A middleware reference of a router or a chain: `@docker`, `@swarm` and `@kubernetescrd` name the
 * stack namespace (a `<namespace>-` prefix of the stack's own namespace is removed); any other
 * provider is refused. Whether the name is defined is decided once the whole file is known.
 */
function parseReference(element: string, path: string, ctx: NormalizeContext): MiddlewareReference | null {
  const at = element.lastIndexOf('@');
  if (at === -1) return { name: middlewareNameFor(element).value, written: element, provider: null, path };
  let written = element.slice(0, at);
  const provider = element.slice(at + 1);
  if (!LOCAL_PROVIDERS.has(provider.toLowerCase())) {
    middlewareProvider(written, provider, path, ctx);
    return null;
  }
  const own = `${ctx.input.identity.namespace}-`;
  if (provider.toLowerCase() === 'kubernetescrd' && written.startsWith(own)) written = written.slice(own.length);
  return { name: middlewareNameFor(written).value, written, provider: provider.toLowerCase(), path };
}

function middlewaresOf(router: RouterLabels, state: ParsedRouting, ctx: NormalizeContext): string[] | null {
  const label = router.fields.get('middlewares');
  if (label === undefined) return [];
  const names: string[] = [];
  let valid = true;
  for (const element of label.value.split(',')) {
    if (element === '') continue;
    const reference = parseReference(element, label.path, ctx);
    if (reference === null) {
      valid = false;
      continue;
    }
    state.references.push(reference);
    names.push(reference.name);
  }
  return valid ? names : null;
}

/** null when absent, undefined when invalid (reported) */
function priorityOf(router: RouterLabels, ctx: NormalizeContext): number | null | undefined {
  const label = router.fields.get('priority');
  if (label === undefined) return null;
  const value = /^[0-9]+$/.test(label.value) ? Number(label.value) : Number.NaN;
  if (Number.isSafeInteger(value)) return value;
  invalidInteger(label, 0, Number.MAX_SAFE_INTEGER, ctx);
  return undefined;
}

/** undefined when invalid (reported) */
function tlsOf(router: RouterLabels, proxy: ProxyIntent, own: InjectedRoute | null, ctx: NormalizeContext): RouteSpec['tls'] | undefined {
  const tlsLabel = router.fields.get('tls');
  const resolver = router.fields.get('tls.certresolver');
  const flag = tlsLabel === undefined ? null : goParseBool(tlsLabel.value);
  let valid = true;
  if (tlsLabel !== undefined && flag === null) {
    invalidBoolean(tlsLabel, ctx);
    valid = false;
  }
  if (resolver !== undefined) {
    if (resolver.value === CERT_RESOLVER && proxy.acme) return valid ? { certResolver: CERT_RESOLVER } : undefined;
    const why = proxy.acme ? `it provides ${CERT_RESOLVER}` : 'proxy.acme is false, so no resolver is configured';
    ctx.sink.error(
      'routing.unknown-certresolver',
      resolver.path,
      `certificate resolver ${resolver.value} is not configured on Dockflow's Traefik (${why})`,
      'Remove `tls.certresolver`, or set `proxy.acme: true` in config.yml.',
    );
    return undefined;
  }
  if (!valid) return undefined;
  if (tlsLabel !== undefined) return flag ? { certResolver: null } : null;
  return own === null ? null : own.tls;
}

function portAmbiguous(subject: string, d: ServiceDraft, candidates: readonly number[], hintName: string, path: string, ctx: NormalizeContext): void {
  const declared = candidates.length === 0 ? 'no port' : `several ports (${candidates.join(', ')})`;
  ctx.sink.error(
    'routing.port-ambiguous',
    path,
    `${subject} needs a port: ${d.composeName} declares ${declared}`,
    `Add \`traefik.http.services.${hintName}.loadbalancer.server.port=<port>\`.`,
  );
}

/** design-01 7.6 */
function routePort(
  name: string,
  router: RouterLabels,
  state: ParsedRouting,
  d: ServiceDraft,
  injectedPort: number | null,
  path: string,
  ctx: NormalizeContext,
): number | null {
  const explicit = router.fields.get('service');
  const serviceName = explicit?.value ?? (state.services.size === 1 ? [...state.services.keys()][0] : null);
  if (serviceName !== null) {
    if (serviceName.includes('@')) {
      ctx.sink.error(
        'routing.internal-service',
        explicit?.path ?? path,
        `router ${name} uses the Traefik service ${serviceName}, which Dockflow does not expose this way`,
        'Use `proxy.dashboard` in config.yml for the Traefik dashboard.',
      );
      return null;
    }
    const service = state.services.get(serviceName);
    if (service === undefined) {
      ctx.sink.error(
        'routing.unknown-service',
        explicit?.path ?? path,
        `router ${name} uses service ${serviceName}, which is not defined in the labels of this service`,
        `Define \`traefik.http.services.${serviceName}.loadbalancer.server.port\` on the same service.`,
      );
      return null;
    }
    if (service.port === 'invalid') return null;
    if (service.port !== null) return service.port;
  }
  if (injectedPort !== null) return injectedPort;
  const candidates = containerPorts(d);
  if (candidates.length === 1) return candidates[0];
  portAmbiguous(`router ${name}`, d, candidates, serviceName ?? name, path, ctx);
  return null;
}

// ---------------------------------------------------------------------------
// Middleware label walk (design-04 2.14.1 rules 2-4 and 7)
// ---------------------------------------------------------------------------

interface ObjectHolder {
  kind: 'object';
  entries: Map<string, Holder>;
}

interface ArrayHolder {
  kind: 'array';
  items: Map<number, ObjectHolder>;
  /** the option as written up to the array, and where it was first written */
  option: string;
  path: string;
}

interface Leaf {
  kind: 'leaf';
  value: unknown;
}

type Holder = ObjectHolder | ArrayHolder | Leaf;

function newObject(): ObjectHolder {
  return { kind: 'object', entries: new Map() };
}

function optionOf(label: MiddlewareLabel, count = label.fields.length): string {
  return [label.type, ...label.fields.slice(0, count)].join('.');
}

function optionUnknown(label: MiddlewareLabel, typeNode: CrdPropertyNode, hint: string, sink: DiagnosticSink): void {
  sink.error(
    'routing.middleware-option-unknown',
    label.path,
    `${optionOf(label)} is not an option of the ${typeNode.canonical} middleware`,
    hint,
  );
}

function optionNames(node: CrdPropertyNode): string[] {
  return Object.values(node.properties ?? {}).map((p) => p.canonical);
}

function nearestOptionsHint(word: string, node: CrdPropertyNode): string {
  const options = nearest(word, optionNames(node));
  return options.length === 0 ? 'Remove the label.' : `Check the spelling; the closest options are ${codeList(options)}.`;
}

function objectEndHint(label: MiddlewareLabel, node: CrdPropertyNode): string {
  if (node.properties === undefined) return `Set one of its entries, for example \`...${optionOf(label)}.<name>=<value>\`.`;
  const first = optionNames(node).sort(compareCodeUnits)[0];
  return `Set one of its options, for example \`...${optionOf(label)}.${first}=<value>\`.`;
}

const COMMA_LIST_HINT = 'Write the values as one comma-separated label, for example `...errors.status=500,502-504`.';

/** Rule 4 for one scalar; undefined once reported. */
function coerceScalar(node: CrdPropertyNode, text: string, label: MiddlewareLabel, sink: DiagnosticSink): unknown {
  const option = optionOf(label);
  const wrongType = (expects: string, hint: string): undefined => {
    sink.error('routing.middleware-option-type', label.path, `${option} expects ${expects}, got "${text}"`, hint);
    return undefined;
  };
  switch (node.type) {
    case 'integer': {
      const value = INTEGER.test(text) ? Number(text) : Number.NaN;
      return Number.isSafeInteger(value) ? value : wrongType('a whole number', 'Write a whole number, without a unit.');
    }
    case 'number':
      return NUMBER.test(text) ? Number(text) : wrongType('a number', 'Write a number, without a unit.');
    case 'boolean': {
      const value = goParseBool(text);
      return value === null ? wrongType('true or false', 'Write `true` or `false`.') : value;
    }
    case 'int-or-string': {
      if (INTEGER.test(text)) {
        const value = Number(text);
        if (Number.isSafeInteger(value)) return value;
      }
      if (DURATION.test(text)) return text;
      return wrongType(
        'a duration such as 10s or a whole number of seconds',
        'Write a duration with a unit (`ns`, `us`, `ms`, `s`, `m`, `h`), such as `500ms`, or a whole number of seconds.',
      );
    }
    default:
      return text;
  }
}

/** Rule 4 for the leaf the walk reached: arrays of scalars are split by rule 3 first. */
function coerceLeaf(node: CrdPropertyNode, label: MiddlewareLabel, sink: DiagnosticSink): unknown {
  if (node.type !== 'array') return coerceScalar(node, label.value, label, sink);
  const { items, escaped } = splitLabelList(label.value);
  if (escaped) escapedComma(label.path, optionOf(label), sink);
  const item = node.items ?? { canonical: '', type: 'string' };
  const values: unknown[] = [];
  let valid = true;
  for (const text of items) {
    const value = coerceScalar(item, text, label, sink);
    if (value === undefined) valid = false;
    else values.push(value);
  }
  return valid ? values : undefined;
}

function escapedComma(path: string, option: string, sink: DiagnosticSink): void {
  sink.warn(
    'routing.middleware-escaped-comma',
    path,
    `${option} uses \\, or \\\\ to keep a comma or a backslash in a value; Traefik on Swarm has no escape and splits the same label differently`,
    'Avoid commas inside values when the same file is also deployed on Swarm.',
  );
}

function duplicateOption(label: MiddlewareLabel, sink: DiagnosticSink): void {
  sink.error('routing.middleware-duplicate-option', label.path, `${optionOf(label)} is written by two labels`, 'Keep one of the labels.');
}

/** Adds one label to the tree; false once its problem is reported. */
function addLabel(root: ObjectHolder, typeNode: CrdPropertyNode, label: MiddlewareLabel, middleware: string, sink: DiagnosticSink): boolean {
  if (label.fields.length === 0) {
    // `compress=true`: a middleware without options, the Swarm way
    if (goParseBool(label.value) === true) return true;
    optionUnknown(label, typeNode, `Set an option of the ${typeNode.canonical} middleware, or write \`...${label.type}=true\` when it takes none.`, sink);
    return false;
  }
  let node = typeNode;
  let holder = root;
  for (let i = 0; i < label.fields.length; i++) {
    const segment = label.fields[i];
    const last = i === label.fields.length - 1;
    let key: string;
    let child: CrdPropertyNode;
    if (node.properties === undefined && node.additionalProperties !== undefined) {
      // a map: the key is user data, kept as written (`X-Forwarded-Proto`, `500`)
      key = segment;
      child = node.additionalProperties;
    } else if (node.properties !== undefined) {
      const indexed = INDEXED.exec(segment);
      const base = indexed === null ? segment : indexed[1];
      const property = node.properties[base.toLowerCase()];
      if (property === undefined) {
        optionUnknown(label, typeNode, nearestOptionsHint(base, node), sink);
        return false;
      }
      if (property.type === 'array' && property.items?.type === 'object') {
        if (indexed === null) {
          sink.error(
            'routing.middleware-index-required',
            label.path,
            `${optionOf(label, i + 1)} is a list of objects and each element needs an index`,
            `Write each element as \`...${optionOf(label, i)}.${segment}[<i>].<option>=<value>\`, counting from 0.`,
          );
          return false;
        }
        if (last) {
          optionUnknown(label, typeNode, objectEndHint(label, property.items), sink);
          return false;
        }
        let array = holder.entries.get(property.canonical);
        if (array === undefined) {
          array = { kind: 'array', items: new Map(), option: optionOf(label, i + 1).replace(/\[[0-9]+\]$/, ''), path: label.path };
          holder.entries.set(property.canonical, array);
        }
        if (array.kind !== 'array') {
          duplicateOption(label, sink);
          return false;
        }
        const index = Number(indexed[2]);
        let element = array.items.get(index);
        if (element === undefined) {
          element = newObject();
          array.items.set(index, element);
        }
        holder = element;
        node = property.items;
        continue;
      }
      if (indexed !== null) {
        // Traefik only indexes slices of structs: `errors.status[0]` does not route on Swarm either
        optionUnknown(label, typeNode, property.type === 'array' ? COMMA_LIST_HINT : nearestOptionsHint(base, node), sink);
        return false;
      }
      key = property.canonical;
      child = property;
    } else {
      // the walk already reached a scalar or a list of scalars
      optionUnknown(label, typeNode, `Remove \`.${label.fields.slice(i).join('.')}\` from the label.`, sink);
      return false;
    }

    if (last) {
      if (child.type === 'object') {
        optionUnknown(label, typeNode, objectEndHint(label, child), sink);
        return false;
      }
      const value = coerceLeaf(child, label, sink);
      if (value === undefined) return false;
      if (holder.entries.has(key)) {
        duplicateOption(label, sink);
        return false;
      }
      holder.entries.set(key, { kind: 'leaf', value });
      if (SECRET_OPTIONS.has(key) && typeof value === 'string') {
        sink.info('routing.middleware-external-secret', label.path, `middleware ${middleware} references the Secret ${value}, which Dockflow does not manage`);
      }
      return true;
    }
    if (child.type !== 'object') {
      optionUnknown(label, typeNode, `Remove \`.${label.fields.slice(i + 1).join('.')}\` from the label.`, sink);
      return false;
    }
    let next = holder.entries.get(key);
    if (next === undefined) {
      next = newObject();
      holder.entries.set(key, next);
    }
    if (next.kind !== 'object') {
      duplicateOption(label, sink);
      return false;
    }
    holder = next;
    node = child;
  }
  return true;
}

/** The plain JSON of the tree; arrays of objects must be indexed from 0 without gaps. */
function materialize(holder: ObjectHolder, sink: DiagnosticSink): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let valid = true;
  for (const [key, entry] of holder.entries) {
    if (entry.kind === 'leaf') {
      out[key] = entry.value;
    } else if (entry.kind === 'object') {
      const value = materialize(entry, sink);
      if (value === null) valid = false;
      else out[key] = value;
    } else {
      const indices = [...entry.items.keys()].sort((a, b) => a - b);
      if (indices.some((index, i) => index !== i)) {
        sink.error(
          'routing.middleware-index-gap',
          entry.path,
          `${entry.option} indices must count from 0 without gaps, got ${indices.join(', ')}`,
          'Number the elements 0, 1, 2 and so on.',
        );
        valid = false;
        continue;
      }
      const items: Record<string, unknown>[] = [];
      for (const index of indices) {
        const item = entry.items.get(index);
        const value = item === undefined ? null : materialize(item, sink);
        if (value === null) valid = false;
        else items.push(value);
      }
      out[key] = items;
    }
  }
  return valid ? out : null;
}

/**
 * design-04 2.14.1 rules 2-4 and 7 for the option labels of one middleware, walked against its CRD
 * type node: option names matched case-insensitively and emitted in the CRD's camelCase, map keys
 * kept as written, `[i]` only on arrays of objects, lists split by rule 3, scalars coerced by the
 * schema type, one leaf written twice refused. Returns `spec.<type>`, or null after reporting every
 * label that does not convert. The special cases of rule 6 are the caller's.
 */
export function walkMiddlewareLabels(
  middleware: string,
  typeNode: CrdPropertyNode,
  labels: readonly MiddlewareLabel[],
  sink: DiagnosticSink,
): Record<string, unknown> | null {
  const root = newObject();
  let valid = true;
  for (const label of labels) {
    if (!addLabel(root, typeNode, label, middleware, sink)) valid = false;
  }
  const spec = materialize(root, sink);
  return valid ? spec : null;
}

// ---------------------------------------------------------------------------
// Middlewares (design-01 7.4)
// ---------------------------------------------------------------------------

interface MiddlewareBuild {
  ctx: NormalizeContext;
  /** Middleware names defined by this file or by the sibling role */
  known: ReadonlySet<string>;
  resolveErrorsService: (middleware: string, label: MiddlewareLabel) => { name: string; port: number } | null;
}

function crossNamespaceTarget(written: string, known: ReadonlySet<string>): boolean {
  for (let i = written.indexOf('-'); i !== -1; i = written.indexOf('-', i + 1)) {
    if (known.has(middlewareNameFor(written.slice(i + 1)).value)) return true;
  }
  return false;
}

function checkReference(reference: MiddlewareReference, known: ReadonlySet<string>, ctx: NormalizeContext): boolean {
  if (known.has(reference.name)) return true;
  if (reference.provider === 'kubernetescrd' && crossNamespaceTarget(reference.written, known)) {
    ctx.sink.error(
      'routing.middleware-provider',
      reference.path,
      `middleware ${reference.written} names a middleware of another namespace through the kubernetescrd provider, which Dockflow's Traefik does not allow`,
      'Define the middleware with `traefik.http.middlewares` labels instead.',
    );
    return false;
  }
  ctx.sink.error(
    'routing.unknown-middleware',
    reference.path,
    `middleware ${reference.written} is not defined by any service of this stack`,
    `Define it with \`traefik.http.middlewares.${reference.written}.<type>...\` on a service of this stack.`,
  );
  return false;
}

/** `chain.middlewares=a,b`: one comma list of names, as on Swarm (design-01 7.4 item 3). */
function chainOf(label: MiddlewareLabel, b: MiddlewareBuild): { name: string }[] | null {
  const { items, escaped } = splitLabelList(label.value);
  if (escaped) escapedComma(label.path, optionOf(label), b.ctx.sink);
  const out: { name: string }[] = [];
  let valid = true;
  for (const element of items) {
    const reference = parseReference(element, label.path, b.ctx);
    if (reference === null || !checkReference(reference, b.known, b.ctx)) valid = false;
    else out.push({ name: reference.name });
  }
  return valid ? out : null;
}

function buildMiddleware(middleware: string, labels: readonly MiddlewareLabel[], b: MiddlewareBuild): MiddlewareSpec | null {
  const { sink } = b.ctx;
  const first = labels[0];
  const types = [...new Set(labels.map((l) => l.type.toLowerCase()))];
  if (types.length > 1) {
    const other = labels.find((l) => l.type.toLowerCase() !== types[0]) ?? first;
    sink.error(
      'routing.middleware-several-types',
      other.path,
      `middleware ${middleware} mixes types ${types[0]} and ${types[1]}`,
      'Use one type per middleware and combine them with a `chain`.',
    );
    return null;
  }
  const type = types[0];
  if (type === 'plugin') {
    sink.error(
      'routing.middleware-plugin-unsupported',
      first.path,
      'Traefik plugin middlewares cannot be configured from compose labels',
      "Dockflow's Traefik runs without the experimental plugin configuration, so a plugin middleware would fail at runtime; declare it with a Helm release instead.",
    );
    return null;
  }
  const typeNode = MIDDLEWARE_SCHEMA[type];
  if (typeNode === undefined) {
    const candidates = Object.values(MIDDLEWARE_SCHEMA)
      .map((node) => node.canonical)
      .filter((name) => name !== 'plugin');
    sink.error(
      'routing.middleware-unsupported',
      first.path,
      `Traefik middleware type "${first.type}" does not exist in Traefik ${MIDDLEWARE_SCHEMA_SOURCE.appVersion}`,
      `Check the spelling; the nearest types are ${codeList(nearest(first.type, candidates))}.`,
    );
    return null;
  }
  const name = middlewareNameFor(middleware);
  if (name.changed) sink.info('names.middleware-sanitized', first.path, `middleware ${middleware} is created as ${name.value}`);
  if (type === 'ipwhitelist') {
    sink.warn('routing.middleware-deprecated', first.path, 'middleware type ipWhiteList is deprecated in Traefik v3', 'Use `ipallowlist` with the same options.');
  }

  const auth = type === 'basicauth' || type === 'digestauth';
  let valid = true;
  let users: string[] | null = null;
  let usersLabel: MiddlewareLabel | null = null;
  let secretLabel: MiddlewareLabel | null = null;
  let usersFile = false;
  let errorsService: MiddlewareSpec['errorsService'] = null;
  let chain: { name: string }[] | null = null;
  const rest: MiddlewareLabel[] = [];
  for (const label of labels) {
    const fields = label.fields.map((f) => f.toLowerCase());
    const single = fields.length === 1 ? fields[0] : null;
    if (auth && single === 'users') {
      const { items, escaped } = splitLabelList(label.value);
      if (escaped) escapedComma(label.path, optionOf(label), sink);
      users = sortedUnique(items.filter((entry) => entry !== ''));
      usersLabel = label;
    } else if (auth && single === 'usersfile') {
      usersFile = true;
      valid = false;
      sink.error(
        'routing.users-file',
        label.path,
        `${type}.usersfile names a file on the machine running dockflow, which the cluster's Traefik cannot read`,
        `Inline the users with \`...${type}.users=user:hash\`, or create the Secret yourself and reference it with \`...${type}.secret=<name>\`.`,
      );
    } else if (type === 'errors' && single === 'service') {
      errorsService = b.resolveErrorsService(middleware, label);
      if (errorsService === null) valid = false;
    } else if (type === 'errors' && fields[0] === 'service') {
      optionUnknown(label, typeNode, 'Name the service with `...errors.service=<service>`.', sink);
      valid = false;
    } else if (type === 'chain' && single === 'middlewares') {
      chain = chainOf(label, b);
      if (chain === null) valid = false;
    } else if (type === 'chain' && fields.length > 0 && CHAIN_MIDDLEWARES.test(fields[0])) {
      optionUnknown(label, typeNode, 'Write the chain as one comma-separated label, for example `...chain.middlewares=a,b`.', sink);
      valid = false;
    } else {
      if (auth && single === 'secret') secretLabel = label;
      rest.push(label);
    }
  }
  if (auth && usersLabel !== null && secretLabel !== null) {
    sink.error(
      'routing.middleware-duplicate-option',
      secretLabel.path,
      `${type}.users and ${type}.secret both set the Secret of middleware ${middleware}`,
      'Keep either `users` or `secret`.',
    );
    valid = false;
  }
  if (auth && !usersFile && secretLabel === null && (users === null || users.length === 0)) {
    sink.error(
      'routing.middleware-missing-users',
      usersLabel?.path ?? first.path,
      `middleware ${middleware} of type ${type} defines no users`,
      `Add \`...${type}.users=user:hash\`.`,
    );
    valid = false;
  }
  const spec = walkMiddlewareLabels(middleware, typeNode, rest, sink);
  if (spec === null || !valid) return null;
  if (chain !== null) spec.middlewares = chain;
  return { name: name.value, spec: { [typeNode.canonical]: spec }, users, errorsService, path: first.path };
}

/**
 * `errors.service=<s>` (design-01 7.4): a Traefik service of this file with a port label, else a
 * compose service key of this role with exactly one container port.
 */
function errorsServiceResolver(
  drafts: readonly ServiceDraft[],
  active: readonly { d: ServiceDraft; s: ParsedRouting }[],
  ctx: NormalizeContext,
): MiddlewareBuild['resolveErrorsService'] {
  return (middleware, label) => {
    let target = label.value;
    const at = target.lastIndexOf('@');
    if (at !== -1) {
      const provider = target.slice(at + 1);
      if (!LOCAL_PROVIDERS.has(provider.toLowerCase())) {
        ctx.sink.error(
          'routing.middleware-provider',
          label.path,
          `middleware ${middleware} sends errors to ${target.slice(0, at)}, which comes from the ${provider} provider that Dockflow's Traefik does not load`,
          'Use a compose service name, or a service declared with `traefik.http.services` labels.',
        );
        return null;
      }
      target = target.slice(0, at);
    }
    for (const { d, s } of active) {
      const service = s.services.get(target);
      if (service === undefined || service.port === null) continue;
      if (service.port === 'invalid') return null;
      return { name: d.name, port: service.port };
    }
    const d = drafts.find((x) => x.composeName === target);
    if (d !== undefined) {
      const ports = containerPorts(d);
      if (ports.length === 1) return { name: d.name, port: ports[0] };
      portAmbiguous(`middleware ${middleware}`, d, ports, target, label.path, ctx);
      return null;
    }
    ctx.sink.error(
      'routing.service-undefined',
      label.path,
      `middleware ${middleware} sends errors to ${target}, which is not a service of this file`,
      `Use a compose service name, or declare the port with \`traefik.http.services.${target}.loadbalancer.server.port\`.`,
    );
    return null;
  };
}

function siblingFile(ctx: NormalizeContext): string {
  return ctx.input.role === 'app' ? 'accessories.yml' : 'docker-compose.yml';
}

/** Routes, Traefik services and middleware labels of one service (design-01 1.2, step 16). */
export function routingLabels(draft: ServiceDraft, ctx: NormalizeContext): void {
  parse(draft, ctx);
}

/**
 * The Middleware objects of the file, sorted by name, and the checks that need every service:
 * router and chain references against this file and `input.sibling.middlewares`, one router name
 * per role, `errors.service`, and one object per name (identical definitions merged by
 * canonicalJson of the built spec, K70).
 */
export function collectMiddlewares(drafts: readonly ServiceDraft[], ctx: NormalizeContext): MiddlewareSpec[] {
  const active = drafts.map((d) => ({ d, s: parse(d, ctx) })).filter((x) => x.s.active);
  const defined = new Set<string>();
  for (const { s } of active) for (const m of s.middlewares.keys()) defined.add(middlewareNameFor(m).value);
  const sibling = new Set(ctx.input.sibling.middlewares.map((m) => middlewareNameFor(m).value));
  const known = new Set([...defined, ...sibling]);

  const routerOwners = new Map<string, ServiceDraft>();
  for (const { d, s } of active) {
    for (const [name, router] of s.routers) {
      const owner = routerOwners.get(name);
      if (owner === undefined) routerOwners.set(name, d);
      else ctx.sink.error('routing.duplicate-router', routerPath(router), `router ${name} is also defined by ${owner.composeName}`, 'Give each router a unique name.');
    }
    for (const reference of s.references) checkReference(reference, known, ctx);
  }

  const build: MiddlewareBuild = { ctx, known, resolveErrorsService: errorsServiceResolver(drafts, active, ctx) };
  const built = new Map<string, { spec: MiddlewareSpec; identity: string; label: string; owner: ServiceDraft }>();
  for (const { d, s } of active) {
    for (const [label, labels] of s.middlewares) {
      const spec = buildMiddleware(label, labels, build);
      if (spec === null) continue;
      const identity = canonicalJson({ spec: spec.spec, users: spec.users, errorsService: spec.errorsService });
      const first = built.get(spec.name);
      if (first === undefined) {
        built.set(spec.name, { spec, identity, label, owner: d });
        if (sibling.has(spec.name)) {
          ctx.sink.error(
            'names.middleware-collision',
            spec.path,
            `middleware ${label} is also defined in ${siblingFile(ctx)}, and both files would create the Middleware ${spec.name}`,
            'Define the middleware in one file only; routers of both files can use it.',
          );
        }
        continue;
      }
      if (first.identity === identity) continue;
      const message =
        first.label === label
          ? `middleware ${label} is defined differently by ${first.owner.composeName}`
          : `middleware ${label} is created as ${spec.name}, which middleware ${first.label} of ${first.owner.composeName} defines differently`;
      ctx.sink.error('names.middleware-collision', spec.path, message, 'Rename one of the middlewares.');
    }
  }
  return [...built.values()].map((entry) => entry.spec).sort((a, b) => compareCodeUnits(a.name, b.name));
}

/**
 * design-01 7.5: the default route of every app service with `ports` when the environment has a
 * domain. Labels of the router `<stackName>-<service>` already override its fields (routingLabels);
 * `traefik.enable=false` opts out (C4).
 */
export function injectDefaultRoutes(drafts: readonly ServiceDraft[], ctx: NormalizeContext): void {
  const p = ctx.proxy;
  if (ctx.input.role !== 'app' || p === null || p.domain === null) return;
  const owners: { d: ServiceDraft; rule: string }[] = [];
  for (const d of drafts) {
    const state = parse(d, ctx);
    if (d.rawPorts.length === 0) continue;
    if (d.routingEnable === false) {
      ctx.sink.info('routing.injection-disabled', d.path, 'traefik.enable=false: no default route is injected');
      continue;
    }
    const injected = injectionFor(d, ctx);
    if (injected === null) continue;
    if (!state.routers.has(injected.router)) {
      d.routes.push({
        router: injected.router,
        rule: injected.rule,
        entryPoints: injected.entryPoints,
        tls: injected.tls,
        middlewares: [],
        priority: null,
        port: injected.port,
        origin: 'injected',
        path: childPath(d.path, 'ports'),
      });
      d.routes.sort((a, b) => compareCodeUnits(a.router, b.router));
      owners.push({ d, rule: injected.rule });
    }
    const route = d.routes.find((r) => r.router === injected.router);
    if (d.rawPorts.length > 1 && route?.port === injected.port) {
      ctx.sink.warn(
        'routing.injected-first-port',
        childPath(d.path, 'ports'),
        `only the first port (${injected.port}) is routed through Traefik`,
        'Add router labels to route another port.',
      );
    }
  }
  const byRule = new Map<string, ServiceDraft[]>();
  for (const { d, rule } of owners) byRule.set(rule, [...(byRule.get(rule) ?? []), d]);
  for (const [rule, services] of byRule) {
    if (services.length < 2) continue;
    for (const d of services) {
      const others = services
        .filter((o) => o !== d)
        .map((o) => o.composeName)
        .sort(compareCodeUnits);
      ctx.sink.warn(
        'routing.duplicate-injected-host',
        d.path,
        `${d.composeName} and ${others.join(', ')} all get the injected route ${rule}; Traefik sends each request to one of them`,
        `Add \`traefik.enable=false\` to \`deploy.labels\` of the services that must not answer on ${p.domain}, or give them their own router rule.`,
      );
    }
  }
}
