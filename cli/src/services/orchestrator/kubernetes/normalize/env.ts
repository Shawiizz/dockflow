// `environment` and `env_file` (design-01 5.3, D11), the env file parsers of design-01 2.11, and the
// value-layer readers of design-01 2.4, 2.5 and 2.9 that the identity, security and healthcheck
// handlers share. Pure: file contents come from NormalizeContext.readFile.

import type { EnvVar } from '../model/types';
import { isSecretDataKey, parseBool, parseDurationMs, parseIntStrict } from '../model/units';
import { serviceNameFor } from '../naming';
import { childPath, compareCodeUnits, indexPath, isPlainMap, type NormalizeContext, type ServiceDraft } from './context';

// ---------------------------------------------------------------------------
// Value layer (design-01 2.4, 2.5, 2.9)
// ---------------------------------------------------------------------------

export type ValueTypeName = 'null' | 'boolean' | 'number' | 'string' | 'list' | 'mapping';

export function typeName(value: unknown): ValueTypeName {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'mapping';
}

/** `<v>` of the design-01 tables: a scalar as written, the type name of anything else. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeName(value);
}

/** null or undefined: the key is treated as absent */
export function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function reportInvalidType(ctx: NormalizeContext, path: string, expected: string, value: unknown): void {
  ctx.sink.error('values.invalid-type', path, `expected ${expected}, got ${typeName(value)}`, 'See the Compose specification for the accepted forms.');
}

export function reportEmpty(ctx: NormalizeContext, path: string): void {
  ctx.sink.error('values.empty', path, 'must not be empty');
}

/** compose-go toBoolean; null after an error */
export function readBool(value: unknown, path: string, ctx: NormalizeContext): boolean | null {
  const parsed = parseBool(value);
  if (parsed === null) {
    ctx.sink.error('values.invalid-boolean', path, `expected true or false, got ${displayValue(value)}`, 'Write `true` or `false`.');
    return null;
  }
  if (parsed.yaml11) {
    ctx.sink.warn(
      'values.yaml11-boolean',
      path,
      `${displayValue(value)} is read as ${parsed.value}; YAML 1.2 only knows true and false`,
      `Write \`${parsed.value}\`.`,
    );
  }
  return parsed.value;
}

/** milliseconds (Go time.ParseDuration); null after an error */
export function readDuration(value: unknown, path: string, ctx: NormalizeContext): number | null {
  const ms = parseDurationMs(value);
  const shown = displayValue(value);
  if (ms === 'negative') {
    ctx.sink.error('values.negative-duration', path, `${shown} must not be negative`);
    return null;
  }
  if (ms === 'overflow') {
    ctx.sink.error('values.duration-too-large', path, `${shown} is too large`);
    return null;
  }
  if (ms === null) {
    ctx.sink.error('values.invalid-duration', path, `${shown} is not a duration`, 'Use a duration such as `30s`, `1m30s` or `500ms`.');
    return null;
  }
  return ms;
}

/** integers written as numbers or decimal strings; null after an error */
export function readInt(value: unknown, path: string, min: number, max: number, ctx: NormalizeContext): number | null {
  const n = parseIntStrict(value, min, max);
  if (n === null) {
    ctx.sink.error('values.invalid-integer', path, `expected an integer between ${min} and ${max}, got ${displayValue(value)}`, 'Write a whole number.');
  }
  return n;
}

export function readString(value: unknown, path: string, ctx: NormalizeContext): string | null {
  if (typeof value === 'string') return value;
  reportInvalidType(ctx, path, 'string', value);
  return null;
}

export interface ListItem {
  value: string;
  path: string;
}

/**
 * `list_of_strings` / `string_or_list` (design-01 2.9). Numbers become strings when `numbers` is
 * set (`group_add: [1000]`); a string is a one-item list when `stringForm` is set. Invalid items
 * are reported and skipped; null after a type error of the whole value.
 */
export function readStringList(
  value: unknown,
  path: string,
  ctx: NormalizeContext,
  options: { numbers?: boolean; stringForm?: boolean } = {},
): ListItem[] | null {
  if (typeof value === 'string' && options.stringForm === true) return [{ value, path }];
  if (!Array.isArray(value)) {
    reportInvalidType(ctx, path, options.stringForm === true ? 'string or list' : 'list', value);
    return null;
  }
  const items: ListItem[] = [];
  value.forEach((item, i) => {
    const itemPath = indexPath(path, i);
    if (typeof item === 'string') items.push({ value: item, path: itemPath });
    else if (typeof item === 'number' && options.numbers === true) items.push({ value: String(item), path: itemPath });
    else reportInvalidType(ctx, itemPath, 'string', item);
  });
  return items;
}

export interface ListOrDictEntry {
  key: string;
  /** null: `K:` in a map, `K` alone in a list */
  value: string | null;
  path: string;
}

/**
 * `list_or_dict` (design-01 2.9): map values as strings (numbers and booleans are normally source
 * text already), list entries split at the first `=`. Duplicate list keys: the last wins, with an
 * info. Returned in the order of each key's last occurrence; null after a type error.
 */
export function readListOrDict(value: unknown, path: string, ctx: NormalizeContext): ListOrDictEntry[] | null {
  const entries = new Map<string, ListOrDictEntry>();
  if (isPlainMap(value)) {
    for (const [key, v] of Object.entries(value)) {
      const entryPath = childPath(path, key);
      if (v === null || v === undefined) entries.set(key, { key, value: null, path: entryPath });
      else if (typeof v === 'string') entries.set(key, { key, value: v, path: entryPath });
      else if (typeof v === 'number' || typeof v === 'boolean') entries.set(key, { key, value: String(v), path: entryPath });
      else reportInvalidType(ctx, entryPath, 'string', v);
    }
    return [...entries.values()];
  }
  if (!Array.isArray(value)) {
    reportInvalidType(ctx, path, 'list or mapping', value);
    return null;
  }
  value.forEach((item, i) => {
    const itemPath = indexPath(path, i);
    if (typeof item !== 'string') {
      reportInvalidType(ctx, itemPath, 'string', item);
      return;
    }
    const eq = item.indexOf('=');
    const key = eq === -1 ? item : item.slice(0, eq);
    if (key === '') {
      ctx.sink.error('values.empty-key', itemPath, 'an entry has an empty name');
      return;
    }
    if (entries.has(key)) {
      ctx.sink.info('values.duplicate-key', itemPath, `${key} is set more than once; the last value wins`);
      entries.delete(key);
    }
    entries.set(key, { key, value: eq === -1 ? null : item.slice(eq + 1), path: itemPath });
  });
  return [...entries.values()];
}

// ---------------------------------------------------------------------------
// Interpolation inside env and label files (design-01 2.3 applied by 2.11)
// ---------------------------------------------------------------------------
// The document-level pass lives in interpolate.ts; env files need the same grammar with a lookup
// over the variables parsed so far, and messages that never name what an env file contains.

export interface EnvInterpolationIssue {
  kind: 'unset' | 'required' | 'invalid';
}

type Lookup = (name: string) => string | undefined;

const NAME_RE = /^[_a-zA-Z][_a-zA-Z0-9]*/;
const BRACED_RE = /^([_a-zA-Z][_a-zA-Z0-9]*)(?:(:?[-+?])([\s\S]*))?$/;

/** index of the `}` closing the `${` whose `{` is at `open`, counting nested `${`; -1 when unclosed */
function matchingBrace(input: string, open: number): number {
  let depth = 1;
  for (let j = open + 1; j < input.length; j++) {
    if (input[j] === '$' && input[j + 1] === '{') {
      depth++;
      j++;
    } else if (input[j] === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Compose interpolation of one value; `lookup` returns undefined for unset variables. */
export function interpolateEnvValue(input: string, lookup: Lookup): { value: string; issues: EnvInterpolationIssue[] } {
  const issues: EnvInterpolationIssue[] = [];
  const rec = (arg: string): string => {
    const inner = interpolateEnvValue(arg, lookup);
    issues.push(...inner.issues);
    return inner.value;
  };
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c !== '$') {
      out += c;
      continue;
    }
    const next = input[i + 1];
    if (next === '$') {
      out += '$';
      i++;
      continue;
    }
    if (next === '{') {
      const end = matchingBrace(input, i + 1);
      const m = end === -1 ? null : BRACED_RE.exec(input.slice(i + 2, end));
      if (m === null) {
        issues.push({ kind: 'invalid' });
        i = end === -1 ? input.length : end;
        continue;
      }
      const [, name, op, arg = ''] = m;
      const value = lookup(name);
      const unsetOrEmpty = value === undefined || value === '';
      switch (op) {
        case undefined:
          if (value === undefined) issues.push({ kind: 'unset' });
          out += value ?? '';
          break;
        case ':-':
          out += unsetOrEmpty ? rec(arg) : value;
          break;
        case '-':
          out += value === undefined ? rec(arg) : value;
          break;
        case ':?':
          if (unsetOrEmpty) issues.push({ kind: 'required' });
          else out += value;
          break;
        case '?':
          if (value === undefined) issues.push({ kind: 'required' });
          else out += value;
          break;
        case ':+':
          out += unsetOrEmpty ? '' : rec(arg);
          break;
        case '+':
          out += value === undefined ? '' : rec(arg);
          break;
      }
      i = end;
      continue;
    }
    const named = NAME_RE.exec(input.slice(i + 1));
    if (named) {
      const value = lookup(named[0]);
      if (value === undefined) issues.push({ kind: 'unset' });
      out += value ?? '';
      i += named[0].length;
      continue;
    }
    // `$5`, `$ `, `$(` and a trailing `$` are kept
    out += '$';
  }
  return { value: out, issues };
}

/**
 * Reports the interpolation issues of one env or label file at the path of the key that reads it.
 * The variable name and the `:?` message are never printed: both are part of the file content.
 */
export function reportFileInterpolationIssues(issues: readonly EnvInterpolationIssue[], file: string, path: string, ctx: NormalizeContext): void {
  const hint = 'Use `{{ current.env.<name> }}` for a Dockflow value, or write `$$` for a literal `$` (for inserted values: `{{ value | replace("$", "$$") }}`).';
  for (const issue of issues) {
    switch (issue.kind) {
      case 'unset':
        ctx.sink.error('interpolate.unset', path, `${file}: contains a $ placeholder that has no value (Dockflow does not pass a process environment)`, hint);
        break;
      case 'required':
        ctx.sink.error(
          'interpolate.required',
          path,
          `${file}: contains a \${...:?} placeholder whose variable has no value (Dockflow does not pass a process environment)`,
          'Replace the placeholder with a Nunjucks value such as `{{ current.env.<name> }}`.',
        );
        break;
      case 'invalid':
        ctx.sink.error('interpolate.invalid', path, `${file}: contains an invalid \${...} placeholder`, 'Write `$$` for a literal `$`.');
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Env file parsers (design-01 2.11)
// ---------------------------------------------------------------------------

export type EnvFileParse = { vars: [string, string][]; issues: EnvInterpolationIssue[] } | { error: string; line: number };

/** compose-go isSpace: every blank except the newline */
function isInlineSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\v' || ch === '\f' || ch === '\r' || ch === '\u0085' || ch === '\u00a0';
}

const KEY_PUNCTUATION = new Set(['_', '.', '-', '[', ']']);
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;
const ESCAPE_SEQUENCE = /\\(?:[abcfnrtv$"\\]|0\d{0,3})/g;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '"': '"',
  '\\': '\\',
};

/** compose-go expandEscapes: `\$` becomes `$$` (a literal `$` for the interpolation that follows) */
function expandEscapes(value: string): string {
  return value.replace(ESCAPE_SEQUENCE, (match) => {
    const c = match[1];
    if (c === '$') return '$$';
    if (c === '0') {
      // Go reads `\0ooo` as the octal escape `\ooo`, which needs exactly three octal digits <= 0o377
      const digits = match.slice(2);
      if (/^[0-7]{3}$/.test(digits) && Number.parseInt(digits, 8) <= 0o377) return String.fromCharCode(Number.parseInt(digits, 8));
      return match;
    }
    return SIMPLE_ESCAPES[c] ?? match;
  });
}

function stripBom(text: string): string {
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

/**
 * compose-go dotenv parser (design-01 2.11). `lookup` resolves variables from earlier env files of
 * the same service; earlier lines of the same file are consulted first. Error messages never quote
 * a value.
 */
export function parseDotenv(src: string, lookup: Lookup): EnvFileParse {
  const out = new Map<string, string>();
  const issues: EnvInterpolationIssue[] = [];
  const look: Lookup = (k) => (out.has(k) ? out.get(k) : lookup(k));
  const interp = (raw: string): string => {
    const r = interpolateEnvValue(raw, look);
    issues.push(...r.issues);
    return r.value;
  };
  let line = 1;
  let rest = stripBom(src);

  for (;;) {
    // statement start: skip blanks (counting lines) and comment lines
    let i = 0;
    for (;;) {
      while (i < rest.length && (isInlineSpace(rest[i]) || rest[i] === '\n')) {
        if (rest[i] === '\n') line++;
        i++;
      }
      if (i < rest.length && rest[i] === '#') {
        const nl = rest.indexOf('\n', i);
        i = nl === -1 ? rest.length : nl;
        continue;
      }
      break;
    }
    rest = rest.slice(i);
    if (rest === '') break;
    if (/^export\s/.test(rest)) {
      rest = rest.slice('export'.length);
      let j = 0;
      while (j < rest.length && isInlineSpace(rest[j])) j++;
      rest = rest.slice(j);
    }

    let separator: '=' | ':' | '\n' | null = null;
    let sepIndex = rest.length;
    for (let j = 0; j < rest.length; ) {
      const cp = rest.codePointAt(j) ?? 0;
      const ch = String.fromCodePoint(cp);
      if (ch === '=' || ch === ':' || ch === '\n') {
        separator = ch;
        sepIndex = j;
        break;
      }
      if (!isInlineSpace(ch) && !KEY_PUNCTUATION.has(ch) && !LETTER_OR_NUMBER.test(ch)) {
        return { error: `unexpected character ${JSON.stringify(ch)} in variable name`, line };
      }
      j += ch.length;
    }
    const key = rest.slice(0, sepIndex).replace(/\s+$/u, '');
    if (key === '') return { error: 'key cannot be empty', line };
    if (key.includes(' ')) return { error: 'key cannot contain a space', line };

    if (separator === null || separator === '\n') {
      // `KEY` alone inherits a value, which only earlier files can provide
      const v = look(key);
      if (v !== undefined) out.set(key, v);
      rest = separator === null ? '' : rest.slice(sepIndex + 1);
      line++;
      continue;
    }

    let value = rest.slice(sepIndex + 1);
    let k = 0;
    while (k < value.length && isInlineSpace(value[k])) k++;
    value = value.slice(k);
    const quote = value[0];
    if (quote !== '"' && quote !== "'") {
      const nl = value.indexOf('\n');
      let raw = nl === -1 ? value : value.slice(0, nl);
      rest = nl === -1 ? '' : value.slice(nl + 1);
      const hash = raw.indexOf(' #');
      if (hash !== -1) raw = raw.slice(0, hash);
      out.set(key, interp(raw.replace(/\s+$/u, '')));
      line++;
      continue;
    }

    // quoted: a backslash before the quote character yields the quote, before any other character both are kept
    const startLine = line;
    let body = '';
    let escaped = false;
    let closed = -1;
    for (let j = 1; j < value.length; j++) {
      const ch = value[j];
      if (ch === '\n') line++;
      if (ch !== quote) {
        if (!escaped && ch === '\\') {
          escaped = true;
          continue;
        }
        if (escaped) {
          escaped = false;
          body += '\\';
        }
        body += ch;
        continue;
      }
      if (escaped) {
        escaped = false;
        body += ch;
        continue;
      }
      closed = j;
      break;
    }
    if (closed === -1) return { error: 'unterminated quoted value', line: startLine };
    out.set(key, quote === '"' ? interp(expandEscapes(body)) : body);
    rest = value.slice(closed + 1);
  }
  return { vars: [...out], issues };
}

/** Docker's kvfile format (`format: raw`): `KEY=VALUE` verbatim, no quotes, no interpolation. */
export function parseKvFile(src: string, lookup: Lookup): EnvFileParse {
  const out = new Map<string, string>();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (i === 0) text = stripBom(text);
    text = text.replace(/^\s+/u, '');
    if (text === '' || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    const key = eq === -1 ? text : text.slice(0, eq);
    if (key === '') return { error: 'no variable name on the line', line: i + 1 };
    if (/\s/u.test(key)) return { error: `variable ${key} contains whitespace`, line: i + 1 };
    if (eq === -1) {
      const v = out.has(key) ? out.get(key) : lookup(key);
      if (v !== undefined) out.set(key, v);
      continue;
    }
    out.set(key, text.slice(eq + 1));
  }
  return { vars: [...out], issues: [] };
}

/**
 * UTF-8 text of a file, or the 1-based line of the first byte sequence that is not UTF-8. Lines
 * are decoded one by one so the error can say where the problem is.
 */
export function decodeUtf8(bytes: Uint8Array): { text: string } | { badLine: number } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return { text: decoder.decode(bytes) };
  } catch {
    let start = 0;
    let line = 1;
    for (let i = 0; i <= bytes.length; i++) {
      if (i === bytes.length || bytes[i] === 0x0a) {
        try {
          decoder.decode(bytes.subarray(start, i));
        } catch {
          return { badLine: line };
        }
        start = i + 1;
        line++;
      }
    }
    return { badLine: 1 };
  }
}

// ---------------------------------------------------------------------------
// environment and env_file (design-01 5.3)
// ---------------------------------------------------------------------------

/** sum of name and value bytes above which the env Secret cannot be created (design-01 ENV-06) */
export const ENV_MAX_BYTES = 1_000_000;

interface EnvFileEntry {
  file: string;
  required: boolean;
  format: 'dotenv' | 'raw';
  /** where a problem with this entry is reported */
  path: string;
}

/** where a variable comes from: the path its diagnostics use, and the env file for message prefixes */
interface EnvSource {
  value: string;
  path: string;
  file: string | null;
}

function readEnvFileEntries(value: unknown, path: string, ctx: NormalizeContext): EnvFileEntry[] {
  if (typeof value === 'string') return [{ file: value, required: true, format: 'dotenv', path }];
  if (!Array.isArray(value)) {
    reportInvalidType(ctx, path, 'string or list', value);
    return [];
  }
  const entries: EnvFileEntry[] = [];
  value.forEach((item, i) => {
    const itemPath = indexPath(path, i);
    if (typeof item === 'string') {
      if (item === '') reportEmpty(ctx, itemPath);
      else entries.push({ file: item, required: true, format: 'dotenv', path: itemPath });
      return;
    }
    if (!isPlainMap(item)) {
      reportInvalidType(ctx, itemPath, 'string or mapping', item);
      return;
    }
    const filePath = childPath(itemPath, 'path');
    let ok = true;
    let required = true;
    if (!isAbsent(item.required)) {
      const b = readBool(item.required, childPath(itemPath, 'required'), ctx);
      if (b === null) ok = false;
      else required = b;
    }
    let format: EnvFileEntry['format'] = 'dotenv';
    if (!isAbsent(item.format)) {
      const formatPath = childPath(itemPath, 'format');
      if (item.format === 'raw') format = 'raw';
      else if (typeof item.format !== 'string') {
        reportInvalidType(ctx, formatPath, 'string', item.format);
        ok = false;
      } else {
        ctx.sink.error('env_file.unsupported-format', formatPath, `format ${displayValue(item.format)} is not supported`, 'Remove `format`, or use `format: raw`.');
        ok = false;
      }
    }
    if (isAbsent(item.path) || item.path === '') {
      reportEmpty(ctx, filePath);
      return;
    }
    if (typeof item.path !== 'string') {
      reportInvalidType(ctx, filePath, 'string', item.path);
      return;
    }
    if (ok) entries.push({ file: item.path, required, format, path: filePath });
  });
  return entries;
}

function mergeEnvFiles(entries: readonly EnvFileEntry[], vars: Map<string, EnvSource>, ctx: NormalizeContext): void {
  // earlier files feed the inherited `KEY` lines and `$KEY` references of later ones
  const lookup: Lookup = (k) => vars.get(k)?.value;
  for (const entry of entries) {
    const read = ctx.readFile(entry.file, entry.path, 'env_file', { required: entry.required });
    if (!read.ok) {
      if (read.reason === 'missing' && !entry.required) {
        ctx.sink.info('env_file.optional-missing', entry.path, `optional env file ${entry.file} was not found and is skipped`);
      }
      continue;
    }
    const decoded = decodeUtf8(read.bytes);
    const parsed =
      'badLine' in decoded
        ? { error: 'the file is not valid UTF-8', line: decoded.badLine }
        : entry.format === 'raw'
          ? parseKvFile(decoded.text, lookup)
          : parseDotenv(decoded.text, lookup);
    if ('error' in parsed) {
      ctx.sink.error(
        'env_file.parse-error',
        entry.path,
        `${entry.file} line ${parsed.line}: ${parsed.error}`,
        'Fix the line; the env file format is described in the Compose specification.',
      );
      continue;
    }
    reportFileInterpolationIssues(parsed.issues, entry.file, entry.path, ctx);
    for (const [name, value] of parsed.vars) {
      vars.delete(name);
      vars.set(name, { value, path: entry.path, file: entry.file });
    }
  }
}

function applyEnvironment(value: unknown, path: string, vars: Map<string, EnvSource>, ctx: NormalizeContext): void {
  const entries = readListOrDict(value, path, ctx);
  if (entries === null) return;
  for (const entry of entries) {
    vars.delete(entry.key);
    if (entry.value === null) {
      ctx.sink.warn(
        'env.unset-variable',
        entry.path,
        `${entry.key} has no value, so it is not set in the container: Dockflow does not pass its own environment to the service`,
        `Give it a value, for example \`${entry.key}: "{{ current.env.${entry.key.toLowerCase()} }}"\`.`,
      );
      continue;
    }
    vars.set(entry.key, { value: entry.value, path: entry.path, file: null });
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `true` when `needle` occurs in `haystack` delimited by the string ends or characters outside `[A-Za-z0-9._-]` */
export function containsToken(haystack: string, needle: string): boolean {
  const inToken = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9._-]/.test(ch);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!inToken(haystack[at - 1]) && !inToken(haystack[at + needle.length])) return true;
  }
  return false;
}

/**
 * design-01 10 S8 (ENV-07, ENV-07b): Swarm service names and renamed compose keys of either role
 * inside environment values. Only the variable name and the matched service name are printed.
 */
function scanServiceNames(vars: ReadonlyMap<string, EnvSource>, ctx: NormalizeContext): void {
  // normalizeStack only runs handlers on a mapping document; a direct call must not throw either
  const raw: unknown = ctx.input.compose.raw;
  const services = isPlainMap(raw) ? raw.services : undefined;
  const own = isPlainMap(services) ? Object.keys(services) : [];
  const keys = [...new Set([...own, ...ctx.input.sibling.services.map((s) => s.key)])].sort(compareCodeUnits);
  if (keys.length === 0) return;
  const stackName = ctx.input.identity.stackName;
  const swarmNames = keys.flatMap((k) => [`${stackName}_${k}`, `tasks.${k}`].map((mention) => ({ k, mention })));
  const renamed = keys.filter((k) => serviceNameFor(k).changed);
  for (const [name, source] of vars) {
    const swarm = swarmNames.find(({ mention }) => containsToken(source.value, mention));
    if (swarm !== undefined) {
      const target = serviceNameFor(swarm.k).value;
      ctx.sink.warn(
        'env.swarm-service-name',
        source.path,
        `the value of ${name} mentions ${swarm.mention}, a Swarm service name that does not resolve on Kubernetes`,
        `Use the service name \`${target}\` instead.`,
      );
    }
    const key = renamed.find((k) => containsToken(source.value, k));
    if (key !== undefined) {
      const target = serviceNameFor(key).value;
      ctx.sink.warn(
        'env.renamed-service-name',
        source.path,
        `the value of ${name} mentions ${key}, which is deployed as Kubernetes service ${target}`,
        `Use \`${target}\`; the compose name does not resolve in DNS.`,
      );
    }
  }
}

/**
 * design-01 5.3: `env_file` entries in list order (later files win), then `environment` (later
 * entries win); a variable without a value is removed. Names must be Secret data keys (C8).
 */
export function env(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const vars = new Map<string, EnvSource>();
  if (!isAbsent(node.env_file)) mergeEnvFiles(readEnvFileEntries(node.env_file, childPath(draft.path, 'env_file'), ctx), vars, ctx);
  if (!isAbsent(node.environment)) applyEnvironment(node.environment, childPath(draft.path, 'environment'), vars, ctx);

  const valid = new Map<string, EnvSource>();
  let bytes = 0;
  for (const [name, source] of vars) {
    if (!isSecretDataKey(name)) {
      const prefix = source.file === null ? '' : `${source.file}: `;
      ctx.sink.error(
        'env.invalid-name',
        source.path,
        `${prefix}environment variable ${name} cannot be stored in a Kubernetes Secret: names may only contain letters, digits, '-', '_' and '.'`,
        'Rename the variable.',
      );
      continue;
    }
    valid.set(name, source);
    bytes += utf8Length(name) + utf8Length(source.value);
  }
  if (bytes > ENV_MAX_BYTES) {
    ctx.sink.error(
      'env.too-large',
      draft.path,
      `the environment of ${draft.composeName} is ${bytes} bytes; Kubernetes Secrets are limited to 1 MiB`,
      'Move large values to a config or secret file.',
    );
  }
  const environment: EnvVar[] = [...valid].map(([name, source]) => ({ name, value: source.value }));
  environment.sort((a, b) => compareCodeUnits(a.name, b.name));
  draft.environment = environment;
  scanServiceNames(valid, ctx);
}
