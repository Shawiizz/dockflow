/**
 * Plugin — expand the plugins a project declares into uploads and hook entries.
 *
 * A plugin contributes to exactly two things, `uploads` and `hooks`, and its
 * manifest is validated by the same schemas as config.yml. Expansion runs once
 * the project config has been rendered, so `with:` values are already concrete:
 * a plugin only ever sees the inputs it declares, never the project's variables.
 *
 * Files a plugin ships are rendered in memory under a key per instance. Two
 * instances of one plugin render the same file with different inputs, and a
 * shared key would let the second silently overwrite the first.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, isAbsolute, join, posix, relative, resolve } from 'path';
import nunjucks from 'nunjucks';
import { parse as parseYaml } from 'yaml';
import { DOCKFLOW_PLUGIN_INSTANCES_DIR, DOCKFLOW_PLUGINS_DIR } from '../constants';
import { BUILTIN_PLUGINS, type BuiltinPluginFiles } from '../plugins';
import { PLUGIN_NAME_PATTERN, PluginManifestSchema, type PluginManifest } from '../schemas/plugin.schema';
import { getLayout, HOOK_PHASES, loadConfig } from '../utils/config';
import type { DockflowConfig, HookEntry, HookEntryInput, HookPhase, PluginUse, UploadItem } from '../utils/config';
import { ConfigError } from '../utils/errors';

const MANIFEST = 'plugin.yml';

// A `file` input carries where its path resolves from until the file is read.
const FROM_PLUGIN = 'plugin:';
const FROM_PROJECT = 'project:';

/** A `file` input's path, without the tag saying where it resolves from. */
function untagged(value: string): string {
  for (const tag of [FROM_PLUGIN, FROM_PROJECT]) {
    if (value.startsWith(tag)) return value.slice(tag.length);
  }
  return value;
}

/**
 * The file name at the end of a path. Sees past a `file` input's tag, which a
 * plain basename would keep for a file at the project root (`project:app.service`).
 */
export function pluginBasename(value: unknown): string {
  return posix.basename(untagged(String(value)).replace(/\\/g, '/'));
}

// Plugin files see only their inputs: a reference to anything else is a bug in
// the plugin, so it throws instead of rendering an empty string.
const pluginEnv = new nunjucks.Environment(undefined, { autoescape: false, throwOnUndefined: true });
pluginEnv.addFilter('basename', pluginBasename);

// A project's own override file is rendered like the project's other files.
const projectEnv = new nunjucks.Environment(undefined, { autoescape: false });

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface PluginSource {
  origin: 'local' | 'builtin';
  /** Shown in messages: a project-relative directory, or `built-in`. */
  location: string;
  hasFile(relPath: string): boolean;
  readFile(relPath: string): Promise<string>;
}

/**
 * A plugin-relative path, refused if it leaves the plugin.
 *
 * Harmless for a plugin the project wrote itself, but a plugin fetched from
 * elsewhere must not be able to reach `../../.env.dockflow`.
 */
export function pluginRelPath(relPath: string, where: string): string {
  const normalized = posix.normalize(relPath.replace(/\\/g, '/'));
  if (isAbsolute(relPath) || normalized === '..' || normalized.startsWith('../')) {
    throw new ConfigError(`${where}: plugin file paths must stay inside the plugin, got "${relPath}"`);
  }
  return normalized;
}

function localSource(dir: string, location: string): PluginSource {
  return {
    origin: 'local',
    location,
    hasFile: (relPath) => {
      const abs = join(dir, pluginRelPath(relPath, location));
      return existsSync(abs) && statSync(abs).isFile();
    },
    readFile: async (relPath) => readFileSync(join(dir, pluginRelPath(relPath, location)), 'utf-8'),
  };
}

function builtinSource(files: BuiltinPluginFiles): PluginSource {
  return {
    origin: 'builtin',
    location: 'built-in',
    hasFile: (relPath) => pluginRelPath(relPath, 'built-in') in files,
    readFile: async (relPath) => Bun.file(files[pluginRelPath(relPath, 'built-in')]).text(),
  };
}

/**
 * Find the plugin a `use:` names.
 *
 * A path (./, ../ or absolute) resolves from the project root. A bare name looks
 * in `.dockflow/plugins/<name>/` first, then among built-in plugins — so a project
 * can replace a built-in plugin wholesale by writing its own under the same name.
 */
export function resolvePluginSource(
  use: string,
  projectRoot: string,
  builtins: Record<string, BuiltinPluginFiles> = BUILTIN_PLUGINS,
): PluginSource {
  if (use.startsWith('./') || use.startsWith('../') || isAbsolute(use)) {
    const dir = resolve(projectRoot, use);
    if (!existsSync(join(dir, MANIFEST))) {
      throw new ConfigError(`plugin not found: ${use}`, `Expected a ${MANIFEST} in ${dir}.`);
    }
    return localSource(dir, use);
  }

  if (!PLUGIN_NAME_PATTERN.test(use)) {
    throw new ConfigError(
      `invalid plugin reference: "${use}"`,
      'Use a plugin name (lowercase letters, digits, hyphens) or a path starting with ./ or ../',
    );
  }

  const localDir = join(projectRoot, DOCKFLOW_PLUGINS_DIR, use);
  if (existsSync(join(localDir, MANIFEST))) {
    return localSource(localDir, `${DOCKFLOW_PLUGINS_DIR}/${use}`);
  }

  const builtin = builtins[use];
  if (builtin) return builtinSource(builtin);

  const available = Object.keys(builtins).sort().join(', ') || 'none';
  throw new ConfigError(
    `unknown plugin: ${use}`,
    `Built-in plugins: ${available}. A project's own plugins live in ${DOCKFLOW_PLUGINS_DIR}/<name>/.`,
  );
}

// ---------------------------------------------------------------------------
// Manifest and inputs
// ---------------------------------------------------------------------------

export function parseManifest(text: string, where: string): PluginManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${where}: ${MANIFEST} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = PluginManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`${where}: invalid ${MANIFEST}\n  ${issues.join('\n  ')}`);
  }
  return result.data;
}

/**
 * Turn what the project passed in `with:` into the plugin's input values.
 *
 * Unknown keys are refused — a typo in an input name would otherwise fall back
 * to the default without a word. `file` inputs are tagged with where their path
 * resolves from, which rendering later consumes.
 */
export function resolveInputs(
  manifest: PluginManifest,
  given: PluginUse['with'],
  where: string,
): Record<string, string> {
  const declared = manifest.inputs ?? {};
  const provided = given ?? {};

  const unknown = Object.keys(provided).filter((key) => !(key in declared));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${where}: unknown input(s): ${unknown.join(', ')}`,
      `Inputs this plugin declares: ${Object.keys(declared).join(', ') || 'none'}.`,
    );
  }

  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, def] of Object.entries(declared)) {
    const isFile = def.type === 'file';
    if (provided[key] !== undefined) {
      const value = String(provided[key]);
      values[key] = isFile ? `${FROM_PROJECT}${value}` : value;
    } else if (def.default !== undefined) {
      values[key] = isFile ? `${FROM_PLUGIN}${def.default}` : def.default;
    } else if (def.required) {
      missing.push(key);
    } else {
      values[key] = '';
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(`${where}: missing required input(s): ${missing.join(', ')}`);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export interface PluginExpansion {
  uploads: UploadItem[];
  hooks: Partial<Record<HookPhase, HookEntryInput[]>>;
  /** Rendered plugin files, keyed where uploads and script entries look them up. */
  files: Map<string, string>;
  /** One line per instance, for validate and debug output. */
  summary: string[];
}

export interface ExpandOptions {
  projectRoot: string;
  /** The context the project's own files are rendered with. */
  projectContext: Record<string, unknown>;
  builtins?: Record<string, BuiltinPluginFiles>;
}

function render(env: nunjucks.Environment, template: string, context: object, where: string): string {
  try {
    return env.renderString(template, context);
  } catch (error) {
    throw new ConfigError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Render every string of a manifest section, leaving its shape untouched. */
function renderStrings<T>(value: T, renderOne: (s: string) => string): T {
  if (typeof value === 'string') return renderOne(value) as T;
  if (Array.isArray(value)) return value.map((v) => renderStrings(v, renderOne)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderStrings(v, renderOne)]),
    ) as T;
  }
  return value;
}

interface Instance {
  id: string;
  display: string;
  source: PluginSource;
  where: string;
  inputs: Record<string, string>;
  pluginContext: Record<string, unknown>;
}

/**
 * Read the file a rendered `src` or `script` points at, render it, and store it
 * under a key private to the instance. Returns that key, and a label that names
 * the file the way a reader of the output would recognise it.
 */
async function materializeFile(
  ref: string,
  instance: Instance,
  opts: ExpandOptions,
  files: Map<string, string>,
): Promise<{ key: string; label: string }> {
  if (ref === '') {
    throw new ConfigError(`${instance.where}: a file reference rendered empty — is a file input missing?`);
  }

  let origin: 'plugin' | 'project';
  let relPath: string;
  let content: string;

  if (ref.startsWith(FROM_PROJECT)) {
    origin = 'project';
    relPath = ref.slice(FROM_PROJECT.length).replace(/\\/g, '/');
    const abs = resolve(opts.projectRoot, relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new ConfigError(`${instance.where}: file not found in the project: ${relPath}`);
    }
    // The project's own file: its variables plus the plugin's inputs.
    content = render(
      projectEnv,
      readFileSync(abs, 'utf-8'),
      { ...opts.projectContext, inputs: instance.inputs },
      `${instance.where} (${relPath})`,
    );
  } else {
    origin = 'plugin';
    relPath = pluginRelPath(ref.startsWith(FROM_PLUGIN) ? ref.slice(FROM_PLUGIN.length) : ref, instance.where);
    if (!instance.source.hasFile(relPath)) {
      throw new ConfigError(`${instance.where}: the plugin has no file "${relPath}" — plugins upload single files only`);
    }
    content = render(
      pluginEnv,
      await instance.source.readFile(relPath),
      instance.pluginContext,
      `${instance.where} (${relPath})`,
    );
  }

  const key = `${DOCKFLOW_PLUGIN_INSTANCES_DIR}/${instance.id}/${origin}/${relPath}`;
  files.set(key, content);
  return { key, label: `${instance.display} › ${relPath}` };
}

/**
 * Expand every declared plugin, in declaration order.
 */
export async function expandPlugins(uses: PluginUse[] | undefined, opts: ExpandOptions): Promise<PluginExpansion> {
  const expansion: PluginExpansion = { uploads: [], hooks: {}, files: new Map(), summary: [] };
  const seenIds = new Map<string, { entry: number; explicit: boolean }>();

  for (const [index, use] of (uses ?? []).entries()) {
    const entry = index + 1;
    const source = resolvePluginSource(use.use, opts.projectRoot, opts.builtins);
    const manifest = parseManifest(await source.readFile(MANIFEST), `plugin ${use.use}`);

    const id = use.id ?? manifest.name;
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      // Say which fix applies: a forgotten id and a repeated one read alike otherwise.
      throw !previous.explicit && use.id === undefined
        ? new ConfigError(
          `plugins #${previous.entry} and #${entry} both use ${manifest.name} without an id`,
          `A plugin used more than once needs an \`id\` on each entry, e.g. \`id: ${manifest.name}-2\`.`,
        )
        : new ConfigError(
          `plugins #${previous.entry} and #${entry} share the id "${id}"`,
          'Each entry needs its own `id`. An entry without one takes the plugin name as its id.',
        );
    }
    seenIds.set(id, { entry, explicit: use.id !== undefined });

    const display = id === manifest.name ? manifest.name : `${manifest.name}[${id}]`;
    const where = `plugin ${display}`;
    const inputs = resolveInputs(manifest, use.with, where);
    const instance: Instance = {
      id,
      display,
      source,
      where,
      inputs,
      pluginContext: {
        inputs,
        env: opts.projectContext.env,
        version: opts.projectContext.version,
        project_name: opts.projectContext.project_name,
      },
    };

    const renderOne = (s: string) => render(pluginEnv, s, instance.pluginContext, where);

    const uploads = renderStrings(manifest.uploads ?? [], renderOne);
    for (const upload of uploads) {
      if (!upload.dest.startsWith('/')) {
        throw new ConfigError(`${where}: upload dest must be an absolute path, got "${upload.dest}"`);
      }
      const { key, label } = await materializeFile(upload.src, instance, opts, expansion.files);
      expansion.uploads.push({ ...upload, src: key, label });
    }

    let entryCount = 0;
    const hooks = renderStrings(manifest.hooks ?? {}, renderOne);
    for (const phase of HOOK_PHASES) {
      for (const entry of hooks[phase] ?? []) {
        const e: HookEntry = typeof entry === 'string' ? { run: entry } : { ...entry };
        e.name = e.name ? `${display} ${e.name}` : display;
        if (e.script !== undefined) {
          e.script = (await materializeFile(e.script, instance, opts, expansion.files)).key;
        }
        const phaseEntries = expansion.hooks[phase] ?? [];
        phaseEntries.push(e);
        expansion.hooks[phase] = phaseEntries;
        entryCount++;
      }
    }

    expansion.summary.push(
      `${display} (${source.location}): ${uploads.length} upload(s), ${entryCount} hook entr${entryCount === 1 ? 'y' : 'ies'}`,
    );
  }

  return expansion;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** The path an upload writes, so two uploads into one directory are not mistaken for a clash. */
function effectiveDest(upload: UploadItem, projectRoot: string, files: Map<string, string>): string {
  if (!upload.dest.endsWith('/')) return upload.dest;

  const inMemory = files.has(upload.src);
  const abs = resolve(projectRoot, upload.src);
  const isFile = inMemory || (existsSync(abs) && statSync(abs).isFile());
  return isFile ? `${upload.dest}${basename(upload.src)}` : upload.dest.replace(/\/+$/, '');
}

/**
 * Fold an expansion into the project config and its rendered files.
 *
 * Plugin entries run before the project's own in every phase. Two uploads that
 * write the same path are refused — whichever ran last would win silently.
 * `rendered` is updated in place, since it is the map every later phase reads.
 */
export function applyPluginExpansion(
  config: DockflowConfig,
  rendered: Map<string, string>,
  expansion: PluginExpansion,
  projectRoot: string,
): DockflowConfig {
  const uploads = [...expansion.uploads, ...(config.uploads ?? [])];

  const writers = new Map<string, string>();
  for (const upload of uploads) {
    const dest = effectiveDest(upload, projectRoot, expansion.files);
    const other = writers.get(dest);
    if (other !== undefined) {
      throw new ConfigError(
        `two uploads write ${dest}: ${other} and ${upload.src}`,
        'Each destination can only come from one upload. Remove one, or give it another dest.',
      );
    }
    writers.set(dest, upload.src);
  }

  const hooks = { ...(config.hooks ?? {}) };
  for (const phase of HOOK_PHASES) {
    const fromPlugins = expansion.hooks[phase];
    if (fromPlugins?.length) hooks[phase] = [...fromPlugins, ...(config.hooks?.[phase] ?? [])];
  }

  for (const [key, content] of expansion.files) rendered.set(key, content);

  return { ...config, uploads, hooks };
}

/**
 * Reload the config from its rendered copy, then expand its plugins.
 *
 * Deploy and build both render the project before reading the final config, and
 * both run hooks. Going through one function means a plugin's build hooks cannot
 * run on deploy but be forgotten by `dockflow build`.
 */
export async function loadConfigWithPlugins(args: {
  rendered: Map<string, string>;
  fallback: DockflowConfig;
  projectRoot: string;
  projectContext: Record<string, unknown>;
}): Promise<{ config: DockflowConfig; pluginSummary: string[] }> {
  const configRelPath = relative(args.projectRoot, getLayout().configPath).replace(/\\/g, '/');
  const config = loadConfig({ content: args.rendered.get(configRelPath), silent: true }) ?? args.fallback;
  if (!config.plugins?.length) return { config, pluginSummary: [] };

  const expansion = await expandPlugins(config.plugins, {
    projectRoot: args.projectRoot,
    projectContext: args.projectContext,
  });
  return {
    config: applyPluginExpansion(config, args.rendered, expansion, args.projectRoot),
    pluginSummary: expansion.summary,
  };
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface PluginListing {
  name: string;
  origin: 'local' | 'builtin';
  location: string;
  description?: string;
  inputs: { name: string; required: boolean; default?: string; type: 'string' | 'file'; description?: string }[];
  /** A project plugin of the same name replaces this built-in one. */
  shadowed: boolean;
  /** Why the manifest could not be read; the other fields are then empty. */
  error?: string;
}

async function describePlugin(name: string, source: PluginSource): Promise<PluginListing> {
  const listing: PluginListing = { name, origin: source.origin, location: source.location, inputs: [], shadowed: false };
  try {
    const manifest = parseManifest(await source.readFile(MANIFEST), `plugin ${name}`);
    listing.description = manifest.description;
    listing.inputs = Object.entries(manifest.inputs ?? {}).map(([inputName, def]) => ({
      name: inputName,
      required: def.required === true,
      default: def.default,
      type: def.type ?? 'string',
      description: def.description,
    }));
  } catch (error) {
    listing.error = error instanceof Error ? error.message : String(error);
  }
  return listing;
}

/**
 * Every plugin a project can use: its own, then the built-in ones.
 *
 * A broken project plugin is listed with its error rather than hiding the rest.
 */
export async function listPlugins(
  projectRoot: string,
  builtins: Record<string, BuiltinPluginFiles> = BUILTIN_PLUGINS,
): Promise<PluginListing[]> {
  const listings: PluginListing[] = [];

  const localRoot = join(projectRoot, DOCKFLOW_PLUGINS_DIR);
  const localNames = existsSync(localRoot)
    ? readdirSync(localRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(localRoot, name, MANIFEST)))
      .sort()
    : [];

  for (const name of localNames) {
    listings.push(await describePlugin(name, localSource(join(localRoot, name), `${DOCKFLOW_PLUGINS_DIR}/${name}`)));
  }

  for (const name of Object.keys(builtins).sort()) {
    const listing = await describePlugin(name, builtinSource(builtins[name]));
    listing.shadowed = localNames.includes(name);
    listings.push(listing);
  }

  return listings;
}
