// D3 coverage of the key registry against the vendored Compose specification (design-01 1.4
// steps 1-4, design-07 4.3): every key of the pinned schema has a policy, every policy names a key
// of the schema, and every code a policy declares is asserted by the test file of its emitter.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeEmitters, KEY_REGISTRY, type KeyPolicy, lookupPolicy } from '../../services/orchestrator/kubernetes/normalize/keys';
import { sha256Hex } from '../../utils/hash';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'compose-spec');
const NORMALIZE_TESTS = join(import.meta.dir, 'normalize');
const DEFS_PREFIX = '#/$defs/';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaText(): string {
  return readFileSync(join(FIXTURE_DIR, 'compose-spec.json'), 'utf8').replace(/\r\n/g, '\n');
}

function vendoredSchema(): JsonObject {
  const schema: unknown = JSON.parse(schemaText());
  if (!isObject(schema)) throw new Error('compose-spec.json is not an object');
  return schema;
}

/**
 * design-01 1.4 step 2: top-level `properties`, every `properties` key, `patternProperties` other
 * than `^x-` and a schema-valued `additionalProperties` as `*`, `items` as `[]`, `$ref` followed,
 * every branch of allOf/oneOf/anyOf at the same path (the grammar of fixtures/compose-spec/README.md).
 * `stop(path)` ends the descent below a path (a whole or freeform policy).
 */
function schemaPaths(schema: JsonObject, stop: (path: string) => boolean = () => false): string[] {
  const paths = new Set<string>();
  const join2 = (path: string, segment: string): string => (path === '' ? segment : `${path}.${segment}`);
  const resolveRef = (ref: string): JsonObject => {
    const defs = schema.$defs;
    const target = isObject(defs) && ref.startsWith(DEFS_PREFIX) ? defs[ref.slice(DEFS_PREFIX.length)] : undefined;
    if (!isObject(target)) throw new Error(`$ref ${ref} does not resolve`);
    return target;
  };
  const add = (node: Json, path: string, refs: readonly string[]): void => {
    paths.add(path);
    if (!stop(path)) expand(node, path, refs);
  };
  const expand = (node: Json, path: string, refs: readonly string[]): void => {
    if (!isObject(node)) return;
    if (typeof node.$ref === 'string') {
      if (refs.includes(node.$ref)) throw new Error(`recursive $ref ${node.$ref} at ${path}`);
      expand(resolveRef(node.$ref), path, [...refs, node.$ref]);
    }
    for (const combinator of ['allOf', 'oneOf', 'anyOf'] as const) {
      const branches = node[combinator];
      if (Array.isArray(branches)) for (const branch of branches) expand(branch, path, refs);
    }
    if (isObject(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) if (!key.startsWith('x-')) add(child, join2(path, key), refs);
    }
    if (isObject(node.patternProperties)) {
      for (const [pattern, child] of Object.entries(node.patternProperties)) if (pattern !== '^x-') add(child, join2(path, '*'), refs);
    }
    if (isObject(node.additionalProperties)) add(node.additionalProperties, join2(path, '*'), refs);
    if (isObject(node.items)) expand(node.items, `${path}[]`, refs);
  };
  expand(schema, '', []);
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function entryAt(path: string): KeyPolicy | null {
  const policy = lookupPolicy(path);
  return policy !== null && policy.path === path ? policy : null;
}

/** A whole or freeform policy: its handler reads everything below it, so the walk stops there. */
function stopsAt(path: string): boolean {
  const policy = entryAt(path);
  return policy !== null && (policy.whole || policy.freeform);
}

/** Step 3: the schema paths without their own registry entry; a refresh adding keys lists them here. */
function uncoveredPaths(schema: JsonObject): string[] {
  return schemaPaths(schema, stopsAt).filter((path) => entryAt(path) === null);
}

const isExtensionPath = (path: string): boolean => path.split('.').includes('x-dockflow');

describe('the vendored Compose specification (design-01 1.4 step 1)', () => {
  test('keys.json lists exactly the key paths of compose-spec.json and records its checksum', () => {
    const keys = JSON.parse(readFileSync(join(FIXTURE_DIR, 'keys.json'), 'utf8')) as { sha256: string; paths: string[] };
    expect(keys.sha256).toBe(sha256Hex(schemaText()));
    expect(schemaPaths(vendoredSchema())).toEqual(keys.paths);
  });
});

describe('registry coverage (design-01 1.4 steps 2-3, U-KEYS-01, U-KEYS-02)', () => {
  test('every schema path has its own registry entry; the walk stops at whole and freeform entries', () => {
    const schema = vendoredSchema();
    expect(uncoveredPaths(schema)).toEqual([]);
    // the stop is effective: keys below a whole subtree are in the schema but not walked
    const full = schemaPaths(schema);
    const walked = new Set(schemaPaths(schema, stopsAt));
    expect(full.filter((p) => p.startsWith('services.*.develop.')).length).toBeGreaterThan(0);
    expect(full.filter((p) => p.startsWith('services.*.develop.') && walked.has(p))).toEqual([]);
  });

  test('every registry entry names a key of the schema, except the x-dockflow extension', () => {
    const full = new Set(schemaPaths(vendoredSchema()));
    const unknown = KEY_REGISTRY.map((p) => p.path).filter((path) => !isExtensionPath(path) && !full.has(path));
    expect(unknown).toEqual([]);
    expect(KEY_REGISTRY.filter((p) => isExtensionPath(p.path)).map((p) => p.path)).toContain('services.*.x-dockflow');
  });

  test('every path has exactly one entry', () => {
    const paths = KEY_REGISTRY.map((p) => p.path);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
    for (const path of schemaPaths(vendoredSchema(), stopsAt)) expect(KEY_REGISTRY.filter((p) => p.path === path)).toHaveLength(1);
  });
});

describe('every declared code is asserted where it is emitted (design-01 1.4 step 3)', () => {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  test('each code of an entry appears in normalize/<emitter>.test.ts', () => {
    const texts = new Map<string, string>();
    const missing: string[] = [];
    for (const policy of KEY_REGISTRY) {
      for (const { emitter, codes } of codeEmitters(policy)) {
        const file = join(NORMALIZE_TESTS, `${emitter}.test.ts`);
        if (!texts.has(file)) texts.set(file, existsSync(file) ? readFileSync(file, 'utf8') : '');
        const text = texts.get(file) ?? '';
        for (const code of codes) {
          // a whole code, not a prefix of a longer one (values.empty vs values.empty-key)
          if (!new RegExp(`(?<![\\w.-])${escape(code)}(?![\\w-])`).test(text)) missing.push(`${emitter}.test.ts: ${code} (${policy.path})`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('refreshing the vendored schema (design-01 1.4 step 4, U-KEYS-05)', () => {
  test('keys added upstream are named by the coverage check; keys below whole or freeform entries are not', () => {
    const schema = vendoredSchema();
    const props = (node: Json | undefined): JsonObject => {
      if (!isObject(node) || !isObject(node.properties)) throw new Error('fixture shape changed');
      return node.properties;
    };
    const defs = schema.$defs as JsonObject;
    props(schema).brand_top = { type: 'string' };
    props(defs.service).brand_new = { type: 'object', properties: { nested: { type: 'string' } } };
    props(defs.deployment).brand_deploy = { type: 'integer' };
    props(defs.development).brand_dev = { type: 'string' };
    expect(uncoveredPaths(schema)).toEqual(['brand_top', 'services.*.brand_new', 'services.*.brand_new.nested', 'services.*.deploy.brand_deploy']);
  });
});
