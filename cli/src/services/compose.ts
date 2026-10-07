/**
 * Compose — template rendering + docker-compose YAML manipulation.
 *
 * Handles Jinja2/nunjucks template rendering, YAML load/serialize,
 * image tag updates, Swarm deploy config injection, and Traefik label
 * generation — all in pure TypeScript.
 *
 * Template rendering is entirely in-memory — no files are ever
 * written to disk. Returns a Map<relativePath, renderedContent>.
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { walkDir } from '../utils/fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import nunjucks from 'nunjucks';
import {
  describeInsertedPlaceholders,
  describeShellPlaceholders,
  findInsertedPlaceholders,
  findShellPlaceholders,
} from './compose-lint';
import { findUndefinedEnvReferences, describeUndefinedEnvReferences } from './template-lint';
import type { DockflowConfig, ProxyConfig, ProxyRoute } from '../utils/config';
import { getAccessoriesPath, getProjectRoot, getComposePath, getLayout } from '../utils/config';
import { printDebug, printDim, printWarning } from '../utils/output';
import { ConfigError } from '../utils/errors';
import { DOCKFLOW_PLUGINS_DIR, TRAEFIK_NETWORK_NAME } from '../constants';
import type { TemplateContext } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposeRenderContext {
  env: string;
  version: string;
  branch: string;
  project_name: string;
  config: DockflowConfig;
  servers?: Record<string, unknown>;
  cluster?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Result of renderTemplates — a Map of relative paths to rendered content.
 * No files are written to disk. Keys use forward slashes.
 */
export type RenderedFiles = Map<string, string>;

export interface ParsedCompose {
  raw: Record<string, unknown>;
  services: Record<string, Record<string, unknown>>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

export interface RenderedComposeResult {
  rendered: RenderedFiles;
  composeContent: string;
  composeDirPath: string;
  projectRoot: string;
  /** The context every file under .dockflow/ was rendered with. */
  renderContext: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Swarm deploy defaults
// ---------------------------------------------------------------------------

const DEFAULT_UPDATE_CONFIG: Record<string, unknown> = {
  parallelism: 1,
  delay: '10s',
  failure_action: 'rollback',
  monitor: '30s',
  max_failure_ratio: 0,
  order: 'start-first',
};

const DEFAULT_ROLLBACK_CONFIG: Record<string, unknown> = {
  parallelism: 1,
  delay: '5s',
  monitor: '15s',
  order: 'start-first',
};

const DEFAULT_RESTART_POLICY: Record<string, unknown> = {
  condition: 'on-failure',
  delay: '5s',
  max_attempts: 3,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deep merge `source` into `target`.
 * Source values win at leaf level (scalars, arrays).
 * Objects are merged recursively.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Heuristic: does an image string already contain a registry domain?
 * e.g. "registry.io/ns/myapp" → true, "myapp" → false
 */
function hasRegistryDomain(image: string): boolean {
  const firstSlash = image.indexOf('/');
  if (firstSlash === -1) return false;
  const prefix = image.substring(0, firstSlash);
  return prefix.includes('.') || prefix.includes(':');
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Parse the container port from a docker-compose port entry.
 *
 * Supported formats:
 *   "80"                 → 80
 *   "8080:80"            → 80
 *   "0.0.0.0:8080:80"   → 80
 *   "127.0.0.1:8080:80" → 80
 *   "80/tcp"             → 80
 *   "8080:80/tcp"        → 80
 *   { target: 80 }       → 80   (long syntax)
 */
export function parseContainerPort(port: unknown): number {
  if (port && typeof port === 'object') return Number((port as Record<string, unknown>).target);
  const raw = String(port);
  const withoutProto = raw.split('/')[0];
  const parts = withoutProto.split(':');
  return parseInt(parts[parts.length - 1], 10);
}

/**
 * Split a Docker image reference into name and tag.
 *
 * The tag separator is the last colon AFTER the last slash.
 * This correctly handles registry:port URLs:
 *   "registry:5000/app:v1"  → { name: "registry:5000/app", tag: "v1" }
 *   "myapp:latest"          → { name: "myapp", tag: "latest" }
 *   "myapp"                 → { name: "myapp", tag: undefined }
 *   "registry:5000/app"     → { name: "registry:5000/app", tag: undefined }
 */
export function parseImageRef(image: string): { name: string; tag: string | undefined } {
  const lastSlash = image.lastIndexOf('/');
  const tagSep = image.indexOf(':', lastSlash + 1);
  if (tagSep === -1) {
    return { name: image, tag: undefined };
  }
  return { name: image.substring(0, tagSep), tag: image.substring(tagSep + 1) };
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Render all templates purely in memory.
 * The original project files are NEVER modified — nothing is written to disk.
 *
 * Returns a Map<relativePath, renderedContent> where keys use forward slashes
 * and are relative to projectRoot (e.g. ".dockflow/docker/docker-compose.yml").
 *
 * Filenames are preserved verbatim — name a file exactly as it should land on the server.
 * All files inside .dockflow/ are rendered through Nunjucks.
 * Custom templates from config.templates are rendered at their dest path.
 */
export function renderTemplates(
  projectRoot: string,
  ctx: ComposeRenderContext,
): RenderedFiles {
  const njk = nunjucks.configure({ autoescape: false, noCache: true });
  const dockflowDir = join(projectRoot, '.dockflow');
  const rendered: RenderedFiles = new Map();

  const templateCtx: Record<string, unknown> = {
    ...ctx,
    ...ctx.config,
  };

  // With a server resolved, warn about current.env references that render as empty
  // strings. Without one — a build with no matching environment — every reference is
  // undefined, and the caller has already said so.
  const current = ctx.current as { name?: string; env?: Record<string, unknown> } | undefined;
  const envKeys = current?.env !== null && typeof current?.env === 'object' ? Object.keys(current.env) : null;
  const lint = (file: string, content: string): void => {
    if (!envKeys) return;
    const references = findUndefinedEnvReferences(content, envKeys);
    for (const line of describeUndefinedEnvReferences(file, references, current?.name ?? 'this server')) {
      printWarning(line);
    }
  };

  const render = (file: string, content: string): string => {
    try {
      return njk.renderString(content, templateCtx);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace('(unknown path) ', '');
      throw new ConfigError(`${file}: ${message}`);
    }
  };

  const files = walkDir(dockflowDir);
  let count = 0;

  for (const filePath of files) {
    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');

    // Plugin files are rendered by the plugin expansion, in the plugin's own
    // scope. Rendering them here would turn every `{{ inputs.x }}` into an empty
    // string and leave the corrupted copy where the build context picks it up.
    if (relPath.startsWith(`${DOCKFLOW_PLUGINS_DIR}/`)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const renderedContent = render(relPath, content);
    lint(relPath, content);

    rendered.set(relPath, renderedContent);
    count++;
  }

  printDebug(`Rendered ${count} file(s) in .dockflow/`);

  // In flat layout, dockflow.yml and the root-level compose and accessories are not
  // inside .dockflow/ so they aren't picked up by the walk above — render them here.
  const layout = getLayout();
  if (layout.type === 'flat') {
    for (const absPath of [layout.configPath, layout.composePath, layout.accessoriesPath]) {
      if (!absPath) continue;
      const relPath = relative(projectRoot, absPath).replace(/\\/g, '/');
      if (!relPath.startsWith('.dockflow/')) {
        const content = readFileSync(absPath, 'utf-8');
        rendered.set(relPath, render(relPath, content));
        lint(relPath, content);
      }
    }
  }

  const templates = ctx.config.templates ?? [];
  for (const tmpl of templates) {
    const src = typeof tmpl === 'string' ? tmpl : tmpl.src;
    const dest = typeof tmpl === 'string' ? tmpl : tmpl.dest;
    const srcPath = join(projectRoot, src);

    if (!existsSync(srcPath)) {
      printDebug(`Custom template not found: ${src}`);
      continue;
    }

    const content = readFileSync(srcPath, 'utf-8');
    const renderedContent = render(src, content);
    lint(src, content);
    rendered.set(dest.replace(/\\/g, '/'), renderedContent);
    printDebug(`Rendered custom template: ${src} → ${dest}`);
  }

  return rendered;
}

/** A copy of the render context whose strings hold no `$`. */
function stripDollars(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('$', '');
  if (Array.isArray(value)) return value.map(stripDollars);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripDollars(item)]));
  }
  return value;
}

/**
 * Warnings for the `$` placeholders Docker would empty in a stack file.
 *
 * Placeholders are looked for in the file as written, where they are the user's own text.
 * In the rendered file they may be part of an inserted secret.
 */
function placeholderWarnings(
  absPath: string,
  rendered: string,
  renderContext: Record<string, unknown>,
  declaredKeys: string[],
): string[] {
  const written = readFileSync(absPath, 'utf-8');
  const withoutDollars = nunjucks
    .configure({ autoescape: false, noCache: true })
    .renderString(written, stripDollars(renderContext) as object);
  return [
    ...describeShellPlaceholders(findShellPlaceholders(written, declaredKeys)),
    ...describeInsertedPlaceholders(findInsertedPlaceholders(rendered, withoutDollars)),
  ];
}

/**
 * Render templates and extract compose content in one call.
 * Eliminates the duplicate render→findCompose→getDirPath boilerplate
 * shared between deploy.ts and build.ts.
 */
export function renderAndResolveCompose(
  ctx: ComposeRenderContext,
  templateContext?: TemplateContext | null,
  options: { uploadOnly?: boolean } = {},
): RenderedComposeResult {
  const projectRoot = getProjectRoot();

  const fullCtx: ComposeRenderContext = {
    ...ctx,
    current: templateContext?.current ?? {},
    servers: templateContext?.servers ?? {},
    cluster: templateContext?.cluster ?? {},
  };
  const rendered = renderTemplates(projectRoot, fullCtx);
  const renderContext: Record<string, unknown> = { ...fullCtx, ...fullCtx.config };

  const originalComposePath = getComposePath();
  if (!originalComposePath) {
    if (options.uploadOnly) {
      return {
        rendered,
        composeContent: 'services: {}\n',
        composeDirPath: join(projectRoot, '.dockflow', 'docker'),
        projectRoot,
        renderContext,
      };
    }
    throw new ConfigError(
      'No docker-compose.yml found',
      'Expected at docker-compose.yml or .dockflow/docker/docker-compose.yml',
    );
  }

  const composeRelPath = relative(projectRoot, originalComposePath).replace(/\\/g, '/');
  const composeContent = rendered.get(composeRelPath);

  if (composeContent) {
    // Warn rather than fail: an already-working deployment must not be blocked by this.
    const declaredKeys = Object.keys(
      (templateContext?.current as { env?: Record<string, string> } | undefined)?.env ?? {},
    );
    const accessoriesPath = getAccessoriesPath();
    for (const absPath of [originalComposePath, accessoriesPath]) {
      if (!absPath) continue;
      const relPath = relative(projectRoot, absPath).replace(/\\/g, '/');
      const content = rendered.get(relPath);
      if (!content) continue;
      for (const line of placeholderWarnings(absPath, content, renderContext, declaredKeys)) {
        printWarning(`${relPath} ${line}`);
      }
    }
  }
  if (!composeContent) {
    throw new ConfigError(
      'Compose file not found in rendered templates',
      `Expected key "${composeRelPath}" in rendered files map`,
    );
  }

  return {
    rendered,
    composeContent,
    composeDirPath: dirname(originalComposePath),
    projectRoot,
    renderContext,
  };
}

// ---------------------------------------------------------------------------
// YAML load / serialize
// ---------------------------------------------------------------------------

/**
 * Load and parse a docker-compose YAML file from disk.
 */
export function load(composePath: string): ParsedCompose {
  const content = readFileSync(composePath, 'utf-8');
  return loadFromString(content);
}

/**
 * Parse a docker-compose YAML string into a ParsedCompose.
 */
export function loadFromString(content: string): ParsedCompose {
  const raw = parseYaml(content) as Record<string, unknown>;

  return {
    raw,
    services: (raw.services ?? {}) as Record<string, Record<string, unknown>>,
    networks: raw.networks as Record<string, unknown> | undefined,
    volumes: raw.volumes as Record<string, unknown> | undefined,
  };
}

/**
 * Serialize a ParsedCompose back to a YAML string.
 */
export function serialize(compose: ParsedCompose): string {
  const obj: Record<string, unknown> = { ...compose.raw };
  obj.services = compose.services;
  if (compose.networks) obj.networks = compose.networks;
  if (compose.volumes) obj.volumes = compose.volumes;

  return stringifyYaml(obj, { lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Image tags
// ---------------------------------------------------------------------------

/**
 * Update image tags in all services.
 *
 * If `image_auto_tag` is true (default):
 *   - Strips existing tag: "my-api:old" → "my-api"
 *   - Appends env + version: "my-api" → "my-api-{env}:{version}"
 *
 * If `registry.enabled`:
 *   - Prepends registry prefix (only if image doesn't already contain a registry domain)
 */
export function updateImageTags(
  compose: ParsedCompose,
  config: DockflowConfig,
  env: string,
  version: string,
  servicesFilter?: string,
): void {
  const autoTag = config.options?.image_auto_tag !== false;
  const useRegistry = config.registry?.enabled === true;
  const registryUrl = config.registry?.url ?? '';
  const registryNs = config.registry?.namespace ?? '';
  const registryPrefix = registryNs
    ? `${registryUrl}/${registryNs}`
    : registryUrl;
  const filterSet = servicesFilter
    ? new Set(servicesFilter.split(',').map(s => s.trim()))
    : null;

  for (const [name, svc] of Object.entries(compose.services)) {
    const originalImage = svc.image as string | undefined;
    if (!originalImage) continue;
    if (filterSet && !filterSet.has(name)) continue;

    let newImage: string;

    if (autoTag) {
      const imageWithoutTag = parseImageRef(originalImage).name;
      newImage = `${imageWithoutTag}-${env}:${version}`;
    } else {
      newImage = originalImage;
    }

    if (useRegistry && !hasRegistryDomain(parseImageRef(newImage).name)) {
      newImage = `${registryPrefix}/${newImage}`;
    }

    compose.services[name] = { ...svc, image: newImage };
  }

  compose.raw.services = compose.services;
}

// ---------------------------------------------------------------------------
// Swarm / accessories deploy defaults
// ---------------------------------------------------------------------------

/**
 * Inject Swarm deploy defaults (update_config + rollback_config) into all services.
 * User-provided values take precedence via deep merge.
 */
/**
 * Drop `build` from every service.
 *
 * Dockflow reads that section to know what to build, but `docker stack deploy` cannot build
 * anything and prints "Ignoring unsupported options: build" on every deployment. Removing it
 * once the image is built keeps that noise out of the output.
 */
export function stripBuildSections(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    if (!('build' in svc)) continue;

    const { build: _build, ...rest } = svc as Record<string, unknown>;
    compose.services[name] = rest as typeof svc;
  }
}

export function injectSwarmDefaults(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    const userDeploy = (svc.deploy ?? {}) as Record<string, unknown>;

    const mergedUpdate = deepMerge(
      DEFAULT_UPDATE_CONFIG,
      (userDeploy.update_config ?? {}) as Record<string, unknown>,
    );
    const mergedRollback = deepMerge(
      DEFAULT_ROLLBACK_CONFIG,
      (userDeploy.rollback_config ?? {}) as Record<string, unknown>,
    );

    const mergedDeploy = {
      ...userDeploy,
      update_config: mergedUpdate,
      rollback_config: mergedRollback,
    };

    compose.services[name] = { ...svc, deploy: mergedDeploy };
  }

  compose.raw.services = compose.services;
}

/**
 * Inject accessories-specific deploy config (restart_policy only).
 * User values take precedence.
 */
export function injectAccessoriesDefaults(compose: ParsedCompose): void {
  for (const [name, svc] of Object.entries(compose.services)) {
    const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
    const userRestart = (deploy.restart_policy ?? {}) as Record<string, unknown>;

    const mergedRestart = deepMerge(DEFAULT_RESTART_POLICY, userRestart);

    const mergedDeploy = {
      ...deploy,
      replicas: deploy.replicas ?? 1,
      restart_policy: mergedRestart,
    };

    compose.services[name] = { ...svc, deploy: mergedDeploy };
  }

  compose.raw.services = compose.services;
}

// ---------------------------------------------------------------------------
// Traefik labels
// ---------------------------------------------------------------------------

/** `deploy.labels` as `key=value` entries, from the list or the map form of compose */
function labelEntries(labels: unknown): string[] {
  if (Array.isArray(labels)) return labels.map(String);
  if (labels && typeof labels === 'object') {
    return Object.entries(labels as Record<string, unknown>).map(([k, v]) => `${k}=${v ?? ''}`);
  }
  return [];
}

/** label values by key; a later entry wins, as when Docker reads the list */
function labelValues(entries: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    values.set(eq === -1 ? entry : entry.slice(0, eq), eq === -1 ? '' : entry.slice(eq + 1));
  }
  return values;
}

/** the false values of Go's strconv.ParseBool, which Traefik reads `traefik.enable` with */
function isFalseLabel(value: string): boolean {
  return ['0', 'f', 'F', 'false', 'FALSE', 'False'].includes(value.trim());
}

/** the labels a service sets itself in `deploy.labels`, by key */
function ownLabels(svc: Record<string, unknown>): Map<string, string> {
  return labelValues(labelEntries((svc.deploy as Record<string, unknown> | undefined)?.labels));
}

/** whether the service sets `traefik.enable=false` itself */
function optsOutOfTraefik(svc: Record<string, unknown>): boolean {
  return isFalseLabel(ownLabels(svc).get('traefik.enable') ?? 'true');
}

/** the container port of the service's first `ports:` entry, else of its first `expose:` entry */
function firstContainerPort(svc: Record<string, unknown>): number | undefined {
  for (const key of ['ports', 'expose']) {
    const list = svc[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const port = parseContainerPort(list[0]);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return undefined;
}

/** the router name of the route on proxy.domains */
function defaultRouter(stackName: string, svcName: string): string {
  return `${stackName}-${svcName}`;
}

/**
 * The services that answer on proxy.domains: those exposing ports, unless proxy.routes lists them,
 * they set traefik.enable=false, or they give the router a rule of their own.
 */
function onDefaultDomain(compose: ParsedCompose, proxy: ProxyConfig, stackName: string): string[] {
  const listed = new Set((proxy.routes ?? []).map((route) => route.service));
  return Object.entries(compose.services)
    .filter(([name, svc]) => Array.isArray(svc.ports) && svc.ports.length > 0 && !listed.has(name) && !optsOutOfTraefik(svc))
    .filter(([name, svc]) => !ownLabels(svc).has(`traefik.http.routers.${defaultRouter(stackName, name)}.rule`))
    .map(([name]) => name);
}

/**
 * Add Traefik labels to a service and attach it to the proxy network.
 * A label the service sets itself wins over the injected one.
 */
function attachToProxy(compose: ParsedCompose, svcName: string, labels: readonly [string, string][]): void {
  const svc = compose.services[svcName];
  const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
  const existing = labelEntries(deploy.labels);
  const own = labelValues(existing);
  const labelList = [...existing, ...labels.filter(([key]) => !own.has(key)).map(([key, value]) => `${key}=${value}`)];

  const existingNets = svc.networks;
  let newNets: unknown;

  if (Array.isArray(existingNets)) {
    const current = existingNets.map(String);
    newNets = [...new Set([...current, TRAEFIK_NETWORK_NAME])];
  } else if (existingNets && typeof existingNets === 'object') {
    const netObj = { ...(existingNets as Record<string, unknown>) };
    if (!(TRAEFIK_NETWORK_NAME in netObj)) {
      netObj[TRAEFIK_NETWORK_NAME] = null;
    }
    newNets = netObj;
  } else {
    newNets = ['default', TRAEFIK_NETWORK_NAME];
  }

  compose.services[svcName] = {
    ...svc,
    deploy: { ...deploy, labels: labelList },
    networks: newNets,
  };
}

/**
 * Inject Traefik routing labels.
 *
 * Each route of `proxy.routes` whose service is in this compose gets a router of its own, and
 * those services get no other route. With `defaultRoute` (the app stack, by default), every other
 * service that exposes ports answers on `proxy.domains[env]`. A service opts out with
 * `traefik.enable=false` in `deploy.labels`, and every label it sets itself wins over the
 * injected one.
 *
 * Returns whether a service of the compose is routed.
 */
export function injectTraefikLabels(
  compose: ParsedCompose,
  proxy: ProxyConfig,
  stackName: string,
  env: string,
  options: { defaultRoute?: boolean } = {},
): boolean {
  if (!proxy.enabled) return false;

  const acme = proxy.acme !== false;
  const entrypoint = acme ? 'websecure' : 'web';
  let routed = false;

  // A router per route, each sending to a Traefik service of its own: routes of one service can
  // reach different ports. Routers are numbered among the routes of their service.
  const listed = new Map<string, ProxyRoute[]>();
  for (const route of proxy.routes ?? []) listed.set(route.service, [...(listed.get(route.service) ?? []), route]);

  for (const [svcName, routes] of listed) {
    if (!Object.hasOwn(compose.services, svcName)) continue;
    const svc = compose.services[svcName];
    if (!routes.some((route) => route.domains[env])) {
      printDim(`Service "${svcName}" has no route for ${env} in proxy.routes: Traefik does not serve it there`);
      continue;
    }
    if (optsOutOfTraefik(svc)) {
      printWarning(`Service "${svcName}" sets traefik.enable=false: its routes in proxy.routes are not applied`);
      continue;
    }

    const labels: [string, string][] = [];
    routes.forEach((route, i) => {
      const domain = route.domains[env];
      const port = route.port ?? firstContainerPort(svc);
      if (!domain) return;
      if (port === undefined) {
        printWarning(`Service "${svcName}" declares no port: its route on ${domain} needs one`);
        return;
      }
      const router = `${stackName}-${svcName}-route${i + 1}`;
      labels.push(
        [`traefik.http.routers.${router}.rule`, route.path ? `Host(\`${domain}\`) && PathPrefix(\`${route.path}\`)` : `Host(\`${domain}\`)`],
        [`traefik.http.routers.${router}.entrypoints`, entrypoint],
        [`traefik.http.routers.${router}.service`, router],
        [`traefik.http.services.${router}.loadbalancer.server.port`, String(port)],
      );
      if (acme) labels.push([`traefik.http.routers.${router}.tls.certresolver`, 'letsencrypt']);
    });
    if (labels.length === 0) continue;

    attachToProxy(compose, svcName, [['traefik.enable', 'true'], ['traefik.docker.network', TRAEFIK_NETWORK_NAME], ...labels]);
    routed = true;
  }

  const domain = proxy.domains?.[env];
  if (options.defaultRoute !== false && domain) {
    const onDomain = onDefaultDomain(compose, proxy, stackName);

    for (const [svcName, svc] of Object.entries(compose.services)) {
      const ports = svc.ports as unknown[] | undefined;
      if (!ports || ports.length === 0 || listed.has(svcName)) continue;
      if (optsOutOfTraefik(svc)) {
        printDim(`Service "${svcName}" sets traefik.enable=false: no route is injected`);
        continue;
      }

      const containerPort = parseContainerPort(ports[0]);
      if (ports.length > 1) {
        printWarning(`Service "${svcName}" exposes ${ports.length} ports — only the first (${containerPort}) will be routed via Traefik`);
      }
      const routerName = defaultRouter(stackName, svcName);

      const traefikLabels: [string, string][] = [
        ['traefik.enable', 'true'],
        ['traefik.docker.network', TRAEFIK_NETWORK_NAME],
        [`traefik.http.routers.${routerName}.rule`, `Host(\`${domain}\`)`],
        [`traefik.http.routers.${routerName}.entrypoints`, entrypoint],
        [`traefik.http.services.${routerName}.loadbalancer.server.port`, String(containerPort)],
      ];
      if (acme) {
        traefikLabels.push([`traefik.http.routers.${routerName}.tls.certresolver`, 'letsencrypt']);
      }
      attachToProxy(compose, svcName, traefikLabels);
      routed = true;
    }

    if (onDomain.length > 1) {
      printWarning(
        `Services ${onDomain.join(', ')} all answer on ${domain}: Traefik sends each request to one of them. ` +
          'Add traefik.enable=false to deploy.labels of the services that must not, or give them their own route in proxy.routes.',
      );
    }
  }

  if (routed) {
    const topNets = (compose.networks ?? {}) as Record<string, unknown>;
    topNets[TRAEFIK_NETWORK_NAME] = { external: true };
    compose.networks = topNets;
    compose.raw.networks = topNets;
  }

  compose.raw.services = compose.services;
  return routed;
}

/**
 * What keeps proxy.routes from being served in this environment, one message each: a route whose
 * service is in neither compose file or in both, a service Traefik knows no port of, two routes
 * on the same domain and path, a route without a path on the domain of proxy.domains while
 * services answer there, or on the dashboard's. `accessories` is null when the project has no
 * accessories.yml.
 */
export function checkProxyRoutes(
  proxy: ProxyConfig,
  env: string,
  stackName: string,
  app: ParsedCompose,
  accessories: ParsedCompose | null,
): string[] {
  if (!proxy.enabled) return [];

  const problems: string[] = [];
  const claimed = new Map<string, number>();
  const defaultDomain = proxy.domains?.[env]?.toLowerCase();
  const onDomain = defaultDomain ? onDefaultDomain(app, proxy, stackName) : [];
  const dashboardDomain = proxy.dashboard?.enabled ? proxy.dashboard.domain?.toLowerCase() : undefined;

  (proxy.routes ?? []).forEach((route, i) => {
    const domain = route.domains[env]?.toLowerCase();
    if (!domain) return;
    const at = `proxy.routes[${i}]`;
    const inApp = Object.hasOwn(app.services, route.service);
    const inAccessories = accessories !== null && Object.hasOwn(accessories.services, route.service);

    if (!inApp && !inAccessories) {
      problems.push(`${at}: no service "${route.service}" in docker-compose.yml or accessories.yml`);
    } else if (inApp && inAccessories) {
      problems.push(`${at}: docker-compose.yml and accessories.yml both have a service "${route.service}"; rename one of them`);
    } else {
      const svc = (inApp ? app : (accessories as ParsedCompose)).services[route.service];
      if (route.port === undefined && firstContainerPort(svc) === undefined) {
        problems.push(`${at}: service "${route.service}" declares no port; set port to the one it listens on`);
      }
    }

    const target = `${domain}${route.path ?? ''}`;
    const first = claimed.get(target);
    if (first !== undefined) {
      problems.push(`${at}: proxy.routes[${first}] already routes ${target}`);
    } else {
      claimed.set(target, i);
    }
    if (domain === defaultDomain && !route.path && onDomain.length > 0) {
      problems.push(
        `${at}: ${domain} is also proxy.domains.${env}, the domain of the default route (${onDomain.join(', ')}); ` +
          'give the route a path, or add traefik.enable=false to deploy.labels of those services',
      );
    }
    if (domain === dashboardDomain && !route.path) {
      problems.push(`${at}: ${domain} is also proxy.dashboard.domain; give the route a path, or the dashboard another domain`);
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of compose containing only the specified services.
 * Networks and volumes are kept intact so external resource creation still works.
 */
export function filterServices(compose: ParsedCompose, filter: string[]): ParsedCompose {
  const filterSet = new Set(filter);
  return {
    ...compose,
    services: Object.fromEntries(
      Object.entries(compose.services).filter(([name]) => filterSet.has(name)),
    ),
  };
}

/**
 * Build a release compose for a partial deploy (--only).
 *
 * Starts from the local compose (preserves new services, config changes), then
 * for services NOT being deployed that also exist in the server release, replaces
 * their image tag with the one from the server so the release reflects what is
 * actually running for those services.
 *
 * Services only in local  (new, not yet on server) → keep local image tag.
 * Services only in server (removed locally)        → absent from release (correct).
 */
export function syncNonTargetedImageTags(
  local: ParsedCompose,
  server: ParsedCompose,
  targetedServices: string[],
): ParsedCompose {
  const targeted = new Set(targetedServices);
  const services = { ...local.services };

  for (const [name, svc] of Object.entries(services)) {
    if (targeted.has(name)) continue;
    const serverImage = server.services[name]?.image as string | undefined;
    if (serverImage) services[name] = { ...svc, image: serverImage };
  }

  return { ...local, services };
}

/**
 * Extract all external network names from a compose object.
 */
export function getExternalNetworks(compose: ParsedCompose): string[] {
  if (!compose.networks) return [];
  return Object.entries(compose.networks)
    .filter(([, value]) => {
      if (value && typeof value === 'object') {
        return (value as Record<string, unknown>).external === true;
      }
      return false;
    })
    .map(([name]) => name);
}

/**
 * Extract all external volume names from a compose object.
 */
export function getExternalVolumes(compose: ParsedCompose): string[] {
  if (!compose.volumes) return [];
  return Object.entries(compose.volumes)
    .filter(([, value]) => {
      if (value && typeof value === 'object') {
        return (value as Record<string, unknown>).external === true;
      }
      return false;
    })
    .map(([name]) => name);
}

/**
 * Extract all image tags referenced in services.
 * Returns a deduplicated list.
 */
export function hasServices(compose: ParsedCompose): boolean {
  return Object.keys(compose.services).length > 0;
}

export function getImages(compose: ParsedCompose): string[] {
  const images = new Set<string>();
  for (const svc of Object.values(compose.services)) {
    const img = svc.image as string | undefined;
    if (img) images.add(img);
  }
  return [...images];
}
