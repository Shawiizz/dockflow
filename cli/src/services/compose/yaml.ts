/**
 * Compose YAML — loads a docker-compose file into plain JSON (merge keys resolved, aliases copied,
 * source text kept for numbers and octal modes, unsafe documents refused) and serializes it back.
 */

import { readFileSync } from 'fs';
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
import { ConfigError } from '../../utils/errors';
import type { ParsedCompose } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
  ['volumes', '*', 'labels', '*'],
  ['volumes', '*', 'driver_opts', '*'],
];

/**
 * File modes Compose reads in base 8, where YAML 1.2 reads `0440` as decimal 440 (0o670 once docker
 * reads it back). An octal literal loads as its source text (`"0440"`); `serialize` turns it into
 * its number for docker/cli, whose schema types `mode` as a number.
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

export function load(composePath: string): ParsedCompose {
  const content = readFileSync(composePath, 'utf-8');
  return loadFromString(content, composePath);
}

/**
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
