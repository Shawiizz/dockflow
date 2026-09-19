// design-07 8.3 P-Y01..P-Y04: the manifest emitter and canonical JSON under generated input, and
// the ambiguous-scalar catalogue read back under both YAML 1.2 (Dockflow) and YAML 1.1 (kubectl).

import { describe, expect, it } from 'bun:test';
import { parseAllDocuments, visit } from 'yaml';
import { canonicalJson } from '../../../utils/hash';
import { KIND_REGISTRY, type ManifestKind, type ManifestObject } from '../../../services/orchestrator/kubernetes/resources/registry';
import { type ArtifactHeader, emitManifests, KEY_PRIORITY, parseManifests } from '../../../services/orchestrator/kubernetes/yaml';
import { deepShuffleKeys, fnv1a32, mulberry32, pick, randomInt, type Rng, seededShuffle } from '../support/prng';
import { forAll } from '../support/property';
import { AMBIGUOUS_SCALARS } from '../support/yaml-scalars';

const header: ArtifactHeader = { format: 'k8s-manifests/1', stackName: 'shop-production', role: 'app', version: '1.4.2' };
const KINDS = Object.keys(KIND_REGISTRY) as ManifestKind[];

const WORDS = ['web', 'db', 'app.kubernetes.io/name', 'dockflow.shawiizz.dev/stack', 'x-y_z', 'A', 'b', 'Z9', 'été', '日本'];
const TEXTS = [
  'hello world',
  'line 1\nline 2',
  'line 1\nline 2\n',
  'trailing blank\n\n',
  '\n',
  '  indented\nfirst',
  'tab\there',
  'key: value',
  'value # not a comment',
  '$(VAR) and $$',
  'éè \u{1f600}',
  'a'.repeat(300),
  'ends with space ',
  '"quoted"',
  "'single'",
  'back\\slash',
  'cr\r\nlf',
];

function stringValue(rng: Rng): string {
  switch (randomInt(rng, 0, 3)) {
    case 0:
      return pick(rng, AMBIGUOUS_SCALARS);
    case 1:
      return pick(rng, TEXTS);
    case 2:
      return pick(rng, WORDS);
    default:
      return `${pick(rng, WORDS)}-${randomInt(rng, 0, 1000)}`;
  }
}

function keyValue(rng: Rng): string {
  switch (randomInt(rng, 0, 3)) {
    case 0:
      return pick(rng, AMBIGUOUS_SCALARS);
    case 1:
      return pick(rng, KEY_PRIORITY);
    default:
      return pick(rng, WORDS);
  }
}

function scalar(rng: Rng): unknown {
  switch (randomInt(rng, 0, 4)) {
    case 0:
      return randomInt(rng, -1_000_000, 1_000_000) || 0;
    case 1:
      return Math.round((rng() - 0.5) * 10_000) / 100 || 0;
    case 2:
      return rng() < 0.5;
    default:
      return stringValue(rng);
  }
}

/** nested JSON without null (the emitter refuses null: the translator never produces it) */
function jsonValue(rng: Rng, depth: number): unknown {
  const roll = depth <= 0 ? 0 : randomInt(rng, 0, 3);
  if (roll === 0 || roll === 1) return scalar(rng);
  if (roll === 2) return Array.from({ length: randomInt(rng, 0, 4) }, () => jsonValue(rng, depth - 1));
  const out: Record<string, unknown> = {};
  for (let i = randomInt(rng, 0, 5); i > 0; i--) out[keyValue(rng)] = jsonValue(rng, depth - 1);
  return out;
}

function manifests(rng: Rng, size: number): ManifestObject[] {
  const count = randomInt(rng, 1, 1 + Math.floor(size / 10));
  return Array.from({ length: count }, (_, i) => {
    const kind = pick(rng, KINDS);
    const labels: Record<string, string> = {};
    for (let j = randomInt(rng, 0, 3); j > 0; j--) labels[pick(rng, WORDS)] = stringValue(rng);
    const object: Record<string, unknown> = {
      apiVersion: KIND_REGISTRY[kind].apiVersion,
      kind,
      metadata: { name: `${pick(rng, ['a', 'b', 'web', 'db'])}-${i}`, namespace: 'dockflow-shop-production', labels },
      spec: jsonValue(rng, 1 + Math.floor(size / 25)),
    };
    if (rng() < 0.5) object.data = Object.fromEntries(Array.from({ length: randomInt(rng, 0, 4) }, () => [keyValue(rng), stringValue(rng)]));
    return object as unknown as ManifestObject;
  });
}

function emissionOrder(objects: readonly ManifestObject[]): ManifestObject[] {
  return [...objects].sort((a, b) => {
    const rank = KIND_REGISTRY[a.kind].rank - KIND_REGISTRY[b.kind].rank;
    return rank !== 0 ? rank : a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
  });
}

function readAsYaml11(text: string): unknown[] {
  return parseAllDocuments(text, { version: '1.1' }).map((doc) => {
    expect(doc.errors).toEqual([]);
    return doc.toJS();
  });
}

describe('YAML emission (design-07 8.3)', () => {
  forAll('P-Y01 parseManifests(emitManifests(objects)) equals the objects', manifests, (objects) => {
    const text = emitManifests(objects, header);
    expect(parseManifests(text)).toEqual(emissionOrder(objects));
  });

  forAll('P-Y01 kubectl (YAML 1.1) reads the same objects', manifests, (objects) => {
    expect(readAsYaml11(emitManifests(objects, header))).toEqual(emissionOrder(objects));
  });

  forAll('P-Y02 no tab, no anchor or alias, a single trailing newline', manifests, (objects) => {
    const text = emitManifests(objects, header);
    expect(text).not.toContain('\t');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const doc of parseAllDocuments(text)) {
      visit(doc, {
        Alias() {
          throw new Error('alias in emitted YAML');
        },
        Node(_key, node) {
          if ('anchor' in node && node.anchor) throw new Error(`anchor ${node.anchor} in emitted YAML`);
        },
      });
    }
  });

  forAll(
    'P-Y03 deep-shuffled keys and object order give identical output',
    (rng, size) => ({ objects: manifests(rng, size), seed: randomInt(rng, 0, 2 ** 31) }),
    ({ objects, seed }) => {
      const rng = mulberry32(seed);
      const shuffled = seededShuffle(deepShuffleKeys(objects, rng), rng);
      expect(emitManifests(shuffled, header)).toBe(emitManifests(objects, header));
    },
  );

  forAll(
    'P-Y04 canonicalJson is invariant under key permutation and round-trips',
    (rng) => ({ value: jsonValue(rng, 4), seed: randomInt(rng, 0, 2 ** 31) }),
    ({ value, seed }) => {
      const text = canonicalJson(value);
      expect(canonicalJson(deepShuffleKeys(value, mulberry32(seed)))).toBe(text);
      expect(JSON.parse(text)).toEqual(value);
    },
  );
});

describe('ambiguous scalars (support/yaml-scalars)', () => {
  it('every catalogue entry survives as a key and as a value under YAML 1.2 and YAML 1.1', () => {
    const data: Record<string, string> = {};
    for (const scalar of AMBIGUOUS_SCALARS) data[scalar] = scalar;
    const object = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'ambiguous', namespace: 'dockflow-shop-production' },
      data,
    } as ManifestObject;
    const text = emitManifests([object], header);
    expect(parseManifests(text)).toEqual([object]);
    expect(readAsYaml11(text)).toEqual([object]);
  });

  it('catalogue entries are unique', () => {
    expect(new Set(AMBIGUOUS_SCALARS).size).toBe(AMBIGUOUS_SCALARS.length);
  });
});

describe('support/prng', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x >= 0 && x < 1).toBe(true);
    }
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('fnv1a32 matches the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('seededShuffle permutes a copy; deepShuffleKeys keeps values and array order', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = seededShuffle(items, mulberry32(7));
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const value = { b: [{ y: 1, x: 2 }, 3], a: { d: 'x', c: true } };
    const deep = deepShuffleKeys(value, mulberry32(3));
    expect(deep).toEqual(value);
    expect(deep).not.toBe(value);
  });
});
