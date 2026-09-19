import { describe, expect, test } from 'bun:test';
import { DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { K8S_PROGRESS_DEADLINE_S } from '../../../services/orchestrator/kubernetes/constants';
import type { ReservedHostPort } from '../../../services/orchestrator/kubernetes/distribution';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import { compareCodeUnits } from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  createContext,
  escapeKubeExpansion,
  fileSourceKey,
  hostPortKey,
  reservedHostPortsFor,
  siblingPublishedReservations,
  TRAEFIK_RESERVATION_REASON,
  translatorBug,
} from '../../../services/orchestrator/kubernetes/translate/context';
import {
  isTranslatorCode,
  reportTranslator,
  TRANSLATOR_CODES,
  type TranslatorCode,
  type TranslatorParams,
  translatorDiagnostic,
} from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import { DeployError, ErrorCode } from '../../../utils/errors';
import {
  canonicalFileSource,
  canonicalService,
  canonicalStack,
  canonicalVolume,
  config,
  deployInput,
  nodeRef,
  stackRef,
  target,
  translateContext,
  translateOptions,
} from '../support/builders';

const SSH_32230: ReservedHostPort = { port: 32230, protocol: 'TCP', reason: 'SSH port of server_1' };

function reasons(map: Map<string, ReservedHostPort>): Record<string, string> {
  return Object.fromEntries([...map].map(([key, r]) => [key, r.reason]));
}

describe('reservedHostPortsFor (PD-2)', () => {
  const traits = k3sDistribution.traits;
  const k3sReserved = {
    '22/TCP': 'SSH',
    '6443/TCP': 'Kubernetes API',
    '10250/TCP': 'kubelet',
    '2379/TCP': 'etcd client',
    '2380/TCP': 'etcd peer',
    '8472/UDP': 'flannel VXLAN',
    '51820/UDP': 'flannel WireGuard',
    '51821/UDP': 'flannel WireGuard IPv6',
    '5001/TCP': 'k3s embedded registry',
  };

  test('without a Dockflow Traefik: the traits and the extra reservations, never 80/443', () => {
    const reserved = reservedHostPortsFor(traits, { extraReservedHostPorts: [SSH_32230], traefikOnCluster: false });
    expect(reasons(reserved)).toEqual({ ...k3sReserved, '32230/TCP': 'SSH port of server_1' });
    expect(reserved.has('80/TCP')).toBe(false);
    expect(reserved.has('443/TCP')).toBe(false);
  });

  test('with a Dockflow Traefik on the cluster: 80/TCP and 443/TCP are reserved for it', () => {
    const reserved = reservedHostPortsFor(traits, { extraReservedHostPorts: [], traefikOnCluster: true });
    expect(reserved.get('80/TCP')).toEqual({ port: 80, protocol: 'TCP', reason: TRAEFIK_RESERVATION_REASON });
    expect(reserved.get('443/TCP')).toEqual({ port: 443, protocol: 'TCP', reason: 'Dockflow Traefik' });
    expect(reserved.has('80/UDP')).toBe(false);
    expect(reserved.size).toBe(Object.keys(k3sReserved).length + 2);
  });

  test("the sibling role's published ports arrive as extra reservations naming the service", () => {
    const fromAccessories = siblingPublishedReservations('accessory', [
      { key: 'db', published: [{ port: 5432, protocol: 'TCP' }] },
      { key: 'dns', published: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]);
    expect(fromAccessories).toEqual([
      { port: 5432, protocol: 'TCP', reason: 'published by accessories service db' },
      { port: 53, protocol: 'UDP', reason: 'published by accessories service dns' },
      { port: 53, protocol: 'TCP', reason: 'published by accessories service dns' },
    ]);
    expect(siblingPublishedReservations('app', [{ key: 'web', published: [{ port: 8080, protocol: 'TCP' }] }])).toEqual([
      { port: 8080, protocol: 'TCP', reason: 'published by app service web' },
    ]);
    const reserved = reservedHostPortsFor(traits, { extraReservedHostPorts: fromAccessories, traefikOnCluster: false });
    expect(reserved.get('5432/TCP')?.reason).toBe('published by accessories service db');
    expect(reserved.get('53/UDP')?.reason).toBe('published by accessories service dns');
    expect(reserved.get('53/TCP')?.reason).toBe('published by accessories service dns');
  });

  test('duplicates collapse to one entry per (port, protocol), the first reason kept', () => {
    const reserved = reservedHostPortsFor(traits, {
      extraReservedHostPorts: [
        { port: 22, protocol: 'TCP', reason: 'SSH port of server_1' },
        { port: 22, protocol: 'TCP', reason: 'SSH port of agent_1' },
        { port: 80, protocol: 'TCP', reason: 'nginx host plugin' },
        { port: 8443, protocol: 'TCP', reason: 'nginx host plugin' },
        { port: 8443, protocol: 'UDP', reason: 'quic' },
      ],
      traefikOnCluster: true,
    });
    expect(reserved.get('22/TCP')?.reason).toBe('SSH');
    expect(reserved.get('80/TCP')?.reason).toBe('nginx host plugin');
    expect(reserved.get('443/TCP')?.reason).toBe('Dockflow Traefik');
    expect(reserved.get('8443/TCP')?.reason).toBe('nginx host plugin');
    expect(reserved.get('8443/UDP')?.reason).toBe('quic');
    expect([...reserved.keys()].filter((k) => k === '22/TCP')).toHaveLength(1);
    expect(reserved.size).toBe(Object.keys(k3sReserved).length + 4);
  });

  test('inputs are never modified and entries are copies', () => {
    const extra: ReservedHostPort[] = [{ ...SSH_32230 }];
    const before = structuredClone(traits.reservedHostPorts);
    const reserved = reservedHostPortsFor(traits, { extraReservedHostPorts: extra, traefikOnCluster: true });
    const entry = reserved.get('32230/TCP');
    expect(entry).toEqual(SSH_32230);
    expect(entry).not.toBe(extra[0]);
    expect(extra).toEqual([SSH_32230]);
    expect(traits.reservedHostPorts).toEqual(before);
    expect(hostPortKey(53, 'UDP')).toBe('53/UDP');
  });
});

describe('createContext (design-02 1.1)', () => {
  test('indexes the stack and shares the options sink', () => {
    const sink = new DiagnosticSink();
    const volume = canonicalVolume({ key: 'postgres_data' });
    const secret = canonicalFileSource({ kind: 'secret', key: 'api_key' });
    const config = canonicalFileSource({ kind: 'config', key: 'api_key', data: new TextEncoder().encode('a: 1') });
    const middleware = { name: 'strip', spec: { stripPrefix: { prefixes: ['/api'] } }, users: null, errorsService: null, path: 'services.web.labels' };
    const stack = canonicalStack({ volumes: [volume], files: [secret, config], middlewares: [middleware] });
    const options = translateOptions({ sink });
    const ctx = createContext(stack, options);
    expect(ctx.stack).toBe(stack);
    expect(ctx.options).toBe(options);
    expect(ctx.sink).toBe(sink);
    expect(ctx.traits).toBe(options.traits);
    expect(ctx.namespace).toBe('dockflow-shop-production');
    expect(ctx.volumes.get('postgres_data')).toBe(volume);
    expect(ctx.files.get(fileSourceKey('secret', 'api_key'))).toBe(secret);
    expect(ctx.files.get('config:api_key')).toBe(config);
    expect(ctx.middlewares.get('strip')).toBe(middleware);
    expect(ctx.publishedOwners.size).toBe(0);
    expect(ctx.reservedHostPorts.get('22/TCP')?.reason).toBe('SSH');
  });

  test('the Traefik reservation follows the cluster, not the stack proxy or role', () => {
    const accessoryWithoutProxy = canonicalStack({ role: 'accessory', proxy: null });
    expect(createContext(accessoryWithoutProxy, translateOptions({ traefikOnCluster: true })).reservedHostPorts.has('443/TCP')).toBe(true);
    expect(translateContext(canonicalStack(), { traefikOnCluster: false }).reservedHostPorts.has('80/TCP')).toBe(false);
  });

  test('translateOptions fills the design-07 5.1 defaults', () => {
    const options = translateOptions();
    expect(options.pullSecretName).toBeNull();
    expect(options.revisionHistoryLimit).toBe(3);
    expect(options.progressDeadlineS).toBe(K8S_PROGRESS_DEADLINE_S);
    expect(options.progressDeadlineS).toBe(240);
    expect(options.extraReservedHostPorts).toEqual([{ port: 22, protocol: 'TCP', reason: 'SSH port of server_1' }]);
    expect(options.traefikOnCluster).toBe(false);
    expect(options.serverNames).toEqual(['server_1', 'agent_1']);
    expect(options.traits).toEqual(k3sDistribution.traits);
    expect(options.traits).not.toBe(k3sDistribution.traits);
    expect(translateOptions().sink).not.toBe(options.sink);
    expect(translateOptions({ traits: { headlessServiceNeedsPort: false } }).traits.headlessServiceNeedsPort).toBe(false);
  });
});

describe('escapeKubeExpansion (T4)', () => {
  test.each([
    ['$', '$$'],
    ['$$', '$$$$'],
    ['$(A)', '$$(A)'],
    ['echo $HOME', 'echo $$HOME'],
    ['trailing $', 'trailing $$'],
    ['no dollar', 'no dollar'],
    ['', ''],
  ])('%p -> %p', (input, expected) => {
    expect(escapeKubeExpansion(input)).toBe(expected);
  });
});

describe('translatorBug (T6)', () => {
  test('throws a DeployError asking for a bug report', () => {
    let caught: unknown;
    try {
      translatorBug('Service web reached the translator with an empty command');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeployError);
    const error = caught as DeployError;
    expect(error.message).toBe('Service web reached the translator with an empty command');
    expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(error.suggestion).toBe('Report this as a Dockflow bug.');
  });
});

/** design-02 11.2, one row per code */
const CATALOGUE_11_2 = [
  'deploy.job-zero-replicas',
  'deploy.restart-policy-unsupported',
  'files.too-large',
  'labels.annotation-conflict',
  'network.dns-secondary',
  'network.host-network',
  'network.hostname-host-network',
  'network.hostname-statefulset',
  'placement.conflict',
  'placement.global-ignored',
  'placement.max-replicas-approximate',
  'ports.host-duplicate-target',
  'ports.host-ip-unsupported',
  'ports.host-port-replicas',
  'ports.name-conflict',
  'ports.no-published-port',
  'ports.publish-none',
  'ports.published-conflict',
  'ports.reserved-host-port',
  'ports.sctp-loadbalancer',
  'ports.too-many-published',
  'probes.override-defaults',
  'probes.routed-without-healthcheck',
  'process.init-shared-pid',
  'resources.request-exceeds-limit',
  'routing.middleware-invalid',
  'routing.middleware-unused',
  'routing.port-added',
  'routing.router-duplicate-rule',
  'security.init-host-pid',
  'security.no-new-privileges-privileged',
  'security.privileged',
  'update.global-all-at-once',
  'update.monitor-too-long',
  'update.statefulset-order',
  'update.strategy-recreate',
  'update.surge-disabled',
  'volumes.access-mode-unsupported',
  'volumes.bind-create-host-path',
  'volumes.bind-node-local',
  'volumes.docker-socket',
  'volumes.per-replica-shared',
  'volumes.pod-volume-name-collision',
  'volumes.propagation-bidirectional',
  'volumes.recursive-readonly-propagation',
  'volumes.rwo-global',
  'volumes.rwo-replicas',
  'volumes.rwo-shared',
  'volumes.rwop-shared',
  'volumes.tmpfs-memory',
];

/** Normalizer-owned codes of design-01 1.6 / design-02 11.1: never in the translator catalogue. */
const NORMALIZER_OWNED = [
  'image.pull-policy-imported',
  'process.empty-command',
  'ports.duplicate',
  'ports.with-host-network',
  'ports.loopback-host-port',
  'ports.ipv6-loopback-host-port',
  'volumes.copy-up-not-emulated',
  'volumes.anonymous-emptydir',
  'resources.pids-unsupported',
  'security.unsafe-sysctl',
  'security.host-sysctl',
  'security.invalid-sysctl',
  'security.host-namespace',
  'env.invalid-name',
  'env.too-large',
  'routing.proxy-disabled',
  'routing.middleware-provider',
  'routing.unknown-middleware',
  'routing.unknown-entrypoint',
  'routing.unknown-certresolver',
  'routing.entrypoint-not-exposed',
  'routing.service-undefined',
  'routing.users-file',
  'routing.middleware-missing-users',
  'routing.duplicate-router',
  'routing.duplicate-injected-host',
  'network.too-many-dns',
  'network.too-many-dns-search',
  'network.invalid-hostname',
  'network.invalid-extra-host',
  'names.sanitized',
  'names.sanitize-collision',
  'names.role-collision',
  'names.invalid-key',
  'labels.reserved',
  'labels.too-large',
  'labels.invalid-key',
  'labels.invalid-value',
  'files.ownership-ignored',
  'files.external-key',
  'extension.publish-unused',
  'extension.lb-source-ranges-without-lb',
  'extension.external-volume',
  'extension.per-replica-kind',
  'extension.probes-without-check',
  'placement.invalid-constraint',
  'placement.unknown-server',
  'deploy.update-delay',
  'deploy.max-failure-ratio',
  'deploy.failure-action',
  'deploy.rollback-config',
  'deploy.update-config-on-job',
  'deploy.statefulset-pacing',
  'mounts.bind-recursive-needs-readonly',
  'mounts.bind-recursive-ignored',
];

/** Deleted spellings of translator conditions (design-02 11.1): never reintroduced. */
const DELETED = [
  'volumes.rwx-local',
  'volumes.shared-rwo',
  'mounts.docker-socket',
  'mounts.create-host-path-unenforced',
  'mounts.bidirectional-needs-privileged',
  'network.dns-truncated',
  'network.dns-after-cluster-dns',
  'resources.reservation-exceeds-limit',
  'process.init-shared-namespace',
  'deploy.order-overridden',
  'ports.not-published',
  'update.delay-ignored',
  'update.job-ignored',
];

const SAMPLES: { [C in TranslatorCode]: TranslatorParams<C> } = {
  'volumes.rwo-replicas': { service: 'web', volume: 'data', accessMode: 'ReadWriteOnce', replicas: 3 },
  'volumes.rwo-global': { service: 'agent', volume: 'data', accessMode: 'ReadWriteOncePod' },
  'volumes.rwo-shared': { volume: 'data', services: ['api', 'web'] },
  'volumes.rwop-shared': { volume: 'data', services: ['api', 'web'] },
  'volumes.per-replica-shared': { volume: 'queue_data', services: ['queue', 'worker'] },
  'volumes.access-mode-unsupported': { volume: 'shared', accessMode: 'ReadWriteMany', storageClass: 'dockflow-local' },
  'volumes.bind-node-local': { service: 'web', source: '/srv/uploads' },
  'volumes.bind-create-host-path': { source: '/srv/uploads' },
  'volumes.propagation-bidirectional': { service: 'agent', source: '/mnt' },
  'volumes.recursive-readonly-propagation': { service: 'web', source: '/srv/ro', propagation: 'rslave' },
  'volumes.tmpfs-memory': { service: 'web', target: '/tmp' },
  'volumes.docker-socket': { service: 'ci', source: '/var/run/docker.sock' },
  'volumes.pod-volume-name-collision': { service: 'web', volume: 'a', other: 'b' },
  'update.strategy-recreate': { service: 'db', volume: 'pg_data', accessMode: 'ReadWriteOnce' },
  'update.surge-disabled': { service: 'web' },
  'update.statefulset-order': { service: 'queue' },
  'update.global-all-at-once': { service: 'agent' },
  'update.monitor-too-long': { service: 'web', monitorS: 250 },
  'deploy.restart-policy-unsupported': { service: 'web', field: 'delay' },
  'deploy.job-zero-replicas': { service: 'migrate' },
  'ports.reserved-host-port': { entry: 'services.web.ports[0]', port: 6443, protocol: 'TCP', reason: 'Kubernetes API' },
  'ports.published-conflict': { entry: 'services.api.ports[0]', port: 8080, protocol: 'TCP', owner: 'services.web.ports[0]' },
  'ports.host-ip-unsupported': { entry: 'services.db.ports[0]', hostIp: '127.0.0.1' },
  'ports.host-duplicate-target': { entry: 'services.web.ports[1]', target: 80, protocol: 'TCP' },
  'ports.host-port-replicas': { service: 'web', port: 8080, protocol: 'TCP', replicas: 2 },
  'ports.too-many-published': { service: 'game', count: 11 },
  'ports.sctp-loadbalancer': { entry: 'services.sig.ports[0]', port: 5000 },
  'ports.no-published-port': { service: 'web', target: 3000 },
  'ports.publish-none': { service: 'web' },
  'ports.name-conflict': { service: 'web', target: 80, protocol: 'TCP' },
  'network.host-network': { service: 'probe' },
  'network.dns-secondary': { service: 'web' },
  'network.hostname-host-network': { service: 'probe' },
  'network.hostname-statefulset': { service: 'queue' },
  'files.too-large': { kind: 'config', key: 'bundle', sizeBytes: 1_048_577 },
  'security.privileged': { service: 'agent' },
  'security.no-new-privileges-privileged': { service: 'agent' },
  'security.init-host-pid': { service: 'agent' },
  'resources.request-exceeds-limit': { service: 'web', resource: 'memory' },
  'placement.conflict': { service: 'web', constraint: 'node.role == manager', other: 'node.role != manager' },
  'placement.max-replicas-approximate': { service: 'web', maxReplicas: 2 },
  'placement.global-ignored': { service: 'agent' },
  'probes.override-defaults': { service: 'web' },
  'probes.routed-without-healthcheck': { service: 'web' },
  'process.init-shared-pid': { service: 'web' },
  'labels.annotation-conflict': { service: 'web', key: 'team' },
  'routing.middleware-unused': { middleware: 'strip' },
  'routing.middleware-invalid': { middleware: 'prefix' },
  'routing.port-added': { service: 'web', port: 8080, router: 'api' },
  'routing.router-duplicate-rule': { first: 'api', second: 'api-v2' },
};

const CODES = Object.keys(SAMPLES) as TranslatorCode[];

describe('TRANSLATOR_CODES (design-02 11.2)', () => {
  test('codes are unique', () => {
    const codes = TRANSLATOR_CODES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('the catalogue is exactly the 11.2 table', () => {
    const codes: string[] = TRANSLATOR_CODES.map((e) => e.code);
    expect(codes.sort(compareCodeUnits)).toEqual([...CATALOGUE_11_2].sort(compareCodeUnits));
  });

  test('every entry has a severity, a path template, a message builder and a hint builder or none', () => {
    for (const e of TRANSLATOR_CODES) {
      expect(e.code).toMatch(/^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(['error', 'warning', 'info', 'default-aware']).toContain(e.severity);
      expect(e.path.length).toBeGreaterThan(0);
      expect(typeof e.message).toBe('function');
      expect(e.hint === null || typeof e.hint === 'function').toBe(true);
    }
  });

  test('no code belongs to the normalizer or is a deleted spelling', () => {
    const own = new Set<string>(TRANSLATOR_CODES.map((e) => e.code));
    expect([...NORMALIZER_OWNED, ...DELETED].filter((code) => own.has(code))).toEqual([]);
  });

  test('every message is one sentence without a trailing period, every hint an imperative sentence', () => {
    for (const code of CODES) {
      const d = translatorDiagnostic(code, 'services.web', SAMPLES[code], { equalsDefault: false });
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.message.endsWith('.')).toBe(false);
      expect(d.message).not.toMatch(/undefined|NaN|\[object /);
      if (d.hint !== undefined) {
        expect(d.hint).toMatch(/^[A-Z].*\.$/);
        expect(d.hint).not.toMatch(/undefined|NaN|\[object /);
      }
    }
  });

  test('update.monitor-too-long carries the PD-5 text', () => {
    expect(translatorDiagnostic('update.monitor-too-long', 'services.web.deploy.update_config.monitor', { service: 'web', monitorS: 250 })).toEqual({
      severity: 'error',
      code: 'update.monitor-too-long',
      path: 'services.web.deploy.update_config.monitor',
      message: 'update_config.monitor of service web is 250s, which leaves no time to observe a rollout inside the 300s convergence deadline',
      hint: 'Set `update_config.monitor` to at most 210s.',
    });
  });

  test('published-port messages follow design-02 6.6', () => {
    const traefik = translatorDiagnostic('ports.reserved-host-port', 'services.web.ports[0]', {
      entry: 'services.web.ports[0]',
      port: 443,
      protocol: 'TCP',
      reason: 'Dockflow Traefik',
    });
    expect(traefik.message).toBe('services.web.ports[0] publishes 443/tcp, which is reserved on the nodes (Dockflow Traefik)');
    expect(traefik.hint).toBe('Route the service through the proxy with traefik labels, or publish another port.');
    const ssh = translatorDiagnostic('ports.reserved-host-port', 'services.web.ports[1]', {
      entry: 'services.web.ports[1]',
      port: 32230,
      protocol: 'TCP',
      reason: 'SSH port of server_1',
    });
    expect(ssh.message).toBe('services.web.ports[1] publishes 32230/tcp, which is reserved on the nodes (SSH port of server_1)');
    expect(ssh.hint).toBe('Publish another port; SSH port of server_1 uses this one on every node.');
    expect(translatorDiagnostic('ports.published-conflict', 'services.api.ports[0]', SAMPLES['ports.published-conflict']).message).toBe(
      'services.api.ports[0] publishes 8080/tcp, already published by services.web.ports[0]',
    );
    expect(translatorDiagnostic('ports.host-ip-unsupported', 'services.db.ports[0]', SAMPLES['ports.host-ip-unsupported']).message).toBe(
      'services.db.ports[0] binds 127.0.0.1, which a load balancer publishing on every node cannot honour',
    );
    expect(translatorDiagnostic('ports.too-many-published', 'services.game.ports', SAMPLES['ports.too-many-published']).message).toBe(
      'Service game publishes 11 ports through its load balancer; ServiceLB runs one container per port on every node, so at most 10 are accepted',
    );
    expect(translatorDiagnostic('ports.host-port-replicas', 'services.web.deploy.replicas', SAMPLES['ports.host-port-replicas']).message).toBe(
      'web binds node port 8080/tcp and runs 2 replicas, but two pods cannot bind one port on one node',
    );
  });

  test('messages name compose keys and never payloads', () => {
    expect(translatorDiagnostic('files.too-large', 'configs.bundle', SAMPLES['files.too-large']).message).toBe(
      'Config bundle is 1048577 bytes; Kubernetes limits it to 1 MiB',
    );
    expect(translatorDiagnostic('volumes.rwo-replicas', 'services.web.deploy.replicas', SAMPLES['volumes.rwo-replicas'])).toEqual({
      severity: 'error',
      code: 'volumes.rwo-replicas',
      path: 'services.web.deploy.replicas',
      message: 'Service web mounts volume data (ReadWriteOnce) and cannot run 3 replicas',
      hint: 'Set `deploy.replicas: 1`, or set `x-dockflow.kind: statefulset` and `volumes.data.x-dockflow.per_replica: true`.',
    });
  });

  test('a code without a hint produces a diagnostic without a hint key', () => {
    const d = translatorDiagnostic('security.privileged', 'services.agent.privileged', { service: 'agent' });
    expect(d).toEqual({
      severity: 'warning',
      code: 'security.privileged',
      path: 'services.agent.privileged',
      message: 'Service agent runs privileged (Swarm ignored privileged)',
    });
    expect('hint' in d).toBe(false);
  });

  test('default-aware codes are info at the injected default and warnings otherwise', () => {
    const path = 'services.web.deploy.update_config.order';
    expect(translatorDiagnostic('update.surge-disabled', path, { service: 'web' }, { equalsDefault: true }).severity).toBe('info');
    expect(translatorDiagnostic('update.surge-disabled', path, { service: 'web' }, { equalsDefault: false }).severity).toBe('warning');
    expect(() => translatorDiagnostic('update.statefulset-order', path, { service: 'queue' })).toThrow(/default-aware/);
  });

  test('reportTranslator writes into the given sink with the catalogue severity', () => {
    const sink = new DiagnosticSink();
    reportTranslator(sink, 'ports.publish-none', 'services.web.x-dockflow.publish', { service: 'web' });
    reportTranslator(sink, 'network.dns-secondary', 'services.web.dns', { service: 'web' });
    reportTranslator(sink, 'volumes.docker-socket', 'services.ci.volumes[0]', SAMPLES['volumes.docker-socket']);
    reportTranslator(sink, 'update.statefulset-order', 'services.queue.deploy.update_config.order', { service: 'queue' }, { equalsDefault: false });
    expect(sink.list().map((d) => [d.severity, d.code])).toEqual([
      ['error', 'volumes.docker-socket'],
      ['warning', 'update.statefulset-order'],
      ['warning', 'network.dns-secondary'],
      ['info', 'ports.publish-none'],
    ]);
    expect(sink.hasErrors()).toBe(true);
  });

  test('isTranslatorCode recognises catalogue members only', () => {
    expect(isTranslatorCode('ports.reserved-host-port')).toBe(true);
    expect(isTranslatorCode('ports.duplicate')).toBe(false);
  });
});

describe('builders used by translator tests', () => {
  test('canonicalStack defaults to one app service and no proxy', () => {
    const stack = canonicalStack();
    expect(stack.schema).toBe(1);
    expect(stack.role).toBe('app');
    expect(stack.services).toEqual([canonicalService()]);
    expect(stack.proxy).toBeNull();
    expect(canonicalStack({ role: 'accessory' }).services[0].role).toBe('accessory');
  });

  test('file sources derive checksum and object name from their content', () => {
    const secret = canonicalFileSource();
    expect(secret.objectName).toMatch(/^api-key-secret-[0-9a-f]{8}$/);
    expect(secret.path).toBe('secrets.api_key');
    const external = canonicalFileSource({ kind: 'config', key: 'nginx_conf', external: true });
    expect(external).toMatchObject({ data: null, checksum: null, objectName: 'nginx_conf', path: 'configs.nginx_conf' });
    expect(canonicalVolume({ key: 'postgres_data' })).toMatchObject({ name: 'postgres-data', path: 'volumes.postgres_data' });
  });

  test('deployInput fills every StackDeployInput field, the PD-10 members included', () => {
    const input = deployInput();
    expect(input.ref).toEqual({ project: 'shop', env: 'production', role: 'app' });
    expect(input.version).toBe('1.4.2');
    expect(input.compose.services).toEqual({ web: { image: 'nginx:1.27' } });
    expect(input.proxy).toBeUndefined();
    expect(input.services).toBeNull();
    expect(input.previousVersion).toBeNull();
    expect(input.force).toBe(false);
    expect(input.images).toEqual({ built: [], mode: 'none', pullSecretName: null });
    expect(input.helm).toEqual([]);
    expect(input.helmDeclared).toEqual([]);
    expect(input.sibling).toEqual({ services: [], volumes: [], middlewares: [] });
    expect(input.serverNames).toEqual(['server_1', 'agent_1']);
    expect(input.files('.env')).toEqual({ ok: false, reason: 'missing' });
    expect(typeof input.onApplyProgress).toBe('function');
    expect(input.rebindVolumes).toBe(false);
    expect(input.traefikOnCluster).toBe(false);
    const accessory = deployInput({ ref: { role: 'accessory' }, images: { mode: 'import' }, files: { '.env': 'A=1' } });
    expect(accessory.ref).toEqual({ project: 'shop', env: 'production', role: 'accessory' });
    expect(accessory.images).toEqual({ built: [], mode: 'import', pullSecretName: null });
    expect(accessory.files('./.env').ok).toBe(true);
  });

  test('target, nodeRef, stackRef and config describe shop/production on k3s', () => {
    const t = target();
    expect(t).toMatchObject({ kind: 'k3s', project: 'shop', env: 'production', stackName: 'shop-production', probes: [] });
    expect(t.controlPlane).toEqual(nodeRef('server_1'));
    expect(t.managers).toEqual([t.controlPlane]);
    expect(t.workers.map((n) => [n.name, n.role])).toEqual([['agent_1', 'worker']]);
    expect(nodeRef('server_1')).toEqual({
      name: 'server_1',
      role: 'manager',
      host: '203.0.113.10',
      privateHost: '203.0.113.10',
      connection: { host: '203.0.113.10', port: 22, user: 'dockflow', privateKey: 'test-private-key' },
    });
    expect(target('server_2').controlPlane.name).toBe('server_2');
    expect(stackRef({ role: 'accessory' })).toEqual({ project: 'shop', env: 'production', role: 'accessory' });
    expect(config()).toEqual({ project_name: 'shop', orchestrator: 'k3s' });
  });
});
