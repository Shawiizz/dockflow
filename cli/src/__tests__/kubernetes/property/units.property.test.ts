// design-07 8.3 P-U01..P-U03: durations, byte values, CPUs and the quantity canonicalizer under
// generated input.

import { describe, expect } from 'bun:test';
import {
  canonicalQuantity,
  ceilSeconds,
  cpuQuantity,
  memoryQuantity,
  parseBytes,
  parseDurationMs,
  parseMilliCpu,
  parseQuantity,
  type Quantity,
} from '../../../services/orchestrator/kubernetes/model/units';
import { pick, randomInt, type Rng } from '../support/prng';
import { forAll } from '../support/property';

/** design-07 7.2: the structural validator's quantity grammar */
const QUANTITY_RE = /^([+-]?[0-9.]+)([eEinumkKMGTP]*[-+]?[0-9]*)$/;

const UNIT_NS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  '\u{b5}s': 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

/** Go-style text of a whole number of milliseconds, in one of several equivalent spellings */
function formatMs(ms: number, style: number): string {
  if (ms === 0) return ['0', '0s', '0ms', '0h0m0s'][style];
  switch (style) {
    case 0: {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      const rest = ms % 1000;
      return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}${rest ? `${rest}ms` : ''}`;
    }
    case 1:
      return `${ms}ms`;
    case 2:
      return `${ms * 1000}us`;
    default: {
      const whole = Math.floor(ms / 1000);
      const fraction = String(ms % 1000).padStart(3, '0');
      return `${whole}.${fraction}s`;
    }
  }
}

interface GeneratedDuration {
  text: string;
  ns: bigint;
}

/** 1..4 components with optional decimals; the expected nanoseconds are computed alongside */
function duration(rng: Rng): GeneratedDuration {
  let text = '';
  let ns = 0n;
  for (let i = randomInt(rng, 1, 4); i > 0; i--) {
    const unitName = pick(rng, Object.keys(UNIT_NS));
    const unit = UNIT_NS[unitName];
    const whole = randomInt(rng, 0, 999);
    const digits = rng() < 0.5 ? '' : String(randomInt(rng, 0, 99999)).padStart(randomInt(rng, 1, 6), '0');
    text += `${whole}${digits === '' ? '' : `.${digits}`}${unitName}`;
    ns += BigInt(whole) * unit;
    // the fraction is truncated to whole nanoseconds, per component
    if (digits !== '') ns += (BigInt(digits) * unit) / 10n ** BigInt(digits.length);
  }
  return { text, ns };
}

function valueOf(q: Quantity): { numerator: bigint; scale: number } {
  return { numerator: q.negative ? -q.mantissa : q.mantissa, scale: q.scale };
}

/** exact comparison of two quantities' values */
function sameValue(a: Quantity, b: Quantity): boolean {
  const x = valueOf(a);
  const y = valueOf(b);
  const scale = Math.min(x.scale, y.scale);
  return x.numerator * 10n ** BigInt(x.scale - scale) === y.numerator * 10n ** BigInt(y.scale - scale);
}

describe('units (design-07 8.3)', () => {
  forAll(
    'P-U01 parseDurationMs(format(ms)) === ms',
    (rng, size) => ({ ms: randomInt(rng, 0, 10 ** Math.min(10, 3 + Math.floor(size / 10))), style: randomInt(rng, 0, 3) }),
    ({ ms, style }) => {
      expect(parseDurationMs(formatMs(ms, style))).toBe(ms);
    },
  );

  forAll(
    'P-U01 generated durations parse to their nanoseconds rounded up to milliseconds',
    (rng) => duration(rng),
    ({ text, ns }) => {
      expect(parseDurationMs(text)).toBe(Number((ns + 999_999n) / 1_000_000n));
    },
  );

  forAll(
    'P-U01 the seconds conversion rounds up and is monotonic',
    (rng) => Array.from({ length: 20 }, () => duration(rng)).map((d) => parseDurationMs(d.text) as number),
    (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; i++) {
        const ms = sorted[i];
        const s = ceilSeconds(ms, 0);
        expect(s * 1000).toBeGreaterThanOrEqual(ms);
        expect((s - 1) * 1000).toBeLessThan(Math.max(ms, 1));
        expect(ceilSeconds(ms, 1)).toBe(Math.max(1, s));
        if (i > 0) expect(s).toBeGreaterThanOrEqual(ceilSeconds(sorted[i - 1], 0));
      }
    },
  );

  forAll(
    'P-U02 byte values use exact binary multipliers; emitted quantities re-parse to the same bytes',
    (rng) => {
      const [suffix, multiplier] = pick(rng, [
        ['', 1],
        ['b', 1],
        ['k', 1024],
        ['kb', 1024],
        ['m', 1024 ** 2],
        ['mb', 1024 ** 2],
        ['g', 1024 ** 3],
        ['gb', 1024 ** 3],
        ['kib', 1024],
        ['mib', 1024 ** 2],
      ] as [string, number][]);
      const cased = [...suffix].map((c) => (rng() < 0.5 ? c.toUpperCase() : c)).join('');
      return { amount: randomInt(rng, 0, 100_000), suffix: cased, multiplier, space: rng() < 0.2 ? ' ' : '' };
    },
    ({ amount, suffix, multiplier, space }) => {
      const bytes = parseBytes(`${amount}${suffix === '' ? '' : space}${suffix}`);
      expect(bytes).toBe(amount * multiplier);
      const quantity = memoryQuantity(bytes as number);
      expect(quantity).not.toMatch(/m$/);
      expect(quantity).toMatch(QUANTITY_RE);
      expect(canonicalQuantity(quantity)).toBe(quantity);
      const parsed = parseQuantity(quantity);
      expect(parsed).not.toBeNull();
      expect(sameValue(parsed as Quantity, { negative: false, mantissa: BigInt(bytes as number), scale: 0, format: 'DecimalSI' })).toBe(
        true,
      );
    },
  );

  forAll(
    'P-U03 cpus: millicores === Math.round(x * 1000); the quantity is canonical and exact',
    (rng) => {
      const milli = randomInt(rng, 1, 64_000);
      const x = milli / 1000;
      return pick(rng, [x, String(x), x.toFixed(3)]);
    },
    (x) => {
      const parsed = parseMilliCpu(x);
      expect(parsed).toEqual({ milli: Math.round(Number(x) * 1000), rounded: false });
      const quantity = cpuQuantity((parsed as { milli: number }).milli);
      expect(quantity).toMatch(QUANTITY_RE);
      expect(canonicalQuantity(quantity)).toBe(quantity);
      expect(
        sameValue(parseQuantity(quantity) as Quantity, {
          negative: false,
          mantissa: BigInt((parsed as { milli: number }).milli),
          scale: -3,
          format: 'DecimalSI',
        }),
      ).toBe(true);
    },
  );

  forAll(
    'canonicalQuantity keeps the value above nano precision; decimal forms are fixed points',
    (rng) => {
      const whole = String(randomInt(rng, 0, 99999));
      const fraction = rng() < 0.5 ? '' : `.${String(randomInt(rng, 0, 999))}`;
      const suffix = pick(rng, ['', 'm', 'k', 'M', 'G', 'u', 'Ki', 'Mi', 'Gi', 'Ti', 'e3', 'e-2', 'E6']);
      return `${pick(rng, ['', '', '-', '+'])}${whole}${fraction}${suffix}`;
    },
    (text) => {
      const canonical = canonicalQuantity(text);
      expect(canonical).not.toBeNull();
      expect(canonical).toMatch(QUANTITY_RE);
      expect(sameValue(parseQuantity(text) as Quantity, parseQuantity(canonical as string) as Quantity)).toBe(true);
      // like apimachinery, a binary value printed without a suffix re-parses as decimal
      // ("15.625Ki" -> "16000" -> "16k"), so only decimal inputs are fixed points
      if (!text.endsWith('i')) expect(canonicalQuantity(canonical as string)).toBe(canonical);
    },
  );
});
