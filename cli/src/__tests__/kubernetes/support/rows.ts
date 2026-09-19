// Row runners (design-07 4.1, 5.1): normalizer rows through normalizeChecked, translator rows
// through translateChecked, so schema and semantic validation run on every mapping row.

import { describe, expect, test } from 'bun:test';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { CanonicalStack } from '../../../services/orchestrator/kubernetes/model/types';
import type { ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import * as builders from './builders';
import type { NormalizeInputOverrides, TranslateOptionsOverrides } from './builders';
import {
  type DiagnosticsExpectation,
  expectPointer,
  expectRowDiagnostics,
  isDiagnosticsExpectation,
  normalizeChecked,
} from './normalize';
import { type TranslateValidation, translateChecked } from './translate';

export {
  type DiagnosticsExpectation,
  type NormalizeRow,
  normalizeRowInput,
  type RowDiagnostic,
  type RowExpectation,
  runNormalizeRows,
} from './normalize';

export type TranslateExpectation =
  /** object `Kind/name`, e.g. `Deployment/web`; pointer into it, e.g. `/spec/template/spec/containers/0/readinessProbe/periodSeconds` */
  | { object: string; pointer: string; equals: unknown }
  | { object: string; absent: true }
  | { object: string; pointer: string; absent: true }
  /** exact sorted list of `Kind/name` */
  | { kinds: string[] }
  | DiagnosticsExpectation;

export interface TranslateRow {
  id: string;
  title: string;
  /** compose YAML run through normalizeChecked (the body of service `web` unless it starts with `services:`) */
  compose?: string;
  /** a builder-made model, for rows that must not depend on the normalizer */
  stack?: (b: typeof builders) => CanonicalStack;
  /** default: builders.translateOptions (pullSecretName null, revisionHistoryLimit 3, progressDeadlineS 240, k3s traits, the SSH reservation of server_1) */
  options?: TranslateOptionsOverrides;
  /** normalizer input of a `compose` row besides the compose text (role, proxy, files...) */
  normalize?: NormalizeInputOverrides;
  validation?: TranslateValidation;
  expect: TranslateExpectation | TranslateExpectation[];
}

function objectKey(object: ManifestObject): string {
  return `${object.kind}/${object.metadata.name}`;
}

export interface TranslatedRow {
  objects: ManifestObject[];
  /** both layers for a `compose` row: the normalizer and the translator share one sink, as in render() */
  diagnostics: Diagnostic[];
}

/** Runs one row: normalize (compose rows), then translate unless the normalizer reported an error. */
export function translateRow(row: TranslateRow): TranslatedRow {
  if ((row.compose === undefined) === (row.stack === undefined)) throw new Error(`${row.id}: give exactly one of compose and stack`);
  const sink = row.options?.sink ?? new DiagnosticSink();
  let stack: CanonicalStack;
  if (row.stack !== undefined) {
    stack = row.stack(builders);
  } else {
    stack = normalizeChecked({ ...row.normalize, compose: row.compose, sink }).stack;
    if (sink.hasErrors()) return { objects: [], diagnostics: sink.list() };
  }
  const { objects, diagnostics } = translateChecked(stack, { ...row.options, sink }, row.validation);
  return { objects, diagnostics };
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

export function runTranslateRows(moduleName: string, rows: readonly TranslateRow[]): void {
  describe(moduleName, () => {
    test('row ids are unique', () => {
      const ids = rows.map((r) => r.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    });
    for (const row of rows) {
      test(`${row.id} ${row.title}`, () => {
        const { objects, diagnostics } = translateRow(row);
        const byKey = new Map(objects.map((o) => [objectKey(o), o]));
        const expectations = asList(row.expect);
        for (const e of expectations) {
          if (isDiagnosticsExpectation(e)) continue;
          if ('kinds' in e) {
            expect(objects.map(objectKey).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(e.kinds);
            continue;
          }
          const object = byKey.get(e.object);
          if (!('pointer' in e)) {
            expect(`${e.object} ${object === undefined ? 'absent' : 'present'}`).toBe(`${e.object} absent`);
            continue;
          }
          expect(`${e.object} ${object === undefined ? 'absent' : 'present'}`).toBe(`${e.object} present`);
          expectPointer(object, e.pointer, 'absent' in e ? { absent: true } : { equals: e.equals }, e.object);
        }
        expectRowDiagnostics(diagnostics, expectations.filter(isDiagnosticsExpectation));
      });
    }
  });
}
