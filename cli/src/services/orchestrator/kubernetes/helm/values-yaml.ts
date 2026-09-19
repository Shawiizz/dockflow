// Helm values read with Helm's own YAML rules (design-04 3.4.2, F19). Helm decodes values files with
// go-yaml v2, config.yml is YAML 1.2: `yes`, `on` and `0644` mean different things in each, and a
// snippet copied from a chart's documentation must mean what it means for Helm. Values then travel
// to Helm as canonical JSON, so nothing is re-interpreted a second time (I2). Pure.

import {
  type Document,
  isAlias,
  isCollection,
  isMap,
  isScalar,
  isSeq,
  type ParsedNode,
  parseAllDocuments,
  parseDocument,
  type Scalar,
  type YAMLError,
} from 'yaml';
import { canonicalJson } from '../../../../utils/hash';
import type { Diagnostic } from '../../diagnostics';

// ---------------------------------------------------------------------------
// go-yaml v2.4.4 resolve() for untagged plain scalars
// ---------------------------------------------------------------------------

export type HelmScalar = string | number | boolean | null;
/** `.inf` / `.nan`: Helm decodes them as floats that JSON cannot carry */
export interface NonFiniteScalar {
  nonFinite: string;
}

const TRUE_WORDS = new Set(['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON']);
const FALSE_WORDS = new Set(['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF']);
const NULL_WORDS = new Set(['', '~', 'null', 'Null', 'NULL']);
const NON_FINITE_WORDS = new Set([
  '.nan', '.NaN', '.NAN',
  '.inf', '.Inf', '.INF',
  '+.inf', '+.Inf', '+.INF',
  '-.inf', '-.Inf', '-.INF',
]);

const YAML_STYLE_FLOAT_RE = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const GO_DECIMAL_FLOAT_RE = /^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$/;
// Layouts "2006-1-2", "2006-1-2 15:4:5.999999999" and "2006-1-2T15:4:5.999999999Z07:00"
const GO_YAML_TIMESTAMP_RE =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt][0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]+)?(Z|[-+][0-9]{2}:[0-9]{2})|[ ][0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]+)?)?$/;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
/** Helm decodes every number as float64: integers beyond this lose precision */
const FLOAT64_EXACT_INT = 2n ** 53n;

interface PlainResolution {
  value: HelmScalar | NonFiniteScalar;
  /** set when the integer path produced the value, to detect float64 precision loss */
  integer: bigint | null;
}

/** Port of go-yaml v2.4.4 resolve() for untagged plain scalars (F19). */
export function goYamlV2Resolve(src: string): HelmScalar | NonFiniteScalar {
  return resolvePlain(src).value;
}

function resolvePlain(src: string): PlainResolution {
  const plain = (value: HelmScalar | NonFiniteScalar): PlainResolution => ({ value, integer: null });
  if (TRUE_WORDS.has(src)) return plain(true);
  if (FALSE_WORDS.has(src)) return plain(false);
  if (NULL_WORDS.has(src)) return plain(null);
  if (NON_FINITE_WORDS.has(src)) return plain({ nonFinite: src });
  const hint = src[0];
  if (hint === '.') return plain(goParseFloat(src) ?? src);
  if (hint === '+' || hint === '-' || (hint >= '0' && hint <= '9')) {
    // go-yaml keeps timestamp-looking scalars as the original string when decoding into interface{}
    if (GO_YAML_TIMESTAMP_RE.test(src)) return plain(src);
    const digits = src.replaceAll('_', '');
    const int = goParseInt(digits, 0);
    if (int !== null) return { value: Number(int), integer: int };
    if (YAML_STYLE_FLOAT_RE.test(digits)) {
      const float = goParseFloat(digits);
      if (float !== null) return plain(float);
    }
    if (digits.startsWith('0b')) {
      const binary = goParseInt(digits.slice(2), 2);
      if (binary !== null) return { value: Number(binary), integer: binary };
    } else if (digits.startsWith('-0b')) {
      const binary = goParseSigned(`-${digits.slice(3)}`, 2);
      if (binary !== null) return { value: Number(binary), integer: binary };
    }
  }
  return plain(src);
}

/** strconv.ParseInt(s, base, 64), then strconv.ParseUint(s, base, 64) as go-yaml tries them */
function goParseInt(s: string, base: 0 | 2): bigint | null {
  const signed = goParseSigned(s, base);
  if (signed !== null) return signed;
  const unsigned = s.startsWith('+') || s.startsWith('-') ? null : goParseUnsigned(s, base);
  return unsigned !== null && unsigned <= UINT64_MAX ? unsigned : null;
}

function goParseSigned(s: string, base: 0 | 2): bigint | null {
  const negative = s.startsWith('-');
  const magnitude = goParseUnsigned(negative || s.startsWith('+') ? s.slice(1) : s, base);
  if (magnitude === null) return null;
  const value = negative ? -magnitude : magnitude;
  return value >= INT64_MIN && value <= INT64_MAX ? value : null;
}

/** digits of strconv.ParseUint without the range check; base 0 reads the 0b/0o/0x/0 prefixes */
function goParseUnsigned(s: string, base: 0 | 2): bigint | null {
  if (s === '') return null;
  let radix: number = base;
  let digits = s;
  if (base === 0) {
    radix = 10;
    if (s[0] === '0') {
      const prefix = s.length >= 3 ? s[1].toLowerCase() : '';
      radix = prefix === 'b' ? 2 : prefix === 'o' ? 8 : prefix === 'x' ? 16 : 8;
      digits = prefix === 'b' || prefix === 'o' || prefix === 'x' ? s.slice(2) : s.slice(1);
    }
  }
  let value = 0n;
  for (const c of digits.toLowerCase()) {
    const d = c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c >= 'a' && c <= 'z' ? c.charCodeAt(0) - 87 : 99;
    if (d >= radix) return null;
    value = value * BigInt(radix) + BigInt(d);
  }
  return value;
}

/** strconv.ParseFloat(s, 64) for decimal syntax; null on a syntax error or an overflow (ErrRange) */
function goParseFloat(s: string): number | null {
  let text = s;
  if (text.includes('_')) {
    if (!goUnderscoreOk(text)) return null;
    text = text.replaceAll('_', '');
  }
  if (!GO_DECIMAL_FLOAT_RE.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** strconv's underscoreOK: an underscore only between two digits */
function goUnderscoreOk(s: string): boolean {
  let saw = '^';
  const body = s.startsWith('+') || s.startsWith('-') ? s.slice(1) : s;
  for (const c of body) {
    if (c >= '0' && c <= '9') {
      saw = '0';
    } else if (c === '_') {
      if (saw !== '0') return false;
      saw = '_';
    } else {
      if (saw === '_') return false;
      saw = '!';
    }
  }
  return saw !== '_';
}

// ---------------------------------------------------------------------------
// Key paths, sensitive keys, merge
// ---------------------------------------------------------------------------

/** Value leaves whose key path matches are secrets (DESIGN-CORE 8.8): redacted and masked in diffs. */
export const SENSITIVE_KEY_RE = /(pass|secret|token|key|credential|auth)/i;

export function isSensitiveKeyPath(keyPath: string): boolean {
  return SENSITIVE_KEY_RE.test(keyPath);
}

/** `a.b`, `a[0]`; a key that would make the path ambiguous is quoted: `a["x.y"]` */
export function joinKeyPath(parent: string, key: string): string {
  if (key === '' || /[.[\]"]/.test(key)) return `${parent}[${JSON.stringify(key)}]`;
  return parent === '' ? key : `${parent}.${key}`;
}

export function isValuesMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Helm's merge of several `-f` layers: maps merge key by key, lists and scalars replace, and a
 * `null` is kept (it deletes the chart default when Helm coalesces, I3).
 */
export function mergeHelmValues(...layers: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) mergeInto(out, layer);
  return out;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const value = source[key];
    // own properties only: a `__proto__` key must never reach Object.prototype
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isValuesMap(value) && isValuesMap(current)) mergeInto(current, value);
    else Object.defineProperty(target, key, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
  }
}

/** What Helm reads on `--values -`: JSON is YAML whose strings all stay strings. */
export function helmValuesStdin(values: Record<string, unknown>): string {
  return `${canonicalJson(values)}\n`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface HelmValuesOrigin {
  /** diagnostic path of the values root: `helm.releases[0].values` or `helm.releases[0].values_files[1]` */
  path: string;
  /** the values file as written in config.yml; null for inline `values` */
  file: string | null;
}

export interface HelmValuesResult {
  /** `{}` when an error was reported */
  values: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

const YAML_OPTIONS = {
  version: '1.1',
  merge: true,
  uniqueKeys: true,
  keepSourceTokens: true,
  logLevel: 'error',
} as const;
const MAX_ALIAS_COUNT = 1000;

const YAML_TAG_PREFIX = 'tag:yaml.org,2002:';
const STR_TAG = `${YAML_TAG_PREFIX}str`;
const INT_TAG = `${YAML_TAG_PREFIX}int`;
const FLOAT_TAG = `${YAML_TAG_PREFIX}float`;
const BOOL_TAG = `${YAML_TAG_PREFIX}bool`;
const NULL_TAG = `${YAML_TAG_PREFIX}null`;
const ALLOWED_TAGS = new Set([STR_TAG, INT_TAG, FLOAT_TAG, BOOL_TAG, NULL_TAG, `${YAML_TAG_PREFIX}map`, `${YAML_TAG_PREFIX}seq`]);

// Fixed texts: the library's messages can quote the offending source, which may be a secret
const YAML_ERROR_TEXT: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: 'duplicate key',
  BAD_INDENT: 'bad indentation',
  TAB_AS_INDENT: 'tab character used for indentation',
  MISSING_CHAR: 'missing closing character',
  BAD_ALIAS: 'invalid alias',
  TAG_RESOLVE_FAILED: 'value does not match its tag',
  MULTILINE_IMPLICIT_KEY: 'implicit key spans several lines',
  MULTIPLE_ANCHORS: 'several anchors on one node',
  MULTIPLE_TAGS: 'several tags on one node',
  KEY_OVER_1024_CHARS: 'implicit key longer than 1024 characters',
};

interface WalkContext {
  doc: Document.Parsed;
  /** source text, for line numbers */
  text: string;
  origin: HelmValuesOrigin;
  diagnostics: Diagnostic[];
  visited: Set<object>;
  failed: boolean;
}

/** One values file: every document parsed with Helm's rules and merged in order (F19). */
export function parseHelmValues(text: string, origin: HelmValuesOrigin): HelmValuesResult {
  const label = origin.file ?? origin.path;
  const diagnostics: Diagnostic[] = [];
  const layers: Record<string, unknown>[] = [];
  for (const doc of parseAllDocuments(text, YAML_OPTIONS)) {
    const error = doc.errors[0];
    if (error) {
      diagnostics.push(yamlDiagnostic(origin, label, error));
      return { values: {}, diagnostics };
    }
    const converted = convertNode(doc, text, doc.contents, origin, doc.warnings, diagnostics);
    if (converted === FAILED) return { values: {}, diagnostics };
    if (converted === null) continue;
    if (!isValuesMap(converted)) {
      diagnostics.push(notMapDiagnostic(origin, label));
      return { values: {}, diagnostics };
    }
    layers.push(converted);
  }
  return { values: mergeHelmValues(...layers), diagnostics };
}

/**
 * Reads `helm.releases[i].values` again from the config source with Helm's rules: config.yml
 * itself was parsed as YAML 1.2. The reader returns null when the source has no such node (or
 * does not parse), and the caller keeps the loaded value.
 */
export function inlineHelmValuesReader(configText: string): (index: number, origin: HelmValuesOrigin) => HelmValuesResult | null {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(configText, YAML_OPTIONS);
  } catch {
    return () => null;
  }
  const inside = (range: readonly number[] | undefined) => (problem: YAMLError) =>
    range !== undefined && problem.pos[0] >= range[0] && problem.pos[0] < range[2];
  return (index, origin) => {
    const node = releaseValuesNode(doc, index);
    if (node === undefined) return null;
    // problems elsewhere in config.yml belong to the config loader, not to these values; one
    // inside them can be new under YAML 1.1 (`on:` next to `true:` is a duplicate key)
    const error = doc.errors.find(inside(node?.range));
    if (error) return { values: {}, diagnostics: [yamlDiagnostic(origin, origin.path, error)] };
    const warnings = doc.warnings.filter(inside(node?.range));
    const diagnostics: Diagnostic[] = [];
    const converted = convertNode(doc, configText, node, origin, warnings, diagnostics);
    if (converted === FAILED || converted === null) return { values: {}, diagnostics };
    if (!isValuesMap(converted)) {
      diagnostics.push(notMapDiagnostic(origin, origin.path));
      return { values: {}, diagnostics };
    }
    return { values: converted, diagnostics };
  };
}

function releaseValuesNode(doc: Document.Parsed, index: number): ParsedNode | null | undefined {
  const releases = mapValue(doc, mapValue(doc, doc.contents, 'helm'), 'releases');
  const seq = deref(doc, releases);
  if (!isSeq(seq)) return undefined;
  const release = seq.items[index];
  return release === undefined ? undefined : mapValue(doc, release, 'values');
}

function deref(doc: Document.Parsed, node: unknown): unknown {
  return isAlias(node) ? node.resolve(doc) : node;
}

/** value node of `key` in a map, following aliases and `<<` merge sources; undefined when absent */
function mapValue(doc: Document.Parsed, node: unknown, key: string): ParsedNode | null | undefined {
  const map = deref(doc, node);
  if (!isMap(map)) return undefined;
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key) return pair.value as ParsedNode | null;
  }
  for (const pair of map.items) {
    if (!isMergeKey(pair.key)) continue;
    const source = deref(doc, pair.value);
    const sources = isSeq(source) ? source.items : [source];
    for (const item of sources) {
      const found = mapValue(doc, item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const FAILED = Symbol('failed');

/** Helm-resolves the scalars under `node` in place, then converts it; FAILED after an error. */
function convertNode(
  doc: Document.Parsed,
  text: string,
  node: unknown,
  origin: HelmValuesOrigin,
  warnings: YAMLError[],
  diagnostics: Diagnostic[],
): unknown {
  const ctx: WalkContext = { doc, text, origin, diagnostics, visited: new Set(), failed: false };
  walk(ctx, node, '');
  if (ctx.failed) return FAILED;
  // the walk resolved every tag itself: the library's tag warnings (`!!float 1`) do not apply
  const warning = warnings.find((w) => w.code !== 'TAG_RESOLVE_FAILED');
  if (warning) {
    diagnostics.push(yamlDiagnostic(origin, origin.file ?? origin.path, warning));
    return FAILED;
  }
  if (node === null || node === undefined) return null;
  try {
    return (node as ParsedNode).toJS(doc, { maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    diagnostics.push({
      severity: 'error',
      code: 'helm.values-yaml',
      path: origin.path,
      message: `${origin.file ?? origin.path}: ${reason}`,
    });
    return FAILED;
  }
}

function walk(ctx: WalkContext, node: unknown, keyPath: string): void {
  if (isAlias(node)) {
    // an anchor defined outside the walked subtree still has to follow Helm's rules
    walk(ctx, node.resolve(ctx.doc), keyPath);
    return;
  }
  if (node === null || typeof node !== 'object' || ctx.visited.has(node)) return;
  ctx.visited.add(node);
  if (!checkTag(ctx, node as ParsedNode, keyPath)) return;
  if (isScalar(node)) {
    resolveValueScalar(ctx, node, keyPath);
  } else if (isMap(node)) {
    for (const pair of node.items) {
      if (isMergeKey(pair.key)) {
        walk(ctx, pair.value, keyPath);
        continue;
      }
      const key = resolveKey(ctx, pair.key, keyPath);
      if (key !== null) walk(ctx, pair.value, joinKeyPath(keyPath, key));
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => walk(ctx, item, `${keyPath}[${i}]`));
  }
}

function isMergeKey(key: unknown): boolean {
  return isScalar(key) && typeof key.value === 'symbol';
}

function checkTag(ctx: WalkContext, node: ParsedNode, keyPath: string): boolean {
  const tag = node.tag;
  if (tag === undefined || ALLOWED_TAGS.has(tag)) return true;
  const shown = tag.startsWith(YAML_TAG_PREFIX) ? `!!${tag.slice(YAML_TAG_PREFIX.length)}` : tag;
  report(ctx, 'error', 'helm.values-tag', keyPath, `${keyLabel(ctx, keyPath)} uses the YAML tag ${shown}, which is not supported in Helm values`);
  ctx.failed = true;
  return false;
}

function resolveValueScalar(ctx: WalkContext, node: Scalar, keyPath: string): void {
  const tag = node.tag;
  // quoted and block scalars without a tag are strings, as the library already read them
  if (tag === undefined && node.type !== 'PLAIN') return;
  const source = typeof node.source === 'string' ? node.source : String(node.value);
  if (tag === STR_TAG) {
    node.value = source;
    return;
  }
  const resolved = resolvePlain(source);
  if (isNonFinite(resolved.value)) {
    if (tag === undefined || tag === FLOAT_TAG) nonFinite(ctx, keyPath, source);
    else tagMismatch(ctx, node);
    return;
  }
  // go-yaml resolves a tagged scalar like a plain one and refuses a result of another type
  // (`!!int 1.5`, `!!bool 1`), except an integer under !!float
  const value = resolved.value;
  const matches =
    tag === undefined ||
    (tag === NULL_TAG && value === null) ||
    (tag === BOOL_TAG && typeof value === 'boolean') ||
    (tag === INT_TAG && resolved.integer !== null) ||
    (tag === FLOAT_TAG && typeof value === 'number');
  if (!matches) {
    tagMismatch(ctx, node);
    return;
  }
  node.value = value;
  if (resolved.integer !== null && tag !== FLOAT_TAG) checkPrecision(ctx, keyPath, source, resolved.integer);
}

function tagMismatch(ctx: WalkContext, node: Scalar): void {
  ctx.diagnostics.push({
    severity: 'error',
    code: 'helm.values-yaml',
    path: ctx.origin.path,
    message: `${ctx.origin.file ?? ctx.origin.path}: value does not match its tag${linePosition(ctx.text, node.range?.[0])}`,
  });
  ctx.failed = true;
}

/** display text of a mapping key; null after reporting a key Helm cannot represent */
function resolveKey(ctx: WalkContext, key: unknown, keyPath: string): string | null {
  const target = isAlias(key) ? key.resolve(ctx.doc) : key;
  if (target === null || target === undefined) return '';
  if (isCollection(target)) {
    const line = linePosition(ctx.text, (target as ParsedNode).range?.[0]);
    report(ctx, 'error', 'helm.values-yaml', '', `${ctx.origin.file ?? ctx.origin.path}: a mapping key must be a scalar${line}`);
    ctx.failed = true;
    return null;
  }
  if (!isScalar(target)) return '';
  if (!checkTag(ctx, target as ParsedNode, keyPath)) return null;
  if (!ctx.visited.has(target)) {
    ctx.visited.add(target);
    if (target.tag !== undefined) {
      const reported = ctx.diagnostics.length;
      resolveValueScalar(ctx, target, keyPath);
      if (ctx.diagnostics.slice(reported).some((d) => d.severity === 'error')) return null;
    } else if (target.type === 'PLAIN' && typeof target.source === 'string') {
      // go-yaml resolves keys like values; JSON then spells booleans and numbers as text
      const resolved = resolvePlain(target.source).value;
      target.value = typeof resolved === 'boolean' || typeof resolved === 'number' ? resolved : target.source;
    }
  }
  return target.value === null ? '' : String(target.value);
}

function isNonFinite(value: HelmScalar | NonFiniteScalar): value is NonFiniteScalar {
  return value !== null && typeof value === 'object';
}

function nonFinite(ctx: WalkContext, keyPath: string, source: string): void {
  report(
    ctx,
    'error',
    'helm.values-non-finite',
    keyPath,
    `${keyLabel(ctx, keyPath)} is ${source}, which Helm values cannot carry through JSON`,
    'Quote it if a string was meant.',
  );
  ctx.failed = true;
}

function checkPrecision(ctx: WalkContext, keyPath: string, source: string, value: bigint): void {
  if (value <= FLOAT64_EXACT_INT && value >= -FLOAT64_EXACT_INT) return;
  report(
    ctx,
    'warning',
    'helm.values-large-int',
    keyPath,
    `${keyLabel(ctx, keyPath)} (${source}) loses precision: Helm decodes numbers as float64`,
    'Quote it if the chart expects a string.',
  );
}

/** inline values: the key path; a values file: the key path and the file */
function keyLabel(ctx: WalkContext, keyPath: string): string {
  const file = ctx.origin.file;
  if (file === null) return keyPath === '' ? ctx.origin.path : keyPath;
  return keyPath === '' ? file : `${keyPath} in ${file}`;
}

function report(
  ctx: WalkContext,
  severity: 'error' | 'warning',
  code: string,
  keyPath: string,
  message: string,
  hint?: string,
): void {
  // a values file keeps its values_files[j] path; inline values point at the key itself
  const path = ctx.origin.file === null && keyPath !== '' ? joinValuesPath(ctx.origin.path, keyPath) : ctx.origin.path;
  ctx.diagnostics.push(hint === undefined ? { severity, code, path, message } : { severity, code, path, message, hint });
}

function joinValuesPath(root: string, keyPath: string): string {
  return keyPath.startsWith('[') ? `${root}${keyPath}` : `${root}.${keyPath}`;
}

function yamlDiagnostic(origin: HelmValuesOrigin, label: string, error: YAMLError): Diagnostic {
  const text = YAML_ERROR_TEXT[error.code] ?? `invalid YAML (${error.code.toLowerCase().replaceAll('_', ' ')})`;
  const line = error.linePos?.[0]?.line;
  return {
    severity: 'error',
    code: 'helm.values-yaml',
    path: origin.path,
    message: `${label}: ${text}${line === undefined ? '' : ` at line ${line}`}`,
  };
}

function linePosition(text: string, offset: number | undefined): string {
  if (offset === undefined) return '';
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return ` at line ${line}`;
}

function notMapDiagnostic(origin: HelmValuesOrigin, label: string): Diagnostic {
  return {
    severity: 'error',
    code: 'helm.values-not-map',
    path: origin.path,
    message: `${label} must contain a mapping at the top level`,
  };
}
