/**
 * Deterministic hashing: every digest Dockflow stores or compares (artifacts, values, checksum
 * annotations) goes through these functions, so equal content always hashes equal.
 */

import { createHash } from 'crypto';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** undefined when JSON has no representation for the value (dropped in objects, null in arrays) */
function serialize(value: unknown, ancestors: Set<object>): string | undefined {
  let current = value;
  if (current !== null && typeof current === 'object' && typeof (current as { toJSON?: unknown }).toJSON === 'function') {
    current = (current as { toJSON: () => unknown }).toJSON();
  }
  switch (typeof current) {
    case 'string':
      return JSON.stringify(current);
    case 'number':
      return Number.isFinite(current) ? JSON.stringify(current) : 'null';
    case 'boolean':
      return current ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson cannot serialize a bigint');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (current === null) return 'null';

  const object = current as object;
  if (ancestors.has(object)) throw new TypeError('canonicalJson cannot serialize a circular structure');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      return `[${object.map((item) => serialize(item, ancestors) ?? 'null').join(',')}]`;
    }
    const record = object as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      const member = serialize(record[key], ancestors);
      if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/** JSON with object keys sorted by code unit at every depth; arrays keep order; no whitespace. undefined properties dropped. */
export function canonicalJson(value: unknown): string {
  const text = serialize(value, new Set());
  if (text === undefined) throw new TypeError(`canonicalJson cannot serialize a top-level ${typeof value}`);
  return text;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortHash(data: string | Uint8Array, length: number): string {
  return sha256Hex(data).slice(0, length);
}
