// The normalizer entry point (design-01 1.2): compose document -> CanonicalStack. It checks the
// value layer and the D3 key registry over the whole document, interpolates it, runs the
// top-level handlers, then the per-service handlers in the order of design-01 1.1, and ends with
// the routing pass, the stack checks and the final assembly. Every problem goes to the render's one
// sink (DESIGN-CORE 8.2) and a handler never throws on user input, so one pass reports them all.
// Pure: file contents come from input.files only.

import type { DiagnosticSink } from '../../diagnostics';
import { isServiceKey } from '../model/units';
import { childPath, emptyStack, indexPath, isPlainMap, NormalizeContext, type NormalizeInput, type NormalizeResult, newServiceDraft, type ServiceDraft, sortedKeys } from './context';
import { deploy } from './deploy';
import { env, isAbsent, reportInvalidType } from './env';
import { extension, volumeExtensions } from './extension';
import { normalizeTopLevelFiles, serviceFiles } from './files';
import { healthcheck } from './healthcheck';
import { identity } from './identity';
import { interpolateDocument } from './interpolate';
import { KEY_REGISTRY, walkKeys } from './keys';
import { normalizeTopLevelNetworks, serviceNetwork } from './network';
import { ports } from './ports';
import { collectMiddlewares, injectDefaultRoutes, routingLabels } from './routing';
import { security } from './security';
import { finalize, stackChecks } from './stack-checks';
import { normalizeTopLevelVolumes, serviceVolumes } from './volumes';

export type { NormalizeInput, NormalizeResult } from './context';

/**
 * core 3 / 8.2: render() owns the ONE sink and passes it as input.sink; translateStack gets the
 * same instance. The normalizer never lists the sink: deduplication and order happen once, in
 * render(), over both layers.
 */
export function normalizeStack(input: NormalizeInput): NormalizeResult {
  const sink = input.sink;
  const raw: unknown = input.compose.raw ?? {};
  if (!isPlainMap(raw)) {
    sink.error('yaml.not-a-mapping', '', 'the compose file must be a mapping with a services key', 'Start the file with `services:`.');
    return { stack: emptyStack(input) };
  }
  const plain = plainValues(raw, sink);
  walkKeys(plain, KEY_REGISTRY, sink);
  const doc = interpolateDocument(plain, sink);
  const ctx = new NormalizeContext(input, sink);

  const volumes = normalizeTopLevelVolumes(doc.volumes, ctx);
  // before the services: mounts read the access mode and per_replica of the volume they name
  volumeExtensions(doc.volumes, volumes, ctx);
  const fileSources = normalizeTopLevelFiles(doc.secrets, doc.configs, ctx);
  const networks = normalizeTopLevelNetworks(doc.networks, ctx);
  normalizeTopLevelMisc(doc, ctx);

  const drafts: ServiceDraft[] = [];
  const services = serviceTable(doc.services, ctx);
  for (const key of sortedKeys(services)) {
    const path = childPath('services', key);
    if (!validServiceKey(key, path, ctx)) continue;
    const node = services[key];
    if (!isPlainMap(node)) {
      sink.error('services.not-a-mapping', path, 'must be a mapping', 'Declare at least `image:` for the service.');
      continue;
    }
    const draft = newServiceDraft(key, path, ctx);
    identity(draft, node, ctx);
    security(draft, node, ctx);
    env(draft, node, ctx);
    ports(draft, node, ctx);
    serviceVolumes(draft, node, volumes, ctx);
    serviceFiles(draft, node, fileSources, ctx);
    healthcheck(draft, node, ctx);
    deploy(draft, node, ctx);
    serviceNetwork(draft, node, networks, ctx);
    extension(draft, node, ctx);
    routingLabels(draft, ctx);
    drafts.push(draft);
  }

  const middlewares = collectMiddlewares(drafts, ctx);
  injectDefaultRoutes(drafts, ctx);
  stackChecks(drafts, volumes, fileSources, networks, ctx);
  return { stack: finalize(drafts, volumes, fileSources, middlewares, ctx) };
}

// ---------------------------------------------------------------------------
// Value layer (design-01 2.2)
// ---------------------------------------------------------------------------

/** The type name of a value that is not plain YAML data, or null for a plain one. */
function unsupportedType(value: unknown): string | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : `number (${String(value)})`;
  if (Array.isArray(value) || isPlainMap(value)) return null;
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return typeof value;
}

/**
 * Every value must be null, a boolean, a finite number, a string, a list or a mapping. The loader
 * refuses tags, so what reaches this check is a non-finite number or a hand-built document. The
 * copy holds null in place of each refused value, so the handlers see the key as absent and one
 * condition is reported once. Top-level `x-*` subtrees are anchor holders, copied untouched: their
 * content is checked where it is merged.
 */
function plainValues(raw: Record<string, unknown>, sink: DiagnosticSink): Record<string, unknown> {
  const copy = (value: unknown, path: string): unknown => {
    const type = unsupportedType(value);
    if (type !== null) {
      sink.error('yaml.unsupported-value', path, `value of type ${type} is not supported`, 'Write a plain string, number, boolean, list or mapping.');
      return null;
    }
    if (Array.isArray(value)) return value.map((item, i) => copy(item, indexPath(path, i)));
    // fromEntries defines own properties, so a `__proto__` key stays a key
    if (isPlainMap(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, copy(value[key], childPath(path, key))]));
    return value;
  };
  return Object.fromEntries(Object.keys(raw).map((key) => [key, key.startsWith('x-') ? raw[key] : copy(raw[key], childPath('', key))]));
}

// ---------------------------------------------------------------------------
// Top-level keys (design-01 3)
// ---------------------------------------------------------------------------

/** `services`: absent or null is a stack without services (Helm-only projects, YAML-15). */
function serviceTable(node: unknown, ctx: NormalizeContext): Record<string, unknown> {
  if (isAbsent(node)) return {};
  if (isPlainMap(node)) return node;
  reportInvalidType(ctx, 'services', 'mapping', node);
  return {};
}

function validServiceKey(key: string, path: string, ctx: NormalizeContext): boolean {
  if (isServiceKey(key)) return true;
  ctx.sink.error('names.invalid-service-key', path, `${key} is not a valid service name`, 'Use letters, digits, `.`, `_` and `-` only.');
  return false;
}

/**
 * `version`, `name`, `include`, `models` and `jobs`. A top-level `x-dockflow` is the key walker's
 * (`extension.misplaced`); other `x-*` keys are extension fields and anchor holders, silent by spec.
 */
function normalizeTopLevelMisc(doc: Record<string, unknown>, ctx: NormalizeContext): void {
  const { sink } = ctx;
  if (Object.hasOwn(doc, 'version')) sink.info('keys.version-ignored', 'version', 'version is obsolete and ignored');
  if (Object.hasOwn(doc, 'name')) {
    const { stackName, namespace } = ctx.input.identity;
    sink.warn(
      'keys.name-ignored',
      'name',
      `name is ignored: the stack is always named ${stackName} and deployed to namespace ${namespace}`,
      'Remove `name`; `project_name` and the environment decide the names.',
    );
  }
  if (!isAbsent(doc.include)) {
    sink.error(
      'unsupported.include',
      'include',
      'include is not supported: Dockflow deploys a single compose file',
      'Inline the included services, or share fragments with a Nunjucks `{% include %}`.',
    );
  }
  if (!isAbsent(doc.models)) {
    sink.error('unsupported.models', 'models', 'models is not supported on Kubernetes deploys', 'Run the model server as a regular service with an image.');
  }
  if (!isAbsent(doc.jobs)) {
    sink.error(
      'unsupported.jobs',
      'jobs',
      'jobs is not supported in this Dockflow version',
      'For a run-to-completion task use a service with `deploy.mode: replicated-job`; scheduled jobs are not supported yet.',
    );
  }
}
