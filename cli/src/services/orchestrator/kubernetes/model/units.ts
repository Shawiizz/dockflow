// Scalar parsing and validation shared by the normalizer and the translator (design-01 2.4-2.8,
// 2.13; design-02 1.2), and the one Kubernetes quantity canonicalizer (DESIGN-CORE 4.2 rule 5).
// Pure: no I/O, no clock.

import { z } from 'zod';
import { DOCKFLOW_K8S_PREFIX } from '../constants';

// ---------------------------------------------------------------------------
// Scalars (design-01 2.4)
// ---------------------------------------------------------------------------

/** compose-go toBoolean; `yaml11` flags the YAML 1.1 spellings Swarm accepted */
export function parseBool(v: unknown): { value: boolean; yaml11: boolean } | null {
  if (typeof v === 'boolean') return { value: v, yaml11: false };
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase();
  if (s === 'true') return { value: true, yaml11: false };
  if (s === 'false') return { value: false, yaml11: false };
  if (s === 'y' || s === 'yes' || s === 'on') return { value: true, yaml11: true };
  if (s === 'n' || s === 'no' || s === 'off') return { value: false, yaml11: true };
  return null;
}

/** integers written as numbers or as decimal strings */
export function parseIntStrict(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?[0-9]+$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

// ---------------------------------------------------------------------------
// Durations (design-01 2.5, Go time.ParseDuration semantics)
// ---------------------------------------------------------------------------

const UNIT_NS: Readonly<Record<string, bigint>> = {
  ns: 1n,
  us: 1_000n,
  '\u{b5}s': 1_000n, // micro sign
  '\u{3bc}s': 1_000n, // Greek small letter mu
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};
const MAX_NS = 9_223_372_036_854_775_807n;
const DURATION_COMPONENT_RE = /^([0-9]*)(?:\.([0-9]*))?([^0-9.]+)/;

/**
 * Milliseconds, rounded UP; null = invalid; 'negative' and 'overflow' are reported separately.
 * Numbers are not durations (the compose schema types them as strings).
 */
export function parseDurationMs(v: unknown): number | null | 'negative' | 'overflow' {
  if (typeof v !== 'string') return null;
  let s = v;
  let negative = false;
  if (s.startsWith('-') || s.startsWith('+')) {
    negative = s.startsWith('-');
    s = s.slice(1);
  }
  // Go accepts a bare zero, signed or not, without a unit
  if (s === '0') return 0;
  if (s === '') return null;
  let total = 0n;
  let overflow = false;
  while (s !== '') {
    const m = DURATION_COMPONENT_RE.exec(s);
    // ".s" is invalid, ".5s" and "5.s" are valid
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
    const unit = UNIT_NS[m[3]];
    if (unit === undefined) return null;
    let ns = (m[1] === '' ? 0n : BigInt(m[1])) * unit;
    // Go truncates the fraction to whole nanoseconds
    if (m[2]) ns += (BigInt(m[2]) * unit) / 10n ** BigInt(m[2].length);
    total += ns;
    if (total > MAX_NS) overflow = true;
    s = s.slice(m[0].length);
  }
  if (negative && total > 0n) return 'negative';
  if (overflow) return 'overflow';
  return Number((total + 999_999n) / 1_000_000n);
}

/** ms -> whole seconds rounded up; result >= min */
export function ceilSeconds(ms: number, min: 0 | 1): number {
  return Math.max(min, Math.ceil(ms / 1000));
}

// ---------------------------------------------------------------------------
// Byte values (design-01 2.6, go-units RAMInBytes: every unit is binary)
// ---------------------------------------------------------------------------

const BINARY: Readonly<Record<string, number>> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

export function parseBytes(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  // exponent notation is refused on purpose: the compose grammar is {amount}{unit}
  const m = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+) ?([A-Za-z]{0,3})$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const sfx = m[2].toLowerCase();
  if (sfx === '' || sfx === 'b') return Math.trunc(n);
  const mul = BINARY[sfx[0]];
  if (mul === undefined) return null;
  if (sfx.length === 2 && sfx[1] !== 'b') return null;
  if (sfx.length === 3 && sfx.slice(1) !== 'ib') return null;
  const bytes = Math.trunc(n * mul);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

// ---------------------------------------------------------------------------
// CPUs (design-01 2.7)
// ---------------------------------------------------------------------------

/** decimal CPUs -> millicores; exact decimal arithmetic; rounds up below 1m */
export function parseMilliCpu(v: unknown): { milli: number; rounded: boolean } | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) && v >= 0 ? String(v) : '') : typeof v === 'string' ? v : '';
  // also rejects exponent notation
  const m = /^([0-9]*)(?:\.([0-9]*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const frac = (m[2] ?? '').padEnd(3, '0');
  let milli = Number(m[1] || '0') * 1000 + Number(frac.slice(0, 3));
  const rounded = /[1-9]/.test(frac.slice(3));
  if (rounded) milli += 1;
  return Number.isSafeInteger(milli) ? { milli, rounded } : null;
}

// ---------------------------------------------------------------------------
// File modes (design-01 2.8)
// ---------------------------------------------------------------------------

/** number: taken as is (the loader already converted 0-prefixed octal literals); string: base 8 (compose-go) */
export function parseFileMode(v: unknown): { mode: number; decimalLooksOctal: boolean } | null {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0 || v > 0o7777) return null;
    // e.g. 440 written without a leading 0
    const looks = v > 0 && /^[0-7]{3,4}$/.test(String(v));
    return { mode: v, decimalLooksOctal: looks };
  }
  if (typeof v === 'string') {
    const m = /^(?:0o)?([0-7]{1,4})$/.exec(v);
    return m ? { mode: Number.parseInt(m[1], 8), decimalLooksOctal: false } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name and value validators (design-01 2.13)
// ---------------------------------------------------------------------------

export const LABEL_KEY_RE =
  /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
export const LABEL_VALUE_RE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])?$/;
export const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const DNS_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const SYSCTL_NAME_RE = /^[a-z0-9]([-_a-z0-9]*[a-z0-9])?([./][a-z0-9]([-_a-z0-9]*[a-z0-9])?)*$/;
const DNS_SUBDOMAIN_MAX = 253;

/** Compose keys of services, volumes, secrets, configs and networks */
export function isServiceKey(v: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(v);
}

/** Kubernetes qualified name: optional DNS subdomain prefix (<= 253) and `/`, then a name of <= 63 */
export function isLabelKey(v: string): boolean {
  if (!LABEL_KEY_RE.test(v)) return false;
  const slash = v.indexOf('/');
  return slash === -1 || slash <= DNS_SUBDOMAIN_MAX;
}

export function isLabelValue(v: string): boolean {
  return LABEL_VALUE_RE.test(v);
}

/** Keys under Dockflow's own prefix, which user maps may not set */
export function isReservedKey(v: string): boolean {
  return v.startsWith(`${DOCKFLOW_K8S_PREFIX}/`);
}

export function isDnsLabel(v: string): boolean {
  return DNS_LABEL_RE.test(v);
}

export function isDnsSubdomain(v: string): boolean {
  return v.length <= DNS_SUBDOMAIN_MAX && DNS_SUBDOMAIN_RE.test(v);
}

/** Secret and ConfigMap data keys (environment names travel as envFrom Secret keys, D11) */
export function isSecretDataKey(v: string): boolean {
  return /^[-._a-zA-Z0-9]+$/.test(v) && v.length <= DNS_SUBDOMAIN_MAX && v !== '.' && !v.startsWith('..');
}

export function isSysctlName(v: string): boolean {
  return SYSCTL_NAME_RE.test(v);
}

const IPV4 = z.ipv4();
const IPV6 = z.ipv6();
const CIDR_V4 = z.cidrv4();
const CIDR_V6 = z.cidrv6();

export function isIp(v: string): boolean {
  return IPV4.safeParse(v).success || IPV6.safeParse(v).success;
}

export function isCidr(v: string): boolean {
  return CIDR_V4.safeParse(v).success || CIDR_V6.safeParse(v).success;
}

export function isAbsolutePosixPath(v: string): boolean {
  return v.startsWith('/') && !v.includes('\0');
}

/**
 * Architectures a placement constraint may name, mapped to `kubernetes.io/arch` values. The
 * normalizer accepts exactly these keys and the translator looks them up (design-02 5.10).
 */
export const ARCH = {
  x86_64: 'amd64',
  amd64: 'amd64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'arm',
  armhf: 'arm',
  arm: 'arm',
  s390x: 's390x',
  ppc64le: 'ppc64le',
  riscv64: 'riscv64',
} as const;

export type ArchName = keyof typeof ARCH;

export function isArchName(v: string): v is ArchName {
  return Object.hasOwn(ARCH, v);
}

// ---------------------------------------------------------------------------
// Kubernetes quantities (DESIGN-CORE 4.2 rule 5, design-02 1.2)
// ---------------------------------------------------------------------------

export type QuantityFormat = 'DecimalSI' | 'BinarySI' | 'DecimalExponent';

/** Exact value `(negative ? -1 : 1) * mantissa * 10^scale`, with the format its suffix implies. */
export interface Quantity {
  negative: boolean;
  mantissa: bigint;
  scale: number;
  format: QuantityFormat;
}

const DECIMAL_SUFFIX_SCALE: Readonly<Record<string, number>> = { n: -9, u: -6, m: -3, '': 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };
const BINARY_SUFFIX_POWER: Readonly<Record<string, number>> = { Ki: 1, Mi: 2, Gi: 3, Ti: 4, Pi: 5, Ei: 6 };
const SCALE_DECIMAL_SUFFIX: Readonly<Record<number, string>> = { [-9]: 'n', [-6]: 'u', [-3]: 'm', 0: '', 3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P', 18: 'E' };
const BINARY_SUFFIXES = ['', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'];
const QUANTITY_RE = /^([+-]?)([0-9]+(?:\.[0-9]*)?|\.[0-9]+)((?:[eE][+-]?[0-9]+)|[numkMGTPE]|[KMGTPE]i)?$/;
/** apimachinery caps BinarySI values at the int64 maximum */
const MAX_BINARY_SI = 9_223_372_036_854_775_807n;
/** apimachinery rounds every non-zero value up to nano precision */
const MIN_SCALE = -9;
/** larger exponents cannot come from a manifest Dockflow writes */
const MAX_EXPONENT = 1000;

/** apimachinery `resource.ParseQuantity`; null when the text is not a quantity */
export function parseQuantity(text: string): Quantity | null {
  const m = QUANTITY_RE.exec(text);
  if (!m) return null;
  const [, sign, number, suffix = ''] = m;
  const dot = number.indexOf('.');
  const digits = dot === -1 ? number : number.slice(0, dot) + number.slice(dot + 1);
  let mantissa = BigInt(digits);
  let scale = dot === -1 ? 0 : -(number.length - dot - 1);
  let format: QuantityFormat = 'DecimalSI';

  if (/^[eE][+-]?[0-9]+$/.test(suffix)) {
    const exponent = Number(suffix.slice(1));
    if (Math.abs(exponent) > MAX_EXPONENT) return null;
    scale += exponent;
    format = 'DecimalExponent';
  } else if (suffix.endsWith('i')) {
    mantissa *= 1024n ** BigInt(BINARY_SUFFIX_POWER[suffix]);
    format = 'BinarySI';
  } else {
    scale += DECIMAL_SUFFIX_SCALE[suffix];
  }

  return normalizeQuantity({ negative: sign === '-', mantissa, scale, format });
}

/** apimachinery `Quantity.String()`: the canonical text the API server returns for this value */
export function formatQuantity(quantity: Quantity): string {
  const q = normalizeQuantity(quantity);
  if (q.mantissa === 0n) return '0';
  const sign = q.negative ? '-' : '';
  if (q.format === 'BinarySI' && compareToInteger(q.mantissa, q.scale, 1024n) >= 0) {
    const integer = integerValue(q.mantissa, q.scale);
    if (integer !== null) {
      let amount = integer;
      let power = 0;
      while (power < BINARY_SUFFIXES.length - 1 && amount % 1024n === 0n) {
        amount /= 1024n;
        power += 1;
      }
      return `${sign}${amount}${BINARY_SUFFIXES[power]}`;
    }
  }
  // decimal: integer mantissa, exponent a multiple of 3
  let amount = q.mantissa;
  let exponent = q.scale;
  while (amount % 10n === 0n) {
    amount /= 10n;
    exponent += 1;
  }
  const rest = ((exponent % 3) + 3) % 3;
  amount *= 10n ** BigInt(rest);
  exponent -= rest;
  if (q.format === 'DecimalExponent') return `${sign}${amount}${exponent === 0 ? '' : `e${exponent}`}`;
  if (exponent > 18) {
    amount *= 10n ** BigInt(exponent - 18);
    exponent = 18;
  }
  return `${sign}${amount}${SCALE_DECIMAL_SUFFIX[exponent]}`;
}

/** The canonical form of a quantity text, or null when it is not a quantity. */
export function canonicalQuantity(text: string): string | null {
  const q = parseQuantity(text);
  return q ? formatQuantity(q) : null;
}

/** 0 -> "0"; 2000 -> "2"; 1500 -> "1500m"; 250 -> "250m" */
export function cpuQuantity(milli: number): string {
  return formatQuantity({ negative: milli < 0, mantissa: BigInt(Math.abs(milli)), scale: -3, format: 'DecimalSI' });
}

/**
 * 0 -> "0"; exact multiples of 1024 in binary form (`512Mi`, `1Gi`); anything else in decimal
 * canonical form (`1536`, `1k` for 1000 bytes). Never a lowercase `m`: bytes are whole numbers.
 */
export function memoryQuantity(bytes: number): string {
  const magnitude = BigInt(Math.abs(bytes));
  const format: QuantityFormat = magnitude >= 1024n && magnitude % 1024n === 0n ? 'BinarySI' : 'DecimalSI';
  return formatQuantity({ negative: bytes < 0, mantissa: magnitude, scale: 0, format });
}

/** The value apimachinery stores after parsing: nano precision rounded up, BinarySI capped, zero unsigned. */
function normalizeQuantity(q: Quantity): Quantity {
  let { mantissa, scale } = q;
  if (mantissa !== 0n && scale < MIN_SCALE) {
    const divisor = 10n ** BigInt(MIN_SCALE - scale);
    mantissa = (mantissa + divisor - 1n) / divisor;
    scale = MIN_SCALE;
  }
  if (q.format === 'BinarySI' && compareToInteger(mantissa, scale, MAX_BINARY_SI) > 0) {
    mantissa = MAX_BINARY_SI;
    scale = 0;
  }
  if (mantissa === 0n) return { negative: false, mantissa: 0n, scale: 0, format: 'DecimalSI' };
  return { negative: q.negative, mantissa, scale, format: q.format };
}

/** sign of `mantissa * 10^scale - integer` */
function compareToInteger(mantissa: bigint, scale: number, integer: bigint): number {
  const left = scale >= 0 ? mantissa * 10n ** BigInt(scale) : mantissa;
  const right = scale >= 0 ? integer : integer * 10n ** BigInt(-scale);
  return left > right ? 1 : left < right ? -1 : 0;
}

function integerValue(mantissa: bigint, scale: number): bigint | null {
  if (scale >= 0) return mantissa * 10n ** BigInt(scale);
  const divisor = 10n ** BigInt(-scale);
  return mantissa % divisor === 0n ? mantissa / divisor : null;
}
