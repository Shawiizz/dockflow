#!/usr/bin/env bun
/**
 * Generates the compose support documentation from the key registry (design-07 19.4):
 *   docs/app/en/configuration/kubernetes/compose-support/page.mdx   region `compose-support`, one
 *     table per area of KEY_POLICIES (normalize/keys.ts);
 *   docs/app/en/configuration/kubernetes/page.mdx                   region `x-dockflow`, the two
 *     x-dockflow tables built from the `.describe()` texts of schemas/compose-extension.schema.ts.
 *
 * Usage (from cli/):
 *   bun run scripts/gen-compose-support.ts [--kubernetes-page <path>] [--check]
 *
 * The Kubernetes page is processed when `--kubernetes-page` names it (it must then exist and carry
 * the x-dockflow markers) or, without the flag, when the default page exists with the markers. A
 * relative path is resolved against the repository root, then against the working directory.
 * --check writes nothing and exits 1 with a diff when a region is stale or missing.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ServiceExtensionSchema, VolumeExtensionSchema } from '../src/schemas/compose-extension.schema';
import {
  COMPOSE_SPEC_PIN,
  KEY_AREAS,
  KEY_POLICIES,
  type KeyPolicy,
  type SwarmSupport,
} from '../src/services/orchestrator/kubernetes/normalize/keys';

const REPO_DIR = resolve(import.meta.dir, '..', '..');
const DOCS_DIR = join('docs', 'app', 'en', 'configuration', 'kubernetes');
export const COMPOSE_SUPPORT_PAGE = join(REPO_DIR, DOCS_DIR, 'compose-support', 'page.mdx');
export const KUBERNETES_PAGE = join(REPO_DIR, DOCS_DIR, 'page.mdx');

export interface RegionMarkers {
  begin: string;
  end: string;
}

export const COMPOSE_SUPPORT_MARKERS: RegionMarkers = {
  begin: '{/* BEGIN GENERATED: compose-support */}',
  end: '{/* END GENERATED: compose-support */}',
};

export const X_DOCKFLOW_MARKERS: RegionMarkers = {
  begin: '{/* x-dockflow:begin */}',
  end: '{/* x-dockflow:end */}',
};

const REGENERATE_HINT = 'Run: bun run scripts/gen-compose-support.ts';

const USAGE = `Usage (from cli/): bun run scripts/gen-compose-support.ts [--kubernetes-page <path>] [--check]

  --kubernetes-page <path>  also generate the x-dockflow region of this page (default: the Kubernetes
                            page of the docs, when it exists and carries the x-dockflow markers)
  --check                   write nothing; print a diff and exit 1 when a region is stale`;

// ---------------------------------------------------------------------------------------------
// MDX text

/**
 * Makes text safe inside an MDX table cell: code spans stay literal (only `|` is escaped, as GFM
 * splits cells first), plain text escapes the characters MDX or Markdown would interpret.
 */
export function mdxCell(text: string): string {
  const source = text.replace(/\s*\r?\n\s*/g, ' ').trim();
  let result = '';
  let i = 0;
  while (i < source.length) {
    if (source[i] === '`') {
      let run = 1;
      while (source[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      const close = findClosingFence(source, i + run, run);
      if (close >= 0) {
        result += fence + source.slice(i + run, close).replace(/\|/g, '\\|') + fence;
        i = close + run;
        continue;
      }
      result += '\\`'.repeat(run);
      i += run;
      continue;
    }
    const char = source[i];
    result += /[\\|{}<>*_[\]~&]/.test(char) ? `\\${char}` : char;
    i++;
  }
  return result;
}

/** Index of the next run of exactly `run` backticks, or -1. */
function findClosingFence(text: string, from: number, run: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let length = 1;
    while (text[i + length] === '`') length++;
    if (length === run) return i;
    i += length;
  }
  return -1;
}

function code(text: string): string {
  return `\`${text.replace(/\|/g, '\\|')}\``;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)];
}

// ---------------------------------------------------------------------------------------------
// Compose support table

const SWARM_LABEL: Record<SwarmSupport, string> = {
  supported: 'Supported',
  ignored: 'Ignored',
  rejected: 'Rejected',
};

/** The x-dockflow keys of a policy that its note does not already name as `x-dockflow.<key>`. */
function unmentionedExtensionKeys(policy: KeyPolicy): string[] {
  const note = policy.note ?? '';
  return (policy.xDockflow ?? []).filter((key) => !new RegExp(`x-dockflow\\.${key}(?![A-Za-z0-9_])`).test(note));
}

function notesCell(policy: KeyPolicy): string {
  const parts: string[] = [];
  if (policy.note !== undefined && policy.note.trim() !== '') parts.push(policy.note.trim());
  const extension = unmentionedExtensionKeys(policy);
  if (extension.length > 0) {
    parts.push(`${parts.length === 0 ? 'See also' : 'see also'} ${extension.map((key) => `\`x-dockflow.${key}\``).join(', ')}`);
  }
  return mdxCell(parts.join('; '));
}

/**
 * The body of the `compose-support` region: one table per area of KEY_AREAS, rows in registry
 * order. Throws on a policy whose area has no title, so a new area cannot vanish from the page.
 */
export function renderComposeSupport(
  policies: readonly KeyPolicy[],
  spec: { commit: string; date: string } = COMPOSE_SPEC_PIN,
): string {
  const known = new Set(KEY_AREAS.map((entry) => entry.area));
  const stray = policies.find((policy) => !known.has(policy.area));
  if (stray !== undefined) throw new Error(`${stray.path} has area ${stray.area}, which KEY_AREAS does not list`);

  const lines = [
    `Generated from the key registry of this Dockflow release, which follows the Compose specification of ${spec.date} (upstream commit ${code(spec.commit.slice(0, 7))}).`,
  ];
  for (const { area, title } of KEY_AREAS) {
    const rows = policies
      .filter((policy) => policy.area === area)
      .map((policy) => [code(policy.path), SWARM_LABEL[policy.swarm], mdxCell(policy.k3s), notesCell(policy)]);
    if (rows.length === 0) continue;
    lines.push('', `### ${title}`, '', ...table(['Key', 'Swarm', 'k3s', 'Notes'], rows));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// x-dockflow reference

type Schema = z.core.$ZodType;

interface FieldRow {
  key: string;
  type: string;
  description: string;
}

function defOf(schema: Schema): z.core.$ZodTypes['_zod']['def'] {
  return (schema as z.core.$ZodTypes)._zod.def;
}

function descriptionOf(schema: Schema): string | undefined {
  const description = z.globalRegistry.get(schema)?.description;
  return description === undefined || description.trim() === '' ? undefined : description.trim();
}

/** Strips `.optional()`, keeping the first description met on the way in. */
function unwrap(schema: Schema): { inner: Schema; optional: boolean; description: string | undefined } {
  let inner = schema;
  let optional = false;
  let description = descriptionOf(schema);
  for (let def = defOf(inner); def.type === 'optional'; def = defOf(inner)) {
    optional = true;
    inner = def.innerType;
    description ??= descriptionOf(inner);
  }
  return { inner, optional, description };
}

const SAFE_BOUND = Number.MAX_SAFE_INTEGER;

function numberLabel(schema: Schema, path: string): string {
  if (!(schema instanceof z.ZodNumber)) throw new Error(`${path}: unexpected number schema`);
  const bag = schema._zod.bag;
  if (bag.exclusiveMinimum !== undefined || bag.exclusiveMaximum !== undefined) {
    throw new Error(`${path}: exclusive number bounds are not supported by the docs generator`);
  }
  const kind = schema.isInt ? 'integer' : 'number';
  const min = schema.minValue;
  const max = schema.maxValue;
  const hasMin = min !== null && Number.isFinite(min) && min > -SAFE_BOUND;
  const hasMax = max !== null && Number.isFinite(max) && max < SAFE_BOUND;
  if (hasMin && hasMax) return `${kind} from ${min} to ${max}`;
  if (hasMin) return `${kind}, at least ${min}`;
  if (hasMax) return `${kind}, at most ${max}`;
  return kind;
}

const STRING_FORMATS: Readonly<Record<string, string>> = {
  cidrv4: 'IPv4 CIDR',
  cidrv6: 'IPv6 CIDR',
};

function typeLabel(schema: Schema, path: string): string {
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
      return typeLabel(def.innerType, path);
    case 'string': {
      const format = 'format' in def && typeof def.format === 'string' ? def.format : null;
      return (format !== null ? STRING_FORMATS[format] : undefined) ?? 'string';
    }
    case 'number':
      return numberLabel(schema, path);
    case 'boolean':
      return 'boolean';
    case 'enum':
      return `one of ${Object.values(def.entries)
        .map((value) => code(String(value)))
        .join(', ')}`;
    case 'union':
      return [...new Set(def.options.map((option) => typeLabel(option, path)))].join(' or ');
    case 'array':
      return defOf(unwrap(def.element).inner).type === 'object' ? 'list of mappings' : `list of ${typeLabel(def.element, `${path}[]`)}`;
    case 'record':
      return `mapping of ${typeLabel(def.keyType, `${path}{}`)} to ${typeLabel(def.valueType, `${path}{}`)}`;
    case 'object':
      return 'mapping';
    default:
      throw new Error(`${path}: the docs generator does not know zod type ${def.type}`);
  }
}

function fieldRows(schema: Schema, prefix: string, name: string, rows: FieldRow[]): void {
  const def = defOf(schema);
  if (def.type !== 'object') throw new Error(`${name}${prefix === '' ? '' : ` at ${prefix}`} is not an object schema`);
  for (const [key, field] of Object.entries(def.shape)) {
    const path = `${prefix}${key}`;
    const { inner, optional, description } = unwrap(field);
    if (description === undefined) throw new Error(`${name} field ${path} has no .describe() text (R-S1-03)`);
    const type = typeLabel(inner, path);
    rows.push({ key: path, type: optional ? type : `${type}, required`, description });
    const innerDef = defOf(inner);
    if (innerDef.type === 'object') fieldRows(inner, `${path}.`, name, rows);
    if (innerDef.type === 'array') {
      const element = unwrap(innerDef.element).inner;
      if (defOf(element).type === 'object') fieldRows(element, `${path}[].`, name, rows);
    }
  }
}

function extensionTable(schema: Schema, name: string, title: string): string[] {
  const intro = descriptionOf(schema);
  if (intro === undefined) throw new Error(`${name} has no .describe() text (R-S1-03)`);
  const rows: FieldRow[] = [];
  fieldRows(schema, '', name, rows);
  return [
    `### ${title}`,
    '',
    mdxCell(intro),
    '',
    ...table(
      ['Key', 'Type', 'Description'],
      rows.map((row) => [code(row.key), mdxCell(row.type), mdxCell(row.description)]),
    ),
  ];
}

/**
 * The body of the `x-dockflow` region: one table per schema, a row per field (nested mappings and
 * list items included) with its type and `.describe()` text. Throws on a field without one.
 */
export function renderXDockflowReference(serviceSchema: Schema, volumeSchema: Schema): string {
  return [
    ...extensionTable(serviceSchema, 'ServiceExtensionSchema', 'Service keys'),
    '',
    ...extensionTable(volumeSchema, 'VolumeExtensionSchema', 'Volume keys'),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Regions

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function regionBounds(text: string, markers: RegionMarkers): { start: number; end: number } | null {
  const start = text.indexOf(markers.begin);
  if (start < 0 || text.indexOf(markers.begin, start + markers.begin.length) >= 0) return null;
  const end = text.indexOf(markers.end, start + markers.begin.length);
  if (end < 0 || text.indexOf(markers.end, end + markers.end.length) >= 0) return null;
  return { start, end };
}

/**
 * The body between the markers (line endings normalized, the blank line after the begin marker
 * and before the end marker removed), or null when the page lacks exactly one pair of markers.
 */
export function extractRegion(page: string, markers: RegionMarkers): string | null {
  const text = normalizeEol(page);
  const bounds = regionBounds(text, markers);
  if (bounds === null) return null;
  const inner = text.slice(bounds.start + markers.begin.length, bounds.end);
  return inner.startsWith('\n\n') && inner.endsWith('\n\n') && inner.length >= 4 ? inner.slice(2, -2) : inner;
}

/** The page with its region replaced by `body`, in the page's line endings; null without markers. */
export function replaceRegion(page: string, markers: RegionMarkers, body: string): string | null {
  const crlf = page.includes('\r\n');
  const text = normalizeEol(page);
  const bounds = regionBounds(text, markers);
  if (bounds === null) return null;
  const replaced = `${text.slice(0, bounds.start)}${markers.begin}\n\n${body}\n\n${text.slice(bounds.end)}`;
  return crlf ? replaced.replace(/\n/g, '\r\n') : replaced;
}

/** Lines removed from `before` (-) and added by `after` (+), from a longest-common-subsequence walk. */
export function formatDiff(before: string, after: string, limit = 80): string {
  const a = normalizeEol(before).split('\n');
  const b = normalizeEol(after).split('\n');
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || common[i + 1][j] >= common[i][j + 1])) {
      lines.push(`-${i + 1}: ${a[i]}`);
      i++;
    } else {
      lines.push(`+${j + 1}: ${b[j]}`);
      j++;
    }
  }
  if (lines.length === 0) return '(line endings differ)';
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `... ${lines.length - limit} more changed lines`].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Command

export interface GeneratorEnv {
  composeSupportPage: string;
  kubernetesPage: string;
  repoDir: string;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface Target {
  path: string;
  markers: RegionMarkers;
  body: string;
  /** a missing page or region is an error; otherwise the target is skipped with a note */
  required: boolean;
}

class UsageError extends Error {}

function write(stream: NodeJS.WriteStream): (text: string) => void {
  return (text) => {
    stream.write(text.endsWith('\n') ? text : `${text}\n`);
  };
}

const DEFAULT_ENV: GeneratorEnv = {
  composeSupportPage: COMPOSE_SUPPORT_PAGE,
  kubernetesPage: KUBERNETES_PAGE,
  repoDir: REPO_DIR,
  cwd: process.cwd(),
  out: write(process.stdout),
  err: write(process.stderr),
};

function parseArgs(argv: readonly string[]): { check: boolean; help: boolean; kubernetesPage: string | null } {
  let check = false;
  let help = false;
  let kubernetesPage: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') check = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--kubernetes-page' || arg.startsWith('--kubernetes-page=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError('--kubernetes-page needs a path');
      if (kubernetesPage !== null) throw new UsageError('--kubernetes-page is given twice');
      kubernetesPage = value;
    } else {
      throw new UsageError(`Unknown argument ${arg}`);
    }
  }
  return { check, help, kubernetesPage };
}

function resolvePage(path: string, env: GeneratorEnv): string {
  if (isAbsolute(path)) return path;
  const fromRepo = resolve(env.repoDir, path);
  return existsSync(fromRepo) ? fromRepo : resolve(env.cwd, path);
}

function label(path: string, env: GeneratorEnv): string {
  const rel = relative(env.repoDir, path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel.split('\\').join('/');
}

function targets(kubernetesPage: string | null, env: GeneratorEnv): Target[] {
  const list: Target[] = [
    {
      path: env.composeSupportPage,
      markers: COMPOSE_SUPPORT_MARKERS,
      body: renderComposeSupport(KEY_POLICIES),
      required: true,
    },
  ];
  const explicit = kubernetesPage !== null;
  const path = explicit ? resolvePage(kubernetesPage, env) : env.kubernetesPage;
  if (explicit || existsSync(path)) {
    list.push({
      path,
      markers: X_DOCKFLOW_MARKERS,
      body: renderXDockflowReference(ServiceExtensionSchema, VolumeExtensionSchema),
      required: explicit,
    });
  } else {
    env.err(`note: ${label(path, env)} does not exist; its x-dockflow region was not generated.`);
  }
  return list;
}

/** Exit code: 0 done or up to date, 1 stale or missing region, 2 usage error. */
export function main(argv: readonly string[], env: GeneratorEnv = DEFAULT_ENV): number {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    env.err(`gen-compose-support: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    env.out(USAGE);
    return 0;
  }

  let failed = false;
  for (const target of targets(options.kubernetesPage, env)) {
    const name = label(target.path, env);
    const region = `${target.markers.begin} ... ${target.markers.end}`;
    if (!existsSync(target.path)) {
      failed = true;
      env.out(`missing  ${name}`);
      continue;
    }
    const committed = readFileSync(target.path, 'utf8');
    const regenerated = replaceRegion(committed, target.markers, target.body);
    if (regenerated === null) {
      if (target.required) {
        failed = true;
        env.out(`no region ${name}: expected exactly one ${region}`);
      } else {
        env.err(`note: ${name} has no ${region} region; it was not generated.`);
      }
      continue;
    }
    const unchanged = normalizeEol(regenerated) === normalizeEol(committed);
    if (options.check) {
      if (unchanged) {
        env.out(`ok       ${name}`);
      } else {
        failed = true;
        env.out(`differs  ${name} (- committed, + regenerated)`);
        env.out(formatDiff(committed, regenerated));
      }
      continue;
    }
    if (!unchanged) writeFileSync(target.path, regenerated);
    env.out(`${unchanged ? 'unchanged' : 'wrote    '} ${name}`);
  }
  if (failed) {
    env.out(options.check ? `The generated compose support docs are out of date. ${REGENERATE_HINT}` : 'Some regions were not generated.');
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gen-compose-support: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
