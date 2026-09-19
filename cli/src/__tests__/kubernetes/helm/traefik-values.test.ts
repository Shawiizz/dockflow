import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse, parseAllDocuments } from 'yaml';
import type { DistributionTraits } from '../../../services/orchestrator/kubernetes/distribution';
import {
  buildTraefikValues,
  type ControlPlaneNodeFact,
  type CustomResourceDefinition,
  controlPlaneNodeFacts,
  filterTraefikCrds,
  intentCapabilities,
  labelTraefikCrds,
  type PlacementInput,
  type PlacementResult,
  planCrdApply,
  proxyHostPorts,
  proxyRefusalError,
  pvNodeHostname,
  resolvePlacement,
  runningTraefikNode,
  TRAEFIK_RUN_AS,
  TRAEFIK_VALUES_GOLDEN_SHA256,
  TRAEFIK_VALUES_REVISION,
  type TraefikIntent,
  traefikDeploymentFact,
  traefikIntentFrom,
  traefikPodFacts,
} from '../../../services/orchestrator/kubernetes/helm/traefik-values';
import type { Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { Node, PersistentVolume, Pod } from '../../../services/orchestrator/kubernetes/resources/core';
import type { ProxyConfig } from '../../../utils/config';
import { ConfigError, DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';

/** the pin shape, spelled out below instead of reading the real pin: goldens must not move with it */
type TraefikChartPin = NonNullable<Parameters<typeof buildTraefikValues>[3]>;

// ---------------------------------------------------------------------------
// Fixtures of design-04 2.4: traits dockflow-local + control-plane label, node `main`
// ---------------------------------------------------------------------------

const PIN: TraefikChartPin = {
  chart: 'traefik',
  repo: 'https://traefik.github.io/charts',
  version: '41.6.0',
  url: 'https://traefik.github.io/charts/traefik/traefik-41.6.0.tgz',
  sha256: 'cd7254ea853da73bdb88edc896f079b88d43ffa0bfe699fdbf21081361eac365',
  appVersion: 'v3.7.13',
};
const IMAGE_DIGEST = 'sha256:f86a2cab1b5c649070c49f883c743dd32d8485a56e3368c5f93b9e91f1e91259';
const DIGEST_PIN: TraefikChartPin = { ...PIN, imageDigest: IMAGE_DIGEST };

const TRAITS: DistributionTraits = {
  name: 'k3s',
  defaultStorageClass: 'dockflow-local',
  defaultStorageClassAccessModes: ['ReadWriteOnce'],
  controlPlaneNodeLabel: { key: 'node-role.kubernetes.io/control-plane', value: 'true' },
  loadBalancerNodePorts: false,
  clusterDnsNameservers: 1,
  helperImage: 'registry.example.com/helper:1',
  imageStoreRoot: '/var/lib/images',
  headlessServiceNeedsPort: true,
  headlessPlaceholderPort: { port: 9, protocol: 'TCP' },
  reservedHostPorts: [],
};
const PLACEMENT = { hostname: 'main' };
const CA_BUNDLE = '-----BEGIN CERTIFICATE-----\nZG9ja2Zsb3cgdGVzdCBDQSBidW5kbGUgZm9yIHRoZSBwcm94eSB2YWx1ZXMgZ29sZGVu\n-----END CERTIFICATE-----\n';

const ACME_DASHBOARD: ProxyConfig = { enabled: true, email: 'ops@example.com', dashboard: { enabled: true, domain: 'traefik.example.com' } };

/** The goldens under backends/proxy-values (design-04 2.4, design-07 10.3 U-BE-PROXY-04/12). */
const GOLDEN_CASES: Record<string, { proxy: ProxyConfig; bundle?: string; pin: TraefikChartPin }> = {
  'acme-dashboard': { proxy: ACME_DASHBOARD, pin: PIN },
  'acme-digest': { proxy: ACME_DASHBOARD, pin: DIGEST_PIN },
  'acme-private-ca': {
    proxy: { ...ACME_DASHBOARD, acme_ca_server: 'https://ca.example.com:14000/dir', acme_ca_bundle: '.dockflow/acme-ca.pem' },
    bundle: CA_BUNDLE,
    pin: PIN,
  },
  'acme-staging': { proxy: { enabled: true, email: 'ops@example.com', acme_ca_server: 'https://acme-staging-v02.api.letsencrypt.org/directory' }, pin: PIN },
  'http-only': { proxy: { enabled: true, acme: false }, pin: PIN },
  'http-dashboard': { proxy: { enabled: true, acme: false, dashboard: { enabled: true, domain: 'traefik.internal.example.com' } }, pin: PIN },
  'default-class': { proxy: { enabled: true, acme: false, default_ingress_class: true }, pin: PIN },
};

const GOLDEN_DIR = join(import.meta.dir, '..', 'backends', 'proxy-values');

function goldenFiles(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
}

function readGolden(file: string): unknown {
  return parse(readFileSync(join(GOLDEN_DIR, file), 'utf8'));
}

function caseValues(name: string): Record<string, unknown> {
  const spec = GOLDEN_CASES[name];
  return buildTraefikValues(traefikIntentFrom(spec.proxy, spec.bundle ?? null), TRAITS, PLACEMENT, spec.pin);
}

function at(values: unknown, ...path: string[]): unknown {
  let node = values;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function intent(overrides: Partial<TraefikIntent> = {}): TraefikIntent {
  return {
    acme: true,
    email: 'ops@example.com',
    caServer: null,
    caBundle: null,
    dashboard: { enabled: false, domain: null },
    defaultIngressClass: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// traefikIntentFrom / intentCapabilities (2.3.2)
// ---------------------------------------------------------------------------

describe('traefikIntentFrom', () => {
  test('ACME is on by default and nothing optional is set', () => {
    expect(traefikIntentFrom({ enabled: true, email: 'ops@example.com' }, null)).toEqual(intent());
  });

  test('a managing ACME stack without e-mail is refused with the exact ConfigError', () => {
    let error: unknown;
    try {
      traefikIntentFrom({ enabled: true }, null);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe('proxy.email is required when this stack manages Traefik with ACME');
    expect((error as ConfigError).suggestion).toBe(
      'Set `proxy.email`, set `proxy.acme: false` for HTTP-only routing, or set `proxy.manage: false` to use the Traefik another stack manages.',
    );
  });

  test('a consuming stack needs no e-mail and never carries one', () => {
    expect(traefikIntentFrom({ enabled: true, manage: false }, null).email).toBeNull();
    expect(traefikIntentFrom({ enabled: true, manage: false, email: 'ops@example.com' }, null).email).toBeNull();
  });

  test('acme: false ignores the e-mail and the CA settings', () => {
    const result = traefikIntentFrom({ enabled: true, acme: false, email: 'ops@example.com', acme_ca_server: 'https://ca.example.com/dir' }, CA_BUNDLE);
    expect(result).toEqual(intent({ acme: false, email: null }));
  });

  test('the CA bundle only applies with a custom CA server', () => {
    expect(traefikIntentFrom({ enabled: true, email: 'ops@example.com' }, CA_BUNDLE).caBundle).toBeNull();
    const custom = traefikIntentFrom({ enabled: true, email: 'ops@example.com', acme_ca_server: 'https://ca.example.com/dir' }, CA_BUNDLE);
    expect(custom.caServer).toBe('https://ca.example.com/dir');
    expect(custom.caBundle).toBe(CA_BUNDLE);
  });

  test('a disabled dashboard has no domain, an enabled one is lowercased', () => {
    expect(traefikIntentFrom({ enabled: true, email: 'a@example.com', dashboard: { enabled: false, domain: 'x.example.com' } }, null).dashboard).toEqual({
      enabled: false,
      domain: null,
    });
    expect(traefikIntentFrom({ enabled: true, email: 'a@example.com', dashboard: { enabled: true, domain: 'Traefik.Example.COM' } }, null).dashboard).toEqual({
      enabled: true,
      domain: 'traefik.example.com',
    });
  });

  test('proxy.default_ingress_class is false unless set to true', () => {
    expect(traefikIntentFrom({ enabled: true, acme: false }, null).defaultIngressClass).toBe(false);
    expect(traefikIntentFrom({ enabled: true, acme: false, default_ingress_class: true }, null).defaultIngressClass).toBe(true);
  });

  const tooLong = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'b'.repeat(62)}`;
  test.each([
    ['https://x.example.com'],
    ['x.example.com:8080'],
    ['x.example.com/p'],
    ['*.example.com'],
    ['x`.example.com'],
    ['x .example.com'],
    [tooLong],
    [''],
  ])('dashboard domain %p is refused', (domain) => {
    expect(tooLong.length).toBe(254);
    let error: unknown;
    try {
      traefikIntentFrom({ enabled: true, acme: false, dashboard: { enabled: true, domain } }, null);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(`proxy.dashboard.domain "${domain}" is not a valid host name`);
    expect((error as ConfigError).suggestion).toBe('Use a DNS name such as `traefik.example.com`, without scheme, port, path or wildcard.');
  });

  test('a 253-character host name is accepted', () => {
    const name = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'b'.repeat(61)}`;
    expect(name.length).toBe(253);
    expect(traefikIntentFrom({ enabled: true, acme: false, dashboard: { enabled: true, domain: name } }, null).dashboard.domain).toBe(name);
  });
});

describe('intentCapabilities', () => {
  test('projects what a consuming stack can depend on', () => {
    expect(intentCapabilities(intent({ dashboard: { enabled: true, domain: 'traefik.example.com' } }))).toEqual({
      acme: true,
      redirectToHttps: true,
      dashboard: true,
      defaultIngressClass: false,
    });
    expect(intentCapabilities(intent({ acme: false, email: null, defaultIngressClass: true }))).toEqual({
      acme: false,
      redirectToHttps: false,
      dashboard: false,
      defaultIngressClass: true,
    });
  });

  test('proxyHostPorts: 443 only with ACME', () => {
    expect(proxyHostPorts(true)).toEqual([80, 443]);
    expect(proxyHostPorts(false)).toEqual([80]);
  });
});

// ---------------------------------------------------------------------------
// buildTraefikValues (2.4) and the values goldens
// ---------------------------------------------------------------------------

describe('buildTraefikValues goldens', () => {
  test('every golden file has a case and every case a golden file', () => {
    expect(goldenFiles()).toEqual(
      Object.keys(GOLDEN_CASES)
        .map((name) => `${name}.yaml`)
        .sort(),
    );
  });

  test.each(Object.keys(GOLDEN_CASES))('%s matches its golden (canonical JSON)', (name) => {
    expect(canonicalJson(caseValues(name))).toBe(canonicalJson(readGolden(`${name}.yaml`)));
  });

  test('the goldens are the ones recorded for TRAEFIK_VALUES_REVISION', () => {
    const digest = sha256Hex(goldenFiles().map((file) => `${file}\n${canonicalJson(readGolden(file))}`).join('\n'));
    // A different output needs new goldens, this digest AND a TRAEFIK_VALUES_REVISION bump, or
    // deployed proxies never learn that their values changed (design-04 2.8.1).
    expect({ revision: TRAEFIK_VALUES_REVISION, digest }).toEqual({ revision: 3, digest: TRAEFIK_VALUES_GOLDEN_SHA256 });
  });
});

describe('buildTraefikValues', () => {
  test('is deterministic, whatever the key order of proxy config', () => {
    const shuffled: ProxyConfig = {
      dashboard: { domain: 'traefik.example.com', enabled: true },
      email: 'ops@example.com',
      enabled: true,
    };
    const first = caseValues('acme-dashboard');
    expect(canonicalJson(caseValues('acme-dashboard'))).toBe(canonicalJson(first));
    expect(canonicalJson(buildTraefikValues(traefikIntentFrom(shuffled, null), TRAITS, PLACEMENT, PIN))).toBe(canonicalJson(first));
  });

  test('traits drive the storage class and the control-plane label, placement the hostname', () => {
    const traits: DistributionTraits = { ...TRAITS, defaultStorageClass: 'fast-local', controlPlaneNodeLabel: { key: 'node.example.com/server', value: 'yes' } };
    const values = buildTraefikValues(intent(), traits, { hostname: 'server-2' }, PIN);
    expect(at(values, 'persistence', 'storageClass')).toBe('fast-local');
    expect(at(values, 'nodeSelector')).toEqual({ 'node.example.com/server': 'yes', 'kubernetes.io/hostname': 'server-2' });
    expect(at(values, 'tolerations')).toEqual([
      { key: 'node.example.com/server', operator: 'Exists', effect: 'NoSchedule' },
      { key: 'CriticalAddonsOnly', operator: 'Exists' },
    ]);
  });

  test.each(Object.keys(GOLDEN_CASES))('%s: one Recreate replica with requests, a memory limit, TLS on websecure and no extra arguments', (name) => {
    const values = caseValues(name);
    expect(at(values, 'resources')).toEqual({ requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } });
    expect(at(values, 'ports', 'websecure', 'http', 'tls', 'enabled')).toBe(true);
    expect(at(values, 'deployment', 'replicas')).toBe(1);
    expect(at(values, 'updateStrategy')).toEqual({ type: 'Recreate' });
    expect(values.additionalArguments).toBeUndefined();
    expect(at(values, 'priorityClassName')).toBe('system-cluster-critical');
  });

  test('IngressClass traefik is the cluster default only on opt-in', () => {
    expect(at(caseValues('http-only'), 'ingressClass')).toEqual({ enabled: true, isDefaultClass: false, name: 'traefik' });
    expect(at(caseValues('acme-dashboard'), 'ingressClass', 'isDefaultClass')).toBe(false);
    expect(at(caseValues('default-class'), 'ingressClass', 'isDefaultClass')).toBe(true);
    // nothing else changes with the opt-in
    const optIn = caseValues('default-class');
    (optIn.ingressClass as Record<string, unknown>).isDefaultClass = false;
    expect(canonicalJson(optIn)).toBe(canonicalJson(caseValues('http-only')));
  });

  test('443, the redirect at priority 1, persistence, the resolver, fsGroup and the init container exist only with ACME', () => {
    const acme = caseValues('acme-dashboard');
    expect(at(acme, 'ports', 'websecure', 'hostPort')).toBe(443);
    expect(at(acme, 'ports', 'websecure', 'expose', 'default')).toBe(true);
    expect(at(acme, 'ports', 'web', 'http', 'redirections', 'entryPoint')).toEqual({ to: 'websecure', scheme: 'https', permanent: true, priority: 1 });
    expect(at(acme, 'persistence')).toEqual({
      enabled: true,
      name: 'data',
      accessMode: 'ReadWriteOnce',
      size: '128Mi',
      storageClass: 'dockflow-local',
      path: '/data',
    });
    expect(at(acme, 'certificatesResolvers', 'letsencrypt', 'acme')).toEqual({
      email: 'ops@example.com',
      storage: '/data/acme.json',
      httpChallenge: { entryPoint: 'web' },
    });
    expect(at(acme, 'podSecurityContext')).toEqual({ fsGroup: TRAEFIK_RUN_AS, fsGroupChangePolicy: 'OnRootMismatch' });
    expect(at(acme, 'deployment', 'initContainers')).toHaveLength(1);

    const http = caseValues('http-only');
    expect(at(http, 'ports', 'websecure', 'hostPort')).toBeUndefined();
    expect(at(http, 'ports', 'websecure', 'expose', 'default')).toBe(false);
    expect(at(http, 'ports', 'web', 'http')).toBeUndefined();
    expect(at(http, 'persistence')).toEqual({ enabled: false });
    expect(at(http, 'certificatesResolvers')).toBeUndefined();
    expect(at(http, 'podSecurityContext')).toBeUndefined();
    expect(at(http, 'deployment')).toEqual({ kind: 'Deployment', replicas: 1 });
  });

  test('the dashboard route follows ACME: websecure with the resolver, or web', () => {
    expect(at(caseValues('acme-dashboard'), 'ingressRoute', 'dashboard')).toEqual({
      enabled: true,
      matchRule: 'Host(`traefik.example.com`)',
      entryPoints: ['websecure'],
      tls: { certResolver: 'letsencrypt' },
    });
    expect(at(caseValues('http-dashboard'), 'ingressRoute', 'dashboard')).toEqual({
      enabled: true,
      matchRule: 'Host(`traefik.internal.example.com`)',
      entryPoints: ['web'],
    });
    expect(at(caseValues('http-dashboard'), 'api', 'dashboard')).toBe(true);
    expect(at(caseValues('http-only'), 'api', 'dashboard')).toBe(false);
  });

  test('caServer only when proxy.acme_ca_server is set', () => {
    expect(at(caseValues('acme-dashboard'), 'certificatesResolvers', 'letsencrypt', 'acme', 'caServer')).toBeUndefined();
    expect(at(caseValues('acme-staging'), 'certificatesResolvers', 'letsencrypt', 'acme', 'caServer')).toBe(
      'https://acme-staging-v02.api.letsencrypt.org/directory',
    );
  });

  test('a CA bundle adds the Secret volume named by its checksum and the lego variables, never the PEM text', () => {
    const values = caseValues('acme-private-ca');
    const secret = `dockflow-traefik-acme-ca-${sha256Hex(CA_BUNDLE).slice(0, 8)}`;
    expect(at(values, 'volumes')).toEqual([{ name: secret, mountPath: '/etc/dockflow/acme-ca', type: 'secret' }]);
    expect(at(values, 'env')).toEqual([
      { name: 'LEGO_CA_CERTIFICATES', value: '/etc/dockflow/acme-ca/ca.crt' },
      { name: 'LEGO_CA_SYSTEM_CERT_POOL', value: 'true' },
    ]);
    expect(canonicalJson(values)).not.toContain('BEGIN CERTIFICATE');
    expect(at(caseValues('acme-staging'), 'volumes')).toBeUndefined();
    expect(at(caseValues('acme-staging'), 'env')).toBeUndefined();

    const other = buildTraefikValues(intent({ caServer: 'https://ca.example.com:14000/dir', caBundle: `${CA_BUNDLE}\n` }), TRAITS, PLACEMENT, PIN);
    expect(at(other, 'volumes')).not.toEqual(at(values, 'volumes'));
  });

  test('an image digest in the pin sets image.digest and pins the init container image', () => {
    expect(at(caseValues('acme-dashboard'), 'image')).toEqual({ registry: 'docker.io', repository: 'traefik', tag: 'v3.7.13' });
    const values = caseValues('acme-digest');
    expect(at(values, 'image')).toEqual({ registry: 'docker.io', repository: 'traefik', tag: 'v3.7.13', digest: IMAGE_DIGEST });
    const init = (at(values, 'deployment', 'initContainers') as Record<string, unknown>[])[0];
    expect(init.image).toBe(`docker.io/traefik@${IMAGE_DIGEST}`);
    expect((at(caseValues('acme-dashboard'), 'deployment', 'initContainers') as Record<string, unknown>[])[0].image).toBe('docker.io/traefik:v3.7.13');
  });
});

// ---------------------------------------------------------------------------
// resolvePlacement (2.4.1)
// ---------------------------------------------------------------------------

const node = (hostname: string, state: Partial<ControlPlaneNodeFact> = {}): ControlPlaneNodeFact => ({ hostname, ready: true, schedulable: true, ...state });

function placement(overrides: Partial<PlacementInput>): ReturnType<typeof resolvePlacement> {
  return resolvePlacement({
    acme: false,
    acmeVolumeHostname: null,
    recordedHostname: null,
    runningHostname: null,
    controlPlaneNodes: [node('main'), node('server-2'), node('server-3')],
    managers: ['main', 'server-2', 'server-3'],
    env: 'production',
    ...overrides,
  });
}

describe('resolvePlacement', () => {
  test('row 0a: an ACME claim pins Traefik to its node, whatever the record says', () => {
    expect(placement({ acme: true, acmeVolumeHostname: 'server-2', recordedHostname: 'server-2' })).toEqual({ kind: 'ok', hostname: 'server-2', warnings: [] });
    expect(placement({ acme: true, acmeVolumeHostname: 'server-2', recordedHostname: 'main' })).toEqual({
      kind: 'ok',
      hostname: 'server-2',
      warnings: [
        {
          code: 'W-PX-NODE-MOVED',
          message: 'Traefik moves from main to server-2, which is the node that answers ports 80 and 443 from now on',
          suggestion: 'Point the DNS records of this environment at server-2 before the deploy finishes.',
        },
      ],
    });
  });

  test('row 0a on a cordoned or NotReady node warns but stays', () => {
    const cordoned = placement({ acme: true, acmeVolumeHostname: 'server-2', controlPlaneNodes: [node('main'), node('server-2', { schedulable: false })] });
    expect(cordoned).toEqual({
      kind: 'ok',
      hostname: 'server-2',
      warnings: [
        {
          code: 'W-PX-NODE-NOTREADY',
          message: 'The node that runs Traefik, server-2, is cordoned, so ports 80 and 443 may answer nowhere',
          suggestion: 'Bring server-2 back, or remove it from `servers.yml` and deploy again to move Traefik.',
        },
      ],
    });
    const down = placement({ acme: true, acmeVolumeHostname: 'server-2', controlPlaneNodes: [node('server-2', { ready: false, schedulable: false })] });
    expect(down.kind === 'ok' && down.warnings[0].message).toBe('The node that runs Traefik, server-2, is not Ready, so ports 80 and 443 may answer nowhere');
  });

  test('row 0b: an ACME claim on a node gone from the cluster is refused', () => {
    expect(placement({ acme: true, acmeVolumeHostname: 'old-node', recordedHostname: 'old-node' })).toEqual({
      kind: 'refuse',
      refusal: {
        code: 'E-PX-ACME-NODE-LOST',
        errorCode: ErrorCode.DEPLOY_FAILED,
        message: "Traefik's ACME volume dockflow-traefik is bound to node old-node, which is no longer in the cluster, so Traefik cannot start on any other node",
        suggestion:
          'Follow the lost-node steps printed by `dockflow helm status production --system`: `dockflow helm uninstall production --system --volumes --force`, then deploy again and restore acme.json from a backup.',
      },
    });
  });

  test('the ACME claim is ignored when ACME is off', () => {
    expect(placement({ acme: false, acmeVolumeHostname: 'old-node', recordedHostname: 'server-3' })).toEqual({ kind: 'ok', hostname: 'server-3', warnings: [] });
  });

  test('row 1: the recorded node stays, with a warning when it is not ready', () => {
    expect(placement({ recordedHostname: 'server-3' })).toEqual({ kind: 'ok', hostname: 'server-3', warnings: [] });
    const result = placement({ recordedHostname: 'server-3', controlPlaneNodes: [node('main'), node('server-3', { ready: false })] });
    expect(result.kind === 'ok' && result.hostname).toBe('server-3');
    expect(result.kind === 'ok' && result.warnings.map((w) => w.code)).toEqual(['W-PX-NODE-NOTREADY']);
  });

  test('row 1 keeps the recorded node even when another pod runs elsewhere (drift is planProxy business)', () => {
    expect(placement({ recordedHostname: 'server-3', runningHostname: 'main' })).toEqual({ kind: 'ok', hostname: 'server-3', warnings: [] });
  });

  test('row 2: a recorded node gone from the cluster or from servers.yml moves to the first ready schedulable manager', () => {
    const nodes = [node('main', { ready: false }), node('server-2', { schedulable: false }), node('server-3')];
    expect(placement({ recordedHostname: 'old-node', controlPlaneNodes: nodes })).toEqual({
      kind: 'ok',
      hostname: 'server-3',
      warnings: [
        {
          code: 'W-PX-NODE-MOVED',
          message: 'Traefik moves from old-node to server-3, which is the node that answers ports 80 and 443 from now on',
          suggestion: 'Point the DNS records of this environment at server-3 before the deploy finishes.',
        },
      ],
    });
    // still in the cluster but removed from servers.yml
    const removed = placement({ recordedHostname: 'server-3', managers: ['main', 'server-2'] });
    expect(removed.kind === 'ok' && removed.hostname).toBe('main');
    expect(removed.kind === 'ok' && removed.warnings.map((w) => w.code)).toEqual(['W-PX-NODE-MOVED']);
  });

  test('row 3: without a record, the node of the running pod is adopted', () => {
    expect(placement({ runningHostname: 'server-2' })).toEqual({ kind: 'ok', hostname: 'server-2', warnings: [] });
  });

  test('row 4: servers.yml order decides, skipping NotReady, cordoned and unknown managers', () => {
    expect(placement({})).toEqual({ kind: 'ok', hostname: 'main', warnings: [] });
    expect(placement({ managers: ['server-3', 'main'] })).toEqual({ kind: 'ok', hostname: 'server-3', warnings: [] });
    const nodes = [node('main', { ready: false }), node('server-2', { schedulable: false }), node('server-3')];
    expect(placement({ controlPlaneNodes: nodes, managers: ['ghost', 'main', 'server-2', 'server-3'] })).toEqual({ kind: 'ok', hostname: 'server-3', warnings: [] });
  });

  test('row 5: no candidate is refused with E-PX-NO-NODE (rows 2 and 4)', () => {
    const refusal: PlacementResult = {
      kind: 'refuse',
      refusal: {
        code: 'E-PX-NO-NODE',
        errorCode: ErrorCode.DEPLOY_FAILED,
        message: 'No control-plane node of production is ready and schedulable to run Traefik',
        suggestion: 'Check the cluster with `dockflow diagnose production`, then deploy again.',
      },
    };
    const nodes = [node('main', { ready: false }), node('server-2', { schedulable: false })];
    expect(placement({ controlPlaneNodes: nodes })).toEqual(refusal);
    expect(placement({ controlPlaneNodes: nodes, recordedHostname: 'old-node' })).toEqual(refusal);
  });
});

describe('observation facts', () => {
  test('controlPlaneNodeFacts: hostname label, Ready condition, cordon', () => {
    const nodes: Node[] = [
      {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name: 'main', labels: { 'kubernetes.io/hostname': 'main' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      },
      {
        apiVersion: 'v1',
        kind: 'Node',
        metadata: { name: 'server-2' },
        spec: { unschedulable: true },
        status: { conditions: [{ type: 'Ready', status: 'Unknown' }] },
      },
    ];
    expect(controlPlaneNodeFacts(nodes)).toEqual([
      { hostname: 'main', ready: true, schedulable: true },
      { hostname: 'server-2', ready: false, schedulable: false },
    ]);
  });

  test('pvNodeHostname: the single hostname In value, null otherwise', () => {
    const pv = (values: string[], key = 'kubernetes.io/hostname'): PersistentVolume => ({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: { name: 'pvc-1' },
      spec: { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key, operator: 'In', values }] }] } } },
    });
    expect(pvNodeHostname(pv(['server-2']))).toBe('server-2');
    expect(pvNodeHostname(pv(['a', 'b']))).toBeNull();
    expect(pvNodeHostname(pv(['server-2'], 'topology.kubernetes.io/zone'))).toBeNull();
    expect(pvNodeHostname({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'pvc-2' } })).toBeNull();
    expect(pvNodeHostname(null)).toBeNull();
  });

  test('traefikDeploymentFact: replicas default 1, ready default 0, null when missing', () => {
    const deployment = (spec: Partial<Deployment['spec']>, status?: Deployment['status']): Deployment => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'dockflow-traefik' },
      spec: { selector: {}, template: { metadata: {}, spec: { containers: [] } }, ...spec },
      status,
    });
    expect(traefikDeploymentFact(deployment({}))).toEqual({ replicas: 1, readyReplicas: 0 });
    expect(traefikDeploymentFact(deployment({ replicas: 0 }, { readyReplicas: 0 }))).toEqual({ replicas: 0, readyReplicas: 0 });
    expect(traefikDeploymentFact(deployment({ replicas: 1 }, { readyReplicas: 1 }))).toEqual({ replicas: 1, readyReplicas: 1 });
    expect(traefikDeploymentFact(null)).toBeNull();
  });

  test('traefikPodFacts and runningTraefikNode', () => {
    const pod = (name: string, nodeName: string | undefined, phase: 'Pending' | 'Running', waiting?: string): Pod => ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name, namespace: 'dockflow-system' },
      spec: { containers: [], ...(nodeName ? { nodeName } : {}) },
      status: {
        phase,
        conditions: [{ type: 'Ready', status: phase === 'Running' && !waiting ? 'True' : 'False' }],
        containerStatuses: waiting ? [{ name: 'traefik', ready: false, restartCount: 3, image: 'traefik', state: { waiting: { reason: waiting } } }] : [],
      },
    });
    const facts = traefikPodFacts([pod('a', undefined, 'Pending'), pod('b', 'server-2', 'Running', 'CrashLoopBackOff'), pod('c', 'main', 'Running')]);
    expect(facts).toEqual([
      { name: 'a', node: null, phase: 'Pending', ready: false, status: 'Pending' },
      { name: 'b', node: 'server-2', phase: 'Running', ready: false, status: 'CrashLoopBackOff' },
      { name: 'c', node: 'main', phase: 'Running', ready: true, status: 'Running' },
    ]);
    expect(runningTraefikNode(facts)).toBe('server-2');
    expect(runningTraefikNode(facts.slice(0, 1))).toBeNull();
    expect(traefikPodFacts([pod('c', 'main', 'Running')], () => 'custom')[0].status).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// CRDs (2.5)
// ---------------------------------------------------------------------------

const TRAEFIK_CRD_NAMES = [
  'ingressroutes',
  'ingressroutetcps',
  'ingressrouteudps',
  'middlewares',
  'middlewaretcps',
  'serverstransports',
  'serverstransporttcps',
  'tlsoptions',
  'tlsstores',
  'traefikservices',
];

function crdYaml(plural: string, group: string): string {
  return [
    '---',
    `# Source: traefik/crds/${group}_${plural}.yaml`,
    'apiVersion: apiextensions.k8s.io/v1',
    'kind: CustomResourceDefinition',
    'metadata:',
    `  name: ${plural}.${group}`,
    '  annotations:',
    '    controller-gen.kubebuilder.io/version: v0.16.1',
    'spec:',
    `  group: ${group}`,
    '  names:',
    `    plural: ${plural}`,
    '  scope: Namespaced',
  ].join('\n');
}

/** Shape of `helm show crds` for chart 41.6.0: traefik.io, hub.traefik.io and Gateway API documents. */
const SHOW_CRDS = [
  ...TRAEFIK_CRD_NAMES.map((plural) => crdYaml(plural, 'traefik.io')),
  crdYaml('apis', 'hub.traefik.io'),
  crdYaml('accesscontrolpolicies', 'hub.traefik.io'),
  crdYaml('httproutes', 'gateway.networking.k8s.io'),
  '---',
  '# empty document',
  '---',
  'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: not-a-crd\n  namespace: default\nspec:\n  group: traefik.io',
].join('\n');

const crdDocs = (text: string): unknown[] => parseAllDocuments(text).map((doc) => doc.toJS());

describe('filterTraefikCrds', () => {
  test('keeps the 10 CustomResourceDefinitions of group traefik.io', () => {
    const crds = filterTraefikCrds(crdDocs(SHOW_CRDS), '41.6.0');
    expect(crds.map((crd) => crd.metadata.name)).toEqual(TRAEFIK_CRD_NAMES.map((plural) => `${plural}.traefik.io`));
    expect(crds.every((crd) => crd.spec.group === 'traefik.io')).toBe(true);
  });

  test('a chart with no traefik.io CRD is a broken pin', () => {
    let error: unknown;
    try {
      filterTraefikCrds(crdDocs(crdYaml('apis', 'hub.traefik.io')), '41.6.0');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeployError);
    expect((error as DeployError).message).toBe('Traefik chart 41.6.0 contains no traefik.io CRDs; the pin is broken');
  });

  test('labelTraefikCrds adds ownership labels and the pin annotations without touching its input', () => {
    const [crd] = filterTraefikCrds(crdDocs(crdYaml('middlewares', 'traefik.io')));
    const [labelled] = labelTraefikCrds([crd], PIN);
    expect(labelled.metadata.labels).toEqual({ 'app.kubernetes.io/managed-by': 'dockflow', 'dockflow.shawiizz.dev/part': 'system' });
    expect(labelled.metadata.annotations).toEqual({
      'controller-gen.kubebuilder.io/version': 'v0.16.1',
      'dockflow.shawiizz.dev/chart-version': '41.6.0',
      'dockflow.shawiizz.dev/traefik-version': 'v3.7.13',
    });
    expect(crd.metadata.labels).toBeUndefined();
    expect(labelled.spec).toEqual(crd.spec);
  });
});

describe('planCrdApply', () => {
  const installed = (name: string, meta: { version?: string; managedBy?: string }): CustomResourceDefinition => ({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name,
      ...(meta.managedBy ? { labels: { 'app.kubernetes.io/managed-by': meta.managedBy } } : {}),
      ...(meta.version ? { annotations: { 'dockflow.shawiizz.dev/chart-version': meta.version } } : {}),
    },
    spec: { group: 'traefik.io' },
  });
  const both = (meta: { version?: string; managedBy?: string }) => [installed('ingressroutes.traefik.io', meta), installed('middlewares.traefik.io', meta)];

  test('absent CRDs are applied', () => {
    expect(planCrdApply([], 'shop-production', PIN)).toEqual({ action: 'apply' });
  });

  test('CRDs from the same or an older pin are applied', () => {
    expect(planCrdApply(both({ version: '41.6.0', managedBy: 'dockflow' }), 'shop-production', PIN)).toEqual({ action: 'apply' });
    expect(planCrdApply(both({ version: '39.0.1', managedBy: 'dockflow' }), 'shop-production', PIN)).toEqual({ action: 'apply' });
  });

  test('CRDs from a newer pin are kept, with W-PX-CRDS-NEWER', () => {
    expect(planCrdApply(both({ version: '42.0.0', managedBy: 'dockflow' }), 'shop-production', PIN)).toEqual({
      action: 'skip',
      warning: {
        code: 'W-PX-CRDS-NEWER',
        message: 'The traefik.io CRDs on this cluster come from chart 42.0.0, which is newer than this Dockflow release (41.6.0), so they are left unchanged',
        suggestion: 'Upgrade the Dockflow CLI used for shop-production.',
      },
    });
  });

  test('unannotated CRDs are applied when Dockflow labelled them, refused otherwise', () => {
    expect(planCrdApply(both({ managedBy: 'dockflow' }), 'shop-production', PIN)).toEqual({ action: 'apply' });
    expect(planCrdApply(both({ managedBy: 'Helm' }), 'shop-production', PIN)).toEqual({
      action: 'refuse',
      refusal: {
        code: 'E-PX-CRDS-FOREIGN',
        errorCode: ErrorCode.VALIDATION_FAILED,
        message: 'The traefik.io CRDs on this cluster were installed by Helm, and Dockflow will not overwrite CRDs it does not own',
        suggestion: 'Let that installation own the proxy and set `proxy.manage: false` here, or remove its CRDs before deploying.',
      },
    });
    const anonymous = planCrdApply(both({}), 'shop-production', PIN);
    expect(anonymous.action === 'refuse' && anonymous.refusal.message).toBe(
      'The traefik.io CRDs on this cluster were installed by another tool, and Dockflow will not overwrite CRDs it does not own',
    );
  });

  test('when the two CRDs disagree, the lower state wins', () => {
    // one newer, one older: the apply repairs the older one
    expect(
      planCrdApply([installed('ingressroutes.traefik.io', { version: '42.0.0' }), installed('middlewares.traefik.io', { version: '40.0.0' })], 'shop-production', PIN),
    ).toEqual({ action: 'apply' });
    // one newer, one missing: repaired by the apply
    expect(planCrdApply([installed('ingressroutes.traefik.io', { version: '42.0.0' })], 'shop-production', PIN)).toEqual({ action: 'apply' });
    // one foreign: refused
    expect(
      planCrdApply([installed('ingressroutes.traefik.io', { version: '41.6.0' }), installed('middlewares.traefik.io', { managedBy: 'Helm' })], 'shop-production', PIN).action,
    ).toBe('refuse');
    // both newer: the lower of the two is named
    const newer = planCrdApply(
      [installed('ingressroutes.traefik.io', { version: '43.1.0' }), installed('middlewares.traefik.io', { version: '42.0.0' })],
      'shop-production',
      PIN,
    );
    expect(newer.action === 'skip' && newer.warning.message).toContain('come from chart 42.0.0');
  });

  test('proxyRefusalError carries the error code and the suggestion', () => {
    const decision = planCrdApply(both({ managedBy: 'Helm' }), 'shop-production', PIN);
    if (decision.action !== 'refuse') throw new Error('expected a refusal');
    const error = proxyRefusalError(decision.refusal);
    expect(error).toBeInstanceOf(DeployError);
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.message).toBe(decision.refusal.message);
    expect(error.suggestion).toBe(decision.refusal.suggestion);
  });
});
