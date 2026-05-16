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

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import nunjucks from 'nunjucks';
import type { DockflowConfig, ProxyConfig } from '../utils/config';
import { getProjectRoot, getComposePath, hasDockflowYml } from '../utils/config';
import { printDebug, printWarning } from '../utils/output';
import { ConfigError } from '../utils/errors';
import { TRAEFIK_NETWORK_NAME } from '../constants';
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

/** Recursively walk a directory and return all file paths. */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

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
 */
export function parseContainerPort(port: string | number): number {
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
 * .j2 files produce an entry without the .j2 extension.
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

  const files = walkDir(dockflowDir);
  let count = 0;

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const renderedContent = njk.renderString(content, templateCtx);

    let relPath = relative(projectRoot, filePath).replace(/\\/g, '/');
    if (relPath.endsWith('.j2')) {
      relPath = relPath.slice(0, -3);
    }

    rendered.set(relPath, renderedContent);
    count++;
  }

  printDebug(`Rendered ${count} file(s) in .dockflow/`);

  if (hasDockflowYml()) {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
      const p = join(projectRoot, name);
      if (existsSync(p)) {
        rendered.set(name, njk.renderString(readFileSync(p, 'utf-8'), templateCtx));
        break;
      }
    }
    for (const name of ['accessories.yml', 'accessories.yaml']) {
      const p = join(projectRoot, name);
      if (existsSync(p)) {
        rendered.set(name, njk.renderString(readFileSync(p, 'utf-8'), templateCtx));
        break;
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

    try {
      const content = readFileSync(srcPath, 'utf-8');
      const renderedContent = njk.renderString(content, templateCtx);
      const relDest = dest.replace(/\\/g, '/');
      rendered.set(relDest, renderedContent);
      printDebug(`Rendered custom template: ${src} → ${dest}`);
    } catch (error) {
      throw new Error(`Custom template render failed for ${src}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return rendered;
}

/**
 * Render templates and extract compose content in one call.
 * Eliminates the duplicate render→findCompose→getDirPath boilerplate
 * shared between deploy.ts and build.ts.
 */
export function renderAndResolveCompose(
  ctx: ComposeRenderContext,
  templateContext?: TemplateContext | null,
): RenderedComposeResult {
  const projectRoot = getProjectRoot();

  const fullCtx: ComposeRenderContext = {
    ...ctx,
    current: templateContext?.current ?? {},
    servers: templateContext?.servers ?? {},
    cluster: templateContext?.cluster ?? {},
  };
  const rendered = renderTemplates(projectRoot, fullCtx);

  const originalComposePath = getComposePath();
  if (!originalComposePath) {
    throw new ConfigError(
      'No docker-compose.yml found',
      'Expected at docker-compose.yml or .dockflow/docker/docker-compose.yml',
    );
  }

  const composeRelPath = relative(projectRoot, originalComposePath).replace(/\\/g, '/');
  const composeContent = rendered.get(composeRelPath);
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
): void {
  const autoTag = config.options?.image_auto_tag !== false;
  const useRegistry = config.registry?.enabled === true;
  const registryUrl = config.registry?.url ?? '';
  const registryNs = config.registry?.namespace ?? '';
  const registryPrefix = registryNs
    ? `${registryUrl}/${registryNs}`
    : registryUrl;

  for (const [name, svc] of Object.entries(compose.services)) {
    const originalImage = svc.image as string | undefined;
    if (!originalImage) continue;

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

/**
 * Inject Traefik routing labels for services that expose ports.
 *
 * Only runs if `config.proxy.enabled` is true and a domain is defined
 * for the given environment.
 */
export function injectTraefikLabels(
  compose: ParsedCompose,
  proxy: ProxyConfig,
  stackName: string,
  env: string,
): void {
  if (!proxy.enabled) return;

  const domain = proxy.domains?.[env];
  if (!domain) return;

  const acme = proxy.acme !== false;
  const entrypoint = acme ? 'websecure' : 'web';
  let hasProxiedService = false;

  for (const [svcName, svc] of Object.entries(compose.services)) {
    const ports = svc.ports as (string | number)[] | undefined;
    if (!ports || ports.length === 0) continue;

    hasProxiedService = true;
    if (ports.length > 1) {
      printWarning(`Service "${svcName}" exposes ${ports.length} ports — only the first (${ports[0]}) will be routed via Traefik`);
    }
    const containerPort = parseContainerPort(ports[0]);
    const routerName = `${stackName}-${svcName}`;

    const traefikLabels: string[] = [
      'traefik.enable=true',
      `traefik.docker.network=${TRAEFIK_NETWORK_NAME}`,
      `traefik.http.routers.${routerName}.rule=Host(\`${domain}\`)`,
      `traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
      `traefik.http.services.${routerName}.loadbalancer.server.port=${containerPort}`,
    ];
    if (acme) {
      traefikLabels.push(`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`);
    }

    const deploy = (svc.deploy ?? {}) as Record<string, unknown>;
    const existingLabels = deploy.labels;
    let labelList: string[];

    if (Array.isArray(existingLabels)) {
      labelList = [...existingLabels.map(String), ...traefikLabels];
    } else if (existingLabels && typeof existingLabels === 'object') {
      labelList = [
        ...Object.entries(existingLabels as Record<string, string>).map(
          ([k, v]) => `${k}=${v}`,
        ),
        ...traefikLabels,
      ];
    } else {
      labelList = traefikLabels;
    }

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

  if (hasProxiedService) {
    const topNets = (compose.networks ?? {}) as Record<string, unknown>;
    topNets[TRAEFIK_NETWORK_NAME] = { external: true };
    compose.networks = topNets;
    compose.raw.networks = topNets;
  }

  compose.raw.services = compose.services;
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

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
export function getImages(compose: ParsedCompose): string[] {
  const images = new Set<string>();
  for (const svc of Object.values(compose.services)) {
    const img = svc.image as string | undefined;
    if (img) images.add(img);
  }
  return [...images];
}
