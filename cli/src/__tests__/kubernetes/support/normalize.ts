// normalizeChecked (design-07 4.1): normalizeStack plus the model invariants of DESIGN-CORE 3,
// asserted on every run, and the normalizer row runner. Also the JSON pointer and diagnostics
// helpers the translator rows share (support/rows.ts).

import { describe, expect, test } from 'bun:test';
import type { Diagnostic, DiagnosticSeverity } from '../../../services/orchestrator/diagnostics';
import type { ImageDelivery } from '../../../services/orchestrator/interfaces';
import type { CanonicalService, CanonicalStack, PortSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { serviceNameFor, volumeClaimNameFor } from '../../../services/orchestrator/kubernetes/naming';
import { type NormalizeInput, normalizeStack } from '../../../services/orchestrator/kubernetes/normalize';
import { childPath } from '../../../services/orchestrator/kubernetes/normalize/context';
import type { ProxyConfig } from '../../../utils/config';
import { type FileFixture, type NormalizeInputOverrides, normalizeInput } from './builders';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Model invariants (DESIGN-CORE 3, design-01 9)
// ---------------------------------------------------------------------------

type Compare<T> = (a: T, b: T) => number;

function checkOrder<T>(items: readonly T[], compare: Compare<T>, where: string, strict: boolean, out: string[]): void {
  for (let i = 1; i < items.length; i++) {
    const order = compare(items[i - 1], items[i]);
    if (order > 0 || (strict && order === 0)) {
      out.push(`${where} is not sorted${strict ? ' unique' : ''} at index ${i}`);
      return;
    }
  }
}

const byString: Compare<string> = compareCodeUnits;
const byNumber: Compare<number> = (a, b) => a - b;

function comparePorts(a: PortSpec, b: PortSpec): number {
  return a.target - b.target || compareCodeUnits(a.protocol, b.protocol) || (a.published ?? -1) - (b.published ?? -1);
}

/** No `undefined` anywhere, maps are plain objects; byte arrays are the one allowed class. */
function checkPlain(value: unknown, where: string, out: string[]): void {
  if (value === undefined) {
    out.push(`${where} is undefined`);
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkPlain(item, `${where}[${i}]`, out));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    out.push(`${where} is not a plain object`);
    return;
  }
  for (const [key, item] of Object.entries(value)) checkPlain(item, `${where}.${key}`, out);
}

function checkStrings(map: Record<string, unknown>, where: string, out: string[]): void {
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== 'string') out.push(`${where}.${key} is ${typeof value}, not a string`);
  }
}

function checkPath(path: unknown, where: string, out: string[]): void {
  if (typeof path !== 'string' || path === '') out.push(`${where}.path is empty`);
}

function serviceViolations(s: CanonicalService, stack: CanonicalStack, where: string, out: string[]): void {
  if (s.role !== stack.role) out.push(`${where}.role is ${s.role} in a ${stack.role} stack`);
  if (s.path !== childPath('services', s.composeName)) out.push(`${where}.path is ${s.path}`);
  checkOrder(s.environment.map((e) => e.name), byString, `${where}.environment`, true, out);
  for (const e of s.environment) if (typeof e.value !== 'string') out.push(`${where}.environment.${e.name} is not a string`);
  checkOrder(s.ports, comparePorts, `${where}.ports`, false, out);
  checkOrder(s.expose, (a, b) => a.target - b.target || compareCodeUnits(a.protocol, b.protocol), `${where}.expose`, false, out);
  checkOrder(s.mounts.map((m) => m.target), byString, `${where}.mounts`, false, out);
  checkOrder(s.files.map((f) => f.target), byString, `${where}.files`, false, out);
  checkOrder(s.process.groupAdd, byNumber, `${where}.process.groupAdd`, true, out);
  checkOrder(s.security.capAdd, byString, `${where}.security.capAdd`, true, out);
  checkOrder(s.security.capDrop, byString, `${where}.security.capDrop`, true, out);
  checkOrder(s.network.networks, byString, `${where}.network.networks`, true, out);
  checkOrder(s.network.aliases, byString, `${where}.network.aliases`, true, out);
  checkOrder(s.network.extraHosts, (a, b) => compareCodeUnits(a.ip, b.ip) || compareCodeUnits(a.hostname, b.hostname), `${where}.network.extraHosts`, false, out);
  checkOrder(s.routes.map((r) => r.router), byString, `${where}.routes`, false, out);
  s.routes.forEach((r, i) => checkOrder(r.entryPoints, byString, `${where}.routes[${i}].entryPoints`, true, out));
  checkOrder(s.extension.loadBalancerSourceRanges, byString, `${where}.extension.loadBalancerSourceRanges`, true, out);

  checkPath(s.path, where, out);
  s.ports.forEach((p, i) => checkPath(p.path, `${where}.ports[${i}]`, out));
  s.expose.forEach((p, i) => checkPath(p.path, `${where}.expose[${i}]`, out));
  s.mounts.forEach((m, i) => checkPath(m.path, `${where}.mounts[${i}]`, out));
  s.files.forEach((f, i) => checkPath(f.path, `${where}.files[${i}]`, out));
  s.placement.constraints.forEach((c, i) => checkPath(c.path, `${where}.placement.constraints[${i}]`, out));
  s.routes.forEach((r, i) => checkPath(r.path, `${where}.routes[${i}]`, out));
  if (s.healthcheck !== null) checkPath(s.healthcheck.path, `${where}.healthcheck`, out);

  checkStrings(s.containerLabels, `${where}.containerLabels`, out);
  checkStrings(s.serviceLabels, `${where}.serviceLabels`, out);
  checkStrings(s.podAnnotations, `${where}.podAnnotations`, out);
  checkStrings(s.security.sysctls, `${where}.security.sysctls`, out);
  checkStrings(s.extension.nodeSelector, `${where}.extension.nodeSelector`, out);
  checkStrings(s.extension.podLabels, `${where}.extension.podLabels`, out);
}

/** Every DESIGN-CORE 3 invariant the stack breaks, one line each; [] for a valid model. */
export function canonicalStackViolations(stack: CanonicalStack): string[] {
  const out: string[] = [];
  checkPlain(stack, 'stack', out);
  if (out.length > 0) return out;

  checkOrder(stack.services.map((s) => s.name), byString, 'services', false, out);
  checkOrder(stack.volumes.map((v) => v.key), byString, 'volumes', true, out);
  checkOrder(stack.files, (a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key), 'files', true, out);
  checkOrder(stack.middlewares.map((m) => m.name), byString, 'middlewares', false, out);
  stack.services.forEach((s, i) => serviceViolations(s, stack, `services[${i}]`, out));

  const mountedBy = new Map<string, string[]>();
  for (const s of stack.services) {
    for (const m of s.mounts) if (m.type === 'volume') mountedBy.set(m.volume, [...(mountedBy.get(m.volume) ?? []), s.composeName]);
  }
  stack.volumes.forEach((v, i) => {
    const where = `volumes[${i}]`;
    checkPath(v.path, where, out);
    checkStrings(v.labels, `${where}.labels`, out);
    if (v.role !== stack.role) out.push(`${where}.role is ${v.role} in a ${stack.role} stack`);
    const users = [...new Set(mountedBy.get(v.key) ?? [])].sort(compareCodeUnits);
    if (users.length === 0) out.push(`${where} (${v.key}) is not mounted by any service`);
    if (JSON.stringify(v.usedBy) !== JSON.stringify(users)) out.push(`${where}.usedBy is ${JSON.stringify(v.usedBy)}, mounted by ${JSON.stringify(users)}`);
  });
  const declaredVolumes = new Set(stack.volumes.map((v) => v.key));
  for (const key of mountedBy.keys()) if (!declaredVolumes.has(key)) out.push(`volume ${key} is mounted but not in stack.volumes`);

  const referenced = new Set(stack.services.flatMap((s) => s.files.map((f) => `${f.kind}/${f.source}`)));
  const declaredFiles = new Set(stack.files.map((f) => `${f.kind}/${f.key}`));
  stack.files.forEach((f, i) => {
    checkPath(f.path, `files[${i}]`, out);
    if (!referenced.has(`${f.kind}/${f.key}`)) out.push(`files[${i}] (${f.kind} ${f.key}) is not mounted by any service`);
  });
  for (const ref of referenced) if (!declaredFiles.has(ref)) out.push(`${ref} is mounted but not in stack.files`);

  stack.middlewares.forEach((m, i) => {
    checkPath(m.path, `middlewares[${i}]`, out);
    if (m.users !== null) checkOrder(m.users, byString, `middlewares[${i}].users`, true, out);
  });
  return out;
}

// ---------------------------------------------------------------------------
// normalizeChecked
// ---------------------------------------------------------------------------

export interface NormalizeChecked {
  stack: CanonicalStack;
  /** the sink's list: deduplicated by (code, path), sorted by (path, code) */
  diagnostics: Diagnostic[];
  input: NormalizeInput;
}

/** normalizeStack over builder defaults (design-07 4.1), failing the test on any model invariant. */
export function normalizeChecked(overrides: NormalizeInputOverrides = {}): NormalizeChecked {
  const input = normalizeInput(overrides);
  const { stack } = normalizeStack(input);
  expect(canonicalStackViolations(stack)).toEqual([]);
  return { stack, diagnostics: input.sink.list(), input };
}

// ---------------------------------------------------------------------------
// Row helpers shared with the translator rows
// ---------------------------------------------------------------------------

/** RFC 6901 pointer lookup; `found: false` when a segment is missing. */
export function jsonPointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) throw new Error(`JSON pointer ${pointer} must start with /`);
  let value: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= value.length) return { found: false, value: undefined };
      value = value[Number(segment)];
    } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value };
}

export interface RowDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  path: string;
}

export interface DiagnosticsExpectation {
  diagnostics: RowDiagnostic[];
  exact?: boolean;
}

function rowKey(d: RowDiagnostic): string {
  return `${d.severity} ${d.code} at ${d.path === '' ? '(root)' : d.path}`;
}

/**
 * The row contract of design-07 4.1: every listed diagnostic is present; unless one expectation is
 * `exact`, extra `info` diagnostics are tolerated and extra warnings or errors fail. A row without
 * any diagnostics expectation therefore fails on any warning or error.
 */
export function expectRowDiagnostics(actual: readonly Diagnostic[], expectations: readonly DiagnosticsExpectation[]): void {
  const listed = expectations.flatMap((e) => e.diagnostics);
  const exact = expectations.some((e) => e.exact === true);
  const actualKeys = new Set(actual.map(rowKey));
  const listedKeys = new Set(listed.map(rowKey));
  const missing = [...listedKeys].filter((k) => !actualKeys.has(k));
  const unexpected = actual.filter((d) => !listedKeys.has(rowKey(d)) && (exact || d.severity !== 'info')).map((d) => `${rowKey(d)}: ${d.message}`);
  expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] });
}

export function expectPointer(root: unknown, pointer: string, expectation: { equals: unknown } | { absent: true }, where: string): void {
  const found = jsonPointer(root, pointer);
  if ('absent' in expectation) {
    expect(`${where}${pointer} ${found.found ? 'present' : 'absent'}`).toBe(`${where}${pointer} absent`);
    return;
  }
  expect(`${where}${pointer} ${found.found ? 'present' : 'absent'}`).toBe(`${where}${pointer} present`);
  expect(found.value).toEqual(expectation.equals);
}

// ---------------------------------------------------------------------------
// Normalizer rows (design-07 4.1)
// ---------------------------------------------------------------------------

export type RowExpectation =
  /** JSON pointer into the CanonicalStack, e.g. `/services/0/ports` */
  | { select: string; equals: unknown }
  | { select: string; absent: true }
  | DiagnosticsExpectation;

type SiblingService = NormalizeInput['sibling']['services'][number];
type SiblingVolume = NormalizeInput['sibling']['volumes'][number];

export interface NormalizeRow {
  /** e.g. `N-PORT-07` */
  id: string;
  title: string;
  /** YAML; when it does not start with `services:` it is the body of service `web` */
  compose: string;
  /** default 'app' */
  role?: NormalizeInput['role'];
  /** default null: proxy disabled; a partial config is enabled unless it says otherwise */
  proxy?: Partial<ProxyConfig> | null;
  /** keys (their names and claim names derived as the sibling render would) or the full detail */
  sibling?: { services?: (string | SiblingService)[]; volumes?: (string | SiblingVolume)[]; middlewares?: string[] };
  /** FileResolver content keyed by path from the compose directory */
  files?: Record<string, FileFixture>;
  /** `mode` becomes NormalizeInput.imageDelivery; default import */
  images?: Partial<ImageDelivery>;
  /** anything else of the input (serverNames, traits, identity...) */
  input?: NormalizeInputOverrides;
  expect: RowExpectation | RowExpectation[];
}

function siblingOf(row: NormalizeRow): NormalizeInputOverrides['sibling'] {
  if (row.sibling === undefined) return undefined;
  return {
    services: (row.sibling.services ?? []).map((s) =>
      typeof s === 'string' ? { key: s, name: serviceNameFor(s).value, aliases: [], published: [] } : s,
    ),
    volumes: (row.sibling.volumes ?? []).map((v) => (typeof v === 'string' ? { key: v, claimName: volumeClaimNameFor(v).value, external: false } : v)),
    middlewares: row.sibling.middlewares ?? [],
  };
}

export function normalizeRowInput(row: NormalizeRow): NormalizeInputOverrides {
  const overrides: NormalizeInputOverrides = {
    compose: row.compose,
    role: row.role ?? 'app',
    proxy: row.proxy === undefined || row.proxy === null ? undefined : { enabled: true, ...row.proxy },
    files: row.files ?? {},
    imageDelivery: row.images?.mode ?? 'import',
  };
  const sibling = siblingOf(row);
  if (sibling !== undefined) overrides.sibling = sibling;
  return { ...overrides, ...row.input };
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function isDiagnosticsExpectation(e: object): e is DiagnosticsExpectation {
  return 'diagnostics' in e;
}

export function runNormalizeRows(moduleName: string, rows: readonly NormalizeRow[]): void {
  describe(moduleName, () => {
    test('row ids are unique', () => {
      const ids = rows.map((r) => r.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    });
    for (const row of rows) {
      test(`${row.id} ${row.title}`, () => {
        const { stack, diagnostics } = normalizeChecked(normalizeRowInput(row));
        const expectations = asList(row.expect);
        for (const e of expectations) {
          if (!isDiagnosticsExpectation(e)) expectPointer(stack, e.select, 'absent' in e ? { absent: true } : { equals: e.equals }, 'stack');
        }
        expectRowDiagnostics(diagnostics, expectations.filter(isDiagnosticsExpectation));
      });
    }
  });
}
