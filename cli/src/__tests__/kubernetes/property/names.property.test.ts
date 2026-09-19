// design-07 8.3 P-N01..P-N10: name algorithms of DESIGN-CORE 5.4 under generated input.

import { describe, expect, it } from 'bun:test';
import { sha256Hex } from '../../../utils/hash';
import {
  hashedObjectName,
  headlessServiceName,
  importedImageRef,
  isIanaSvcName,
  loadBalancerServiceName,
  namespaceFor,
  nodeNameFor,
  portNameFor,
  releaseSecretName,
  releaseSlug,
  sanitizeDnsLabel,
  serviceNameFor,
} from '../../../services/orchestrator/kubernetes/naming';
import { isDnsLabel, isDnsSubdomain, isLabelValue } from '../../../services/orchestrator/kubernetes/model/units';
import type { Protocol } from '../../../services/orchestrator/kubernetes/model/types';
import { mulberry32, pick, randomInt, type Rng } from '../support/prng';
import { forAll } from '../support/property';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = LOWER + DIGITS;
const COMPOSE_CHARS = `${ALNUM}ABCDEFGHIJKLMNOPQRSTUVWXYZ._-`;
const DNS_LABEL_STRICT = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS_1035 = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

function chars(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

/** any UTF-16, lone surrogates included (sanitizers must not throw) */
function rawJsString(rng: Rng, size: number): string {
  const length = randomInt(rng, 0, Math.max(1, size));
  let out = '';
  for (let i = 0; i < length; i++) {
    const roll = rng();
    if (roll < 0.4) out += COMPOSE_CHARS[Math.floor(rng() * COMPOSE_CHARS.length)];
    else if (roll < 0.55) out += pick(rng, [' ', '/', ':', '@', '+', '$', '\t', '\n', '\u{a0}', '\u{200d}']);
    else if (roll < 0.7) out += String.fromCharCode(randomInt(rng, 0xd800, 0xdfff));
    else if (roll < 0.85) out += String.fromCharCode(randomInt(rng, 0x80, 0xd7ff));
    else out += String.fromCodePoint(randomInt(rng, 0x1f300, 0x1faff));
  }
  return out;
}

/** compose keys: length 1..80 over [a-zA-Z0-9._-], weighted towards the awkward edges */
function composeName(rng: Rng): string {
  const length = randomInt(rng, 1, 80);
  const body = chars(rng, COMPOSE_CHARS, length);
  switch (randomInt(rng, 0, 6)) {
    case 0:
      return `${randomInt(rng, 0, 9)}${body}`.slice(0, 80);
    case 1:
      return '_'.repeat(length);
    case 2:
      return `${body}--${body}`.slice(0, 80);
    case 3:
      return `${body}__x`.slice(0, 80);
    case 4:
      return `${body}${pick(rng, ['.', '-'])}`.slice(-80);
    case 5:
      return body.toUpperCase();
    default:
      return body;
  }
}

/** DNS label made of [a-z0-9] runs joined by single dashes, the fixed points of sanitizeDnsLabel */
function cleanLabel(rng: Rng, maxLength: number, startWithLetter: boolean): string {
  let out = startWithLetter ? pick(rng, [...LOWER]) : pick(rng, [...ALNUM]);
  const target = randomInt(rng, 1, maxLength);
  while (out.length < target) {
    out += out.endsWith('-') || out.length === target - 1 || rng() < 0.8 ? pick(rng, [...ALNUM]) : '-';
  }
  return out;
}

/** config schema names: [a-z0-9]([a-z0-9-]*[a-z0-9])? */
function schemaName(rng: Rng, maxLength: number): string {
  const length = randomInt(rng, 1, maxLength);
  if (length === 1) return pick(rng, [...ALNUM]);
  return pick(rng, [...ALNUM]) + chars(rng, `${ALNUM}-`, length - 2) + pick(rng, [...ALNUM]);
}

function version(rng: Rng): string {
  const core = `${randomInt(rng, 0, 20)}.${randomInt(rng, 0, 99)}.${randomInt(rng, 0, 999)}`;
  const idChars = `${ALNUM}ABCDEFGHIJKLMNOPQRSTUVWXYZ-`;
  const ids = (count: number) => Array.from({ length: count }, () => chars(rng, idChars, randomInt(rng, 1, 12))).join('.');
  let v = pick(rng, ['', 'v', 'V']) + core;
  if (rng() < 0.5) v += `-${ids(randomInt(rng, 1, 4))}`;
  if (rng() < 0.4) v += `+${ids(randomInt(rng, 1, 4))}`;
  if (rng() < 0.2) v += `_${chars(rng, idChars, randomInt(rng, 1, 60))}`;
  return v.slice(0, 128);
}

// distribution/reference grammar (docker/distribution regexp.go)
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const HOST = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])`;
const NAME = `(?:${HOST}(?::[0-9]+)?/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;
const REFERENCE_RE = new RegExp(`^(${NAME})(?::[\\w][\\w.-]{0,127})?(?:@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,})?$`);

function isImageReference(ref: string): boolean {
  const m = REFERENCE_RE.exec(ref);
  return m !== null && m[1].length <= 255;
}

function pathComponent(rng: Rng): string {
  let out = chars(rng, ALNUM, randomInt(rng, 1, 10));
  for (let i = randomInt(rng, 0, 2); i > 0; i--) out += pick(rng, ['.', '_', '__', '-', '--']) + chars(rng, ALNUM, randomInt(rng, 1, 8));
  return out;
}

function imageRef(rng: Rng): string {
  let name = Array.from({ length: randomInt(rng, 1, 3) }, () => pathComponent(rng)).join('/');
  const host = pick(rng, ['', 'registry.example.com', 'Registry.Example.com', 'localhost', 'ghcr.io', '10.0.0.5', '[::1]', 'my-registry']);
  if (host !== '') name = `${host}${rng() < 0.5 ? `:${randomInt(rng, 1, 65535)}` : ''}/${name}`;
  const tag = rng() < 0.6 ? `:${chars(rng, `${ALNUM}ABCXYZ_.-`, randomInt(rng, 1, 20)).replace(/^[.-]/, 'v')}` : '';
  const digest = rng() < 0.3 ? `@sha256:${sha256Hex(name)}` : '';
  return `${name}${tag}${digest}`;
}

describe('names (design-07 8.3)', () => {
  forAll(
    'P-N01 sanitizeDnsLabel never throws and yields a valid label within max',
    (rng, size) => ({ input: rawJsString(rng, size), max: randomInt(rng, 8, 63), mustStartWithLetter: rng() < 0.5 }),
    ({ input, max, mustStartWithLetter }) => {
      const result = sanitizeDnsLabel(input, { max, mustStartWithLetter });
      expect(result.value).toMatch(DNS_LABEL_STRICT);
      expect(result.value.length).toBeLessThanOrEqual(max);
      expect(sanitizeDnsLabel(input, { max, mustStartWithLetter })).toEqual(result);
      expect(result.changed).toBe(result.value !== input);
      if (mustStartWithLetter) expect(result.value[0]).toMatch(/[a-z]/);
    },
  );

  forAll(
    'P-N01 sanitizeDnsLabel on compose names',
    (rng) => composeName(rng),
    (input) => {
      const result = sanitizeDnsLabel(input, { max: 52, mustStartWithLetter: true });
      expect(result.value).toMatch(DNS_1035);
      expect(result.value.length).toBeLessThanOrEqual(52);
    },
  );

  forAll(
    'P-N02 valid inputs within max are returned unchanged',
    (rng) => {
      const max = randomInt(rng, 8, 63);
      const mustStartWithLetter = rng() < 0.5;
      return { input: cleanLabel(rng, max, mustStartWithLetter), max, mustStartWithLetter };
    },
    ({ input, max, mustStartWithLetter }) => {
      expect(sanitizeDnsLabel(input, { max, mustStartWithLetter })).toEqual({ value: input, changed: false });
    },
  );

  it('P-N03 5 000 pairs of distinct inputs sharing 70 leading characters give distinct outputs', () => {
    const rng = mulberry32(0x5eed03);
    for (let i = 0; i < 5000; i++) {
      const prefix = chars(rng, COMPOSE_CHARS, 70);
      const a = prefix + chars(rng, COMPOSE_CHARS, randomInt(rng, 1, 10));
      let b = prefix + chars(rng, COMPOSE_CHARS, randomInt(rng, 1, 10));
      if (a === b) b += 'x';
      expect(serviceNameFor(a).value).not.toBe(serviceNameFor(b).value);
      expect(sanitizeDnsLabel(a, { max: 63, mustStartWithLetter: false }).value).not.toBe(
        sanitizeDnsLabel(b, { max: 63, mustStartWithLetter: false }).value,
      );
    }
  });

  forAll(
    'P-N04 service names are <= 52; -lb and -hl are DNS-1035 labels <= 55',
    (rng) => composeName(rng),
    (input) => {
      const name = serviceNameFor(input).value;
      expect(name.length).toBeLessThanOrEqual(52);
      for (const derived of [loadBalancerServiceName(name), headlessServiceName(name)]) {
        expect(derived).toMatch(DNS_1035);
        expect(derived.length).toBeLessThanOrEqual(55);
      }
    },
  );

  forAll(
    'P-N05 namespaceFor yields a valid label <= 63 starting with dockflow-',
    (rng) => ({ project: schemaName(rng, 63), env: schemaName(rng, 50) }),
    ({ project, env }) => {
      const ns = namespaceFor(project, env);
      expect(isDnsLabel(ns)).toBe(true);
      expect(ns.length).toBeLessThanOrEqual(63);
      expect(ns.startsWith('dockflow-')).toBe(true);
    },
  );

  it('P-N05 namespaceFor is injective over 10 000 generated pairs', () => {
    const rng = mulberry32(0x5eed05);
    const seen = new Map<string, string>();
    for (let i = 0; i < 10000; i++) {
      const project = schemaName(rng, 63);
      const env = schemaName(rng, 50);
      // ('a-b', 'c') and ('a', 'b-c') are the same stack name by construction; compare raw names
      const raw = `${project}-${env}`;
      const ns = namespaceFor(project, env);
      const previous = seen.get(ns);
      if (previous !== undefined) expect(previous).toBe(raw);
      seen.set(ns, raw);
    }
  });

  forAll(
    'P-N06 hashedObjectName is a valid subdomain <= 65; distinct checksums give distinct names',
    (rng) => ({
      key: composeName(rng),
      kind: pick(rng, ['env', 'secret', 'config'] as const),
      a: sha256Hex(`a${rng()}`),
      b: sha256Hex(`b${rng()}`),
    }),
    ({ key, kind, a, b }) => {
      const base = kind === 'env' ? serviceNameFor(key).value : key;
      const name = hashedObjectName(base, kind, a);
      expect(isDnsSubdomain(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(65);
      expect(hashedObjectName(base, kind, b)).not.toBe(name);
    },
  );

  forAll(
    'P-N07 releaseSlug is a valid label value <= 40 and names a valid Secret',
    (rng) => version(rng),
    (v) => {
      const slug = releaseSlug(v);
      expect(isLabelValue(slug)).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(40);
      expect(isDnsSubdomain(releaseSecretName(v))).toBe(true);
    },
  );

  forAll(
    'P-N07 releaseSlug is the identity for simple versions',
    (rng) => `${randomInt(rng, 0, 99)}.${randomInt(rng, 0, 99)}.${randomInt(rng, 0, 999)}${rng() < 0.5 ? `-rc.${randomInt(rng, 1, 9)}` : ''}`,
    (v) => {
      expect(releaseSlug(v)).toBe(v);
    },
  );

  it('P-N07 distinct versions give distinct slugs over 10 000 generated versions', () => {
    const rng = mulberry32(0x5eed07);
    const seen = new Map<string, string>();
    for (let i = 0; i < 10000; i++) {
      const v = version(rng);
      const slug = releaseSlug(v);
      const previous = seen.get(slug);
      if (previous !== undefined) expect(previous).toBe(v);
      seen.set(slug, v);
    }
  });

  forAll(
    'P-N08 portNameFor always yields a valid IANA_SVC_NAME and keeps valid requests',
    (rng, size) => ({
      port: pick(rng, [1, 53, 80, 8080, 65535, randomInt(rng, 1, 65535)]),
      protocol: pick(rng, ['TCP', 'UDP', 'SCTP'] as Protocol[]),
      requested: pick(rng, [null, rawJsString(rng, size), cleanLabel(rng, 15, true), chars(rng, `${LOWER}-_`, randomInt(rng, 1, 20))]),
    }),
    ({ port, protocol, requested }) => {
      const name = portNameFor(port, protocol, requested);
      expect(isIanaSvcName(name)).toBe(true);
      if (requested !== null && isIanaSvcName(requested)) expect(name).toBe(requested);
    },
  );

  forAll(
    'P-N09 nodeNameFor turns every servers.yml key into a valid label',
    (rng) => {
      const length = randomInt(rng, 1, 63);
      if (length === 1) return pick(rng, [...ALNUM]);
      return pick(rng, [...ALNUM]) + chars(rng, `${ALNUM}_-`, length - 2) + pick(rng, [...ALNUM]);
    },
    (key) => {
      const node = nodeNameFor(key);
      expect(isDnsLabel(node)).toBe(true);
      expect(node).toBe(key.replace(/_/g, '-'));
    },
  );

  it('the reference grammar used by P-N10 accepts and refuses what distribution does', () => {
    for (const ok of ['nginx', 'library/nginx:1.27', 'registry.example.com:5000/a/b:v1', 'localhost/app:latest', '[::1]:5000/app', `a@sha256:${'a'.repeat(64)}`]) {
      expect([ok, isImageReference(ok)]).toEqual([ok, true]);
    }
    for (const bad of ['Nginx', 'app:', 'app:-x', 'a//b', 'dockflow.invalid/localhost:5000/app', `${'a'.repeat(256)}`]) {
      expect([bad, isImageReference(bad)]).toEqual([bad, false]);
    }
  });

  forAll(
    'P-N10 importedImageRef parses with the distribution reference grammar under dockflow.invalid/',
    (rng) => imageRef(rng),
    (ref) => {
      expect(isImageReference(ref)).toBe(true);
      const imported = importedImageRef(ref);
      expect(imported.startsWith('dockflow.invalid/')).toBe(true);
      expect(isImageReference(imported)).toBe(true);
    },
  );
});
