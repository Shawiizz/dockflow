// Value diff printed before `deploy --adopt` takes over a release installed outside Dockflow
// (design-04 3.7.4): the operator's user values against the generated ones, leaf by leaf. Secrets
// are masked on both sides but their change is still shown. Pure.

import { canonicalJson } from '../../../../utils/hash';
import { goYamlV2Resolve, isSensitiveKeyPath, isValuesMap, joinKeyPath } from './values-yaml';

export type DiffKind = 'changed' | 'added' | 'removed';

export interface DiffLine {
  /** dotted key path, `a.b[0]` style keys quoted when ambiguous */
  path: string;
  kind: DiffKind;
  /** deployed value as printed; '' for an added leaf */
  before: string;
  /** generated value as printed; CHART_DEFAULT for a removed leaf */
  after: string;
  /** the key path is sensitive: both values print as MASK */
  masked: boolean;
}

export const MASK = '***';
/** `--reset-values` drops every value config.yml does not set, so the chart default applies */
export const CHART_DEFAULT = '(chart default)';

const KIND_LABEL: Readonly<Record<DiffKind, string>> = {
  changed: 'changed',
  added: 'added',
  removed: 'removed by --reset-values',
};

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Side = { present: false } | { present: true; value: unknown };
const ABSENT: Side = { present: false };

/**
 * Leaves that differ, sorted by key path. Maps present on both sides are recursed; a map present
 * on one side only is listed leaf by leaf; lists and scalars are compared as whole values.
 * `deployed` is null when the release has no user values (`helm get values` prints null).
 */
export function valuesDiff(deployed: Record<string, unknown> | null, desired: Record<string, unknown>): DiffLine[] {
  const lines: DiffLine[] = [];
  compareMaps(deployed ?? {}, desired, '', lines);
  return lines.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/** `  - primary.persistence.size  20Gi -> 8Gi  (changed)`, columns aligned */
export function formatValuesDiff(lines: DiffLine[]): string[] {
  const width = (pick: (line: DiffLine) => string): number => Math.max(0, ...lines.map((line) => pick(line).length));
  const pathWidth = width((line) => line.path);
  const beforeWidth = width((line) => line.before);
  const afterWidth = width((line) => line.after);
  return lines.map((line) => {
    const marker = line.kind === 'added' ? '+' : '-';
    return `  ${marker} ${line.path.padEnd(pathWidth)}  ${line.before.padEnd(beforeWidth)} -> ${line.after.padEnd(afterWidth)} (${KIND_LABEL[line.kind]})`;
  });
}

function compareMaps(before: Record<string, unknown>, after: Record<string, unknown>, prefix: string, out: DiffLine[]): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const path = joinKeyPath(prefix, key);
    compareValues(side(before, key), side(after, key), path, out);
  }
}

function compareValues(before: Side, after: Side, path: string, out: DiffLine[]): void {
  if (before.present && after.present) {
    if (isValuesMap(before.value) && isValuesMap(after.value)) {
      compareMaps(before.value, after.value, path, out);
    } else if (!sameValue(before.value, after.value)) {
      out.push(line(path, 'changed', before, after));
    }
    return;
  }
  const only = before.present ? before : after;
  if (!only.present) return;
  // a whole subtree added or dropped is still reported per leaf, like the rest of the diff
  if (isValuesMap(only.value) && Object.keys(only.value).length > 0) {
    const empty = {};
    if (before.present) compareMaps(only.value, empty, path, out);
    else compareMaps(empty, only.value, path, out);
    return;
  }
  out.push(line(path, before.present ? 'removed' : 'added', before, after));
}

function side(map: Record<string, unknown>, key: string): Side {
  return Object.hasOwn(map, key) ? { present: true, value: map[key] } : ABSENT;
}

function sameValue(a: unknown, b: unknown): boolean {
  // wrapped in a list so an undefined leaf compares as null instead of throwing
  return canonicalJson([a]) === canonicalJson([b]);
}

function line(path: string, kind: DiffKind, before: Side, after: Side): DiffLine {
  const masked = isSensitiveKeyPath(path);
  const shown = (value: unknown): string => (masked ? MASK : display(value));
  return {
    path,
    kind,
    before: before.present ? shown(before.value) : '',
    after: after.present ? shown(after.value) : CHART_DEFAULT,
    masked,
  };
}

function display(value: unknown): string {
  if (typeof value === 'string') return readsAsItself(value) ? value : JSON.stringify(value);
  return value === undefined ? 'null' : canonicalJson(value);
}

/** A string is printed bare only when it reads back as that string: `"3"` and `"yes"` stay quoted. */
function readsAsItself(text: string): boolean {
  return text !== '' && text.trim() === text && !/[\n\r\t]/.test(text) && goYamlV2Resolve(text) === text;
}
