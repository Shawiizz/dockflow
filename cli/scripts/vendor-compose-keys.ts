#!/usr/bin/env bun
/**
 * Vendors the Compose specification schema the key registry is checked against (design-01 1.4,
 * design-07 4.3) and derives the key list from it:
 *   src/__tests__/kubernetes/fixtures/compose-spec/compose-spec.json  the schema, byte for byte
 *   src/__tests__/kubernetes/fixtures/compose-spec/keys.json          every key path of the schema
 *   src/__tests__/kubernetes/fixtures/compose-spec/README.md          commit, date, sha256, refresh steps
 *
 * Usage (from cli/):
 *   bun run scripts/vendor-compose-keys.ts [--offline] [--check]
 *
 * The commit and its date come from COMPOSE_SPEC_PIN in normalize/keys.ts, which is also where the
 * `keys.unknown` message reads the date: to refresh, change the pin, run this script, then give every
 * new path of keys.json a policy in KEY_REGISTRY (the coverage test names them).
 * --offline derives keys.json and README.md from the committed compose-spec.json instead of
 * downloading it. --check rebuilds everything in memory and exits 1 when a committed file differs.
 *
 * Path grammar: segments joined by `.`; `*` stands for any map key (patternProperties other than
 * `^x-`, or a schema-valued additionalProperties); `[]` is appended for the items of a list. Every
 * branch of allOf, oneOf and anyOf is expanded at the same path, so the object form of a key that
 * also has a string form (`build`, `ports[]`, `volumes[]`) shares that key's path. Extension fields
 * (`^x-`) are not keys. A path is listed for every property and map-key position; a list position on
 * its own (`services.*.ports[]`) is not, only the keys below it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPOSE_SPEC_PIN } from '../src/services/orchestrator/kubernetes/normalize/keys';

const CLI_DIR = resolve(import.meta.dir, '..');
const FIXTURE_DIR = join(CLI_DIR, 'src', '__tests__', 'kubernetes', 'fixtures', 'compose-spec');
const SCHEMA_FILE = 'compose-spec.json';
const KEYS_FILE = 'keys.json';
const README_FILE = 'README.md';
const REQUEST_TIMEOUT_MS = 120_000;
const DEFS_PREFIX = '#/$defs/';

const USAGE = `Usage (from cli/):
  bun run scripts/vendor-compose-keys.ts [--offline] [--check]

  --offline  derive keys.json and README.md from the committed compose-spec.json (no download)
  --check    rebuild in memory and exit 1 when a committed file differs
`;

class VendorError extends Error {}
class UsageError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Options {
  offline: boolean;
  check: boolean;
  help: boolean;
}

interface Output {
  file: string;
  content: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { offline: false, check: false, help: false };
  for (const arg of argv) {
    if (arg === '--offline') options.offline = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help') options.help = true;
    else throw new UsageError(`Unknown argument ${arg}`);
  }
  return options;
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaUrl(commit: string): string {
  return `https://raw.githubusercontent.com/compose-spec/compose-spec/${commit}/schema/compose-spec.json`;
}

async function download(url: string): Promise<string> {
  let failure = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dockflow-vendor-compose-keys' },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.text();
      failure = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await Bun.sleep(attempt * 2000);
  }
  throw new VendorError(`GET ${url} failed: ${failure}`);
}

// ---------------------------------------------------------------------------------------------
// Path expansion

function resolveRef(root: JsonObject, ref: string): JsonObject {
  if (!ref.startsWith(DEFS_PREFIX)) throw new VendorError(`Unsupported $ref ${ref}`);
  const defs = root.$defs;
  const target = isObject(defs) ? defs[ref.slice(DEFS_PREFIX.length)] : undefined;
  if (!isObject(target)) throw new VendorError(`$ref ${ref} does not resolve`);
  return target;
}

function join2(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

/** Every key path of the schema, sorted by code unit. */
export function composeKeyPaths(schema: unknown): string[] {
  if (!isObject(schema)) throw new VendorError('the schema is not an object');
  const root = schema;
  const paths = new Set<string>();

  const expand = (node: Json, path: string, refs: readonly string[]): void => {
    if (!isObject(node)) return;
    const ref = node.$ref;
    if (typeof ref === 'string') {
      // A recursive definition would expand for ever; the Compose schema has none today.
      if (refs.includes(ref)) throw new VendorError(`recursive $ref ${ref} at ${path}`);
      expand(resolveRef(root, ref), path, [...refs, ref]);
    }
    for (const combinator of ['allOf', 'oneOf', 'anyOf'] as const) {
      const branches = node[combinator];
      if (Array.isArray(branches)) for (const branch of branches) expand(branch, path, refs);
    }
    const properties = node.properties;
    if (isObject(properties)) {
      for (const key of Object.keys(properties)) {
        if (key.startsWith('x-')) continue;
        const child = join2(path, key);
        paths.add(child);
        expand(properties[key], child, refs);
      }
    }
    const patterns = node.patternProperties;
    if (isObject(patterns)) {
      for (const pattern of Object.keys(patterns)) {
        if (pattern === '^x-') continue;
        const child = join2(path, '*');
        paths.add(child);
        expand(patterns[pattern], child, refs);
      }
    }
    const additional = node.additionalProperties;
    if (isObject(additional)) {
      const child = join2(path, '*');
      paths.add(child);
      expand(additional, child, refs);
    }
    const items = node.items;
    if (isObject(items)) expand(items, `${path}[]`, refs);
  };

  expand(root, '', []);
  return [...paths].sort(compareCodeUnits);
}

// ---------------------------------------------------------------------------------------------
// Outputs

function keysJson(paths: string[], sha256: string): string {
  const body = {
    commit: COMPOSE_SPEC_PIN.commit,
    date: COMPOSE_SPEC_PIN.date,
    sha256,
    paths,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function readme(sha256: string, count: number): string {
  const lines = [
    '# Vendored Compose specification',
    '',
    'Generated by `cli/scripts/vendor-compose-keys.ts`; do not edit. The key registry',
    '(`src/services/orchestrator/kubernetes/normalize/keys.ts`) is checked against this pinned copy, so',
    '`keys.unknown` means "unknown to this Dockflow release", never "not in the current specification".',
    '',
    `- Commit: \`${COMPOSE_SPEC_PIN.commit}\``,
    `- Date: ${COMPOSE_SPEC_PIN.date}`,
    `- Source: ${schemaUrl(COMPOSE_SPEC_PIN.commit)}`,
    `- sha256 of \`${SCHEMA_FILE}\`: \`${sha256}\``,
    `- Key paths in \`${KEYS_FILE}\`: ${count}`,
    '',
    'The date is the `<vendor date>` printed by `keys.unknown`. It is `COMPOSE_SPEC_PIN.date`, and the',
    'Kubernetes test suite checks that both agree.',
    '',
    '## Refreshing',
    '',
    '1. Set `COMPOSE_SPEC_PIN` in `normalize/keys.ts` to the new commit of `compose-spec/compose-spec`',
    '   and the date of that commit.',
    '2. From `cli/`, run `bun run scripts/vendor-compose-keys.ts`.',
    '3. Run the key coverage test: it names every new path of `keys.json` without a policy. Give each',
    '   one a registry entry (a key known to Compose but not implemented gets `reject` with its own',
    '   `unsupported.<slug>` code, never `keys.unknown`) and update the design tables it cites.',
    '',
    '`bun run scripts/vendor-compose-keys.ts --check` compares the committed files with a fresh download;',
    'add `--offline` to re-derive `keys.json` from the committed schema without network access.',
    '',
    '## Path grammar',
    '',
    'Segments are joined by `.`; `*` is any map key and `[]` the items of a list',
    '(`services.*.volumes[].bind.propagation`). Every branch of `allOf`, `oneOf` and `anyOf` is expanded',
    'at the same path, so the object form of a key that also has a string form shares its path.',
    'Extension fields (`x-*`) are not keys.',
    '',
  ];
  return lines.join('\n');
}

async function build(options: Options): Promise<Output[]> {
  let schemaText: string;
  if (options.offline) {
    const path = join(FIXTURE_DIR, SCHEMA_FILE);
    if (!existsSync(path)) throw new VendorError(`${path} does not exist; run without --offline first`);
    schemaText = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } else {
    const url = schemaUrl(COMPOSE_SPEC_PIN.commit);
    err(`- ${url}`);
    schemaText = await download(url);
  }
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch (error) {
    throw new VendorError(`${SCHEMA_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = composeKeyPaths(schema);
  if (paths.length === 0) throw new VendorError(`${SCHEMA_FILE} defines no key`);
  const sha256 = sha256Hex(schemaText);
  return [
    { file: SCHEMA_FILE, content: schemaText },
    { file: KEYS_FILE, content: keysJson(paths, sha256) },
    { file: README_FILE, content: readme(sha256, paths.length) },
  ];
}

function committed(file: string): string | null {
  const path = join(FIXTURE_DIR, file);
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : null;
}

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const outputs = await build(options);
  if (options.check) {
    const stale = outputs.filter((output) => committed(output.file) !== output.content).map((output) => output.file);
    if (stale.length === 0) {
      out('Vendored Compose specification is up to date');
      return 0;
    }
    err(`Out of date: ${stale.join(', ')}\nRun bun run scripts/vendor-compose-keys.ts from cli/ and commit the result.`);
    return 1;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const output of outputs) writeFileSync(join(FIXTURE_DIR, output.file), output.content);
  out(`${outputs.length} files written to ${FIXTURE_DIR}`);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof UsageError) {
        err(`${error.message}\n\n${USAGE}`);
        process.exitCode = 2;
        return;
      }
      err(`vendor-compose-keys: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
