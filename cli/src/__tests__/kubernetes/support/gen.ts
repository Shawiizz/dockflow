// Shared generators for the translator's property tests (design-07 8.2). Every export is a
// `Gen<T>` (deterministic given its `Rng`), so a `forAll` run built from one of them reproduces
// from the seed it prints. `miniStack` builds a small but structurally valid CanonicalStack
// directly with `support/builders.ts` (never through compose text), so a property that renders it
// exercises the translator alone, exactly like the row files of this package.

import type { Protocol } from '../../../services/orchestrator/kubernetes/model/types';
import type { CanonicalFileSource, CanonicalStack, CanonicalService, CanonicalVolume, FileMountSpec, MountSpec, PortSpec, RouteSpec } from '../../../services/orchestrator/kubernetes/model/types';
import { ARCH } from '../../../services/orchestrator/kubernetes/model/units';
import { childPath } from '../../../services/orchestrator/kubernetes/normalize/context';
import * as builders from './builders';
import { pick, randomInt, type Rng } from './prng';
import type { Gen } from './property';

// ---------------------------------------------------------------------------
// Strings (design-07 8.2)
// ---------------------------------------------------------------------------

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-';

function randomChars(rng: Rng, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += NAME_CHARS[randomInt(rng, 0, NAME_CHARS.length - 1)];
  return out;
}

/** length 1..80 over `[a-zA-Z0-9._-]`, weighted edges: leading digit, only `_`, `--`, `__`, trailing `.`/`-`, uppercase. */
export const composeName: Gen<string> = (rng, size) => {
  const edge = rng();
  if (edge < 0.06) return `${randomInt(rng, 0, 9)}${randomChars(rng, randomInt(rng, 0, 8))}`;
  if (edge < 0.12) return '_'.repeat(randomInt(rng, 1, 5));
  if (edge < 0.18) return `a--${randomChars(rng, randomInt(rng, 0, 6))}`;
  if (edge < 0.24) return `a__${randomChars(rng, randomInt(rng, 0, 6))}`;
  if (edge < 0.3) return `${randomChars(rng, randomInt(rng, 1, 10)) || 'a'}${pick(rng, ['.', '-'])}`;
  if (edge < 0.36) return randomChars(rng, randomInt(rng, 1, 10)).toUpperCase() || 'A';
  const length = Math.max(1, Math.min(80, randomInt(rng, 1, Math.max(1, Math.min(80, size + 1)))));
  return randomChars(rng, length) || 'a';
};

/** BMP letters, astral emoji, combining marks, RTL marks, ZWJ, NBSP; no lone surrogates. */
const UNICODE_POOL: readonly string[] = [
  'é', // combining acute accent on a base letter, never bare
  'Ω', // Omega
  'あ', // hiragana a
  '漢', // han "kanji"
  'א', // hebrew alef
  'ا', // arabic alif
  '‍', // ZWJ
  '‏', // RTL mark
  ' ', // NBSP
  '😀', // emoji, valid surrogate pair
  '🎉',
  '👍🏽', // emoji + skin tone modifier
  'A',
  '0',
  ' ',
];

export const unicodeString: Gen<string> = (rng, size) => {
  const length = randomInt(rng, 0, Math.max(1, Math.min(40, size)));
  let out = '';
  for (let i = 0; i < length; i++) out += pick(rng, UNICODE_POOL);
  return out;
};

/** Any UTF-16, lone surrogates included: sanitizers must never throw on this. */
export const rawJsString: Gen<string> = (rng, size) => {
  const length = randomInt(rng, 0, Math.max(1, Math.min(40, size)));
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(randomInt(rng, 0, 0xffff));
  return out;
};

const ENV_NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-';

/** 80% valid relaxed names (isSecretDataKey), 20% invalid (`=`, empty, non-ASCII). */
export const envName: Gen<string> = (rng, size) => {
  if (rng() < 0.8) {
    const length = randomInt(rng, 1, Math.max(1, Math.min(60, size + 5)));
    let out = '';
    for (let i = 0; i < length; i++) out += ENV_NAME_CHARS[randomInt(rng, 0, ENV_NAME_CHARS.length - 1)];
    if (out === '.' || out.startsWith('..')) out = `V${out}`;
    return out;
  }
  const kind = randomInt(rng, 0, 2);
  if (kind === 0) return '';
  if (kind === 1) return `A=B${randomInt(rng, 0, 999)}`;
  return `VAR_${pick(rng, ['É', 'ü', 'Ω', '中'])}`;
};

const ENV_VALUE_TOKENS: readonly string[] = ['$', '$$', '$(X)', '$$(X)', '\n', '\r\n', '\t', 'plain', 'á', '😀', ' '];

/** UTF-8 text with `$`, `$$`, `$(X)`, `$$(X)`, `\n`, `\r\n`, `\t`; length 0..100000, scaled by `size`. */
export const envValue: Gen<string> = (rng, size) => {
  const maxLength = Math.min(100_000, size * 500);
  const targetLength = randomInt(rng, 0, maxLength);
  let out = '';
  while (out.length < targetLength) out += pick(rng, ENV_VALUE_TOKENS);
  return out.slice(0, targetLength);
};

const YAML_AMBIGUOUS_POOL: readonly string[] = [
  '010',
  '0777',
  '0x1F',
  '1e3',
  '1_000',
  '.5',
  '+1',
  'true',
  'False',
  'yes',
  'on',
  '~',
  'null',
  "''",
  ':',
  '- x',
  '# x',
  '! x',
  '&a',
  '*a',
  '%x',
  '@x',
  '`x`',
  '{a}',
  '[a]',
  '  leading',
  'trailing  ',
  '---',
  '...',
];

/** The design-07 8.2 pool of scalars go-yaml (kubectl's reader) and YAML 1.2 disagree about. */
export const yamlAmbiguous: Gen<string> = (rng) => pick(rng, YAML_AMBIGUOUS_POOL);

// ---------------------------------------------------------------------------
// Compose scalars
// ---------------------------------------------------------------------------

/** 1..65535 with boundaries weighted in. */
export const port: Gen<number> = (rng) => {
  const edge = rng();
  if (edge < 0.1) return 1;
  if (edge < 0.2) return 65535;
  if (edge < 0.3) return pick(rng, [22, 80, 443, 8080, 6443, 10250]);
  return randomInt(rng, 1, 65535);
};

export interface PortSpecSample {
  target: number;
  published: number | null;
  protocol: Protocol;
  /** short compose syntax, e.g. `"8080:80"` or `"80"` */
  short: string;
  /** long compose syntax fields */
  long: Record<string, unknown>;
}

/** Structured port specs, rendered as both short and long compose syntax. */
export const portSpec: Gen<PortSpecSample> = (rng, size) => {
  const target = port(rng, size);
  const published = rng() < 0.2 ? null : port(rng, size);
  const protocolWord = pick(rng, ['tcp', 'udp', 'sctp'] as const);
  const protocol = protocolWord.toUpperCase() as Protocol;
  const short =
    published === null
      ? protocolWord === 'tcp'
        ? `${target}`
        : `${target}/${protocolWord}`
      : protocolWord === 'tcp'
        ? `${published}:${target}`
        : `${published}:${target}/${protocolWord}`;
  const long: Record<string, unknown> = { target, protocol: protocolWord };
  if (published !== null) long.published = published;
  return { target, published, protocol, short, long };
};

const DURATION_UNITS: readonly string[] = ['ns', 'us', 'µs', 'ms', 's', 'm', 'h'];

/** 1..4 components of `ns`/`us`/`µs`/`ms`/`s`/`m`/`h`, some with a decimal fraction. */
export const duration: Gen<string> = (rng) => {
  let text = '';
  for (let i = randomInt(rng, 1, 4); i > 0; i--) {
    const unit = pick(rng, DURATION_UNITS);
    const whole = randomInt(rng, 0, 999);
    const hasFraction = rng() < 0.3;
    text += hasFraction ? `${whole}.${randomInt(rng, 0, 999)}${unit}` : `${whole}${unit}`;
  }
  return text;
};

const BYTE_SUFFIXES: readonly string[] = ['', 'b', 'k', 'kb', 'm', 'mb', 'g', 'gb'];

/** integers with `b`, `k`, `kb`, `m`, `mb`, `g`, `gb` in any case. */
export const byteValue: Gen<string> = (rng) => {
  const amount = randomInt(rng, 0, 100_000);
  const suffix = pick(rng, BYTE_SUFFIXES);
  const cased = [...suffix].map((c) => (rng() < 0.5 ? c.toUpperCase() : c)).join('');
  return `${amount}${cased}`;
};

/** 0.001..64 CPUs, as a number or a string. */
export const cpus: Gen<string | number> = (rng) => {
  const milli = randomInt(rng, 1, 64_000);
  const value = milli / 1000;
  return pick(rng, [value, String(value)]);
};

function alnum(rng: Rng): string {
  return pick(rng, [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
}

const LABEL_BODY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';

function labelBody(rng: Rng, length: number): string {
  if (length <= 0) return '';
  if (length === 1) return alnum(rng);
  let mid = '';
  for (let i = 0; i < length - 2; i++) mid += LABEL_BODY_CHARS[randomInt(rng, 0, LABEL_BODY_CHARS.length - 1)];
  return `${alnum(rng)}${mid}${alnum(rng)}`;
}

/** Values valid and near-valid around the 63-character label-value limit. */
export const labelValue: Gen<string> = (rng) => labelBody(rng, pick(rng, [0, 1, 2, 30, 61, 62, 63, 64, 70]));

/** Keys valid and near-valid around the 63-character name / 253-character prefix limits. */
export const labelKey: Gen<string> = (rng) => {
  const name = labelBody(rng, pick(rng, [1, 2, 30, 61, 62, 63, 64])) || 'k';
  if (rng() < 0.4) {
    const prefix = labelBody(rng, pick(rng, [1, 20, 62, 253, 254])).toLowerCase() || 'a';
    return `${prefix}/${name}`;
  }
  return name;
};

/** semver-shaped text with pre-release and build metadata, uppercase and `_` allowed, up to 128 chars. */
export const version: Gen<string> = (rng) => {
  let v = `${randomInt(rng, 0, 99)}.${randomInt(rng, 0, 99)}.${randomInt(rng, 0, 99)}`;
  if (rng() < 0.4) v += `-${pick(rng, ['alpha', 'beta', 'rc'])}.${randomInt(rng, 0, 9)}`;
  if (rng() < 0.3) v += `+build.${randomInt(rng, 0, 9999)}`;
  if (rng() < 0.2) v = v.toUpperCase();
  if (rng() < 0.2) v += '_dev';
  if (rng() < 0.05) v = v.repeat(Math.ceil(128 / v.length) + 1).slice(0, 140);
  return v;
};

function hexDigits(rng: Rng, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += '0123456789abcdef'[randomInt(rng, 0, 15)];
  return out;
}

/** A registry host with an optional port, 1-3 path components, and a tag, digest or neither. */
export const imageRef: Gen<string> = (rng) => {
  const host = pick(rng, ['docker.io', 'registry.example.com', 'registry.example.com:5000', 'ghcr.io']);
  const segments = Array.from({ length: randomInt(rng, 1, 3) }, () => pick(rng, ['team', 'app', 'library', 'service']));
  const base = rng() < 0.7 ? `${host}/${segments.join('/')}` : segments.join('/');
  const kind = rng();
  if (kind < 0.4) return `${base}:${pick(rng, ['1.2.3', 'latest', 'v1'])}`;
  if (kind < 0.7) return `${base}@sha256:${hexDigits(rng, 64)}`;
  return base;
};

/** Nested JSON, `depth` levels deep at most, with `yamlAmbiguous` strings among the leaves. */
export function jsonValue(depth: number): Gen<unknown> {
  const leaf: Gen<unknown> = (rng, size) => {
    const kind = randomInt(rng, 0, 4);
    if (kind === 0) return yamlAmbiguous(rng, size);
    if (kind === 1) return randomInt(rng, -1000, 1000);
    if (kind === 2) return rng() < 0.5;
    if (kind === 3) return null;
    return unicodeString(rng, size);
  };
  const build = (rng: Rng, size: number, remaining: number): unknown => {
    if (remaining <= 0 || rng() < 0.3) return leaf(rng, size);
    if (rng() < 0.5) {
      return Array.from({ length: randomInt(rng, 0, 4) }, () => build(rng, size, remaining - 1));
    }
    const out: Record<string, unknown> = {};
    for (let i = 0, n = randomInt(rng, 0, 4); i < n; i++) out[`k${i}`] = build(rng, size, remaining - 1);
    return out;
  };
  return (rng, size) => build(rng, size, depth);
}

// ---------------------------------------------------------------------------
// miniStack (design-07 8.2): a small CanonicalStack built directly, never through compose
// ---------------------------------------------------------------------------

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** short, safe environment values: the property tests exercise `$` handling, not string generation cost. */
function smallEnvValue(rng: Rng): string {
  const length = randomInt(rng, 0, 12);
  let out = '';
  while (out.length < length) out += pick(rng, ENV_VALUE_TOKENS);
  return out;
}

/** node.role or node.platform.arch: the only constraints miniStack writes, both self-contained. */
function placementConstraint(rng: Rng, path: string): CanonicalService['placement']['constraints'][number] {
  if (rng() < 0.5) {
    return { attribute: 'node.role', operator: pick(rng, ['==', '!=']), value: pick(rng, ['manager', 'worker']), path };
  }
  const arch = pick(rng, Object.keys(ARCH));
  return { attribute: 'node.platform.arch', operator: pick(rng, ['==', '!=']), value: arch, path };
}

interface MiniServicePlan {
  composeName: string;
  global: boolean;
  replicas: number;
}

/**
 * One service drawn from the feature pool (ports, env, volumes, healthchecks, placement, secrets,
 * routes, x-dockflow): every feature it picks is internally consistent (a route only when the
 * stack's proxy is enabled, a mounted volume and secret declared nowhere else), so the result never
 * hits a translator precondition (T6) the normalizer would otherwise have guaranteed.
 */
function miniService(
  plan: MiniServicePlan,
  routingEnabled: boolean,
  rng: Rng,
): { service: CanonicalService; volume: CanonicalVolume | null; file: CanonicalFileSource | null } {
  const svcPath = childPath('services', plan.composeName);
  const mode = plan.global ? 'global' : 'replicated';
  const overrides: Parameters<typeof builders.canonicalService>[0] = {
    composeName: plan.composeName,
    mode,
    replicas: plan.global ? 1 : plan.replicas,
  };

  const mounts: MountSpec[] = [];
  let volume: CanonicalVolume | null = null;
  if (rng() < 0.3) {
    const key = `vol-${plan.composeName}`;
    const accessMode = pick(rng, ['ReadWriteOnce', 'ReadWriteMany'] as const);
    volume = builders.canonicalVolume({ key, accessMode, usedBy: [plan.composeName] });
    mounts.push({ type: 'volume', volume: key, target: '/data', readOnly: false, subpath: null, path: childPath(svcPath, 'volumes') });
  }

  const files: FileMountSpec[] = [];
  let file: CanonicalFileSource | null = null;
  if (rng() < 0.3) {
    const key = `sec-${plan.composeName}`;
    file = builders.canonicalFileSource({ key, role: 'app' });
    files.push({ kind: 'secret', source: key, target: `/run/secrets/${key}`, mode: 0o444, uid: null, gid: null, path: childPath(svcPath, 'secrets') });
  }

  if (rng() < 0.5) {
    const count = randomInt(rng, 1, 3);
    overrides.environment = Array.from({ length: count }, (_, i) => ({ name: `V${i}`, value: smallEnvValue(rng) })).sort((a, b) =>
      compareCodeUnits(a.name, b.name),
    );
  }

  const ports: PortSpec[] = [];
  if (rng() < 0.5) {
    const target = port(rng, 50);
    const published = rng() < 0.7 ? port(rng, 50) : null;
    const canBindHost = published !== null && (plan.global || plan.replicas <= 1) && rng() < 0.3;
    ports.push({
      target,
      published,
      protocol: 'TCP',
      mode: canBindHost ? 'host' : 'ingress',
      hostIp: null,
      name: null,
      appProtocol: null,
      path: childPath(svcPath, 'ports'),
    });
  }
  if (ports.length > 0) overrides.ports = ports;

  if (rng() < 0.4) {
    overrides.healthcheck = {
      test: rng() < 0.5 ? { type: 'exec', argv: ['CMD', 'true'] } : { type: 'shell', command: 'true' },
      intervalMs: randomInt(rng, 1000, 60_000),
      timeoutMs: randomInt(rng, 500, 30_000),
      retries: randomInt(rng, 1, 5),
      startPeriodMs: rng() < 0.5 ? 0 : randomInt(rng, 1000, 60_000),
      startIntervalMs: randomInt(rng, 1000, 10_000),
      path: childPath(svcPath, 'healthcheck'),
    };
  }

  if (rng() < 0.3) {
    overrides.placement = { constraints: [placementConstraint(rng, childPath(svcPath, 'deploy.placement.constraints'))] };
  }

  const routes: RouteSpec[] = [];
  if (routingEnabled && rng() < 0.3) {
    routes.push({
      router: `${plan.composeName}-r`,
      rule: `Host(\`${plan.composeName}.example.com\`)`,
      entryPoints: ['web'],
      tls: null,
      middlewares: [],
      priority: null,
      port: port(rng, 50),
      origin: 'labels',
      path: childPath(svcPath, 'labels'),
    });
  }
  if (routes.length > 0) overrides.routes = routes;

  if (rng() < 0.2) {
    overrides.extension = { nodeSelector: { zone: pick(rng, ['a', 'b']) } };
  } else if (rng() < 0.4) {
    overrides.extension = { fsGroup: randomInt(rng, 1, 2000) };
  } else if (rng() < 0.6) {
    overrides.extension = { publish: pick(rng, ['loadbalancer', 'hostport', 'none'] as const) };
  }

  if (mounts.length > 0) overrides.mounts = mounts.sort((a, b) => compareCodeUnits(a.target, b.target));
  if (files.length > 0) overrides.files = files.sort((a, b) => compareCodeUnits(a.target, b.target));

  return { service: builders.canonicalService(overrides), volume, file };
}

/**
 * 1..6 services drawn from the feature pool, with consistent top-level `volumes`/`files`/`proxy`
 * declarations. Every service is safe to feed straight to `translateStack`: nothing here needs a
 * normalizer precondition the translator would otherwise assume (T6).
 */
export const miniStack: Gen<CanonicalStack> = (rng, size) => {
  const count = randomInt(rng, 1, Math.max(1, Math.min(6, 1 + Math.floor(size / 20))));
  const routingEnabled = rng() < 0.5;
  const services: CanonicalService[] = [];
  const volumes: CanonicalVolume[] = [];
  const files: CanonicalFileSource[] = [];
  for (let i = 0; i < count; i++) {
    const plan: MiniServicePlan = { composeName: `svc-${i}`, global: rng() < 0.3, replicas: randomInt(rng, 0, 3) };
    const built = miniService(plan, routingEnabled, rng);
    services.push(built.service);
    if (built.volume !== null) volumes.push(built.volume);
    if (built.file !== null) files.push(built.file);
  }
  services.sort((a, b) => compareCodeUnits(a.name, b.name));
  volumes.sort((a, b) => compareCodeUnits(a.key, b.key));
  files.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.key, b.key));
  const anyRoutes = services.some((s) => s.routes.length > 0);
  return builders.canonicalStack({
    role: 'app',
    services,
    volumes,
    files,
    middlewares: [],
    proxy: routingEnabled && anyRoutes ? builders.proxyIntent() : null,
  });
};
