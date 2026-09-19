// Seeded randomness for property tests and shuffled-input tests: the same seed always yields the
// same sequence, so every failure is reproducible from the seed printed with it.

/** Uniform in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast, good enough for test inputs. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a of the UTF-16 code units; turns a property name into a stable default seed. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Integer in [min, max], both inclusive. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() needs at least one item');
  return items[Math.floor(rng() * items.length)];
}

/** Fisher-Yates on a copy. */
export function seededShuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Deep copy whose plain objects are rebuilt with their keys inserted in a shuffled order; arrays
 * keep their order. Output that depends on key insertion order changes under this, correct output
 * does not.
 */
export function deepShuffleKeys<T>(value: T, rng: Rng): T {
  if (Array.isArray(value)) return value.map((item) => deepShuffleKeys(item, rng)) as T;
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of seededShuffle(Object.keys(record), rng)) out[key] = deepShuffleKeys(record[key], rng);
    return out as T;
  }
  return value;
}
