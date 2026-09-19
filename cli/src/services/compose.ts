/**
 * Compose — template rendering + docker-compose YAML manipulation.
 *
 * Handles Jinja2/nunjucks template rendering, YAML load/serialize,
 * image tag updates, accessories and Swarm deploy config injection, and
 * Traefik label generation — all in pure TypeScript. Both orchestrators
 * load compose files through `loadFromString`.
 *
 * Template rendering is entirely in-memory — no files are ever
 * written to disk. Returns a Map<relativePath, renderedContent>.
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import { walkDir } from '../utils/fs';
import {
  type Alias,
  type Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  Scalar,
  stringify as stringifyYaml,
  visit,
  type YAMLError,
  type YAMLMap,
} from 'yaml';
import nunjucks from 'nunjucks';
import {
  describeInsertedPlaceholders,
  describeShellPlaceholders,
  findInsertedPlaceholders,
  findShellPlaceholders,
  lintsStackFiles,
} from './compose-lint';
import { findUndefinedEnvReferences, describeUndefinedEnvReferences } from './template-lint';
import type { OrchestratorKind } from './orchestrator/interfaces';
import type { DockflowConfig, ProxyConfig } from '../utils/config';
import { getAccessoriesPath, getProjectRoot, getComposePath, getLayout } from '../utils/config';
import { printDebug, printWarning } from '../utils/output';
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
// Deploy defaults
// ---------------------------------------------------------------------------

/**
 * Dockflow's `update_config` for app services. Swarm merges it into the stack file; on k3s the
 * normalizer falls back to it field by field and never materializes it.
 */
export const DEFAULT_UPDATE_CONFIG = Object.freeze({
  parallelism: 1,
  delay: '10s',
  failure_action: 'rollback',
  monitor: '30s',
  max_failure_ratio: 0,
  order: 'start-first',
} as const);

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

/** Modes that run one task per node: docker refuses `replicas` with them. */
const PER_NODE_MODES = new Set(['global', 'global-job']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compose reads an empty value (`key:`) as unset. */
function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/**
 * Services whose definition is a mapping. Anything else is left in place for the normalizer
 * (or docker) to refuse with a precise message instead of crashing a rewrite helper.
 */
function serviceEntries(compose: ParsedCompose): [string, Record<string, unknown>][] {
  if (!isRecord(compose.services)) return [];
  return Object.entries(compose.services).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );
}

/** Mirrors the build targets `build.ts` collects: only these services get a Dockflow-built image. */
function hasBuild(service: Record<string, unknown>): boolean {
  const build = service.build;
  return typeof build === 'string' ? build !== '' : build !== null && typeof build === 'object';
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

  if (composeContent && lintsStackFiles(ctx.config.orchestrator ?? 'swarm')) {
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

/** Alias expansions allowed before a file is refused as a resource-exhaustion attempt. */
const MAX_ALIAS_COUNT = 1000;

const YAML_TAG_PREFIX = 'tag:yaml.org,2002:';

/** Explicit tags whose value is still plain JSON. `!` is the non-specific tag (a string). */
const PLAIN_TAGS = new Set([
  '!',
  ...['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((name) => `${YAML_TAG_PREFIX}${name}`),
]);

/** Compose merge tags: they only mean something when override files are merged. */
const OVERRIDE_TAGS = new Set(['!reset', '!override']);

/**
 * String-typed values YAML would otherwise read as numbers or booleans: `PORT: 010` must reach
 * the container as `010`, not `10`. `*` is any key of a mapping, `[]` any item of a sequence.
 */
const SOURCE_TEXT_PATHS: readonly (readonly string[])[] = [
  ['services', '*', 'environment', '*'],
  ['services', '*', 'labels', '*'],
  ['services', '*', 'deploy', 'labels', '*'],
  ['services', '*', 'annotations', '*'],
  ['services', '*', 'build', 'args', '*'],
  ['services', '*', 'sysctls', '*'],
  ['services', '*', 'extra_hosts', '*'],
  ['services', '*', 'x-dockflow', 'node_selector', '*'],
  ['services', '*', 'x-dockflow', 'pod_labels', '*'],
  ['services', '*', 'x-dockflow', 'tolerations', '[]', 'value'],
  ['volumes', '*', 'labels', '*'],
  ['volumes', '*', 'driver_opts', '*'],
];

/**
 * File modes Compose reads in base 8, where YAML 1.2 reads `0440` as decimal 440. An octal literal
 * loads as its source text (`"0440"`), so the k3s normalizer can tell it from a decimal `288`;
 * `serialize` turns it back into a number for docker/cli, whose schema types `mode` as a number.
 */
const FILE_MODE_PATHS: readonly (readonly string[])[] = [
  ['services', '*', 'secrets', '[]', 'mode'],
  ['services', '*', 'configs', '[]', 'mode'],
  ['services', '*', 'volumes', '[]', 'tmpfs', 'mode'],
];

const OCTAL_MODE = /^0o?([0-7]+)$/;

type AliasTargets = Map<Alias, Node | undefined>;

/** `!!binary` rather than `tag:yaml.org,2002:binary`, as the user wrote it. */
function displayTag(tag: string): string {
  return tag.startsWith(YAML_TAG_PREFIX) ? `!!${tag.slice(YAML_TAG_PREFIX.length)}` : tag;
}

/** The first line of a yaml message: the rest is a code frame that may quote a secret. */
function firstLine(message: string): string {
  const [line] = message.split('\n');
  return line.replace(/:$/, '').replaceAll(YAML_TAG_PREFIX, '!!');
}

function describeYamlError(doc: Document, error: YAMLError, lineOf: (offset: number) => number): string {
  if (error.code === 'MULTIPLE_DOCS') return 'the file contains several YAML documents; keep one';
  if (error.code !== 'DUPLICATE_KEY') return firstLine(error.message);

  let key: string | undefined;
  visit(doc, {
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.range?.[0] === error.pos[0]) {
        key = String(pair.key.value);
        return visit.BREAK;
      }
      return undefined;
    },
  });
  const line = lineOf(error.pos[0]);
  return key === undefined ? `duplicate key at line ${line}` : `duplicate key ${key} at line ${line}`;
}

/**
 * Refuse every tag that is not a core-schema tag. yaml only warns about `!reset` and unknown tags
 * and keeps the value; `!!binary`, `!!set`, `!!omap` and `!!timestamp` resolve to values that are
 * not plain JSON.
 */
function refuseTags(doc: Document, file: string, lineOf: (offset: number) => number): void {
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node) || node.tag === undefined || PLAIN_TAGS.has(node.tag)) return;
      const line = node.range ? lineOf(node.range[0]) : 0;
      if (OVERRIDE_TAGS.has(node.tag)) {
        throw new ConfigError(
          `${file}: tag ${node.tag} at line ${line} is only meaningful in Compose override files; Dockflow reads a single file`,
          'Remove the tag and write the final value.',
        );
      }
      throw new ConfigError(
        `${file}: unsupported YAML tag ${displayTag(node.tag)} at line ${line}`,
        'Remove the tag and write a plain string, number, boolean, list or mapping.',
      );
    },
  });
}

/**
 * The node each alias stands for, `undefined` when no anchor precedes it. Same rule as yaml's
 * `Alias.resolve` (the last anchor of that name before the alias), in one pass instead of one per
 * alias. `cyclic` holds the aliases placed inside the value they name.
 */
function aliasTargets(doc: Document): { targets: AliasTargets; cyclic: Alias[] } {
  const anchors = new Map<string, Node>();
  const targets: AliasTargets = new Map();
  const cyclic: Alias[] = [];
  visit(doc, {
    Node(_key, node, path) {
      if (isAlias(node)) {
        const target = anchors.get(node.source);
        targets.set(node, target);
        if (target !== undefined && path.includes(target)) cyclic.push(node);
      } else if (node.anchor) {
        anchors.set(node.anchor, node);
      }
    },
  });
  return { targets, cyclic };
}

/** A deep copy in which every use of an anchor is its own object (structuredClone keeps sharing). */
function copyPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlain);
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // defineProperty keeps a `__proto__` key an own property, as yaml's toJS does
    Object.defineProperty(copy, key, { value: copyPlain(item), writable: true, enumerable: true, configurable: true });
  }
  return copy;
}

function deref(node: unknown, aliases: AliasTargets): unknown {
  return isAlias(node) ? aliases.get(node) : node;
}

function isMergeKey(key: unknown): boolean {
  if (!isScalar(key) || (key.type !== undefined && key.type !== Scalar.PLAIN)) return false;
  return key.value === '<<' || (typeof key.value === 'symbol' && key.value.description === '<<');
}

/**
 * The entries a mapping has once `toJS` resolved its merge keys, keyed like `toJS` keys them:
 * written keys always win, then merged maps in order, the first one winning.
 */
function mapEntries(map: YAMLMap, aliases: AliasTargets, seen: ReadonlySet<YAMLMap> = new Set()): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  const inner = new Set(seen).add(map);
  for (const pair of map.items) {
    if (isMergeKey(pair.key)) {
      const value = deref(pair.value, aliases);
      const sources = isSeq(value) ? value.items.map((item) => deref(item, aliases)) : [value];
      for (const source of sources) {
        if (!isMap(source) || inner.has(source)) continue;
        for (const [key, node] of mapEntries(source, aliases, inner)) {
          if (!entries.has(key)) entries.set(key, node);
        }
      }
      continue;
    }
    const key = deref(pair.key, aliases);
    if (isScalar(key)) entries.set(key.value === null ? '' : String(key.value), pair.value);
  }
  return entries;
}

/**
 * Replace, in the loaded value, every scalar found at `path` by what `rewrite` returns for its
 * node (`undefined` keeps it). The walk follows aliases and merge keys, so a value written once
 * under an anchor is rewritten wherever it lands on the path.
 */
function rewriteScalars(
  node: unknown,
  value: unknown,
  path: readonly string[],
  aliases: AliasTargets,
  rewrite: (scalar: Scalar) => unknown,
): void {
  const [segment, ...rest] = path;
  if (segment === undefined) return;
  const target = deref(node, aliases);

  const visitChild = (child: unknown, current: unknown, replace: (next: unknown) => void): void => {
    if (rest.length > 0) {
      rewriteScalars(child, current, rest, aliases, rewrite);
      return;
    }
    const scalar = deref(child, aliases);
    if (!isScalar(scalar)) return;
    const next = rewrite(scalar);
    if (next !== undefined) replace(next);
  };

  if (segment === '[]') {
    if (!isSeq(target) || !Array.isArray(value)) return;
    target.items.forEach((item, index) => {
      if (index < value.length) visitChild(item, value[index], (next) => { value[index] = next; });
    });
    return;
  }
  if (!isMap(target) || !isRecord(value)) return;
  for (const [key, child] of mapEntries(target, aliases)) {
    if ((segment === '*' || segment === key) && Object.hasOwn(value, key)) {
      visitChild(child, value[key], (next) => { value[key] = next; });
    }
  }
}

/** Untagged plain scalars only: an explicit `!!int` is the user's own choice of type. */
function isUntaggedPlain(scalar: Scalar): boolean {
  return scalar.tag === undefined && scalar.type === Scalar.PLAIN;
}

function sourceText(scalar: Scalar): unknown {
  if (!isUntaggedPlain(scalar) || scalar.value === null || typeof scalar.value === 'string') return undefined;
  return scalar.source;
}

function octalFileMode(scalar: Scalar): unknown {
  if (!isUntaggedPlain(scalar) || typeof scalar.value !== 'number') return undefined;
  return OCTAL_MODE.test(scalar.source ?? '') ? scalar.source : undefined;
}

/**
 * `value` with every octal mode string at `path` turned into its number. Copies only the objects
 * and lists on the way to a changed mode, so the compose being serialized is left untouched.
 */
function numericFileModes(value: unknown, path: readonly string[]): unknown {
  const [segment, ...rest] = path;
  if (segment === undefined) {
    const digits = typeof value === 'string' ? OCTAL_MODE.exec(value)?.[1] : undefined;
    return digits === undefined ? value : Number.parseInt(digits, 8);
  }
  if (segment === '[]') {
    if (!Array.isArray(value)) return value;
    const next = value.map((item) => numericFileModes(item, rest));
    return next.some((item, index) => item !== value[index]) ? next : value;
  }
  if (!isRecord(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const key of segment === '*' ? Object.keys(value) : [segment]) {
    if (!Object.hasOwn(value, key)) continue;
    const next = numericFileModes(value[key], rest);
    if (next === value[key]) continue;
    // the spread keeps a `__proto__` key an own property, so the assignment below stays a plain write
    copy ??= { ...value };
    copy[key] = next;
  }
  return copy ?? value;
}

/**
 * Parse compose YAML into plain JSON. Refused with a `ConfigError` naming `file`: YAML errors,
 * duplicate keys, several documents, tags outside the core schema, unresolved aliases and alias
 * bombs. Merge keys are resolved and aliases become copies.
 */
function parseComposeYaml(content: string, file: string): Record<string, unknown> {
  const lines = new LineCounter();
  const doc = parseDocument(content, {
    merge: true,
    keepSourceTokens: true,
    uniqueKeys: true,
    lineCounter: lines,
    // yaml would print its own notices on stderr; Dockflow reports through ConfigError only
    logLevel: 'error',
  });
  const lineOf = (offset: number): number => lines.linePos(offset).line;

  const [error] = doc.errors;
  if (error) throw new ConfigError(`${file}: ${describeYamlError(doc, error, lineOf)}`);
  refuseTags(doc, file, lineOf);
  const [warning] = doc.warnings;
  if (warning) throw new ConfigError(`${file}: ${firstLine(warning.message)}`);

  const { targets: aliases, cyclic } = aliasTargets(doc);
  const at = (alias: Alias): string => (alias.range ? ` at line ${lineOf(alias.range[0])}` : '');
  for (const [alias, target] of aliases) {
    if (target === undefined) throw new ConfigError(`${file}: unresolved alias *${alias.source}${at(alias)}`);
  }
  const [loop] = cyclic;
  if (loop) {
    throw new ConfigError(
      `${file}: alias *${loop.source}${at(loop)} is inside the value it refers to`,
      'Point the alias at an anchor defined outside the mapping or list that contains it.',
    );
  }

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ConfigError(
      /alias count/i.test(message)
        ? `${file}: too many alias expansions (limit ${MAX_ALIAS_COUNT})`
        : `${file}: ${firstLine(message)}`,
    );
  }

  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: the top level must be a mapping`, 'Start the file with Compose keys such as `services:`.');
  }

  // toJS shares one object between every use of an anchor; the rewrites below and the
  // injection helpers must not leak from one service into another.
  const raw = copyPlain(value) as Record<string, unknown>;
  for (const path of SOURCE_TEXT_PATHS) rewriteScalars(doc.contents, raw, path, aliases, sourceText);
  for (const path of FILE_MODE_PATHS) rewriteScalars(doc.contents, raw, path, aliases, octalFileMode);
  return raw;
}

/**
 * Load and parse a docker-compose YAML file from disk.
 */
export function load(composePath: string): ParsedCompose {
  const content = readFileSync(composePath, 'utf-8');
  return loadFromString(content, composePath);
}

/**
 * Parse a docker-compose YAML string into a ParsedCompose (both orchestrators).
 *
 * `file` names the source in error messages. Numbers and booleans written where Compose expects
 * strings keep their source text (`PORT: 010` stays `"010"`), and so do octal file modes
 * (`mode: 0440` stays `"0440"`, which Compose reads in base 8). See `parseComposeYaml` for what is
 * refused.
 */
export function loadFromString(content: string, file = 'compose file'): ParsedCompose {
  const raw = parseComposeYaml(content, file);

  return {
    raw,
    services: (raw.services ?? {}) as Record<string, Record<string, unknown>>,
    networks: raw.networks as Record<string, unknown> | undefined,
    volumes: raw.volumes as Record<string, unknown> | undefined,
  };
}

/**
 * Serialize a ParsedCompose back to a YAML string, without anchors or aliases. File modes loaded
 * as octal text (`"0440"`) are written as numbers (`288`), the only form docker/cli accepts.
 */
export function serialize(compose: ParsedCompose): string {
  const obj: Record<string, unknown> = { ...compose.raw };
  obj.services = compose.services;
  if (compose.networks) obj.networks = compose.networks;
  if (compose.volumes) obj.volumes = compose.volumes;

  let out: unknown = obj;
  for (const path of FILE_MODE_PATHS) out = numericFileModes(out, path);
  return stringifyYaml(out, { lineWidth: 0, aliasDuplicateObjects: false });
}

// ---------------------------------------------------------------------------
// Image tags
// ---------------------------------------------------------------------------

/**
 * Whether built images are pushed to the registry and pulled from it: enabled, with a URL AND a
 * password. The one registry predicate: the delivery mode, the push, the pull secret and the
 * image references must agree, or pods reference images nothing pushed.
 */
export function usesRegistry(config: DockflowConfig): boolean {
  const registry = config.registry;
  return registry?.enabled === true && !!registry.url && !!registry.password;
}

/**
 * Update the image tags of the services Dockflow builds (those with a `build` section).
 * Pulled images keep the reference the compose file gives them.
 *
 * If `image_auto_tag` is true (default):
 *   - Strips existing tag: "my-api:old" → "my-api"
 *   - Appends env + version: "my-api" → "my-api-{env}:{version}"
 *
 * If `usesRegistry(config)`:
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
  const useRegistry = usesRegistry(config);
  const registryUrl = config.registry?.url ?? '';
  const registryNs = config.registry?.namespace ?? '';
  const registryPrefix = registryNs
    ? `${registryUrl}/${registryNs}`
    : registryUrl;
  const filterSet = servicesFilter
    ? new Set(servicesFilter.split(',').map(s => s.trim()))
    : null;

  for (const [name, svc] of serviceEntries(compose)) {
    const originalImage = svc.image;
    if (typeof originalImage !== 'string' || originalImage === '' || !hasBuild(svc)) continue;
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
 * Inject the accessories deploy defaults. User values take precedence.
 *
 * Both orchestrators: `deploy.replicas: 1` when no replica count is written, except for services
 * that run once per node (`global`, `global-job`), which docker refuses with `replicas`, and for
 * services that set `scale`, which the count would contradict.
 * Swarm only: the restart policy defaults. k3s gets nothing else, so every value the normalizer
 * warns about is one the user wrote.
 */
export function injectAccessoriesDefaults(compose: ParsedCompose, kind: OrchestratorKind): void {
  for (const [name, svc] of serviceEntries(compose)) {
    // A malformed `deploy` is left for the normalizer (or docker) to refuse as written.
    if (!isAbsent(svc.deploy) && !isRecord(svc.deploy)) continue;
    const deploy = isRecord(svc.deploy) ? svc.deploy : {};
    const mergedDeploy: Record<string, unknown> = { ...deploy };

    const perNode = typeof deploy.mode === 'string' && PER_NODE_MODES.has(deploy.mode);
    if (isAbsent(deploy.replicas) && isAbsent(svc.scale) && !perNode) mergedDeploy.replicas = 1;

    if (kind === 'swarm' && (isAbsent(deploy.restart_policy) || isRecord(deploy.restart_policy))) {
      const userRestart = isRecord(deploy.restart_policy) ? deploy.restart_policy : {};
      mergedDeploy.restart_policy = deepMerge(DEFAULT_RESTART_POLICY, userRestart);
    }

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
  const serverServices = new Map(serviceEntries(server));

  for (const [name, svc] of serviceEntries(local)) {
    if (targeted.has(name)) continue;
    const serverImage = serverServices.get(name)?.image;
    if (typeof serverImage === 'string' && serverImage !== '') services[name] = { ...svc, image: serverImage };
  }

  return { ...local, services };
}

/**
 * Names of the external entries of a top-level section: the `name:` Docker knows the
 * resource by when one is written, the compose key otherwise.
 */
function externalNames(section: Record<string, unknown> | undefined): string[] {
  if (!isRecord(section)) return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isRecord(value) || value.external !== true) continue;
    names.push(typeof value.name === 'string' && value.name !== '' ? value.name : key);
  }
  return names;
}

/**
 * Extract all external network names from a compose object.
 */
export function getExternalNetworks(compose: ParsedCompose): string[] {
  return externalNames(compose.networks);
}

/**
 * Extract all external volume names from a compose object.
 */
export function getExternalVolumes(compose: ParsedCompose): string[] {
  return externalNames(compose.volumes);
}

export function hasServices(compose: ParsedCompose): boolean {
  return Object.keys(compose.services).length > 0;
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
