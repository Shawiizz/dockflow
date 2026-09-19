// Structural validator (design-07 7.2, design-02 14.3): one object against the vendored OpenAPI v3
// and Traefik CRD bundles, the way `kubectl apply --validate=strict` would reject it: unknown
// fields, types, enums, required fields, integer ranges, int-or-string, quantities as strings,
// base64, SSA list-map keys. Built-in kinds are checked against the minimum server version, so a
// field added later is `unknown-field` offline. No dependency; the bundles are read on first use.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface SchemaIssue {
  /** path inside the object (`spec.template.spec.containers[0].name`), '' for the object itself */
  path: string;
  /** structural keyword (`unknown-field`, `type`, `required`, ...) or semantic rule id (`S05`, `SEM-013`) */
  rule: string;
  message: string;
  /** absent = error; a warning never fails a render (SEM-071 middleware references) */
  severity?: 'warning';
}

/** The subset of OpenAPI v3 / JSON schema the vendored bundles use. */
export interface SchemaNode {
  $ref?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  format?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  default?: unknown;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  'x-kubernetes-int-or-string'?: boolean;
  'x-kubernetes-preserve-unknown-fields'?: boolean;
  'x-kubernetes-list-type'?: 'atomic' | 'map' | 'set';
  'x-kubernetes-list-map-keys'?: string[];
}

/** Format of the files written by `cli/scripts/vendor-k8s-schemas.ts` (design-07 7.1 step 5). */
export interface SchemaBundle {
  schema: 1;
  sources: { url: string; sha256: string }[];
  /** `<apiVersion>/<kind>` -> definition name */
  roots: Record<string, string>;
  schemas: Record<string, SchemaNode>;
}

export interface SchemaBundles {
  kubernetes: SchemaBundle;
  traefik: SchemaBundle;
  /** file names, which carry the vendored versions */
  files: { kubernetes: string; traefik: string };
}

export const REF_PREFIX = '#/components/schemas/';
const QUANTITY = 'io.k8s.apimachinery.pkg.api.resource.Quantity';
const OBJECT_META = 'io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta';
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

let bundles: SchemaBundles | null = null;

function bundleFile(prefix: 'k8s' | 'traefik'): string {
  const files = readdirSync(import.meta.dir).filter((file) => file.startsWith(`${prefix}-`) && file.endsWith('.json.gz'));
  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one vendored ${prefix} schema bundle next to validate.ts, found ${files.length}; run bun run scripts/vendor-k8s-schemas.ts`,
    );
  }
  return files[0];
}

function readBundle(file: string): SchemaBundle {
  const parsed = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, file))).toString('utf8')) as SchemaBundle;
  if (parsed.schema !== 1) throw new Error(`${file} has schema format ${String(parsed.schema)}, expected 1`);
  return parsed;
}

/** The two vendored bundles, read once. */
export function schemaBundles(): SchemaBundles {
  if (bundles === null) {
    const files = { kubernetes: bundleFile('k8s'), traefik: bundleFile('traefik') };
    bundles = { kubernetes: readBundle(files.kubernetes), traefik: readBundle(files.traefik), files };
  }
  return bundles;
}

// ---------------------------------------------------------------------------------------------
// Quantities (apimachinery resource.Quantity), shared with the semantic rules

export type QuantityFormat = 'BinarySI' | 'DecimalSI' | 'DecimalExponent';

/** `sign * digits * 10^scale`, rounded up to nano precision as the API server stores it. */
export interface Quantity {
  negative: boolean;
  digits: bigint;
  scale: number;
  format: QuantityFormat;
}

const QUANTITY_RE = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:(Ki|Mi|Gi|Ti|Pi|Ei)|([numkMGTPE])|([eE][+-]?\d+))?$/;
const BINARY_POWERS: Record<string, number> = { Ki: 1, Mi: 2, Gi: 3, Ti: 4, Pi: 5, Ei: 6 };
const BINARY_SUFFIXES = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'];
const DECIMAL_EXPONENTS: Record<string, number> = { n: -9, u: -6, m: -3, '': 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };
const DECIMAL_SUFFIXES = new Map(Object.entries(DECIMAL_EXPONENTS).map(([suffix, exponent]) => [exponent, suffix]));
const NANO_SCALE = -9;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Parses the quantity grammar of apimachinery; null when the text is not a quantity. */
export function parseQuantity(text: string): Quantity | null {
  const match = QUANTITY_RE.exec(text);
  if (!match) return null;
  const [, sign, number, binary, decimal, exponent] = match;
  const [whole, fraction = ''] = number.split('.');
  let digits = BigInt(`${whole}${fraction}` || '0');
  let scale = -fraction.length;
  let format: QuantityFormat = 'DecimalSI';
  if (binary !== undefined) {
    digits *= 1024n ** BigInt(BINARY_POWERS[binary]);
    format = 'BinarySI';
  } else if (decimal !== undefined) {
    scale += DECIMAL_EXPONENTS[decimal];
  } else if (exponent !== undefined) {
    scale += Number.parseInt(exponent.slice(1), 10);
    format = 'DecimalExponent';
  }
  if (scale < NANO_SCALE) {
    const divisor = pow10(NANO_SCALE - scale);
    digits = (digits + divisor - 1n) / divisor;
    scale = NANO_SCALE;
  }
  return { negative: sign === '-' && digits !== 0n, digits, scale, format };
}

/** The canonical string the API server returns for a quantity (resource.Quantity CanonicalizeBytes). */
export function formatQuantity(quantity: Quantity): string {
  if (quantity.digits === 0n) return '0';
  const sign = quantity.negative ? '-' : '';
  let { digits, scale } = quantity;
  let format = quantity.format;
  if (format === 'BinarySI') {
    const integral = scale >= 0 || digits % pow10(-scale) === 0n;
    const magnitude = scale >= 0 ? digits * pow10(scale) : digits / pow10(-scale);
    if (!integral || magnitude < 1024n) format = 'DecimalSI';
    else {
      let value = magnitude;
      let power = 0;
      while (value % 1024n === 0n && power < BINARY_SUFFIXES.length - 1) {
        value /= 1024n;
        power += 1;
      }
      return `${sign}${value}${BINARY_SUFFIXES[power]}`;
    }
  }
  while (digits % 10n === 0n) {
    digits /= 10n;
    scale += 1;
  }
  const remainder = ((scale % 3) + 3) % 3;
  if (remainder !== 0) {
    digits *= pow10(remainder);
    scale -= remainder;
  }
  if (format === 'DecimalExponent') return `${sign}${digits}${scale === 0 ? '' : `e${scale}`}`;
  return `${sign}${digits}${DECIMAL_SUFFIXES.get(scale) ?? `e${scale}`}`;
}

/** Canonical form of a quantity string, or null when it does not parse. */
export function canonicalQuantity(text: string): string | null {
  const quantity = parseQuantity(text);
  return quantity === null ? null : formatQuantity(quantity);
}

/** Numeric comparison (-1, 0, 1) of two quantities. */
export function compareQuantities(a: Quantity, b: Quantity): number {
  const scale = Math.min(a.scale, b.scale);
  const left = (a.negative ? -1n : 1n) * a.digits * pow10(a.scale - scale);
  const right = (b.negative ? -1n : 1n) * b.digits * pow10(b.scale - scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Schema resolution

interface Effective {
  schema: SchemaNode;
  quantity: boolean;
}

const effectiveCache = new WeakMap<SchemaNode, Effective>();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function definition(bundle: SchemaBundle, ref: string): { name: string; node: SchemaNode } {
  const name = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
  const node = bundle.schemas[name];
  if (node === undefined) throw new Error(`The vendored schema bundle has no ${name} (${ref})`);
  return { name, node };
}

/**
 * Flattens `$ref` and `allOf` into one node: Kubernetes wraps every reference in a one-element
 * `allOf`, so the allowed property set is the union of the members' (design-02 14.3 rule 2).
 * Keys of the outer node win over the referenced definition.
 */
function effective(bundle: SchemaBundle, node: SchemaNode): Effective {
  const cached = effectiveCache.get(node);
  if (cached) return cached;
  const schema: SchemaNode = {};
  const merged = schema as Record<string, unknown>;
  let quantity = false;
  const seen = new Set<string>();
  const visit = (current: SchemaNode): void => {
    for (const [key, value] of Object.entries(current)) {
      if (key === '$ref' || key === 'allOf') continue;
      if (key === 'properties') schema.properties = { ...(value as Record<string, SchemaNode>), ...schema.properties };
      else if (key === 'required') schema.required = [...new Set([...(schema.required ?? []), ...(value as string[])])];
      else if (merged[key] === undefined) merged[key] = value;
    }
    if (current.$ref !== undefined) {
      const target = definition(bundle, current.$ref);
      if (target.name === QUANTITY) quantity = true;
      if (!seen.has(target.name)) {
        seen.add(target.name);
        visit(target.node);
      }
    }
    for (const member of current.allOf ?? []) visit(member);
  };
  visit(node);
  const result = { schema, quantity };
  effectiveCache.set(node, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Walk

export function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (/^[A-Za-z_$][\w$-]*$/.test(key)) return path === '' ? key : `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function issue(path: string, rule: string, message: string): SchemaIssue {
  return { path, rule, message };
}

const patternCache = new Map<string, RegExp | null>();

function compiledPattern(pattern: string): RegExp | null {
  if (!patternCache.has(pattern)) {
    let compiled: RegExp | null = null;
    try {
      compiled = new RegExp(pattern, 'u');
    } catch {
      // An RE2 construct JavaScript does not know: left to the API server.
    }
    patternCache.set(pattern, compiled);
  }
  return patternCache.get(pattern) ?? null;
}

function walk(value: unknown, node: SchemaNode, path: string, bundle: SchemaBundle): SchemaIssue[] {
  // Dockflow never emits null (emission rule 5), even where the API would accept it.
  if (value === null) return [issue(path, 'null', 'null is never emitted')];
  const { schema, quantity } = effective(bundle, node);
  if (quantity) {
    if (typeof value !== 'string') return [issue(path, 'quantity', `quantity must be a string, got ${describe(value)}`)];
    return parseQuantity(value) === null ? [issue(path, 'quantity', `${JSON.stringify(value)} is not a Kubernetes quantity`)] : [];
  }
  if (schema['x-kubernetes-int-or-string'] === true || schema.format === 'int-or-string') {
    if (typeof value === 'string') return [];
    const int32 = schema.format === 'int-or-string';
    const valid = typeof value === 'number' && Number.isInteger(value) && (int32 ? value >= INT32_MIN && value <= INT32_MAX : Number.isSafeInteger(value));
    return valid ? [] : [issue(path, 'int-or-string', `expected an integer or a string, got ${describe(value)}`)];
  }
  if (schema['x-kubernetes-preserve-unknown-fields'] === true && schema.properties === undefined) return [];
  if (schema.type === undefined) {
    const alternatives = schema.oneOf ?? schema.anyOf;
    if (alternatives === undefined || alternatives.some((member) => walk(value, member, path, bundle).length === 0)) return [];
    return [issue(path, schema.oneOf ? 'one-of' : 'any-of', `${describe(value)} matches none of the allowed schemas`)];
  }
  switch (schema.type) {
    case 'object':
      return walkObject(value, schema, path, bundle);
    case 'array':
      return walkArray(value, schema, path, bundle);
    case 'string':
      return checkString(value, schema, path);
    case 'integer':
      return checkInteger(value, schema, path);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? checkRange(value, schema, path) : [issue(path, 'type', `expected number, got ${describe(value)}`)];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [issue(path, 'type', `expected boolean, got ${describe(value)}`)];
    default:
      return [];
  }
}

function walkObject(value: unknown, schema: SchemaNode, path: string, bundle: SchemaBundle): SchemaIssue[] {
  if (!isRecord(value)) return [issue(path, 'type', `expected object, got ${describe(value)}`)];
  const issues: SchemaIssue[] = [];
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) issues.push(issue(childPath(path, key), 'required', `required field ${key} is missing`));
  }
  const { properties, additionalProperties } = schema;
  // No properties and no additionalProperties: a free-form object (FieldsV1, RawExtension); a CRD
  // node that preserves unknown fields keeps them next to its declared properties.
  const freeForm =
    (properties === undefined && additionalProperties === undefined) || schema['x-kubernetes-preserve-unknown-fields'] === true;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const next = childPath(path, key);
    if (properties !== undefined && Object.hasOwn(properties, key)) issues.push(...walk(child, properties[key], next, bundle));
    else if (isRecord(additionalProperties)) issues.push(...walk(child, additionalProperties, next, bundle));
    else if (additionalProperties !== true && !freeForm) issues.push(issue(next, 'unknown-field', `unknown field ${key}`));
  }
  return issues;
}

function walkArray(value: unknown, schema: SchemaNode, path: string, bundle: SchemaBundle): SchemaIssue[] {
  if (!Array.isArray(value)) return [issue(path, 'type', `expected array, got ${describe(value)}`)];
  const issues: SchemaIssue[] = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    issues.push(issue(path, 'min-items', `has ${value.length} items, at least ${schema.minItems} required`));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    issues.push(issue(path, 'max-items', `has ${value.length} items, at most ${schema.maxItems} allowed`));
  }
  const items = schema.items;
  if (items !== undefined) value.forEach((item, index) => issues.push(...walk(item, items, childPath(path, index), bundle)));
  const listType = schema['x-kubernetes-list-type'];
  if (listType === 'map' && items !== undefined) {
    const keys = schema['x-kubernetes-list-map-keys'] ?? [];
    const itemProperties = effective(bundle, items).schema.properties ?? {};
    const seen = new Map<string, number>();
    value.forEach((item, index) => {
      if (!isRecord(item)) return;
      const tuple: unknown[] = [];
      for (const key of keys) {
        let part = item[key];
        // A key whose property has a default may be absent (the server fills it in).
        if (part === undefined && Object.hasOwn(itemProperties, key)) part = effective(bundle, itemProperties[key]).schema.default;
        if (part === undefined) issues.push(issue(childPath(childPath(path, index), key), 'list-map-key', `list-map key ${key} is missing`));
        tuple.push(part);
      }
      const id = JSON.stringify(tuple);
      const first = seen.get(id);
      if (first === undefined) seen.set(id, index);
      else {
        issues.push(
          issue(childPath(path, index), 'list-map-duplicate', `duplicates ${childPath(path, first)} on (${keys.join(', ')}) = (${tuple.map(String).join(', ')})`),
        );
      }
    });
  } else if (listType === 'set') {
    const seen = new Map<string, number>();
    value.forEach((item, index) => {
      const id = JSON.stringify(item);
      const first = seen.get(id);
      if (first === undefined) seen.set(id, index);
      else issues.push(issue(childPath(path, index), 'set-duplicate', `duplicates ${childPath(path, first)} in a set`));
    });
  }
  return issues;
}

function checkEnum(value: unknown, schema: SchemaNode, path: string): SchemaIssue[] {
  if (schema.enum === undefined || schema.enum.includes(value)) return [];
  return [issue(path, 'enum', `${JSON.stringify(value)} is not one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`)];
}

function checkString(value: unknown, schema: SchemaNode, path: string): SchemaIssue[] {
  if (typeof value !== 'string') return [issue(path, 'type', `expected string, got ${describe(value)}`)];
  const issues = checkEnum(value, schema, path);
  const pattern = schema.pattern === undefined ? null : compiledPattern(schema.pattern);
  if (pattern !== null && !pattern.test(value)) issues.push(issue(path, 'pattern', `${JSON.stringify(value)} does not match ${schema.pattern}`));
  const length = [...value].length;
  if (schema.minLength !== undefined && length < schema.minLength) {
    issues.push(issue(path, 'min-length', `is ${length} characters long, at least ${schema.minLength} required`));
  }
  if (schema.maxLength !== undefined && length > schema.maxLength) {
    issues.push(issue(path, 'max-length', `is ${length} characters long, at most ${schema.maxLength} allowed`));
  }
  if (schema.format === 'byte' && !BASE64_RE.test(value)) issues.push(issue(path, 'byte', 'is not canonical base64'));
  if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) issues.push(issue(path, 'date-time', `${JSON.stringify(value)} is not an RFC 3339 time`));
  return issues;
}

function checkRange(value: number, schema: SchemaNode, path: string): SchemaIssue[] {
  const issues = checkEnum(value, schema, path);
  if (schema.minimum !== undefined && value < schema.minimum) issues.push(issue(path, 'minimum', `${value} is below the minimum ${schema.minimum}`));
  if (schema.maximum !== undefined && value > schema.maximum) issues.push(issue(path, 'maximum', `${value} is above the maximum ${schema.maximum}`));
  return issues;
}

function checkInteger(value: unknown, schema: SchemaNode, path: string): SchemaIssue[] {
  if (typeof value !== 'number' || !Number.isInteger(value)) return [issue(path, 'type', `expected integer, got ${describe(value)}`)];
  if (schema.format === 'int32' && (value < INT32_MIN || value > INT32_MAX)) return [issue(path, 'int32', `${value} does not fit in int32`)];
  if (schema.format === 'int64' && !Number.isSafeInteger(value)) return [issue(path, 'int64', `${value} is not a safe int64`)];
  return checkRange(value, schema, path);
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** Root definition for an object, and the bundle it lives in. */
function rootFor(apiVersion: unknown, kind: unknown): { bundle: SchemaBundle; node: SchemaNode; crd: boolean } | null {
  if (typeof apiVersion !== 'string' || typeof kind !== 'string') return null;
  const { kubernetes, traefik } = schemaBundles();
  const key = `${apiVersion}/${kind}`;
  for (const bundle of [kubernetes, traefik]) {
    if (Object.hasOwn(bundle.roots, key)) return { bundle, node: definition(bundle, bundle.roots[key]).node, crd: bundle === traefik };
  }
  return null;
}

/** Structural issues of one object; an empty list means the API server would accept its shape. */
export function validateObject(object: unknown): SchemaIssue[] {
  if (!isRecord(object)) return [issue('', 'type', `expected object, got ${describe(object)}`)];
  const root = rootFor(object.apiVersion, object.kind);
  if (root === null) return [issue('', 'gvk', `no vendored schema for ${String(object.apiVersion)} ${String(object.kind)}`)];
  const issues = walk(object, root.node, '', root.bundle);
  // A CRD schema leaves metadata untyped; the API server validates it as ObjectMeta (design-02 14.3).
  if (root.crd && object.metadata !== undefined && object.metadata !== null) {
    const { kubernetes } = schemaBundles();
    issues.push(...walk(object.metadata, definition(kubernetes, OBJECT_META).node, 'metadata', kubernetes));
  }
  return issues;
}

/** `<kind>/<name> <path>: <rule> <message>`, the one-line form of design-02 14.5. */
export function formatIssue(object: unknown, found: SchemaIssue): string {
  const kind = isRecord(object) && typeof object.kind === 'string' ? object.kind : '?';
  const metadata = isRecord(object) && isRecord(object.metadata) ? object.metadata : {};
  const name = typeof metadata.name === 'string' ? metadata.name : '?';
  const location = found.path === '' ? '' : ` ${found.path}`;
  return `${kind}/${name}${location}: ${found.rule} ${found.message}${found.severity === 'warning' ? ' (warning)' : ''}`;
}
