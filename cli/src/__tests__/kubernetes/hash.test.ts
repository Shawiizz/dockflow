import { describe, expect, it } from 'bun:test';
import { canonicalJson, sha256Hex, shortHash } from '../../utils/hash';

describe('sha256Hex (U-HASH-01)', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a string as its UTF-8 bytes', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
    expect(sha256Hex(new TextEncoder().encode('é'))).toBe(sha256Hex('é'));
  });
});

describe('shortHash (U-HASH-01)', () => {
  it('is the prefix of sha256Hex', () => {
    expect(shortHash('abc', 8)).toBe('ba7816bf');
    expect(shortHash('abc', 12)).toBe(sha256Hex('abc').slice(0, 12));
    expect(shortHash(new TextEncoder().encode('abc'), 8)).toBe('ba7816bf');
  });
});

describe('canonicalJson (U-HASH-01)', () => {
  it('sorts keys at every depth, keeps array order and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: undefined } })).toBe('{"a":{"d":[2,1]},"b":1}');
  });

  it('sorts keys by code unit, never by locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, é: 4, _: 5 })).toBe('{"B":2,"_":5,"a":3,"b":1,"é":4}');
  });

  it('does not depend on insertion order', () => {
    const one = { spec: { replicas: 2, selector: { app: 'web' } }, kind: 'Deployment' };
    const two = { kind: 'Deployment', spec: { selector: { app: 'web' }, replicas: 2 } };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('serializes scalars like JSON, with undefined array items as null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('uses toJSON when present', () => {
    expect(canonicalJson({ at: new Date('2026-09-17T10:11:12.000Z') })).toBe('{"at":"2026-09-17T10:11:12.000Z"}');
  });

  it('refuses values JSON cannot represent', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(TypeError);
  });

  it('accepts a shared object referenced twice (not a cycle)', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"x":1},"b":[{"x":1}]}');
  });
});
