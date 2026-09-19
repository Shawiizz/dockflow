// Property-style tests without a dependency (design-07 8.1): a generator, a property, many seeded
// runs, no shrinking. A failure prints the seed and the run count that reproduce it:
//   DOCKFLOW_PROPERTY_SEED=<seed> DOCKFLOW_PROPERTY_RUNS=<n> bun test <file>
// A failing value becomes an explicit regression row in the matching test file.

import { test } from 'bun:test';
import { fnv1a32, mulberry32, type Rng } from './prng';

export type { Rng };

/** `size` grows from 1 to 100 over the runs, so early runs try small values. */
export type Gen<T> = (rng: Rng, size: number) => T;

export interface ForAllOptions {
  /** default 300; DOCKFLOW_PROPERTY_RUNS overrides it */
  runs?: number;
  /** default fnv1a32(name); DOCKFLOW_PROPERTY_SEED overrides it */
  seed?: number;
  /** per-test timeout, generous so nightly runs with many iterations fit */
  timeoutMs?: number;
}

const DEFAULT_RUNS = 300;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Run count: DOCKFLOW_PROPERTY_RUNS, else the option, else 300. */
export function propertyRuns(options?: ForAllOptions): number {
  const raw = process.env.DOCKFLOW_PROPERTY_RUNS;
  const runs = raw === undefined || raw === '' ? (options?.runs ?? DEFAULT_RUNS) : Number(raw);
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(`DOCKFLOW_PROPERTY_RUNS must be a positive integer, got ${raw}`);
  }
  return runs;
}

/** Base seed: DOCKFLOW_PROPERTY_SEED (an integer, or any text hashed with FNV-1a), else the option, else fnv1a32(name). */
export function propertySeed(name: string, options?: ForAllOptions): number {
  const raw = process.env.DOCKFLOW_PROPERTY_SEED;
  if (raw !== undefined && raw !== '') return /^-?[0-9]+$/.test(raw) ? Number(raw) >>> 0 : fnv1a32(raw);
  return (options?.seed ?? fnv1a32(name)) >>> 0;
}

function show(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Registers one `test` that checks `property` against `runs` generated values. */
export function forAll<T>(name: string, gen: Gen<T>, property: (value: T) => void, options?: ForAllOptions): void {
  test(
    `property: ${name}`,
    () => {
      const runs = propertyRuns(options);
      const baseSeed = propertySeed(name, options);
      for (let i = 0; i < runs; i++) {
        const value = gen(mulberry32((baseSeed + i) >>> 0), 1 + Math.floor((i * 100) / runs));
        try {
          property(value);
        } catch (error) {
          // the run count is part of the reproduction: `size` depends on it
          throw new Error(
            `${name} failed at run ${i} (DOCKFLOW_PROPERTY_SEED=${baseSeed} DOCKFLOW_PROPERTY_RUNS=${runs})\n` +
              `value: ${show(value)}\n${String(error)}`,
          );
        }
      }
    },
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}
