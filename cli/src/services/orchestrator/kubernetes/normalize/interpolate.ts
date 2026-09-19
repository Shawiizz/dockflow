// Compose interpolation (compose spec 12) with an empty environment (design-01 2.3). Dockflow passes
// no process environment to Compose: Nunjucks is the value mechanism, so an unresolved placeholder is
// an error here, where Compose only warns (D3: a silently emptied value is a dropped value).
// Pure: the lookup is a parameter, env files pass their own (design-01 2.11).

import type { DiagnosticSink } from '../../diagnostics';
import { childPath, indexPath, isPlainMap } from './context';

export interface InterpolationIssue {
  kind: 'unset' | 'required' | 'invalid';
  /** null for `invalid` */
  variable: string | null;
  /** the text after `?` / `:?`, itself interpolated; null unless `required` */
  reason: string | null;
}

/** undefined for an unset variable */
export type InterpolationLookup = (name: string) => string | undefined;

export interface InterpolationResult {
  value: string;
  issues: InterpolationIssue[];
}

/** What the normalizer passes everywhere except inside env files. */
export const EMPTY_ENVIRONMENT: InterpolationLookup = () => undefined;

const NAMED = /^[_a-zA-Z][_a-zA-Z0-9]*/;
const BRACED = /^([_a-zA-Z][_a-zA-Z0-9]*)(?:(:?[-+?])([\s\S]*))?$/;

/**
 * Index of the `}` closing the `${` at `start`, counting nested `${` (compose-go
 * getFirstBraceClosingIndex); -1 when it is never closed.
 */
function closingBrace(input: string, start: number): number {
  let open = 0;
  for (let i = start; i < input.length; i++) {
    if (input[i] === '}') {
      open--;
      if (open === 0) return i;
    }
    if (input.startsWith('${', i)) {
      open++;
      i++;
    }
  }
  return -1;
}

function expand(input: string, lookup: InterpolationLookup, issues: InterpolationIssue[]): string {
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
      const end = closingBrace(input, i);
      const match = end === -1 ? null : BRACED.exec(input.slice(i + 2, end));
      if (match === null) {
        issues.push({ kind: 'invalid', variable: null, reason: null });
        i = end === -1 ? input.length : end;
        continue;
      }
      const [, name, operator, argument = ''] = match;
      const value = lookup(name);
      const unsetOrEmpty = value === undefined || value === '';
      // Defaults and alternatives are expanded lazily, so a placeholder in a branch that is not
      // taken reports nothing (compose-go does the same).
      switch (operator) {
        case undefined:
          if (value === undefined) issues.push({ kind: 'unset', variable: name, reason: null });
          out += value ?? '';
          break;
        case ':-':
          out += unsetOrEmpty ? expand(argument, lookup, issues) : (value ?? '');
          break;
        case '-':
          out += value === undefined ? expand(argument, lookup, issues) : value;
          break;
        case ':?':
          if (unsetOrEmpty) issues.push({ kind: 'required', variable: name, reason: expand(argument, lookup, issues) });
          else out += value ?? '';
          break;
        case '?':
          if (value === undefined) issues.push({ kind: 'required', variable: name, reason: expand(argument, lookup, issues) });
          else out += value;
          break;
        case ':+':
          out += unsetOrEmpty ? '' : expand(argument, lookup, issues);
          break;
        case '+':
          out += value === undefined ? '' : expand(argument, lookup, issues);
          break;
      }
      i = end;
      continue;
    }
    const named = NAMED.exec(input.slice(i + 1));
    if (named !== null) {
      const value = lookup(named[0]);
      if (value === undefined) issues.push({ kind: 'unset', variable: named[0], reason: null });
      out += value ?? '';
      i += named[0].length;
      continue;
    }
    // `$5`, `$(`, `$ ` and a trailing `$` are kept (compose-go).
    out += '$';
  }
  return out;
}

/** `$$` -> `$`, `$VAR`, `${VAR}`, `${VAR:-d}`, `${VAR-d}`, `${VAR:+a}`, `${VAR+a}`, `${VAR:?m}`, `${VAR?m}`, nested defaults. */
export function interpolate(input: string, lookup: InterpolationLookup = EMPTY_ENVIRONMENT): InterpolationResult {
  const issues: InterpolationIssue[] = [];
  const value = expand(input, lookup, issues);
  return { value, issues };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Service keys whose values never carry an inserted secret, so a diagnostic may name the variable
 * (design-01 2.3). Everywhere else a placeholder may be the tail of an inserted value such as a
 * password containing `$`, and printing the "variable" would print part of that value.
 */
const NAME_VISIBLE_SERVICE_KEYS: ReadonlySet<string> = new Set([
  'image',
  'ports',
  'expose',
  'volumes',
  'tmpfs',
  'networks',
  'hostname',
  'working_dir',
  'user',
  'platform',
  'pull_policy',
  'dns',
  'dns_search',
  'extra_hosts',
  'x-dockflow',
]);

/** Whether an interpolation diagnostic at this document path may name the variable. */
export function interpolationNameVisible(segments: readonly (string | number)[]): boolean {
  const [root, , key, sub] = segments;
  if (root === 'volumes') return key === 'x-dockflow';
  if (root !== 'services' || typeof key !== 'string') return false;
  if (NAME_VISIBLE_SERVICE_KEYS.has(key)) return true;
  if (key === 'deploy') return sub !== 'labels';
  if (key === 'healthcheck') return sub !== 'test';
  return false;
}

export interface InterpolationDiagnostic {
  code: 'interpolate.unset' | 'interpolate.required' | 'interpolate.invalid';
  message: string;
  hint: string;
}

const LITERAL_DOLLAR_HINT = 'write `$$` for a literal `$` (for inserted values: `{{ value | replace("$", "$$") }}`)';

/** The one wording of the three interpolation codes; `nameVisible` from interpolationNameVisible. */
export function interpolationDiagnostic(issue: InterpolationIssue, nameVisible: boolean): InterpolationDiagnostic {
  const variable = nameVisible ? issue.variable : null;
  const nunjucks = `{{ current.env.${variable === null ? '<name>' : variable.toLowerCase()} }}`;
  switch (issue.kind) {
    case 'unset':
      return {
        code: 'interpolate.unset',
        message:
          variable === null
            ? 'contains a $ placeholder that has no value (Dockflow does not pass a process environment)'
            : `contains the placeholder $${variable}, which has no value: Dockflow does not pass a process environment to Compose interpolation`,
        hint: `Use \`${nunjucks}\` for a Dockflow value, or ${LITERAL_DOLLAR_HINT}.`,
      };
    case 'required': {
      const reason = issue.reason ?? '';
      return {
        code: 'interpolate.required',
        message:
          variable === null
            ? 'contains a placeholder that requires a variable, which has no value (Dockflow does not pass a process environment)'
            : reason === ''
              ? `requires variable ${variable}`
              : `requires variable ${variable}: ${reason}`,
        hint: `Replace the placeholder with a Nunjucks value such as \`${nunjucks}\`.`,
      };
    }
    case 'invalid':
      return {
        code: 'interpolate.invalid',
        message: 'contains an invalid ${...} placeholder',
        hint: 'Write `$$` for a literal `$`.',
      };
  }
}

/** Reports every issue of one scalar at its path (the sink keeps the first report per code). */
export function reportInterpolationIssues(
  sink: DiagnosticSink,
  path: string,
  issues: readonly InterpolationIssue[],
  nameVisible: boolean,
): void {
  for (const issue of issues) {
    const d = interpolationDiagnostic(issue, nameVisible);
    sink.error(d.code, path, d.message, d.hint);
  }
}

/**
 * Interpolates every string scalar of the document (list items and map values; never map keys) on a
 * deep copy, with the empty environment, and reports each unresolved placeholder at its path.
 * Top-level `x-*` subtrees are copied untouched: they hold YAML anchors, whose content is
 * interpolated where it is merged.
 */
export function interpolateDocument(
  raw: Record<string, unknown>,
  sink: DiagnosticSink,
  lookup: InterpolationLookup = EMPTY_ENVIRONMENT,
): Record<string, unknown> {
  const copy = (value: unknown, segments: (string | number)[], path: string, active: boolean): unknown => {
    if (typeof value === 'string') {
      if (!active) return value;
      const result = interpolate(value, lookup);
      reportInterpolationIssues(sink, path, result.issues, interpolationNameVisible(segments));
      return result.value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => copy(item, [...segments, index], indexPath(path, index), active));
    }
    if (isPlainMap(value)) {
      // fromEntries defines own properties, so a `__proto__` key stays a key
      return Object.fromEntries(
        Object.keys(value).map((key) => [key, copy(value[key], [...segments, key], childPath(path, key), active)]),
      );
    }
    return value;
  };
  return Object.fromEntries(Object.keys(raw).map((key) => [key, copy(raw[key], [key], childPath('', key), !key.startsWith('x-'))]));
}
