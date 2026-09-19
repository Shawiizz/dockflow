import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import {
  CODE_EMITTERS,
  COMPOSE_SPEC_PIN,
  codeEmitters,
  damerauLevenshtein,
  isNormalizeCode,
  KEY_AREAS,
  KEY_POLICIES,
  KEY_REGISTRY,
  type KeyHandler,
  type KeyPolicy,
  lookupPolicy,
  NORMALIZE_CODES,
  normalizeCode,
  suggestKey,
  walkKeys,
} from '../../../services/orchestrator/kubernetes/normalize/keys';
import { TRANSLATOR_CODES } from '../../../services/orchestrator/kubernetes/translate/diagnostics';
import { parsedCompose } from '../support/builders';

const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'compose-spec');

const UNKNOWN_MESSAGE = `is not known to this Dockflow release, which follows the Compose specification of ${COMPOSE_SPEC_PIN.date}`;
const UNKNOWN_HINT =
  'Check the spelling; if the key was added to the Compose specification after that date, upgrade Dockflow, and put Kubernetes-only settings under `x-dockflow` (see the Kubernetes page of the docs).';

function walk(raw: unknown, registry: readonly KeyPolicy[] = KEY_REGISTRY): Diagnostic[] {
  const sink = new DiagnosticSink();
  walkKeys(raw, registry, sink);
  return sink.list();
}

/** Walks a document loaded through the real loader (anchors, merge keys and source text resolved). */
function walkYaml(source: string): Diagnostic[] {
  return walk(parsedCompose(source).raw);
}

function unknownAt(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.code === 'keys.unknown').map((d) => d.path);
}

function service(body: Record<string, unknown>): Record<string, unknown> {
  return { services: { web: { image: 'nginx:1.29', ...body } } };
}

describe('KEY_REGISTRY as data (R-S1-01, R-S1-02)', () => {
  const policies = new Set(['translate', 'translate-with-warning', 'reject']);
  const handlers = new Set([
    'index',
    'identity',
    'security',
    'env',
    'ports',
    'volumes',
    'files',
    'healthcheck',
    'deploy',
    'network',
    'extension',
    'routing',
  ]);
  const areas = new Set(KEY_AREAS.map((a) => a.area));

  test('KEY_POLICIES is the registry and survives a JSON round trip', () => {
    expect(KEY_POLICIES).toBe(KEY_REGISTRY);
    expect(JSON.parse(JSON.stringify(KEY_POLICIES))).toEqual([...KEY_POLICIES]);
  });

  test('every path is declared once', () => {
    const paths = KEY_REGISTRY.map((p) => p.path);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  test('every entry carries the registry and docs fields (U-KEYS-06)', () => {
    for (const p of KEY_REGISTRY) {
      const where = `${p.path}: `;
      expect(`${where}${policies.has(p.policy)}`).toBe(`${where}true`);
      expect(`${where}${handlers.has(p.handler)}`).toBe(`${where}true`);
      expect(`${where}${areas.has(p.area)}`).toBe(`${where}true`);
      expect(`${where}${['supported', 'ignored', 'rejected'].includes(p.swarm)}`).toBe(`${where}true`);
      expect(`${where}${typeof p.whole}/${typeof p.freeform}`).toBe(`${where}boolean/boolean`);
      expect(`${where}${p.table.length > 0 && p.k3s.length > 0}`).toBe(`${where}true`);
      expect(Array.isArray(p.codes)).toBe(true);
      if (p.note !== undefined) expect(`${where}${p.note.length > 0 && !p.note.endsWith('.')}`).toBe(`${where}true`);
      if (p.effect !== undefined) expect(p.effect).toBe('none');
      for (const key of p.xDockflow ?? []) expect(key).toMatch(/^[a-z_]+$/);
    }
  });

  test('an entry that changes no object explains why in its note', () => {
    for (const p of KEY_REGISTRY.filter((entry) => entry.effect === 'none' || entry.table === 'T0')) {
      expect(`${p.path}: ${p.effect}`).toBe(`${p.path}: none`);
      expect(`${p.path}: ${(p.note ?? '').length > 0}`).toBe(`${p.path}: true`);
    }
  });

  test('every code of an entry is a normalizer code, listed once per emitter', () => {
    for (const p of KEY_REGISTRY) {
      for (const { emitter, codes } of codeEmitters(p)) {
        for (const code of codes) expect(`${p.path} ${code} ${isNormalizeCode(code)}`).toBe(`${p.path} ${code} true`);
        expect(`${p.path} ${emitter}: ${codes.filter((c, i) => codes.indexOf(c) !== i).join(', ')}`).toBe(`${p.path} ${emitter}: `);
      }
    }
  });

  test('otherEmitters names other files than the handler, each with codes', () => {
    for (const p of KEY_REGISTRY) {
      for (const [emitter, codes] of Object.entries(p.otherEmitters ?? {})) {
        expect(`${p.path}: ${emitter}`).not.toBe(`${p.path}: ${p.handler}`);
        expect(`${p.path}: ${(CODE_EMITTERS as readonly string[]).includes(emitter)}`).toBe(`${p.path}: true`);
        expect(`${p.path} ${emitter}: ${(codes ?? []).length > 0}`).toBe(`${p.path} ${emitter}: true`);
      }
    }
  });

  test('a refused key has an error code of its own', () => {
    for (const p of KEY_REGISTRY.filter((entry) => entry.policy === 'reject')) {
      const errors = p.codes.filter((code) => normalizeCode(code)?.severity === 'error');
      expect(`${p.path}: ${errors.length > 0}`).toBe(`${p.path}: true`);
    }
  });

  test('build keys the builder warns about have no normalizer code (IMG-09)', () => {
    const external = KEY_REGISTRY.filter((p) => p.table === 'IMG-09');
    expect(external.length).toBeGreaterThan(0);
    for (const p of external) {
      expect(p.path.startsWith('services.*.build.')).toBe(true);
      expect(p.policy).toBe('translate-with-warning');
      expect(codeEmitters(p)).toEqual([]);
      expect(p.swarm).toBe('ignored');
    }
  });

  test('keys known to Compose but not implemented use their own unsupported code, never keys.unknown', () => {
    const expected: Record<string, string> = {
      include: 'unsupported.include',
      models: 'unsupported.models',
      jobs: 'unsupported.jobs',
      'services.*.models': 'unsupported.models',
      'services.*.profiles': 'unsupported.profiles',
      'services.*.provider': 'unsupported.provider',
      'services.*.extends': 'unsupported.extends',
      'services.*.pre_start': 'unsupported.pre-start',
      'services.*.volumes_from': 'unsupported.volumes-from',
      'services.*.container_name': 'unsupported.container-name',
    };
    for (const [path, code] of Object.entries(expected)) {
      expect(lookupPolicy(path)?.codes).toContain(code);
    }
    for (const p of KEY_REGISTRY) expect(p.codes).not.toContain('keys.unknown');
    for (const p of KEY_REGISTRY.filter((entry) => entry.policy === 'reject')) {
      expect(`${p.path}: ${p.note ?? ''}`).not.toContain('unknown');
    }
  });

  test('every subtree the walker must not descend is whole or freeform', () => {
    const stops = (path: string): boolean => {
      const p = lookupPolicy(path);
      return p !== null && p.path === path && (p.whole || p.freeform);
    };
    for (const path of [
      'include',
      'models',
      'jobs',
      'services.*.develop',
      'services.*.extends',
      'services.*.provider',
      'services.*.models',
      'services.*.pre_start',
      'services.*.x-dockflow',
      'volumes.*.x-dockflow',
      'services.*.environment',
      'services.*.labels',
      'services.*.annotations',
      'services.*.deploy.labels',
      'services.*.build.args',
      'services.*.sysctls',
      'services.*.extra_hosts',
      'services.*.ulimits',
      'services.*.logging',
      'services.*.deploy.rollback_config',
      'volumes.*.labels',
      'volumes.*.driver_opts',
    ]) {
      expect(`${path}: ${stops(path)}`).toBe(`${path}: true`);
    }
  });

  test('KEY_AREAS lists each area once and every area is used', () => {
    const listed = KEY_AREAS.map((a) => a.area);
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(KEY_REGISTRY.map((p) => p.area))).toEqual(new Set(listed));
  });
});

describe('code emitters (design-01 1.1, 1.4 step 3)', () => {
  function policy(path: string): KeyPolicy {
    const found = lookupPolicy(path);
    if (found === null || found.path !== path) throw new Error(`no entry ${path}`);
    return found;
  }

  function byEmitter(path: string): Record<string, readonly string[]> {
    return Object.fromEntries(codeEmitters(policy(path)).map((group) => [group.emitter, group.codes]));
  }

  /** design-01 1.1 rows 6-15, with `logging` and `pull_refresh_after` read next to their neighbours */
  const READERS: Record<KeyHandler, readonly string[]> = {
    index: [],
    identity: [
      'image',
      'build',
      'pull_policy',
      'pull_refresh_after',
      'platform',
      'container_name',
      'labels',
      'label_file',
      'annotations',
      'profiles',
      'provider',
      'extends',
      'models',
      'develop',
      'attach',
      'entrypoint',
      'command',
      'working_dir',
      'tty',
      'stdin_open',
      'init',
      'stop_grace_period',
      'stop_signal',
      'post_start',
      'pre_stop',
      'pre_start',
    ],
    security: [
      'user',
      'group_add',
      'privileged',
      'cap_add',
      'cap_drop',
      'read_only',
      'security_opt',
      'sysctls',
      'pid',
      'ipc',
      'uts',
      'userns_mode',
      'cgroup',
      'cgroup_parent',
      'devices',
      'device_cgroup_rules',
      'gpus',
      'ulimits',
      'oom_score_adj',
      'oom_kill_disable',
      'runtime',
      'isolation',
      'credential_spec',
      'storage_opt',
      'use_api_socket',
      'blkio_config',
      'logging',
    ],
    env: ['env_file', 'environment'],
    ports: ['ports', 'expose'],
    volumes: ['volumes', 'tmpfs', 'shm_size', 'volumes_from'],
    files: ['secrets', 'configs'],
    healthcheck: ['healthcheck'],
    deploy: [
      'deploy',
      'scale',
      'restart',
      'depends_on',
      'cpus',
      'cpu_count',
      'cpu_percent',
      'cpu_period',
      'cpu_quota',
      'cpu_rt_period',
      'cpu_rt_runtime',
      'cpu_shares',
      'cpuset',
      'mem_limit',
      'mem_reservation',
      'mem_swappiness',
      'memswap_limit',
      'pids_limit',
    ],
    network: [
      'networks',
      'links',
      'external_links',
      'network_mode',
      'hostname',
      'domainname',
      'dns',
      'dns_search',
      'dns_opt',
      'extra_hosts',
      'mac_address',
    ],
    extension: ['x-dockflow'],
    routing: [],
  };

  test('every service key is registered under the module that reads it', () => {
    const reader = new Map<string, KeyHandler>();
    for (const [handler, keys] of Object.entries(READERS) as [KeyHandler, readonly string[]][]) {
      for (const key of keys) reader.set(key, handler);
    }
    for (const key of reader.keys()) policy(`services.*.${key}`);
    for (const p of KEY_REGISTRY) {
      const m = /^services\.\*\.([^.[]+)/.exec(p.path);
      if (m === null) continue;
      // deploy.labels are label maps (design-01 1.1 row 6)
      const expected = p.path.startsWith('services.*.deploy.labels') ? 'identity' : reader.get(m[1]);
      expect(`${p.path}: ${p.handler}`).toBe(`${p.path}: ${expected}`);
    }
  });

  test('codes only routing.ts, the stack checks or index.ts emit are never listed under a handler', () => {
    // `unsupported.models` is index.ts' at top level and the identity handler's under a service
    const indexOnly = new Set(['names.invalid-service-key', 'services.not-a-mapping']);
    for (const p of KEY_REGISTRY) {
      for (const code of p.codes) {
        const module = normalizeCode(code)?.module ?? '';
        const emitter = indexOnly.has(code) ? 'index' : module === 'routing' || module === 'stack-checks' ? module : p.handler;
        expect(`${p.path} ${code}: ${p.handler}`).toBe(`${p.path} ${code}: ${emitter}`);
      }
    }
  });

  test('the handler comes first, then the other files in CODE_EMITTERS order', () => {
    expect(codeEmitters(policy('services.*')).map((group) => group.emitter)).toEqual(['identity', 'index', 'env', 'routing', 'stack-checks']);
    const silent = { ...policy('services.*'), codes: [] };
    expect(codeEmitters(silent).map((group) => group.emitter)).toEqual(['index', 'env', 'routing', 'stack-checks']);
    expect(codeEmitters({ ...silent, otherEmitters: { routing: [] } })).toEqual([]);
  });

  test('service-level codes sit with index.ts, the stack checks and routing.ts', () => {
    const service = byEmitter('services.*');
    expect(service.index).toEqual(['names.invalid-service-key', 'services.not-a-mapping']);
    expect(service['stack-checks']).toEqual(['names.role-collision', 'names.sanitize-collision', 'names.derived-collision']);
    expect(service.routing).toContain('routing.injection-disabled');
    expect(service.routing).toContain('routing.duplicate-injected-host');
    expect(service.identity).toContain('names.sanitized');
    for (const path of ['services.*.labels', 'services.*.deploy.labels']) {
      const labels = byEmitter(path);
      expect(labels.identity.filter((code) => code.startsWith('routing.') || code.startsWith('names.middleware-'))).toEqual([]);
      expect(labels.routing).toContain('routing.missing-rule');
      expect(labels.routing).toContain('names.middleware-collision');
      expect(labels.routing).toContain('values.invalid-integer');
    }
    expect(byEmitter('services.*.ports').routing).toEqual(['routing.injected-first-port', 'routing.duplicate-injected-host']);
    expect(byEmitter('services.*.networks.*.aliases')['stack-checks']).toEqual(['names.sanitize-collision', 'names.derived-collision']);
    expect(byEmitter('volumes.*')['stack-checks']).toContain('volumes.unused');
    expect(byEmitter('secrets.*')['stack-checks']).toContain('files.unused');
  });

  test('engine-level resource keys are the deploy handler codes (design-01 1.1 row 13)', () => {
    for (const key of ['cpu_count', 'cpu_percent']) expect(byEmitter(`services.*.${key}`)).toEqual({ deploy: ['resources.windows-only'] });
    for (const key of ['mem_swappiness', 'memswap_limit']) expect(byEmitter(`services.*.${key}`)).toEqual({ deploy: ['resources.swap-ignored'] });
    expect(normalizeCode('resources.swap-ignored')?.module).toBe('deploy');
  });

  test('namespace modes other than the documented ones are refused for every namespace key', () => {
    for (const key of ['pid', 'ipc', 'uts', 'cgroup']) expect(policy(`services.*.${key}`).codes).toContain('security.invalid-namespace-mode');
  });

  test('network codes are listed where the network handler reports them', () => {
    expect(policy('services.*.network_mode').codes).toEqual(
      expect.arrayContaining(['network.undeclared', 'network.flat', 'values.empty', 'values.invalid-type']),
    );
    expect(policy('networks').codes).toContain('network.flat');
    expect(policy('networks.*').codes).toEqual(expect.arrayContaining(['networks.not-needed', 'networks.external-cross-stack']));
    for (const key of ['internal', 'enable_ipv6']) {
      expect(policy(`networks.*.${key}`).codes).toEqual(expect.arrayContaining(['values.invalid-boolean', 'values.yaml11-boolean']));
    }
    // a malformed entry is network.invalid-extra-host; a repeated host is a valid hosts file
    expect(policy('services.*.extra_hosts').codes).toEqual(['network.invalid-extra-host', 'network.host-gateway-unsupported', 'values.invalid-type']);
    for (const path of ['services.*.hostname', 'services.*.dns_opt', 'services.*.networks.*.aliases', 'services.*.links', 'services.*.ports[].target']) {
      expect(policy(path).codes).toContain('values.empty');
    }
    for (const key of ['expose', 'dns', 'dns_search', 'links', 'external_links', 'domainname', 'extra_hosts']) {
      expect(policy(`services.*.${key}`).codes).toContain('values.invalid-type');
    }
  });
});

describe('NORMALIZE_CODES', () => {
  const codes = NORMALIZE_CODES.map((c) => c.code);

  test('codes are unique, well formed and have one severity', () => {
    expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
    for (const entry of NORMALIZE_CODES) {
      expect(entry.code).toMatch(/^[a-z][a-z_]*\.[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(['error', 'warning', 'info']).toContain(entry.severity);
    }
  });

  test('the walker and interpolation codes are listed with their severities', () => {
    expect(normalizeCode('keys.unknown')).toEqual({ code: 'keys.unknown', severity: 'error', module: 'keys' });
    expect(normalizeCode('extension.misplaced')).toEqual({ code: 'extension.misplaced', severity: 'error', module: 'keys' });
    for (const code of ['interpolate.unset', 'interpolate.required', 'interpolate.invalid']) {
      expect(normalizeCode(code)).toEqual({ code, severity: 'error', module: 'interpolate' });
    }
    expect(normalizeCode('no.such-code')).toBeNull();
    expect(isNormalizeCode('no.such-code')).toBe(false);
  });

  test('PD-6: routing.web-served-with-acme is a normalizer warning', () => {
    expect(normalizeCode('routing.web-served-with-acme')).toEqual({
      code: 'routing.web-served-with-acme',
      severity: 'warning',
      module: 'routing',
    });
  });

  test('DESIGN-CORE 8.2: disjoint from the translator catalogue', () => {
    const translator = new Set<string>(TRANSLATOR_CODES.map((entry) => entry.code));
    expect(codes.filter((code) => translator.has(code))).toEqual([]);
    const listed = KEY_REGISTRY.flatMap((p) => codeEmitters(p).flatMap((group) => group.codes));
    expect(listed.filter((code) => translator.has(code))).toEqual([]);
  });

  test('design-01 1.6: codes owned by the translator or deleted are never normalizer codes', () => {
    const notHere = [
      // translator-owned (1.6 shared conditions)
      'security.privileged',
      'network.host-network',
      'ports.host-port-replicas',
      'ports.host-duplicate-target',
      'ports.no-published-port',
      'ports.publish-none',
      'ports.reserved-host-port',
      'ports.published-conflict',
      'ports.host-ip-unsupported',
      'volumes.docker-socket',
      'volumes.rwo-replicas',
      'volumes.rwo-global',
      'volumes.rwo-shared',
      'files.too-large',
      'resources.request-exceeds-limit',
      'deploy.restart-policy-unsupported',
      'placement.max-replicas-approximate',
      'network.dns-secondary',
      'process.init-shared-pid',
      // deleted spellings
      'mounts.docker-socket',
      'volumes.shared-rwo',
      'extension.per-replica-shared',
      'volumes.rwx-local',
      'mounts.create-host-path-unenforced',
      'mounts.bidirectional-needs-privileged',
      'deploy.order-overridden',
      'network.dns-after-cluster-dns',
      'network.dns-truncated',
      'network.hostname-fqdn',
      'network.extra-host-invalid',
      'network.dns-search-limit',
      'environment.too-large',
      'environment.name-unsupported',
      'labels.reserved-key',
      'labels.annotations-too-large',
      'files.owner-unsupported',
      'process.init-shared-namespace',
      'ports.lb-source-ranges-unused',
      'ports.not-published',
      'volumes.external-options-ignored',
      'volumes.no-copy-up',
      'resources.reservation-exceeds-limit',
      'security.sysctl-unsafe',
      'routing.middleware-undefined',
      'update.delay-ignored',
      'update.max-failure-ratio-ignored',
      'update.failure-action-ignored',
      'update.job-ignored',
      'deploy.job-restart-any',
      'build.key-ignored',
    ];
    for (const code of notHere) expect(`${code} ${isNormalizeCode(code)}`).toBe(`${code} false`);
  });

  test('design-01 1.6: normalizer-owned shared conditions are normalizer codes', () => {
    for (const code of [
      'image.pull-policy-imported',
      'ports.duplicate',
      'volumes.copy-up-not-emulated',
      'volumes.anonymous-emptydir',
      'resources.pids-unsupported',
      'security.unsafe-sysctl',
      'security.host-sysctl',
      'security.invalid-sysctl',
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
      'network.too-many-dns',
      'network.invalid-hostname',
      'network.invalid-extra-host',
      'network.too-many-dns-search',
      'labels.reserved',
      'labels.too-large',
      'files.ownership-ignored',
      'extension.publish-unused',
      'extension.external-volume',
      'process.empty-command',
      'deploy.update-delay',
      'deploy.max-failure-ratio',
      'deploy.failure-action',
      'deploy.rollback-config',
      'deploy.statefulset-pacing',
      'deploy.update-config-on-job',
    ]) {
      expect(`${code} ${isNormalizeCode(code)}`).toBe(`${code} true`);
    }
  });
});

describe('vendored Compose specification', () => {
  test('the pin, README.md and keys.json agree on commit and date', () => {
    const readme = readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8');
    expect(readme).toContain(`- Commit: \`${COMPOSE_SPEC_PIN.commit}\``);
    expect(readme).toContain(`- Date: ${COMPOSE_SPEC_PIN.date}`);
    const keys = JSON.parse(readFileSync(join(FIXTURE_DIR, 'keys.json'), 'utf8')) as {
      commit: string;
      date: string;
      paths: string[];
    };
    expect(keys.commit).toBe(COMPOSE_SPEC_PIN.commit);
    expect(keys.date).toBe(COMPOSE_SPEC_PIN.date);
    expect(COMPOSE_SPEC_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(COMPOSE_SPEC_PIN.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(keys.paths).toContain('services.*.deploy.resources.limits.cpus');
    expect(keys.paths).toContain('services.*.volumes[].bind.propagation');
  });
});

describe('lookupPolicy', () => {
  test('registry patterns and document segments find the same entry', () => {
    expect(lookupPolicy('services.*.image')?.path).toBe('services.*.image');
    expect(lookupPolicy(['services', 'web', 'image'])?.path).toBe('services.*.image');
    expect(lookupPolicy('services.web.image')?.path).toBe('services.*.image');
    expect(lookupPolicy('services.*.ports[].target')?.path).toBe('services.*.ports[].target');
    expect(lookupPolicy(['services', 'web', 'ports', 2, 'target'])?.path).toBe('services.*.ports[].target');
    expect(lookupPolicy(['services', 'web', 'ports', '[]', 'target'])?.path).toBe('services.*.ports[].target');
    expect(lookupPolicy(['volumes', 'data', 'external', 'name'])?.path).toBe('volumes.*.external.name');
    expect(lookupPolicy([])).toBeNull();
  });

  test('a key below a whole or freeform entry gets that entry', () => {
    expect(lookupPolicy(['services', 'web', 'environment', 'DB_HOST'])?.path).toBe('services.*.environment');
    expect(lookupPolicy(['services', 'web', 'labels', 'traefik.http.routers.web.rule'])?.path).toBe('services.*.labels');
    expect(lookupPolicy(['services', 'web', 'develop', 'watch', 0, 'path'])?.path).toBe('services.*.develop');
    expect(lookupPolicy(['services', 'web', 'x-dockflow', 'probes', 'readiness'])?.path).toBe('services.*.x-dockflow');
    expect(lookupPolicy(['volumes', 'data', 'x-dockflow', 'size'])?.path).toBe('volumes.*.x-dockflow');
    expect(lookupPolicy(['jobs', 'nightly', 'triggers', 'schedule', 0, 'cron'])?.path).toBe('jobs');
  });

  test('an unknown key, an extension field or a list item without an entry is null', () => {
    expect(lookupPolicy(['services', 'web', 'imagee'])).toBeNull();
    expect(lookupPolicy(['servics'])).toBeNull();
    expect(lookupPolicy(['services', 'web', 'x-note'])).toBeNull();
    expect(lookupPolicy(['x-common'])).toBeNull();
    expect(lookupPolicy(['services', 'web', 'ports', 0])).toBeNull();
    expect(lookupPolicy(['services', 'web', 'image', 'nested'])).toBeNull();
  });

  test('entries carry their policy', () => {
    expect(lookupPolicy('include')?.policy).toBe('reject');
    expect(lookupPolicy('name')?.policy).toBe('translate-with-warning');
    expect(lookupPolicy('services.*.image')?.policy).toBe('translate');
    expect(lookupPolicy('services.*.deploy.update_config.monitor')?.handler).toBe('deploy');
  });

  test('a custom registry is looked up on its own', () => {
    const registry = [KEY_REGISTRY[0]];
    expect(lookupPolicy(KEY_REGISTRY[0].path, registry)).toBe(KEY_REGISTRY[0]);
    expect(lookupPolicy('services.*.image', registry)).toBeNull();
  });
});

describe('walkKeys', () => {
  test('a document of known keys produces nothing', () => {
    const diagnostics = walkYaml(`services:
  web:
    image: nginx:1.29
    command: ["nginx", "-g", "daemon off;"]
    environment: {DB_HOST: db}
    ports: ["80:80", {target: 443, published: 443, protocol: tcp, mode: host}]
    volumes: [data:/data, {type: bind, source: /srv, target: /srv, bind: {propagation: rshared}}]
    secrets: [db_password, {source: api_key, target: /run/api_key, mode: 0400}]
    healthcheck: {test: ["CMD", "true"], interval: 10s}
    deploy:
      replicas: 2
      resources: {limits: {cpus: "0.5", memory: 256M}}
      update_config: {parallelism: 1, order: start-first}
      placement: {constraints: [node.role == manager], preferences: [{spread: node.labels.zone}]}
    depends_on: {db: {condition: service_started}}
    networks: {front: {aliases: [www]}}
  db:
    image: postgres:16
    depends_on: [web]
    networks: [front]
volumes:
  data: {labels: {team: core}}
secrets:
  db_password: {file: ./db.txt}
  api_key: {external: true}
configs:
  app: {content: "a=b"}
networks:
  front: {external: {name: shared}}
`);
    expect(diagnostics).toEqual([]);
  });

  test('TOP-11: a misspelt top-level key names the vendor date and suggests the key', () => {
    expect(walk({ servics: { web: { image: 'nginx:1.29' } } })).toEqual([
      {
        severity: 'error',
        code: 'keys.unknown',
        path: 'servics',
        message: UNKNOWN_MESSAGE,
        hint: `Did you mean \`services\`? ${UNKNOWN_HINT}`,
      },
    ]);
  });

  test('TOP-11: a key far from every known key gets the hint without a suggestion', () => {
    expect(walk(service({ future_key: 1 }))).toEqual([
      { severity: 'error', code: 'keys.unknown', path: 'services.web.future_key', message: UNKNOWN_MESSAGE, hint: UNKNOWN_HINT },
    ]);
  });

  test('the message never claims the key is absent from the specification', () => {
    const [d] = walk(service({ future_key: 1 }));
    expect(d.message).not.toContain('does not exist');
    expect(d.message).toContain(COMPOSE_SPEC_PIN.date);
  });

  test('N-IDX-01: a service key one edit away is suggested', () => {
    const [d] = walk(service({ imagee: 'x' }));
    expect(d.path).toBe('services.web.imagee');
    expect(d.hint?.startsWith('Did you mean `image`? ')).toBe(true);
  });

  test('suggestions come from the keys of the same mapping only', () => {
    const [bind] = walk(service({ volumes: [{ type: 'bind', source: '/a', target: '/a', bind: { propogation: 'rshared' } }] }));
    expect(bind.path).toBe('services.web.volumes[0].bind.propogation');
    expect(bind.hint?.startsWith('Did you mean `propagation`? ')).toBe(true);

    // `image` is a service key, not a deploy key
    const [deploy] = walk(service({ deploy: { imag: 'x' } }));
    expect(deploy.path).toBe('services.web.deploy.imag');
    expect(deploy.hint).toBe(UNKNOWN_HINT);
  });

  test('U-KEYS-04: unknown keys are reported at every object level', () => {
    const raw = {
      services: {
        web: {
          image: 'nginx:1.29',
          bogus: 1,
          deploy: {
            bogus: 1,
            resources: { bogus: 1, limits: { bogus: 1 }, reservations: { bogus: 1 } },
            update_config: { bogus: 1 },
            restart_policy: { bogus: 1 },
            placement: { bogus: 1, preferences: [{ bogus: 1 }] },
          },
          healthcheck: { bogus: 1 },
          volumes: [{ type: 'volume', source: 'data', target: '/data', bogus: 1, volume: { bogus: 1 } }],
          ports: [{ target: 80, bogus: 1 }],
          secrets: [{ source: 's', bogus: 1 }],
          configs: [{ source: 'c', bogus: 1 }],
          env_file: [{ path: '.env', bogus: 1 }],
          depends_on: { db: { bogus: 1 } },
          networks: { front: { bogus: 1 } },
          post_start: [{ command: 'true', bogus: 1 }],
          build: { context: '.', bogus: 1 },
        },
      },
      volumes: { data: { bogus: 1, external: { bogus: 1 } } },
      secrets: { s: { file: 's.txt', bogus: 1 } },
      configs: { c: { file: 'c.txt', bogus: 1 } },
      networks: { front: { bogus: 1 } },
      bogus: 1,
    };
    expect(unknownAt(walk(raw))).toEqual([
      'bogus',
      'configs.c.bogus',
      'networks.front.bogus',
      'secrets.s.bogus',
      'services.web.bogus',
      'services.web.build.bogus',
      'services.web.configs[0].bogus',
      'services.web.depends_on.db.bogus',
      'services.web.deploy.bogus',
      'services.web.deploy.placement.bogus',
      'services.web.deploy.placement.preferences[0].bogus',
      'services.web.deploy.resources.bogus',
      'services.web.deploy.resources.limits.bogus',
      'services.web.deploy.resources.reservations.bogus',
      'services.web.deploy.restart_policy.bogus',
      'services.web.deploy.update_config.bogus',
      'services.web.env_file[0].bogus',
      'services.web.healthcheck.bogus',
      'services.web.networks.front.bogus',
      'services.web.ports[0].bogus',
      'services.web.post_start[0].bogus',
      'services.web.secrets[0].bogus',
      'services.web.volumes[0].bogus',
      'services.web.volumes[0].volume.bogus',
      'volumes.data.bogus',
      'volumes.data.external.bogus',
    ]);
  });

  test('old Compose file format keys are unknown too (volume_driver, net)', () => {
    expect(unknownAt(walk(service({ volume_driver: 'local', net: 'host', cpu_quota: 50000 })))).toEqual([
      'services.web.net',
      'services.web.volume_driver',
    ]);
  });

  test('keys that are not identifiers are quoted in the path', () => {
    expect(unknownAt(walk(service({ 'my key': 1, 'a.b': 2 })))).toEqual(['services.web["a.b"]', 'services.web["my key"]']);
  });

  test('whole subtrees are left to their handler (MISC-01..07, TOP-03, TOP-07, TOP-08)', () => {
    const raw = {
      include: [{ path: 'a.yml', bogus: 1 }],
      models: { m: { model: 'ai/x', bogus: 1 } },
      jobs: { j: { image: 'x', triggers: { manual: true, bogus: 1 } } },
      services: {
        web: {
          image: 'nginx:1.29',
          develop: { watch: [{ path: '.', action: 'sync', bogus: 1 }] },
          extends: { service: 'base', file: 'base.yml', bogus: 1 },
          provider: { type: 'x', options: { anything: 1 } },
          models: { m: { endpoint_var: 'URL', bogus: 1 } },
          pre_start: [{ command: 'x', bogus: 1 }],
          logging: { driver: 'json-file', options: { 'max-size': '10m' }, bogus: 1 },
          ulimits: { nofile: { soft: 1, hard: 2, bogus: 1 } },
          deploy: { rollback_config: { bogus: 1 }, resources: { reservations: { devices: [{ bogus: 1 }] } } },
          'x-dockflow': { kind: 'statefulset', anything: { deep: 1 } },
        },
      },
      volumes: { data: { 'x-dockflow': { size: '5Gi', anything: 1 }, driver_opts: { type: 'nfs', bogus: 1 } } },
    };
    expect(walk(raw)).toEqual([]);
  });

  test('freeform maps take any key (environment, labels, sysctls, build args, extra_hosts...)', () => {
    const raw = {
      services: {
        web: {
          image: 'nginx:1.29',
          environment: { future_key: 1, 'x-dockflow': 'a' },
          labels: { 'com.example.team': 'core', 'x-dockflow': 'b' },
          annotations: { anything: 'x' },
          sysctls: { 'net.core.somaxconn': 1024 },
          extra_hosts: { 'db.local': '10.0.0.2' },
          build: { context: '.', args: { TOKEN: 'x' } },
          deploy: { labels: { 'traefik.enable': 'true' } },
        },
      },
      volumes: { data: { labels: { anything: 'x' } } },
    };
    expect(walk(raw)).toEqual([]);
  });

  test('x-* extension fields are skipped wherever the keys are not names', () => {
    const raw = {
      'x-common': { bogus: { deeper: 1 } },
      services: {
        web: {
          image: 'nginx:1.29',
          'x-future-key': 1,
          deploy: { 'x-note': 1, resources: { limits: { 'x-note': 1 } } },
          ports: [{ target: 80, 'x-note': 1 }],
        },
      },
      volumes: { data: { 'x-note': 1 } },
      networks: { front: { 'x-note': 1 } },
    };
    expect(walk(raw)).toEqual([]);
  });

  test('TOP-10: x-dockflow outside a service or a top-level volume is misplaced', () => {
    const raw = {
      'x-dockflow': {},
      services: { web: { image: 'nginx:1.29', deploy: { 'x-dockflow': { kind: 'deployment' } }, ports: [{ target: 80, 'x-dockflow': {} }] } },
      networks: { front: { 'x-dockflow': {} } },
      secrets: { s: { file: 's.txt', 'x-dockflow': {} } },
    };
    const diagnostics = walk(raw);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['extension.misplaced', 'networks.front.x-dockflow'],
      ['extension.misplaced', 'secrets.s.x-dockflow'],
      ['extension.misplaced', 'services.web.deploy.x-dockflow'],
      ['extension.misplaced', 'services.web.ports[0].x-dockflow'],
      ['extension.misplaced', 'x-dockflow'],
    ]);
    expect(diagnostics[4]).toEqual({
      severity: 'error',
      code: 'extension.misplaced',
      path: 'x-dockflow',
      message: 'x-dockflow is not allowed here',
      hint: 'Put `x-dockflow` under a service (`services.<name>.x-dockflow`) or a volume (`volumes.<name>.x-dockflow`).',
    });
  });

  test('where keys are names, an x- key is a name and is walked as such', () => {
    const raw = {
      services: { 'x-api': { image: 'nginx:1.29', bogus: 1 } },
      volumes: { 'x-data': { bogus: 1 } },
    };
    expect(unknownAt(walk(raw))).toEqual(['services.x-api.bogus', 'volumes.x-data.bogus']);
  });

  test('values of the wrong type are left to the handlers', () => {
    expect(walk({ services: [] })).toEqual([]);
    expect(walk({ services: { web: null } })).toEqual([]);
    expect(walk(service({ deploy: 'x', ports: { a: 1 }, image: { nested: { bogus: 1 } }, command: [{ bogus: 1 }] }))).toEqual([]);
    expect(walk(null)).toEqual([]);
    expect(walk(['services'])).toEqual([]);
    expect(walk('services')).toEqual([]);
  });

  test('string and object forms of one key share their entries', () => {
    expect(walk(service({ build: '.', env_file: ['.env', { path: '.env.local', required: false }] }))).toEqual([]);
    expect(walk(service({ depends_on: ['db'], networks: ['front'], ports: ['80:80', 443] }))).toEqual([]);
  });

  test('merge keys and anchors are resolved by the loader before the walk', () => {
    const diagnostics = walkYaml(`services:
  base: &base
    image: nginx:1.29
    restart: always
  web:
    <<: *base
    ports: ["80:80"]
`);
    expect(diagnostics).toEqual([]);
  });

  test('the report does not depend on the key order of the document', () => {
    const a = { services: { web: { image: 'x', zeta: 1, alpha: 2 } }, omega: 1 };
    const b = { omega: 1, services: { web: { alpha: 2, zeta: 1, image: 'x' } } };
    expect(walk(a)).toEqual(walk(b));
    expect(unknownAt(walk(a))).toEqual(['omega', 'services.web.alpha', 'services.web.zeta']);
  });

  test('a registry that declares a path twice is a programming error', () => {
    const entry = KEY_REGISTRY[0];
    expect(() => walk({}, [entry, { ...entry }])).toThrow(`KEY_REGISTRY declares ${entry.path} twice`);
  });

  test('a custom registry drives the walk', () => {
    const only = KEY_REGISTRY.filter((p) => p.path === 'services' || p.path === 'services.*' || p.path === 'services.*.image');
    expect(unknownAt(walk({ services: { web: { image: 'x', command: 'y' } }, volumes: {} }, only))).toEqual([
      'services.web.command',
      'volumes',
    ]);
  });
});

describe('suggestions', () => {
  test('damerauLevenshtein counts adjacent transpositions as one edit', () => {
    expect(damerauLevenshtein('image', 'image')).toBe(0);
    expect(damerauLevenshtein('imgae', 'image')).toBe(1);
    expect(damerauLevenshtein('servics', 'services')).toBe(1);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
    expect(damerauLevenshtein('abc', '')).toBe(3);
    expect(damerauLevenshtein('ca', 'abc')).toBe(3);
  });

  test('suggestKey picks the closest key within distance 2, ties in code-unit order', () => {
    expect(suggestKey('imgae', ['image', 'init', 'ipc'])).toBe('image');
    expect(suggestKey('cpu', ['cpus', 'pid'])).toBe('cpus');
    expect(suggestKey('xyz', ['image', 'ports'])).toBeNull();
    expect(suggestKey('abx', ['aby', 'abz'])).toBe('aby');
    expect(suggestKey('abx', ['abz', 'aby'])).toBe('aby');
    expect(suggestKey('abcd', ['ab'])).toBe('ab');
    expect(suggestKey('abcde', ['ab'])).toBeNull();
    expect(suggestKey('x', [])).toBeNull();
  });
});
