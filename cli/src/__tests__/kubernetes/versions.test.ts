import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { K3S_PIN } from '../../services/orchestrator/kubernetes/k3s/versions';
import {
  type CrdPropertyNode,
  MIDDLEWARE_SCHEMA,
  MIDDLEWARE_SCHEMA_SOURCE,
} from '../../services/orchestrator/kubernetes/traefik-crd-schema.generated';
import {
  HELM_PIN,
  PINNED_ARCHES,
  type PinnedDownload,
  TRAEFIK_CHART_PIN,
} from '../../services/orchestrator/kubernetes/versions';

const SHA256 = /^[0-9a-f]{64}$/;

// Helm version skew policy (helm.sh/docs/topics/version_skew, read 2026-09-19): the Kubernetes
// minors each Helm minor supports. Add the row of a new Helm minor when HELM_PIN moves to it.
const HELM_SUPPORTED_KUBERNETES: Record<string, { oldest: string; newest: string }> = {
  '4.0': { oldest: '1.31', newest: '1.34' },
  '4.1': { oldest: '1.32', newest: '1.35' },
  '4.2': { oldest: '1.33', newest: '1.36' },
  '4.3': { oldest: '1.34', newest: '1.37' },
};

// The spec properties of the pinned Middleware CRD (design-01 0, facts table).
const MIDDLEWARE_TYPES = [
  'addPrefix',
  'basicAuth',
  'buffering',
  'chain',
  'circuitBreaker',
  'compress',
  'contentType',
  'digestAuth',
  'encodedCharacters',
  'errors',
  'forwardAuth',
  'grpcWeb',
  'headers',
  'inFlightReq',
  'ipAllowList',
  'ipWhiteList',
  'passTLSClientCert',
  'plugin',
  'rateLimit',
  'redirectRegex',
  'redirectScheme',
  'replacePath',
  'replacePathRegex',
  'retry',
  'stripPrefix',
  'stripPrefixRegex',
];

function versionParts(version: string): number[] {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) throw new Error(`${version} is not a version`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function minorOf(version: string): string {
  const [major, minor] = versionParts(version);
  return `${major}.${minor}`;
}

function option(type: string, ...path: string[]): CrdPropertyNode | undefined {
  let node: CrdPropertyNode | undefined = MIDDLEWARE_SCHEMA[type];
  for (const segment of path) node = node?.properties?.[segment];
  return node;
}

const k3sDownloads: PinnedDownload[] = [K3S_PIN.installScript, ...PINNED_ARCHES.map((arch) => K3S_PIN.binaries[arch])];
const helmDownloads: PinnedDownload[] = PINNED_ARCHES.map((arch) => HELM_PIN.archives[arch]);
const chartDownload: PinnedDownload = { url: TRAEFIK_CHART_PIN.url, sha256: TRAEFIK_CHART_PIN.sha256 };

describe('U-PIN-01 pinned versions', () => {
  test('pins exist for exactly the Dockflow architectures', () => {
    expect([...PINNED_ARCHES]).toEqual(['amd64', 'arm64']);
    expect(Object.keys(K3S_PIN.binaries).sort()).toEqual([...PINNED_ARCHES]);
    expect(Object.keys(HELM_PIN.archives).sort()).toEqual([...PINNED_ARCHES]);
  });

  test('every sha256 is 64 lowercase hex and the image digest is a sha256 digest', () => {
    for (const download of [...k3sDownloads, ...helmDownloads, chartDownload]) {
      expect(download.sha256).toMatch(SHA256);
    }
    expect(TRAEFIK_CHART_PIN.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('version strings have the shape each project publishes', () => {
    expect(K3S_PIN.version).toMatch(/^v\d+\.\d+\.\d+\+k3s\d+$/);
    expect(K3S_PIN.minimumServerVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(HELM_PIN.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(TRAEFIK_CHART_PIN.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(TRAEFIK_CHART_PIN.appVersion).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test('every URL is HTTPS and embeds its version, with + written %2B', () => {
    const tag = encodeURIComponent(K3S_PIN.version);
    expect(tag).toContain('%2B');
    for (const download of [...k3sDownloads, ...helmDownloads, chartDownload]) {
      expect(download.url).toStartWith('https://');
      expect(download.url).not.toContain('+');
    }
    for (const download of k3sDownloads) expect(download.url).toContain(`/${tag}/`);
    expect(K3S_PIN.installScript.url).toEndWith(`/${tag}/install.sh`);
    expect(K3S_PIN.binaries.amd64.url).toEndWith(`/${tag}/k3s`);
    expect(K3S_PIN.binaries.arm64.url).toEndWith(`/${tag}/k3s-arm64`);
    for (const arch of PINNED_ARCHES) {
      expect(HELM_PIN.archives[arch].url).toEndWith(`/helm-${HELM_PIN.version}-linux-${arch}.tar.gz`);
    }
    expect(TRAEFIK_CHART_PIN.url).toStartWith(`${TRAEFIK_CHART_PIN.repo}/`);
    expect(TRAEFIK_CHART_PIN.url).toEndWith(`/${TRAEFIK_CHART_PIN.chart}-${TRAEFIK_CHART_PIN.version}.tgz`);
  });

  test('the minimum server version is not newer than the pinned k3s', () => {
    expect(compareVersions(K3S_PIN.minimumServerVersion, K3S_PIN.version)).toBeLessThanOrEqual(0);
  });

  test('the pinned Helm supports every Kubernetes minor from the minimum server to the k3s pin', () => {
    const helmMinor = minorOf(HELM_PIN.version);
    const supported = HELM_SUPPORTED_KUBERNETES[helmMinor];
    if (!supported) throw new Error(`Add the Helm ${helmMinor} row of the version skew page to HELM_SUPPORTED_KUBERNETES`);
    expect(compareVersions(supported.oldest, minorOf(K3S_PIN.minimumServerVersion))).toBeLessThanOrEqual(0);
    expect(compareVersions(supported.newest, minorOf(K3S_PIN.version))).toBeGreaterThanOrEqual(0);
  });

  test('vendored API schema file names match the pins (design-07 7.1)', () => {
    const directory = join(import.meta.dir, 'support', 'schema');
    const vendored = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith('.json.gz')) : [];
    for (const file of vendored) {
      if (file.startsWith('k8s-')) expect(file).toBe(`k8s-${K3S_PIN.minimumServerVersion}.json.gz`);
      else expect(file).toBe(`traefik-${TRAEFIK_CHART_PIN.version}.json.gz`);
    }
  });
});

describe('Traefik Middleware CRD property map', () => {
  test('was extracted from the pinned chart', () => {
    expect<string>(MIDDLEWARE_SCHEMA_SOURCE.chart).toBe(TRAEFIK_CHART_PIN.chart);
    expect<string>(MIDDLEWARE_SCHEMA_SOURCE.chartVersion).toBe(TRAEFIK_CHART_PIN.version);
    expect<string>(MIDDLEWARE_SCHEMA_SOURCE.chartSha256).toBe(TRAEFIK_CHART_PIN.sha256);
    expect<string>(MIDDLEWARE_SCHEMA_SOURCE.appVersion).toBe(TRAEFIK_CHART_PIN.appVersion);
    expect<string>(MIDDLEWARE_SCHEMA_SOURCE.file).toBe(`${TRAEFIK_CHART_PIN.chart}/crds/traefik.io_middlewares.yaml`);
    expect(MIDDLEWARE_SCHEMA_SOURCE.apiVersion).toBe('traefik.io/v1alpha1');
  });

  test('lists every middleware type of the CRD under its lowercase name', () => {
    expect(Object.keys(MIDDLEWARE_SCHEMA).sort()).toEqual(MIDDLEWARE_TYPES.map((type) => type.toLowerCase()).sort());
    for (const type of MIDDLEWARE_TYPES) {
      expect(MIDDLEWARE_SCHEMA[type.toLowerCase()]).toMatchObject({ canonical: type, type: 'object' });
    }
  });

  test('carries the option types label coercion depends on', () => {
    expect(option('stripprefix', 'prefixes')).toEqual({
      canonical: 'prefixes',
      type: 'array',
      items: { canonical: '', type: 'string' },
    });
    expect(option('retry', 'attempts')).toEqual({ canonical: 'attempts', type: 'integer' });
    expect(option('redirectscheme', 'permanent')).toEqual({ canonical: 'permanent', type: 'boolean' });
    expect(option('ratelimit', 'period')).toEqual({ canonical: 'period', type: 'int-or-string' });
    expect(option('ipallowlist', 'sourcerange')).toMatchObject({ canonical: 'sourceRange', type: 'array', items: { type: 'string' } });
    expect(option('errors', 'status')).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(option('buffering', 'maxrequestbodybytes')).toEqual({ canonical: 'maxRequestBodyBytes', type: 'integer' });
    expect(option('headers', 'customrequestheaders')).toEqual({
      canonical: 'customRequestHeaders',
      type: 'object',
      additionalProperties: { canonical: '', type: 'string' },
    });
    expect(option('errors', 'statusrewrites')).toMatchObject({ type: 'object', additionalProperties: { type: 'integer' } });
    const chain = option('chain', 'middlewares');
    expect(chain).toMatchObject({ canonical: 'middlewares', type: 'array', items: { type: 'object' } });
    expect(chain?.items?.properties?.name).toEqual({ canonical: 'name', type: 'string' });
    expect(option('plugin')).toEqual({ canonical: 'plugin', type: 'object', additionalProperties: { canonical: '', type: 'any' } });
  });

  test('has no users option on basicAuth or digestAuth: users labels become a Secret (design-04 2.14.1 rule 6)', () => {
    for (const type of ['basicauth', 'digestauth']) {
      expect(option(type, 'users')).toBeUndefined();
      expect(option(type, 'secret')).toEqual({ canonical: 'secret', type: 'string' });
    }
  });

  test('is a well-formed tree', () => {
    const scalar = new Set(['string', 'integer', 'number', 'boolean', 'int-or-string', 'any']);
    const check = (node: CrdPropertyNode, path: string, named: boolean): void => {
      expect(node.canonical === '', `${path} canonical`).toBe(!named);
      if (scalar.has(node.type) || node.type === 'array') expect(node.properties, `${path} properties`).toBeUndefined();
      if (scalar.has(node.type)) {
        expect(node.items, `${path} items`).toBeUndefined();
        expect(node.additionalProperties, `${path} additionalProperties`).toBeUndefined();
      }
      if (node.type === 'array') expect(node.items, `${path} items`).toBeDefined();
      if (node.type === 'object') {
        expect(node.properties !== undefined || node.additionalProperties !== undefined, `${path} has children`).toBe(true);
      }
      if (node.items) check(node.items, `${path}[]`, false);
      if (node.additionalProperties) check(node.additionalProperties, `${path}{}`, false);
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        expect(key, `${path}.${key}`).toBe(child.canonical.toLowerCase());
        check(child, `${path}.${child.canonical}`, true);
      }
    };
    for (const [key, node] of Object.entries(MIDDLEWARE_SCHEMA)) {
      expect(key).toBe(node.canonical.toLowerCase());
      check(node, node.canonical, true);
    }
  });
});
