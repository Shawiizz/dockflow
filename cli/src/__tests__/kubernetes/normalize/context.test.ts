import { describe, expect, test } from 'bun:test';
import { DEFAULT_UPDATE_CONFIG } from '../../../services/compose';
import { DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type { FileResolveFailure, FileResolver } from '../../../services/orchestrator/interfaces';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import type { CanonicalService } from '../../../services/orchestrator/kubernetes/model/types';
import { parseDurationMs } from '../../../services/orchestrator/kubernetes/model/units';
import {
  childPath,
  compareCodeUnits,
  DEFAULT_STOP_GRACE_PERIOD_MS,
  DEFAULT_VOLUME_SIZE,
  DOCKER_UPDATE_DEFAULTS,
  DOCKFLOW_UPDATE_DEFAULTS,
  defaultUpdateSpec,
  draftToFileSource,
  draftToService,
  emptyStack,
  type FileReadFailure,
  fileReadDiagnostic,
  HEALTHCHECK_DEFAULTS,
  indexPath,
  isPlainMap,
  NormalizeContext,
  newFileSourceDraft,
  newNetworkDraft,
  newServiceDraft,
  newVolumeDraft,
  normalizeFilePath,
  pathKey,
  proxyIntentFor,
  sortedKeys,
  sortedUnique,
} from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  canonicalService,
  composeYaml,
  fileResolver,
  normalizeContext,
  normalizeInput,
  parsedCompose,
  serviceDraft,
} from '../support/builders';

/** Every CanonicalService field of DESIGN-CORE 3, nothing more. */
const MODEL_KEYS = [
  'composeName',
  'containerLabels',
  'environment',
  'expose',
  'extension',
  'files',
  'healthcheck',
  'image',
  'mode',
  'mounts',
  'name',
  'network',
  'path',
  'placement',
  'podAnnotations',
  'ports',
  'process',
  'replicas',
  'resources',
  'restart',
  'role',
  'routes',
  'security',
  'serviceLabels',
  'update',
  'workloadKind',
];

function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.entries(value).flatMap(([k, v]) => undefinedPaths(v, `${path}.${k}`));
  }
  return [];
}

function isSorted(values: readonly string[]): boolean {
  return values.every((v, i) => i === 0 || compareCodeUnits(values[i - 1], v) <= 0);
}

/** The DESIGN-CORE 3 invariants that apply to one service (design-07 4.1 normalizeChecked). */
function modelInvariantViolations(s: CanonicalService): string[] {
  const issues = undefinedPaths(s).map((p) => `undefined at ${p}`);
  if (s.path === '') issues.push('empty path');
  const sortedChecks: [string, readonly string[]][] = [
    ['environment', s.environment.map((e) => e.name)],
    ['process.groupAdd', s.process.groupAdd.map((g) => String(g).padStart(10, '0'))],
    ['security.capAdd', s.security.capAdd],
    ['security.capDrop', s.security.capDrop],
    ['network.networks', s.network.networks],
    ['network.aliases', s.network.aliases],
    ['routes', s.routes.map((r) => r.router)],
    ['mounts', s.mounts.map((m) => m.target)],
    ['files', s.files.map((f) => f.target)],
    ['extension.loadBalancerSourceRanges', s.extension.loadBalancerSourceRanges],
  ];
  for (const [name, values] of sortedChecks) if (!isSorted(values)) issues.push(`${name} not sorted`);
  const maps: [string, unknown][] = [
    ['containerLabels', s.containerLabels],
    ['serviceLabels', s.serviceLabels],
    ['podAnnotations', s.podAnnotations],
    ['security.sysctls', s.security.sysctls],
    ['extension.nodeSelector', s.extension.nodeSelector],
    ['extension.podLabels', s.extension.podLabels],
  ];
  for (const [name, value] of maps) if (!isPlainMap(value)) issues.push(`${name} is not a plain map`);
  return issues;
}

function countingResolver(files: Record<string, string | { fail: FileResolveFailure }>): {
  resolver: FileResolver;
  calls: string[];
} {
  const calls: string[] = [];
  const inner = fileResolver(files);
  return {
    calls,
    resolver: (p) => {
      calls.push(p);
      return inner(p);
    },
  };
}

describe('ServiceDraft defaults (DESIGN-CORE 3 invariants)', () => {
  test('a fresh draft of either role satisfies the model invariants', () => {
    for (const role of ['app', 'accessory'] as const) {
      const draft = serviceDraft('web', normalizeContext({ role }));
      expect(modelInvariantViolations(draftToService(draft))).toEqual([]);
      expect(undefinedPaths(draft)).toEqual([]);
    }
  });

  test('identity fields come from the key, the path and the render role', () => {
    const ctx = normalizeContext({ role: 'accessory' });
    const draft = newServiceDraft('Api.V2', childPath('services', 'Api.V2'), ctx);
    expect(draft.composeName).toBe('Api.V2');
    expect(draft.name).toBe('api-v2');
    expect(draft.path).toBe('services["Api.V2"]');
    expect(draft.role).toBe('accessory');
  });

  test('every documented default holds', () => {
    const d = serviceDraft();
    expect(d.mode).toBe('replicated');
    expect(d.workloadKind).toBe('Deployment');
    expect(d.replicas).toBe(1);
    expect(d.healthcheck).toBeNull();
    expect(d.process).toEqual({
      entrypoint: null,
      command: null,
      workingDir: null,
      user: null,
      groupAdd: [],
      tty: false,
      stdinOpen: false,
      init: false,
      stopGracePeriodMs: 10_000,
      hostname: null,
      postStart: null,
      preStop: null,
    });
    expect(DEFAULT_STOP_GRACE_PERIOD_MS).toBe(10_000);
    expect(d.restart).toEqual({ condition: 'any', delayMs: null, maxAttempts: null, windowMs: null });
    expect(d.resources).toEqual({ limits: { cpu: null, memory: null, pids: null }, reservations: { cpu: null, memory: null } });
    expect(d.placement).toEqual({ constraints: [], spreadLabels: [], maxReplicasPerNode: null });
    expect(d.security).toEqual({
      privileged: false,
      capAdd: [],
      capDrop: [],
      readOnlyRootFilesystem: false,
      noNewPrivileges: false,
      seccomp: 'default',
      apparmor: 'default',
      sysctls: {},
      hostPid: false,
      hostIpc: false,
    });
    expect(d.network).toEqual({
      networks: ['default'],
      aliases: [],
      endpointMode: 'vip',
      hostNetwork: false,
      dns: [],
      dnsSearch: [],
      dnsOptions: [],
      extraHosts: [],
    });
    expect(d.extension).toEqual({
      kind: null,
      publish: null,
      loadBalancerSourceRanges: [],
      probes: null,
      nodeSelector: {},
      tolerations: [],
      fsGroup: null,
      podLabels: {},
    });
    for (const list of [d.environment, d.ports, d.expose, d.mounts, d.files, d.routes]) expect(list).toEqual([]);
    for (const map of [d.containerLabels, d.serviceLabels, d.podAnnotations]) expect(map).toEqual({});
    expect(d.image).toEqual({ ref: '', composeRef: '', origin: 'pulled', pullPolicy: 'IfNotPresent' });
  });

  test('update defaults follow the role (design-01 INJ-05)', () => {
    expect(serviceDraft('web', normalizeContext({ role: 'app' })).update).toEqual({
      parallelism: 1,
      delayMs: 10_000,
      failureAction: 'rollback',
      monitorMs: 30_000,
      order: 'start-first',
      maxFailureRatio: 0,
      defaults: 'dockflow',
    });
    expect(serviceDraft('db', normalizeContext({ role: 'accessory' })).update).toEqual({
      parallelism: 1,
      delayMs: 0,
      failureAction: 'pause',
      monitorMs: 5_000,
      order: 'stop-first',
      maxFailureRatio: 0,
      defaults: 'docker',
    });
  });

  test('the app update defaults are Compose.DEFAULT_UPDATE_CONFIG in model units', () => {
    expect(DOCKFLOW_UPDATE_DEFAULTS).toEqual({
      parallelism: DEFAULT_UPDATE_CONFIG.parallelism,
      delayMs: parseDurationMs(DEFAULT_UPDATE_CONFIG.delay) as number,
      failureAction: DEFAULT_UPDATE_CONFIG.failure_action,
      monitorMs: parseDurationMs(DEFAULT_UPDATE_CONFIG.monitor) as number,
      order: DEFAULT_UPDATE_CONFIG.order,
      maxFailureRatio: DEFAULT_UPDATE_CONFIG.max_failure_ratio,
      defaults: 'dockflow',
    });
    expect(DOCKER_UPDATE_DEFAULTS.defaults).toBe('docker');
    expect(Object.isFrozen(DOCKFLOW_UPDATE_DEFAULTS)).toBe(true);
    const copy = defaultUpdateSpec('app');
    copy.parallelism = 5;
    expect(DOCKFLOW_UPDATE_DEFAULTS.parallelism).toBe(1);
  });

  test('draft-only fields start empty', () => {
    const d = serviceDraft();
    expect(d.rawPorts).toEqual([]);
    expect(d.routingLabels).toEqual([]);
    expect(d.routingEnable).toBeNull();
    expect(d.healthcheckDisabled).toBe(false);
  });

  test('draftToService keeps exactly the model fields', () => {
    const d = serviceDraft();
    d.rawPorts.push('8080:80');
    d.routingLabels.push({ key: 'traefik.enable', value: 'true', path: 'services.web.labels["traefik.enable"]', source: 'labels' });
    d.healthcheckDisabled = true;
    const service = draftToService(d);
    expect(Object.keys(service).sort(compareCodeUnits)).toEqual([...MODEL_KEYS].sort(compareCodeUnits));
    expect(Object.keys(canonicalService()).sort(compareCodeUnits)).toEqual([...MODEL_KEYS].sort(compareCodeUnits));
  });

  test('drafts never share mutable defaults', () => {
    const ctx = normalizeContext();
    const a = serviceDraft('a', ctx);
    const b = serviceDraft('b', ctx);
    a.process.groupAdd.push(1000);
    a.network.networks.push('back');
    a.security.sysctls['net.core.somaxconn'] = '1024';
    a.update.parallelism = 3;
    a.extension.tolerations.push({ key: null, operator: 'Exists', value: null, effect: null, tolerationSeconds: null });
    expect(b.process.groupAdd).toEqual([]);
    expect(b.network.networks).toEqual(['default']);
    expect(b.security.sysctls).toEqual({});
    expect(b.update.parallelism).toBe(1);
    expect(b.extension.tolerations).toEqual([]);
    expect(serviceDraft('c', ctx).process.groupAdd).toEqual([]);
  });

  test('healthcheck defaults are Docker timings (D10)', () => {
    expect(HEALTHCHECK_DEFAULTS).toEqual({ intervalMs: 30_000, timeoutMs: 30_000, retries: 3, startPeriodMs: 0, startIntervalMs: 5_000 });
  });

  test('the canonicalService builder is a valid model service', () => {
    const s = canonicalService();
    expect(modelInvariantViolations(s)).toEqual([]);
    expect(s.image).toEqual({ ref: 'nginx:1.27', composeRef: 'nginx:1.27', origin: 'pulled', pullPolicy: 'IfNotPresent' });
    const job = canonicalService({ composeName: 'migrate', mode: 'replicated-job', role: 'accessory' });
    expect(job.workloadKind).toBe('Job');
    expect(job.path).toBe('services.migrate');
    expect(job.update.defaults).toBe('docker');
    expect(canonicalService({ extension: { kind: 'statefulset' } }).workloadKind).toBe('StatefulSet');
    expect(canonicalService({ mode: 'global' }).workloadKind).toBe('DaemonSet');
    expect(canonicalService({ process: { init: true } }).process.stopGracePeriodMs).toBe(10_000);
  });
});

describe('top-level table drafts (design-01 6.1-6.3)', () => {
  test('a volume draft holds the 6.2 defaults of the render role', () => {
    const ctx = normalizeContext({ role: 'accessory' });
    const draft = newVolumeDraft('postgres_data', ctx);
    expect(draft).toEqual({
      key: 'postgres_data',
      name: 'postgres-data',
      role: 'accessory',
      external: false,
      size: '1Gi',
      storageClass: k3sDistribution.traits.defaultStorageClass,
      accessMode: 'ReadWriteOnce',
      perReplica: false,
      labels: {},
      usedBy: [],
      path: 'volumes.postgres_data',
    });
    expect(DEFAULT_VOLUME_SIZE).toBe('1Gi');
    expect(undefinedPaths(draft)).toEqual([]);
    expect(newVolumeDraft('data', normalizeContext({ traits: { defaultStorageClass: 'fast-ssd' } })).storageClass).toBe('fast-ssd');
  });

  test('volume drafts never share mutable defaults', () => {
    const ctx = normalizeContext();
    const a = newVolumeDraft('data', ctx);
    a.usedBy.push('web');
    a.labels.backup = 'daily';
    expect(newVolumeDraft('data', ctx)).toMatchObject({ usedBy: [], labels: {} });
  });

  test('a file source draft stays unread until a service references it', () => {
    const ctx = normalizeContext();
    expect(newFileSourceDraft('secret', 'tls_cert', ctx)).toEqual({
      kind: 'secret',
      key: 'tls_cert',
      objectName: 'tls_cert',
      role: 'app',
      external: false,
      data: null,
      checksum: null,
      path: 'secrets.tls_cert',
      file: null,
    });
    const config = newFileSourceDraft('config', 'nginx.conf', normalizeContext({ role: 'accessory' }));
    expect(config.path).toBe('configs["nginx.conf"]');
    expect(config.role).toBe('accessory');
    config.file = './nginx/nginx.conf';
    const model = draftToFileSource(config);
    expect('file' in model).toBe(false);
    expect(Object.keys(model).sort(compareCodeUnits)).toEqual(
      ['checksum', 'data', 'external', 'key', 'kind', 'objectName', 'path', 'role'].sort(compareCodeUnits),
    );
  });

  test('a network draft is named after its key', () => {
    expect(newNetworkDraft('back')).toEqual({ key: 'back', external: false, name: 'back', path: 'networks.back' });
    expect(newNetworkDraft('traefik-public').path).toBe('networks.traefik-public');
  });
});

describe('NormalizeContext.readFile (design-01 1.5)', () => {
  const cases: [FileResolveFailure, string, string, string][] = [
    [
      'missing',
      'files.not-found',
      'file app.env was not found in the project',
      'Paths are relative to the directory of the compose file and must stay inside the project.',
    ],
    ['directory', 'files.not-a-file', 'app.env is a directory', 'Point the key at a file.'],
    [
      'outside-project',
      'files.outside-project',
      'app.env is outside the project directory and is not read',
      'Move the file into the project; Dockflow never reads files from the machine running `dockflow` outside it.',
    ],
    ['unreadable', 'files.unreadable', 'app.env could not be read', 'Check the file permissions.'],
  ];

  for (const [reason, code, message, hint] of cases) {
    test(`resolver reason ${reason} becomes ${code} at the caller's path`, () => {
      const files: Record<string, { fail: FileResolveFailure }> = reason === 'missing' ? {} : { 'app.env': { fail: reason } };
      const ctx = normalizeContext({ files });
      const result = ctx.readFile('app.env', 'services.web.env_file[0]', 'env_file');
      expect(result).toEqual({ ok: false, reason });
      expect(ctx.sink.list()).toEqual([{ severity: 'error', code, path: 'services.web.env_file[0]', message, hint }]);
    });
  }

  test('a readable file returns its bytes and reports nothing', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x10]);
    const ctx = normalizeContext({ files: { 'certs/keystore.p12': bytes, 'app.env': 'A=1\n' } });
    expect(ctx.readFile('certs/keystore.p12', 'secrets.keystore.file', 'secret')).toEqual({ ok: true, bytes, rendered: false });
    const text = ctx.readFile('app.env', 'services.web.env_file', 'env_file');
    expect(text.ok && new TextDecoder().decode(text.bytes)).toBe('A=1\n');
    expect(ctx.sink.list()).toEqual([]);
  });

  test('absolute and backslash paths are refused before the resolver is called', () => {
    const { resolver, calls } = countingResolver({});
    const ctx = normalizeContext({ files: resolver });
    const refused: [string, FileReadFailure, string][] = [
      ['/etc/app.env', 'absolute-path', 'services.web.env_file[0]'],
      ['~/app.env', 'absolute-path', 'services.web.env_file[1]'],
      ['C:\\app.env', 'absolute-path', 'services.web.env_file[2]'],
      ['config\\app.env', 'backslash-path', 'services.web.env_file[3]'],
    ];
    for (const [path, reason, diagPath] of refused) {
      expect(ctx.readFile(path, diagPath, 'env_file')).toEqual({ ok: false, reason });
    }
    expect(calls).toEqual([]);
    expect(ctx.sink.list().map((d) => [d.code, d.path, d.message])).toEqual([
      [
        'files.absolute-path',
        'services.web.env_file[0]',
        'absolute paths are not supported: /etc/app.env would be read on the machine running dockflow',
      ],
      ['files.absolute-path', 'services.web.env_file[1]', 'absolute paths are not supported: ~/app.env would be read on the machine running dockflow'],
      [
        'files.absolute-path',
        'services.web.env_file[2]',
        'absolute paths are not supported: C:\\app.env would be read on the machine running dockflow',
      ],
      ['files.backslash-path', 'services.web.env_file[3]', 'path config\\app.env must use / separators'],
    ]);
    expect(fileReadDiagnostic('absolute-path', 'x').hint).toBe('Put the file in the project and use a path relative to the compose file.');
  });

  test('resolver calls are memoized per normalized path', () => {
    const { resolver, calls } = countingResolver({ 'env/app.env': 'A=1\n' });
    const ctx = normalizeContext({ files: resolver });
    for (const path of ['env/app.env', './env/app.env', 'env//app.env', '././env/app.env']) {
      expect(ctx.readFile(path, 'services.web.env_file', 'env_file').ok).toBe(true);
    }
    expect(calls).toEqual(['env/app.env']);
    expect(normalizeFilePath('./a//b///c')).toBe('a/b/c');
  });

  test('a memoized failure is reported at every caller path', () => {
    const { resolver, calls } = countingResolver({});
    const ctx = normalizeContext({ files: resolver });
    ctx.readFile('shared.env', 'services.api.env_file', 'env_file');
    ctx.readFile('./shared.env', 'services.web.env_file', 'env_file');
    expect(calls).toEqual(['shared.env']);
    expect(ctx.sink.list().map((d) => [d.code, d.path])).toEqual([
      ['files.not-found', 'services.api.env_file'],
      ['files.not-found', 'services.web.env_file'],
    ]);
  });

  test('required: false leaves a missing file to the caller and still reports other failures', () => {
    const ctx = normalizeContext({ files: { dir: { fail: 'directory' } } });
    expect(ctx.readFile('optional.env', 'services.web.env_file[0].path', 'env_file', { required: false })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(ctx.sink.list()).toEqual([]);
    ctx.readFile('dir', 'services.web.env_file[1].path', 'env_file', { required: false });
    expect(ctx.sink.list().map((d) => d.code)).toEqual(['files.not-a-file']);
  });
});

describe('NormalizeContext.markFatal', () => {
  test('marks one service path, idempotently, and nothing else', () => {
    const ctx = normalizeContext();
    expect(ctx.isFatal('services.web')).toBe(false);
    ctx.markFatal('services.web');
    ctx.markFatal('services.web');
    expect(ctx.isFatal('services.web')).toBe(true);
    expect(ctx.isFatal('services.api')).toBe(false);
    expect(ctx.isFatal('services.web.ports[0]')).toBe(false);
    expect(normalizeContext().isFatal('services.web')).toBe(false);
  });
});

describe('NormalizeContext wiring', () => {
  test('uses the render sink for its own reports and its name registry', () => {
    const sink = new DiagnosticSink();
    const ctx = new NormalizeContext(normalizeInput({ sink }));
    expect(ctx.sink).toBe(sink);
    ctx.names.claim('service', 'web-app', { description: 'service web_app', path: 'services.web_app' });
    ctx.names.claim('service', 'web-app', { description: 'service web-app', path: 'services.web-app' });
    expect(sink.list().map((d) => [d.code, d.path])).toEqual([['names.sanitize-collision', 'services.web-app']]);
  });

  test('exposes traits and the server-name set', () => {
    const ctx = normalizeContext({ serverNames: ['server_1', 'worker_1'] });
    expect(ctx.traits).toEqual(k3sDistribution.traits);
    expect(ctx.serverNames.has('worker_1')).toBe(true);
    expect(ctx.serverNames.has('agent_1')).toBe(false);
  });

  test('the proxy intent is null only when the proxy is disabled, for both roles', () => {
    for (const role of ['app', 'accessory'] as const) {
      expect(normalizeContext({ role }).proxy).toBeNull();
      expect(normalizeContext({ role, proxy: { enabled: false, domains: { production: 'shop.example.com' } } }).proxy).toBeNull();
      // the config schema defaults proxy.enabled to false
      expect(normalizeContext({ role, proxy: { domains: { production: 'shop.example.com' } } }).proxy).toBeNull();
    }
    const proxy = { enabled: true, acme: true, email: 'ops@example.com', domains: { production: 'shop.example.com' } };
    expect(normalizeContext({ proxy }).proxy).toEqual({
      domain: 'shop.example.com',
      acme: true,
      entryPoint: 'websecure',
      certResolver: 'letsencrypt',
      manage: true,
    });
    expect(normalizeContext({ role: 'accessory', proxy }).proxy).toEqual({
      domain: null,
      acme: true,
      entryPoint: 'websecure',
      certResolver: 'letsencrypt',
      manage: true,
    });
  });

  test('ACME off serves web without a resolver; manage false and a missing domain are kept', () => {
    expect(proxyIntentFor({ enabled: true, acme: false, domains: { production: 'shop.example.com' } }, 'app', 'production')).toEqual({
      domain: 'shop.example.com',
      acme: false,
      entryPoint: 'web',
      certResolver: null,
      manage: true,
    });
    const notOwner = { enabled: true, email: 'ops@example.com', manage: false, domains: { staging: 'staging.example.com' } };
    expect(proxyIntentFor(notOwner, 'app', 'production')).toEqual({
      domain: null,
      acme: true,
      entryPoint: 'websecure',
      certResolver: 'letsencrypt',
      manage: false,
    });
  });

  test('emptyStack keeps identity, role and proxy intent', () => {
    const input = normalizeInput({ role: 'accessory', proxy: { enabled: true, acme: false } });
    expect(emptyStack(input)).toEqual({
      schema: 1,
      identity: input.identity,
      role: 'accessory',
      services: [],
      volumes: [],
      files: [],
      middlewares: [],
      proxy: { domain: null, acme: false, entryPoint: 'web', certResolver: null, manage: true },
    });
  });
});

describe('shared helpers', () => {
  test('isPlainMap accepts YAML mappings only', () => {
    expect(isPlainMap({})).toBe(true);
    expect(isPlainMap({ a: 1 })).toBe(true);
    expect(isPlainMap(Object.create(null))).toBe(true);
    for (const value of [null, undefined, [], 'x', 1, new Date(0), new Uint8Array(1), new Map()]) {
      expect(isPlainMap(value)).toBe(false);
    }
  });

  test('sorting uses code units, never locale order', () => {
    expect(sortedKeys({ b: 1, B: 2, _x: 3, '-x': 4, a: 5 })).toEqual(['-x', 'B', '_x', 'a', 'b']);
    expect(sortedUnique(['web', 'Web', 'api', 'web'])).toEqual(['Web', 'api', 'web']);
    expect(['pg_data', 'pg-data'].sort(compareCodeUnits)).toEqual(['pg-data', 'pg_data']);
  });

  test('paths follow the design-01 0.3 key rule', () => {
    expect(childPath('services', 'web')).toBe('services.web');
    expect(childPath('services', 'web_app')).toBe('services.web_app');
    expect(childPath('services', '2fa')).toBe('services["2fa"]');
    expect(childPath('services.web.labels', 'com.example.team')).toBe('services.web.labels["com.example.team"]');
    expect(childPath('services.web.environment', 'DB_HOST')).toBe('services.web.environment.DB_HOST');
    expect(childPath('', 'services')).toBe('services');
    expect(pathKey('x-dockflow')).toBe('x-dockflow');
    expect(pathKey('my label')).toBe('["my label"]');
    expect(indexPath('services.web.ports', 1)).toBe('services.web.ports[1]');
  });
});

describe('builders (design-07 4.1)', () => {
  test('a body without services: belongs to service web', () => {
    expect(
      composeYaml(`
        image: nginx:1.27
        ports:
          - "8080:80"
      `),
    ).toBe('services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n');
    expect(composeYaml('services:\n  api:\n    image: api:1')).toBe('services:\n  api:\n    image: api:1\n');
    expect(parsedCompose().services).toEqual({ web: { image: 'nginx:1.27' } });
    expect(parsedCompose({ image: 'redis:7' }).services).toEqual({ web: { image: 'redis:7' } });
    expect(parsedCompose({ services: { db: { image: 'postgres:16' } } }).services).toEqual({ db: { image: 'postgres:16' } });
  });

  test('normalizeInput fills every field with the design-07 defaults', () => {
    const input = normalizeInput();
    expect(input.role).toBe('app');
    expect(input.identity).toEqual({
      project: 'shop',
      env: 'production',
      stackName: 'shop-production',
      namespace: 'dockflow-shop-production',
      version: '1.4.2',
    });
    expect(input.proxy).toBeUndefined();
    expect(input.sibling).toEqual({ services: [], volumes: [], middlewares: [] });
    expect(input.serverNames).toEqual(['server_1', 'agent_1']);
    expect(input.imageDelivery).toBe('import');
    expect(input.traits).toEqual(k3sDistribution.traits);
    expect(input.traits).not.toBe(k3sDistribution.traits);
    expect(input.files('anything')).toEqual({ ok: false, reason: 'missing' });
    expect(input.sink.list()).toEqual([]);
    expect(normalizeInput().sink).not.toBe(input.sink);
    expect(normalizeInput({ identity: { project: 'blog', env: 'staging' } }).identity.namespace).toBe('dockflow-blog-staging');
  });
});
