import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type {
  AccessMode,
  CanonicalStack,
  FileMountSpec,
  MiddlewareSpec,
  PortSpec,
  Protocol,
  RouteSpec,
  StackRole,
  VolumeMountSpec,
  WorkloadKind,
} from '../../../services/orchestrator/kubernetes/model/types';
import { hashedObjectName, serviceNameFor, volumeClaimNameFor } from '../../../services/orchestrator/kubernetes/naming';
import {
  compareCodeUnits,
  type FileSourceDraft,
  type FileSourceTable,
  indexPath,
  isPlainMap,
  type NetworkTable,
  type NormalizeContext,
  newFileSourceDraft,
  newNetworkDraft,
  newVolumeDraft,
  type ServiceDraft,
  type VolumeDraft,
  type VolumeTable,
} from '../../../services/orchestrator/kubernetes/normalize/context';
import { finalize, stackChecks } from '../../../services/orchestrator/kubernetes/normalize/stack-checks';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { type NormalizeInputOverrides, normalizeContext, serviceDraft } from '../support/builders';
import { deepShuffleKeys, mulberry32, pick, type Rng, randomInt, seededShuffle } from '../support/prng';
import { forAll } from '../support/property';

// ---------------------------------------------------------------------------
// Fixture: drafts and top-level tables as the handlers leave them
// ---------------------------------------------------------------------------

type FileKind = FileMountSpec['kind'];

class Fixture {
  readonly ctx: NormalizeContext;
  readonly drafts: ServiceDraft[] = [];
  readonly volumes: VolumeTable = new Map();
  readonly files: FileSourceTable = { secrets: new Map(), configs: new Map() };
  readonly networks: NetworkTable = new Map();
  readonly middlewares: MiddlewareSpec[] = [];

  constructor(overrides: NormalizeInputOverrides = {}) {
    this.ctx = normalizeContext(overrides);
  }

  service(key: string, fill: (d: ServiceDraft) => void = () => {}): ServiceDraft {
    const draft = serviceDraft(key, this.ctx);
    fill(draft);
    this.drafts.push(draft);
    return draft;
  }

  volume(key: string, overrides: Partial<VolumeDraft> = {}): VolumeDraft {
    const volume = { ...newVolumeDraft(key, this.ctx), ...overrides };
    this.volumes.set(key, volume);
    return volume;
  }

  /** `content` null declares an external object named `objectName` (default: the key). */
  file(kind: FileKind, key: string, content: string | null, overrides: Partial<FileSourceDraft> = {}): FileSourceDraft {
    const source = newFileSourceDraft(kind, key, this.ctx);
    if (content === null) {
      source.external = true;
    } else {
      const data = new TextEncoder().encode(content);
      const checksum = sha256Hex(data);
      Object.assign(source, { data, checksum, objectName: hashedObjectName(key, kind, checksum), file: `./${key}.pem` });
    }
    Object.assign(source, overrides);
    (kind === 'secret' ? this.files.secrets : this.files.configs).set(key, source);
    return source;
  }

  network(key: string): void {
    this.networks.set(key, newNetworkDraft(key));
  }

  checks(): Diagnostic[] {
    stackChecks(this.drafts, this.volumes, this.files, this.networks, this.ctx);
    return this.ctx.sink.list();
  }

  run(): { stack: CanonicalStack; diagnostics: Diagnostic[] } {
    const diagnostics = this.checks();
    return { stack: finalize(this.drafts, this.volumes, this.files, this.middlewares, this.ctx), diagnostics };
  }
}

function mountVolume(d: ServiceDraft, volume: string, target: string): VolumeMountSpec {
  const mount: VolumeMountSpec = {
    type: 'volume',
    volume,
    target,
    readOnly: false,
    subpath: null,
    path: indexPath(`${d.path}.volumes`, d.mounts.length),
  };
  d.mounts.push(mount);
  return mount;
}

function mountFile(d: ServiceDraft, kind: FileKind, source: string, target?: string): FileMountSpec {
  const mount: FileMountSpec = {
    kind,
    source,
    target: target ?? (kind === 'secret' ? `/run/secrets/${source}` : `/${source}`),
    mode: 0o444,
    uid: null,
    gid: null,
    path: indexPath(`${d.path}.${kind}s`, d.files.filter((f) => f.kind === kind).length),
  };
  d.files.push(mount);
  return mount;
}

function publish(
  d: ServiceDraft,
  published: number | null,
  target: number,
  options: { protocol?: Protocol; mode?: PortSpec['mode']; hostIp?: string | null } = {},
): PortSpec {
  const port: PortSpec = {
    target,
    published,
    protocol: options.protocol ?? 'TCP',
    mode: options.mode ?? 'ingress',
    hostIp: options.hostIp ?? null,
    name: null,
    appProtocol: null,
    path: indexPath(`${d.path}.ports`, d.ports.length),
  };
  d.ports.push(port);
  return port;
}

function route(d: ServiceDraft, router: string, overrides: Partial<RouteSpec> = {}): RouteSpec {
  const r: RouteSpec = {
    router,
    rule: 'Host(`shop.example.com`)',
    entryPoints: ['websecure'],
    tls: { certResolver: 'letsencrypt' },
    middlewares: [],
    priority: null,
    port: 80,
    origin: 'labels',
    path: `${d.path}.labels["traefik.http.routers.${router}.rule"]`,
    ...overrides,
  };
  d.routes.push(r);
  return r;
}

function middleware(name: string, overrides: Partial<MiddlewareSpec> = {}): MiddlewareSpec {
  return {
    name,
    spec: { compress: {} },
    users: null,
    errorsService: null,
    path: `services.api.labels["traefik.http.middlewares.${name}.compress"]`,
    ...overrides,
  };
}

function siblingService(key: string, aliases: string[] = []) {
  return { key, name: serviceNameFor(key).value, aliases, published: [] };
}

function lines(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}`);
}

function find(diagnostics: readonly Diagnostic[], code: string, path: string): Diagnostic {
  const found = diagnostics.find((d) => d.code === code && d.path === path);
  if (found === undefined) throw new Error(`no ${code} at ${path} in:\n${lines(diagnostics).join('\n')}`);
  return found;
}

// codes design-01 10 marks (T2): the translator owns them, the normalizer never emits them
const TRANSLATOR_STACK_CODES = [
  'volumes.rwo-replicas',
  'volumes.rwo-global',
  'volumes.rwo-shared',
  'volumes.per-replica-shared',
  'volumes.access-mode-unsupported',
  'update.strategy-recreate',
  'ports.published-conflict',
  'ports.reserved-host-port',
  'ports.host-port-replicas',
  'ports.host-duplicate-target',
];

// ---------------------------------------------------------------------------
// SC-01 service names (S1, S10)
// ---------------------------------------------------------------------------

describe('SC-01 the Service name space (design-01 10 S1)', () => {
  test('a compose key declared in both files is names.role-collision, reported once (S10)', () => {
    const f = new Fixture({ sibling: { services: [siblingService('db')] } });
    f.service('db');
    f.service('web');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.role-collision services.db']);
    const d = find(diagnostics, 'names.role-collision', 'services.db');
    expect(d.message).toBe('db is declared in both docker-compose.yml and accessories.yml');
    expect(d.hint).toBe(
      'Rename one of them: services and accessories share the namespace `dockflow-shop-production`, so names must be unique.',
    );
  });

  test('a sibling service holding the load balancer name of a service is names.derived-collision on that service', () => {
    const f = new Fixture({ sibling: { services: [siblingService('web-lb')] } });
    f.service('web', (d) => publish(d, 8080, 80));
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.derived-collision services.web']);
    const d = find(diagnostics, 'names.derived-collision', 'services.web');
    expect(d.message).toBe(
      'needs the load balancer Service web-lb, which is already the name of accessories service web-lb (services.web-lb)',
    );
    expect(d.hint).toBe('Rename one of the services.');
  });

  test('the accessory render reports the mirror collision on its own service', () => {
    const f = new Fixture({ role: 'accessory', sibling: { services: [siblingService('web')] } });
    f.service('web-lb');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.derived-collision services.web-lb']);
    expect(find(diagnostics, 'names.derived-collision', 'services.web-lb').message).toBe(
      'resolves to web-lb, which is reserved for the load balancer Service of app service web',
    );
  });

  test('two keys of one file sanitizing to one name: the second in code-unit order is reported (ID-02)', () => {
    const f = new Fixture();
    f.service('api-v2');
    f.service('Api.V2');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.sanitize-collision services.api-v2']);
    const d = find(diagnostics, 'names.sanitize-collision', 'services.api-v2');
    expect(d.message).toBe('resolves to the Kubernetes name api-v2, already used by service Api.V2 (services["Api.V2"])');
    expect(d.hint).toBe('Rename one of the services.');
  });

  test('a service named like the load balancer or headless Service of another is names.derived-collision on it (ID-04)', () => {
    const f = new Fixture();
    f.service('web-lb');
    f.service('web', (d) => publish(d, 8080, 80));
    f.service('db-hl');
    f.service('db');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual([
      'error names.derived-collision services.db-hl',
      'error names.derived-collision services.web-lb',
    ]);
    expect(find(diagnostics, 'names.derived-collision', 'services.db-hl').message).toBe(
      'resolves to db-hl, which is reserved for the headless Service of db',
    );
    expect(find(diagnostics, 'names.derived-collision', 'services.web-lb').message).toBe(
      'resolves to web-lb, which is reserved for the load balancer Service of web',
    );
    expect(find(diagnostics, 'names.derived-collision', 'services.web-lb').hint).toBe('Rename the service.');
  });

  test('a key sanitizing like a sibling service is names.sanitize-collision naming the other file', () => {
    const f = new Fixture({ sibling: { services: [siblingService('web-app')] } });
    f.service('web_app');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.sanitize-collision services.web_app']);
    expect(find(diagnostics, 'names.sanitize-collision', 'services.web_app').message).toBe(
      'resolves to the Kubernetes name web-app, already used by accessories service web-app (services.web-app)',
    );
  });

  test('an alias never takes a name from a service, even from a later compose key', () => {
    const f = new Fixture();
    f.service('db');
    f.service('api', (d) => {
      d.network.aliases = ['db'];
    });
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.derived-collision services.api']);
    const d = find(diagnostics, 'names.derived-collision', 'services.api');
    expect(d.message).toBe('needs the alias Service db, which is already the name of service db (services.db)');
    expect(d.hint).toBe('Remove or rename the alias.');
  });

  test('an alias against a derived name is names.sanitize-collision: derived names share the space', () => {
    const f = new Fixture();
    f.service('web', (d) => publish(d, 8080, 80));
    f.service('api', (d) => {
      d.network.aliases = ['web-lb'];
    });
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.sanitize-collision services.api']);
    expect(find(diagnostics, 'names.sanitize-collision', 'services.api').message).toBe(
      'needs the alias Service web-lb, which is already the load balancer Service of web',
    );
  });

  test('a service named like an alias of a sibling service is names.derived-collision', () => {
    const f = new Fixture({ sibling: { services: [siblingService('db', ['cache'])] } });
    f.service('cache');
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.derived-collision services.cache']);
    expect(find(diagnostics, 'names.derived-collision', 'services.cache').message).toBe(
      'resolves to cache, which is reserved for the alias Service of accessories service db',
    );
  });

  test('collisions inside the sibling file are left to its own render', () => {
    const f = new Fixture({
      sibling: { services: [siblingService('a_b'), siblingService('a-b'), siblingService('c', ['a-b', 'a-b-lb'])] },
    });
    f.service('web');
    expect(f.checks()).toEqual([]);
  });

  test('an alias equal to its own service name and distinct names are silent', () => {
    const f = new Fixture({ sibling: { services: [siblingService('redis')] } });
    f.service('web', (d) => {
      publish(d, 8080, 80);
      d.network.aliases = ['web', 'www'];
    });
    f.service('api', (d) => {
      d.workloadKind = 'StatefulSet';
    });
    expect(f.checks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SC-02, SC-03 claim names (S2, S3, S4)
// ---------------------------------------------------------------------------

describe('SC-02 / SC-03 claim names (design-01 10 S2-S4, DESIGN-CORE C3)', () => {
  test('SC-02 two volume keys stored in one claim: the second key in code-unit order is reported', () => {
    const f = new Fixture();
    f.volume('pg_data');
    f.volume('pg-data');
    f.service('db', (d) => {
      mountVolume(d, 'pg_data', '/a');
      mountVolume(d, 'pg-data', '/b');
    });
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.volume-collision volumes.pg_data']);
    const d = find(diagnostics, 'names.volume-collision', 'volumes.pg_data');
    expect(d.message).toBe('volume pg_data is stored in the claim pg-data, already used by volume pg-data (volumes.pg-data)');
    expect(d.hint).toBe('Rename one of the volumes.');
  });

  test('a volume nobody mounts creates no claim and cannot collide', () => {
    const f = new Fixture();
    f.volume('pg_data');
    f.volume('pg-data');
    f.service('db', (d) => mountVolume(d, 'pg_data', '/a'));
    expect(lines(f.checks())).toEqual(['info volumes.unused volumes.pg-data']);
  });

  test('SC-03 the same non-external key in both files is volumes.role-collision', () => {
    const f = new Fixture({ sibling: { volumes: [{ key: 'data', claimName: 'data', external: false }] } });
    f.volume('data');
    f.service('web', (d) => mountVolume(d, 'data', '/data'));
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error volumes.role-collision volumes.data']);
    const d = find(diagnostics, 'volumes.role-collision', 'volumes.data');
    expect(d.message).toBe(
      'volume data is declared in both docker-compose.yml and accessories.yml; on Kubernetes both would be the claim data',
    );
    expect(d.hint).toBe(
      'Declare the volume in one file and reference it from the other with `external: true` and `name: data`, or rename one of them.',
    );
  });

  test('SC-03 both sides external with the same name is the documented sharing pattern', () => {
    const f = new Fixture({ sibling: { volumes: [{ key: 'data', claimName: 'shared', external: true }] } });
    f.volume('data', { external: true, name: 'shared' });
    f.service('web', (d) => mountVolume(d, 'data', '/data'));
    expect(f.checks()).toEqual([]);
  });

  test('SC-03 / S4 an external volume naming a claim of this file or of the sibling file is silent', () => {
    const f = new Fixture({ sibling: { volumes: [{ key: 'pgdata', claimName: 'pgdata', external: false }] } });
    f.volume('shared', { external: true, name: 'data' });
    f.volume('data');
    f.volume('pg', { external: true, name: 'pgdata' });
    f.service('web', (d) => {
      mountVolume(d, 'shared', '/a');
      mountVolume(d, 'data', '/b');
      mountVolume(d, 'pg', '/c');
    });
    expect(f.checks()).toEqual([]);
  });

  test('different keys of the two files stored in one claim are names.volume-collision naming the other file', () => {
    const f = new Fixture({ sibling: { volumes: [{ key: 'pg-data', claimName: 'pg-data', external: false }] } });
    f.volume('pg_data');
    f.service('db', (d) => mountVolume(d, 'pg_data', '/data'));
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.volume-collision volumes.pg_data']);
    expect(find(diagnostics, 'names.volume-collision', 'volumes.pg_data').message).toBe(
      'volume pg_data is stored in the claim pg-data, already used by accessories volume pg-data (volumes.pg-data)',
    );
  });

  test('a key of this file equal to an external sibling key is not a role collision', () => {
    const f = new Fixture({ sibling: { volumes: [{ key: 'data', claimName: 'other', external: true }] } });
    f.volume('data');
    f.service('web', (d) => mountVolume(d, 'data', '/data'));
    expect(f.checks()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (T2) rows: the model carries the facts, the translator decides
// ---------------------------------------------------------------------------

describe('SC-04 / SC-05 / SC-06 / SC-11 stack rows owned by the translator (T2)', () => {
  test('SC-04 / SC-05 RWO and RWOP volumes against replicas, global mode and sharing produce no normalizer diagnostic', () => {
    const f = new Fixture();
    f.volume('data');
    f.volume('state', { perReplica: true });
    f.volume('logs');
    f.volume('ext', { external: true, name: 'pgdata' });
    f.volume('shared');
    f.volume('single', { accessMode: 'ReadWriteOncePod' });
    f.service('web', (d) => {
      d.replicas = 2;
      mountVolume(d, 'data', '/data');
    });
    f.service('db', (d) => {
      d.workloadKind = 'StatefulSet';
      d.extension.kind = 'statefulset';
      d.replicas = 3;
      mountVolume(d, 'state', '/var/lib/db');
    });
    f.service('agent', (d) => {
      d.mode = 'global';
      d.workloadKind = 'DaemonSet';
      mountVolume(d, 'logs', '/logs');
      mountVolume(d, 'ext', '/ext');
    });
    f.service('api', (d) => mountVolume(d, 'shared', '/shared'));
    f.service('admin', (d) => mountVolume(d, 'shared', '/shared'));
    f.service('a', (d) => mountVolume(d, 'single', '/s'));
    f.service('b', (d) => mountVolume(d, 'single', '/s'));
    const { stack, diagnostics } = f.run();
    expect(diagnostics).toEqual([]);
    for (const code of TRANSLATOR_STACK_CODES) expect(diagnostics.some((d) => d.code === code)).toBe(false);
    const byKey = Object.fromEntries(stack.volumes.map((v) => [v.key, v]));
    expect(byKey.data).toMatchObject({ accessMode: 'ReadWriteOnce', usedBy: ['web'], perReplica: false });
    expect(byKey.state).toMatchObject({ perReplica: true, usedBy: ['db'] });
    expect(byKey.ext).toMatchObject({ external: true, name: 'pgdata', usedBy: ['agent'] });
    expect(byKey.shared.usedBy).toEqual(['admin', 'api']);
    expect(byKey.single).toMatchObject({ accessMode: 'ReadWriteOncePod', usedBy: ['a', 'b'] });
    expect(stack.services.find((s) => s.composeName === 'web')?.replicas).toBe(2);
    expect(stack.services.find((s) => s.composeName === 'agent')?.workloadKind).toBe('DaemonSet');
  });

  test('SC-06 a published port used twice, or by the sibling file, is carried to the translator unreported', () => {
    const f = new Fixture({
      sibling: { services: [{ key: 'proxy', name: 'proxy', aliases: [], published: [{ port: 8080, protocol: 'TCP' }] }] },
    });
    f.service('web', (d) => publish(d, 8080, 80));
    f.service('admin', (d) => publish(d, 8080, 80));
    const { stack, diagnostics } = f.run();
    expect(diagnostics).toEqual([]);
    expect(stack.services.map((s) => s.ports.map((p) => p.published))).toEqual([[8080], [8080]]);
  });

  test('SC-11 node-bound ports with replicas and twice on one target are carried to the translator unreported', () => {
    const f = new Fixture();
    f.service('web', (d) => {
      d.replicas = 2;
      d.extension.publish = 'hostport';
      publish(d, 8080, 80);
    });
    f.service('edge', (d) => {
      publish(d, 80, 80, { mode: 'host', hostIp: '10.0.0.2' });
      publish(d, 80, 80, { mode: 'host', hostIp: '10.0.0.1' });
    });
    const { stack, diagnostics } = f.run();
    expect(diagnostics).toEqual([]);
    const edge = stack.services.find((s) => s.composeName === 'edge');
    expect(edge?.ports.map((p) => p.hostIp)).toEqual(['10.0.0.1', '10.0.0.2']);
  });
});

// ---------------------------------------------------------------------------
// SC-07 references, SC-08 routing, SC-09 file objects, SC-10 accessories
// ---------------------------------------------------------------------------

describe('SC-07 references to undeclared entries (design-01 10 S6)', () => {
  // depends_on and links are not in the model: their rows (DEP-03, NET-07) belong to the handlers
  test('volumes, secrets and networks absent from the top-level tables are errors at the entry path', () => {
    const f = new Fixture({ compose: { services: { web: { image: 'nginx:1.27', networks: ['backend', 'ghost'] } } } });
    f.volume('data');
    f.file('secret', 'api_key', 'k');
    f.network('backend');
    f.service('web', (d) => {
      d.network.networks = ['backend', 'ghost'];
      mountVolume(d, 'data', '/data');
      mountVolume(d, 'ghost', '/x');
      mountFile(d, 'secret', 'api_key');
      mountFile(d, 'secret', 'ghost');
      mountFile(d, 'config', 'ghost');
    });
    const { stack, diagnostics } = f.run();
    expect(lines(diagnostics)).toEqual([
      'error files.undeclared services.web.configs[0]',
      'error network.undeclared services.web.networks[1]',
      'error files.undeclared services.web.secrets[1]',
      'error volumes.undeclared services.web.volumes[1]',
    ]);
    expect(find(diagnostics, 'volumes.undeclared', 'services.web.volumes[1]')).toMatchObject({
      message: 'volume ghost is not declared under top-level volumes',
      hint: 'Declare it: `volumes: {ghost: {}}`; a host path must start with `/`.',
    });
    expect(find(diagnostics, 'files.undeclared', 'services.web.secrets[1]')).toMatchObject({
      message: 'secret ghost is not declared under top-level secrets',
      hint: 'Declare it, for example `secrets: {ghost: {file: ./ghost.txt}}`.',
    });
    expect(find(diagnostics, 'files.undeclared', 'services.web.configs[0]').message).toBe(
      'config ghost is not declared under top-level configs',
    );
    expect(find(diagnostics, 'network.undeclared', 'services.web.networks[1]')).toMatchObject({
      message: 'network ghost is not declared under top-level networks',
      hint: 'Declare it, or remove it from the service.',
    });
    // the dangling references never reach the translator
    const web = stack.services[0];
    expect(web.mounts.map((m) => m.path)).toEqual(['services.web.volumes[0]']);
    expect(web.files.map((m) => m.path)).toEqual(['services.web.secrets[0]']);
    expect(stack.volumes.map((v) => v.key)).toEqual(['data']);
    expect(stack.files.map((s) => s.key)).toEqual(['api_key']);
  });

  test('a network written as a map is reported at its key; default is always declared', () => {
    const f = new Fixture({ compose: { services: { web: { image: 'nginx:1.27', networks: { ghost: { aliases: ['w'] } } } } } });
    f.service('web', (d) => {
      d.network.networks = ['default', 'ghost'];
    });
    expect(lines(f.checks())).toEqual(['error network.undeclared services.web.networks.ghost']);
  });
});

describe('SC-08 routing references', () => {
  test('a router using a middleware defined on another service of the file is kept without diagnostic', () => {
    const f = new Fixture({ proxy: { enabled: true, domains: { production: 'shop.example.com' } } });
    f.middlewares.push(middleware('auth', { spec: { basicAuth: {} }, users: ['admin:$apr1$x'] }));
    f.service('api', (d) => publish(d, null, 8080));
    f.service('web', (d) => route(d, 'web', { middlewares: ['auth'] }));
    const { stack, diagnostics } = f.run();
    expect(diagnostics).toEqual([]);
    expect(stack.middlewares.map((m) => m.name)).toEqual(['auth']);
    expect(stack.services.find((s) => s.composeName === 'web')?.routes[0].middlewares).toEqual(['auth']);
  });
});

describe('SC-09 content-named objects (design-01 10 S9)', () => {
  test('two secrets whose keys sanitize to one base with identical content are names.file-collision', () => {
    const f = new Fixture();
    const first = f.file('secret', 'tls-cert', 'PEM');
    f.file('secret', 'tls_cert', 'PEM');
    f.service('web', (d) => {
      mountFile(d, 'secret', 'tls_cert', '/run/secrets/a');
      mountFile(d, 'secret', 'tls-cert', '/run/secrets/b');
    });
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.file-collision secrets.tls_cert']);
    const d = find(diagnostics, 'names.file-collision', 'secrets.tls_cert');
    expect(d.message).toBe(
      `secret tls_cert would create the object ${first.objectName}, already created for secret tls-cert (secrets.tls-cert)`,
    );
    expect(d.hint).toBe('Rename one of them.');
  });

  test('the file space is the render registry: a name a handler claimed first keeps it, and the collision is reported once', () => {
    const f = new Fixture();
    const first = f.file('secret', 'tls_cert', 'PEM');
    f.file('secret', 'tls-cert', 'PEM');
    f.service('web', (d) => {
      mountFile(d, 'secret', 'tls_cert', '/a');
      mountFile(d, 'secret', 'tls-cert', '/b');
    });
    // a handler reading `tls_cert` first claimed its object name before the stack checks ran
    f.ctx.names.claim('file', first.objectName, { description: 'secret tls_cert', path: 'secrets.tls_cert' });
    f.ctx.names.claim('file', first.objectName, { description: 'secret tls-cert', path: 'secrets.tls-cert' });
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error names.file-collision secrets.tls-cert']);
    expect(find(diagnostics, 'names.file-collision', 'secrets.tls-cert').message).toBe(
      `secret tls-cert would create the object ${first.objectName}, already created for secret tls_cert (secrets.tls_cert)`,
    );
  });

  test('a config and a secret with the same key are distinct references', () => {
    const f = new Fixture();
    f.file('secret', 'app', 'A');
    f.file('config', 'app', 'A');
    f.service('web', (d) => mountFile(d, 'config', 'app', '/etc/app'));
    const { stack, diagnostics } = f.run();
    expect(lines(diagnostics)).toEqual(['info files.unused secrets.app']);
    expect(stack.files.map((s) => `${s.kind}/${s.key}`)).toEqual(['config/app']);
  });

  test('different content, another kind, external objects and unused entries never collide', () => {
    const f = new Fixture();
    f.file('secret', 'tls-cert', 'PEM');
    f.file('secret', 'tls_cert', 'OTHER');
    f.file('config', 'tls_cert', 'PEM');
    f.file('secret', 'ext_a', null, { objectName: 'shared' });
    f.file('secret', 'ext-a', null, { objectName: 'shared' });
    f.file('config', 'tls-cert', 'PEM');
    f.service('web', (d) => {
      mountFile(d, 'secret', 'tls-cert', '/a');
      mountFile(d, 'secret', 'tls_cert', '/b');
      mountFile(d, 'config', 'tls_cert', '/c');
      mountFile(d, 'secret', 'ext_a', '/d');
      mountFile(d, 'secret', 'ext-a', '/e');
    });
    expect(lines(f.checks())).toEqual(['info files.unused configs.tls-cert']);
  });
});

describe('SC-10 accessories', () => {
  test('an accessory with published ports and the proxy enabled gets no route and no routing diagnostic', () => {
    const f = new Fixture({ role: 'accessory', proxy: { enabled: true, domains: { production: 'shop.example.com' } } });
    f.service('postgres', (d) => publish(d, 5432, 5432));
    const { stack, diagnostics } = f.run();
    expect(diagnostics).toEqual([]);
    expect(stack.role).toBe('accessory');
    expect(stack.services[0].routes).toEqual([]);
    expect(stack.services[0].role).toBe('accessory');
    expect(stack.proxy).toEqual({ domain: null, acme: true, entryPoint: 'websecure', certResolver: 'letsencrypt', manage: true });
  });
});

// ---------------------------------------------------------------------------
// usedBy, unused entries, per-replica volumes
// ---------------------------------------------------------------------------

describe('usedBy and unused entries', () => {
  test('usedBy lists the compose keys mounting each declared volume, sorted unique, fatal services included', () => {
    const f = new Fixture();
    const data = f.volume('data');
    const cache = f.volume('cache');
    f.service('web', (d) => {
      mountVolume(d, 'data', '/a');
      mountVolume(d, 'data', '/b');
    });
    f.service('Api', (d) => mountVolume(d, 'data', '/data'));
    const broken = f.service('broken', (d) => mountVolume(d, 'data', '/data'));
    f.ctx.markFatal(broken.path);
    const diagnostics = f.checks();
    expect(data.usedBy).toEqual(['Api', 'broken', 'web']);
    expect(cache.usedBy).toEqual([]);
    expect(lines(diagnostics)).toEqual(['info volumes.unused volumes.cache']);
    expect(find(diagnostics, 'volumes.unused', 'volumes.cache').message).toBe('is not mounted by any service, so no claim is created');
  });

  test('secrets and configs no service mounts are files.unused infos', () => {
    const f = new Fixture();
    f.file('secret', 'pw', null);
    f.file('config', 'app', 'a: 1');
    f.file('config', 'used', 'b: 2');
    f.service('web', (d) => mountFile(d, 'config', 'used'));
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['info files.unused configs.app', 'info files.unused secrets.pw']);
    expect(find(diagnostics, 'files.unused', 'secrets.pw').message).toBe('is not used by any service, so no object is created');
  });

  test('a per_replica volume mounted by a service that is not a StatefulSet is extension.per-replica-kind (X2)', () => {
    const f = new Fixture();
    f.volume('data', { perReplica: true });
    f.service('web', (d) => {
      mountVolume(d, 'data', '/data');
    });
    f.service('db', (d) => {
      d.workloadKind = 'StatefulSet';
      mountVolume(d, 'data', '/data');
    });
    const broken = f.service('broken', (d) => mountVolume(d, 'data', '/data'));
    f.ctx.markFatal(broken.path);
    const diagnostics = f.checks();
    expect(lines(diagnostics)).toEqual(['error extension.per-replica-kind services.web.volumes[0]']);
    expect(find(diagnostics, 'extension.per-replica-kind', 'services.web.volumes[0]')).toMatchObject({
      message: 'volume data has per_replica: true but web is not a StatefulSet',
      hint: 'Add `x-dockflow: {kind: statefulset}` to `web`.',
    });
  });
});

// ---------------------------------------------------------------------------
// finalize (design-01 9)
// ---------------------------------------------------------------------------

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

describe('finalize', () => {
  test('services are sorted by Kubernetes name; fatal drafts and what only they use are left out', () => {
    const f = new Fixture();
    f.volume('data');
    f.volume('only_broken');
    f.file('secret', 'pw', 'x');
    f.service('web_b', (d) => mountVolume(d, 'data', '/data'));
    f.service('Web.A');
    const broken = f.service('broken', (d) => {
      mountVolume(d, 'only_broken', '/x');
      mountVolume(d, 'data', '/data');
      mountFile(d, 'secret', 'pw');
    });
    f.ctx.markFatal(broken.path);
    const { stack } = f.run();
    expect(stack.services.map((s) => [s.name, s.composeName])).toEqual([
      ['web-a', 'Web.A'],
      ['web-b', 'web_b'],
    ]);
    expect(stack.volumes.map((v) => [v.key, v.usedBy])).toEqual([['data', ['web_b']]]);
    expect(stack.files).toEqual([]);
  });

  test('every array is in its documented order; declaration-order fields are kept as written', () => {
    const f = new Fixture();
    f.volume('data');
    f.volume('logs');
    f.file('secret', 'pw', 'x');
    f.file('config', 'app', 'y');
    const web = f.service('web', (d) => {
      d.environment = [
        { name: 'b', value: '2' },
        { name: 'B', value: '1' },
        { name: 'a', value: '0' },
      ];
      publish(d, null, 80);
      publish(d, 8443, 443);
      publish(d, 8080, 80);
      publish(d, 53, 53, { protocol: 'UDP' });
      publish(d, 53, 53);
      d.expose = [
        { target: 9000, protocol: 'UDP', path: 'services.web.expose[0]' },
        { target: 9000, protocol: 'TCP', path: 'services.web.expose[1]' },
        { target: 3000, protocol: 'TCP', path: 'services.web.expose[2]' },
      ];
      mountVolume(d, 'logs', '/var/log');
      mountVolume(d, 'data', '/data');
      d.mounts.push({ type: 'tmpfs', target: '/tmp', sizeBytes: null, path: 'services.web.tmpfs' });
      mountFile(d, 'secret', 'pw', '/run/secrets/pw');
      mountFile(d, 'config', 'app', '/etc/app.yml');
      d.process.groupAdd = [1000, 5, 1000, 20];
      d.process.command = ['z', 'a'];
      d.process.entrypoint = ['/bin/sh', '-c'];
      d.security.capAdd = ['SYS_TIME', 'NET_ADMIN', 'SYS_TIME'];
      d.security.capDrop = ['MKNOD', 'CHOWN'];
      d.network.networks = ['frontend', 'default', 'backend'];
      d.network.aliases = ['www', 'api', 'www'];
      d.network.dns = ['9.9.9.9', '1.1.1.1'];
      d.network.dnsSearch = ['b.internal', 'a.internal'];
      d.network.dnsOptions = ['use-vc', 'ndots:2'];
      d.network.extraHosts = [
        { hostname: 'z.internal', ip: '10.0.0.1' },
        { hostname: 'a.internal', ip: '10.0.0.2' },
        { hostname: 'b.internal', ip: '10.0.0.1' },
      ];
      d.placement.constraints = [
        { attribute: 'node.role', operator: '==', value: 'worker', path: 'services.web.deploy.placement.constraints[0]' },
        { attribute: 'node.labels', key: 'disk', operator: '==', value: 'ssd', path: 'services.web.deploy.placement.constraints[1]' },
      ];
      d.placement.spreadLabels = ['zone', 'rack'];
      d.extension.tolerations = [
        { key: 'z', operator: 'Exists', value: null, effect: null, tolerationSeconds: null },
        { key: 'a', operator: 'Exists', value: null, effect: null, tolerationSeconds: null },
      ];
      d.extension.loadBalancerSourceRanges = ['192.168.0.0/16', '10.0.0.0/8', '10.0.0.0/8'];
      route(d, 'web-b', { entryPoints: ['websecure', 'web', 'websecure'], middlewares: ['z', 'a'] });
      route(d, 'web-a');
    });
    const { stack } = f.run();
    const s = stack.services[0];
    expect(s.environment.map((e) => e.name)).toEqual(['B', 'a', 'b']);
    expect(s.ports.map((p) => `${p.target}/${p.protocol}/${p.published}`)).toEqual([
      '53/TCP/53',
      '53/UDP/53',
      '80/TCP/null',
      '80/TCP/8080',
      '443/TCP/8443',
    ]);
    expect(s.expose.map((e) => `${e.target}/${e.protocol}`)).toEqual(['3000/TCP', '9000/TCP', '9000/UDP']);
    expect(s.mounts.map((m) => m.target)).toEqual(['/data', '/tmp', '/var/log']);
    expect(s.files.map((m) => m.target)).toEqual(['/etc/app.yml', '/run/secrets/pw']);
    expect(s.process.groupAdd).toEqual([5, 20, 1000]);
    expect(s.process.command).toEqual(['z', 'a']);
    expect(s.process.entrypoint).toEqual(['/bin/sh', '-c']);
    expect(s.security.capAdd).toEqual(['NET_ADMIN', 'SYS_TIME']);
    expect(s.security.capDrop).toEqual(['CHOWN', 'MKNOD']);
    expect(s.network.networks).toEqual(['backend', 'default', 'frontend']);
    expect(s.network.aliases).toEqual(['api', 'www']);
    expect(s.network.dns).toEqual(['9.9.9.9', '1.1.1.1']);
    expect(s.network.dnsSearch).toEqual(['b.internal', 'a.internal']);
    expect(s.network.dnsOptions).toEqual(['use-vc', 'ndots:2']);
    expect(s.network.extraHosts).toEqual([
      { hostname: 'b.internal', ip: '10.0.0.1' },
      { hostname: 'z.internal', ip: '10.0.0.1' },
      { hostname: 'a.internal', ip: '10.0.0.2' },
    ]);
    expect(s.placement.constraints.map((c) => c.attribute)).toEqual(['node.role', 'node.labels']);
    expect(s.placement.spreadLabels).toEqual(['zone', 'rack']);
    expect(s.extension.tolerations.map((t) => t.key)).toEqual(['z', 'a']);
    expect(s.extension.loadBalancerSourceRanges).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
    expect(s.routes.map((r) => r.router)).toEqual(['web-a', 'web-b']);
    expect(s.routes[1].entryPoints).toEqual(['web', 'websecure']);
    expect(s.routes[1].middlewares).toEqual(['z', 'a']);
    // the draft itself is left in its written order
    expect(web.environment.map((e) => e.name)).toEqual(['b', 'B', 'a']);
    expect(stack.volumes.map((v) => v.key)).toEqual(['data', 'logs']);
    expect(stack.files.map((x) => `${x.kind}/${x.key}`)).toEqual(['config/app', 'secret/pw']);
  });

  test('the stack carries schema, identity, role and proxy, and services only model fields', () => {
    const f = new Fixture();
    f.service('web', (d) => {
      d.rawPorts = ['8080:80'];
      d.routingEnable = true;
      d.healthcheckDisabled = true;
    });
    const { stack } = f.run();
    expect(stack.schema).toBe(1);
    expect(stack.identity).toEqual(f.ctx.input.identity);
    expect(stack.role).toBe('app');
    expect(stack.proxy).toBeNull();
    expect(Object.keys(stack.services[0]).sort(compareCodeUnits)).toEqual(MODEL_KEYS);
    expect(Object.keys(stack).sort(compareCodeUnits)).toEqual(['files', 'identity', 'middlewares', 'proxy', 'role', 'schema', 'services', 'volumes']);

    const proxied = new Fixture({ proxy: { enabled: true, acme: false, domains: { production: 'shop.example.com' } } });
    expect(proxied.run().stack.proxy).toEqual({
      domain: 'shop.example.com',
      acme: false,
      entryPoint: 'web',
      certResolver: null,
      manage: true,
    });
  });

  test('middlewares are sorted by name with users sorted unique; null users stay null', () => {
    const f = new Fixture();
    f.middlewares.push(middleware('strip', { path: 'services.web.labels.b' }));
    f.middlewares.push(middleware('auth', { users: ['bob:$x', 'alice:$y', 'bob:$x'], errorsService: { name: 'errors', port: 8080 } }));
    const { stack } = f.run();
    expect(stack.middlewares.map((m) => m.name)).toEqual(['auth', 'strip']);
    expect(stack.middlewares[0].users).toEqual(['alice:$y', 'bob:$x']);
    expect(stack.middlewares[0].errorsService).toEqual({ name: 'errors', port: 8080 });
    expect(stack.middlewares[1].users).toBeNull();
  });

  test('no undefined reaches the model, and maps are plain objects with sorted keys', () => {
    const f = new Fixture();
    f.middlewares.push(middleware('auth', { spec: { basicAuth: { realm: undefined, removeHeader: true } } }));
    f.service('web', (d) => {
      Object.assign(d.process, { workingDir: undefined });
      d.containerLabels = { zeta: '1', alpha: '2' };
      d.security.sysctls = { 'net.core.somaxconn': '1024', 'kernel.shm_rmid_forced': '1' };
    });
    const { stack } = f.run();
    expect(undefinedPaths(stack)).toEqual([]);
    expect(stack.services[0].process.workingDir).toBeNull();
    expect(stack.middlewares[0].spec).toEqual({ basicAuth: { realm: null, removeHeader: true } });
    expect(Object.keys(stack.services[0].containerLabels)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(stack.services[0].security.sysctls)).toEqual(['kernel.shm_rmid_forced', 'net.core.somaxconn']);
    expect(isPlainMap(stack.services[0].podAnnotations)).toBe(true);
  });

  test('the stack shares nothing mutable with the drafts, so finalize can run again', () => {
    const f = new Fixture();
    f.volume('data');
    f.file('config', 'app', 'a: 1');
    f.service('web', (d) => {
      d.environment = [{ name: 'A', value: '1' }];
      mountVolume(d, 'data', '/data');
      mountFile(d, 'config', 'app');
    });
    const { stack } = f.run();
    const before = canonicalJson(stack);
    stack.services[0].environment.push({ name: 'Z', value: 'x' });
    stack.services[0].mounts.length = 0;
    stack.volumes[0].usedBy.push('ghost');
    const again = finalize(f.drafts, f.volumes, f.files, f.middlewares, f.ctx);
    expect(canonicalJson(again)).toBe(before);
    expect(f.drafts[0].environment).toEqual([{ name: 'A', value: '1' }]);
    expect(f.volumes.get('data')?.usedBy).toEqual(['web']);
    // content bytes are shared, not copied
    expect(again.files[0].data).toBe(f.files.configs.get('app')?.data ?? null);
  });
});

// ---------------------------------------------------------------------------
// DET-01 and the invariants on shuffled drafts
// ---------------------------------------------------------------------------

interface PortGen {
  target: number;
  published: number | null;
  protocol: Protocol;
  mode: PortSpec['mode'];
  hostIp: string | null;
}

interface ServiceGen {
  key: string;
  fatal: boolean;
  workloadKind: WorkloadKind;
  replicas: number;
  env: [string, string][];
  ports: PortGen[];
  expose: { target: number; protocol: Protocol }[];
  volumes: [string, string][];
  tmpfs: string[];
  files: [FileKind, string, string][];
  aliases: string[];
  networks: string[];
  capAdd: string[];
  groupAdd: number[];
  extraHosts: { hostname: string; ip: string }[];
  routes: { router: string; entryPoints: string[]; middlewares: string[] }[];
  labels: Record<string, string>;
  lbRanges: string[];
}

interface StackGen {
  role: StackRole;
  services: ServiceGen[];
  volumes: { key: string; external: boolean; name: string; perReplica: boolean; accessMode: AccessMode }[];
  files: { kind: FileKind; key: string; content: string | null }[];
  networks: string[];
  middlewares: { name: string; users: string[] | null }[];
  sibling: {
    services: { key: string; aliases: string[] }[];
    volumes: { key: string; claimName: string; external: boolean }[];
  };
  shuffleSeed: number;
}

const SERVICE_KEYS = ['web', 'web_app', 'web-app', 'Web.App', 'api', 'api-lb', 'db', 'db-hl', 'worker', '2fa', 's-2fa', 'cache'];
const VOLUME_KEYS = ['data', 'pg_data', 'pg-data', 'cache', 'logs', 'shared'];
const FILE_KEYS = ['tls_cert', 'tls-cert', 'api_key', 'conf'];
const ALIASES = ['db', 'web-lb', 'alias-one', 'api', 'cache', 'db-hl', 'www'];

function subset<T>(rng: Rng, pool: readonly T[], max: number): T[] {
  return seededShuffle(pool, rng).slice(0, randomInt(rng, 0, Math.min(max, pool.length)));
}

function genService(rng: Rng, key: string): ServiceGen {
  const labels: Record<string, string> = {};
  for (const k of subset(rng, ['team', 'tier', 'com.example.owner', 'a'], 4)) labels[k] = pick(rng, ['x', 'y']);
  return {
    key,
    fatal: rng() < 0.15,
    workloadKind: pick(rng, ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'] as const),
    replicas: randomInt(rng, 0, 3),
    env: subset(rng, ['A', 'B', 'C', 'PATH', 'a'], 4).map((name) => [name, pick(rng, ['1', 'x', ''])]),
    ports: Array.from({ length: randomInt(rng, 0, 3) }, () => ({
      target: pick(rng, [80, 443, 53]),
      published: pick(rng, [null, 8080, 8443]),
      protocol: pick(rng, ['TCP', 'UDP'] as const),
      mode: pick(rng, ['ingress', 'host'] as const),
      hostIp: pick(rng, [null, '127.0.0.1', '10.0.0.1']),
    })),
    expose: Array.from({ length: randomInt(rng, 0, 2) }, () => ({
      target: pick(rng, [3000, 9000]),
      protocol: pick(rng, ['TCP', 'UDP'] as const),
    })),
    volumes: Array.from({ length: randomInt(rng, 0, 3) }, () => [
      pick(rng, [...VOLUME_KEYS, 'ghost']),
      pick(rng, ['/data', '/var/lib', '/cache']),
    ]),
    tmpfs: subset(rng, ['/tmp', '/run', '/data'], 2),
    files: Array.from({ length: randomInt(rng, 0, 3) }, () => [
      pick(rng, ['secret', 'config'] as const),
      pick(rng, [...FILE_KEYS, 'ghost']),
      pick(rng, ['/run/secrets/a', '/etc/b', '/c']),
    ]),
    aliases: subset(rng, ALIASES, 2),
    networks: subset(rng, ['default', 'backend', 'frontend', 'ghost'], 3),
    capAdd: [...subset(rng, ['NET_ADMIN', 'SYS_TIME', 'CHOWN'], 3), ...subset(rng, ['NET_ADMIN'], 1)],
    groupAdd: [...subset(rng, [1000, 5, 20, 999], 3), ...subset(rng, [5], 1)],
    extraHosts: subset(
      rng,
      [
        { hostname: 'a.internal', ip: '10.0.0.2' },
        { hostname: 'b.internal', ip: '10.0.0.1' },
        { hostname: 'c.internal', ip: '10.0.0.1' },
      ],
      3,
    ),
    routes: Array.from({ length: randomInt(rng, 0, 2) }, () => ({
      router: pick(rng, ['r1', 'r2', 'shop-production-web']),
      entryPoints: [...subset(rng, ['websecure', 'web'], 2), ...subset(rng, ['web'], 1)],
      middlewares: subset(rng, ['auth', 'compress', 'strip'], 2),
    })),
    labels,
    lbRanges: [...subset(rng, ['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32'], 3), ...subset(rng, ['10.0.0.0/8'], 1)],
  };
}

function genStack(rng: Rng): StackGen {
  const volumes = subset(rng, VOLUME_KEYS, 6).map((key) => {
    const external = rng() < 0.25;
    return {
      key,
      external,
      name: external ? pick(rng, ['shared', 'data', 'pgdata']) : volumeClaimNameFor(key).value,
      perReplica: rng() < 0.2,
      accessMode: pick(rng, ['ReadWriteOnce', 'ReadWriteOncePod', 'ReadWriteMany'] as const),
    };
  });
  const files = (['secret', 'config'] as const).flatMap((kind) =>
    subset(rng, FILE_KEYS, 4).map((key) => ({ kind, key, content: pick(rng, [null, 'A', 'B']) })),
  );
  return {
    role: pick(rng, ['app', 'accessory'] as const),
    services: subset(rng, SERVICE_KEYS, 7).map((key) => genService(rng, key)),
    volumes,
    files,
    networks: subset(rng, ['backend', 'frontend'], 2),
    middlewares: subset(rng, ['auth', 'compress', 'strip'], 3).map((name) => ({
      name,
      users: pick(rng, [null, ['u2:$x', 'u1:$y', 'u2:$x']]),
    })),
    sibling: {
      services: subset(rng, ['db', 'redis', 'web-lb', 'cache_x', 'api'], 3).map((key) => ({
        key,
        aliases: subset(rng, ['cache', 'alias-two', 'www'], 1),
      })),
      volumes: subset(rng, ['data', 'pg-data', 'redis_data'], 3).map((key) => {
        const external = rng() < 0.3;
        return { key, claimName: external ? pick(rng, ['shared', 'data']) : volumeClaimNameFor(key).value, external };
      }),
    },
    shuffleSeed: randomInt(rng, 0, 0x7fffffff),
  };
}

function maybeShuffle<T>(items: readonly T[], rng: Rng | null): T[] {
  return rng === null ? [...items] : seededShuffle(items, rng);
}

/**
 * Builds the fixture of a generated stack. With an rng, everything whose order must not matter is
 * permuted: drafts, table insertion order, sibling lists, the key order of every mapping and every
 * array finalize sorts. Paths come from the generated index, so they do not move with the element.
 */
function buildFixture(gen: StackGen, rng: Rng | null): Fixture {
  const f = new Fixture({
    role: gen.role,
    sibling: {
      services: maybeShuffle(
        gen.sibling.services.map((s) => siblingService(s.key, s.aliases)),
        rng,
      ),
      volumes: maybeShuffle(gen.sibling.volumes, rng),
    },
  });
  for (const v of maybeShuffle(gen.volumes, rng)) {
    f.volume(v.key, { external: v.external, name: v.name, perReplica: v.perReplica, accessMode: v.accessMode });
  }
  for (const s of maybeShuffle(gen.files, rng)) f.file(s.kind, s.key, s.content);
  for (const n of maybeShuffle(gen.networks, rng)) f.network(n);
  for (const m of maybeShuffle(gen.middlewares, rng)) {
    const spec = { stripPrefix: { prefixes: ['/b', '/a'], forceSlash: false }, headers: { a: '1', b: '2' } };
    f.middlewares.push(
      middleware(m.name, {
        spec: rng === null ? spec : deepShuffleKeys(spec, rng),
        users: m.users === null ? null : maybeShuffle(m.users, rng),
      }),
    );
  }
  const drafts: ServiceDraft[] = [];
  for (const s of maybeShuffle(gen.services, rng)) {
    const d = serviceDraft(s.key, f.ctx);
    d.workloadKind = s.workloadKind;
    d.replicas = s.replicas;
    d.environment = maybeShuffle(
      s.env.map(([name, value]) => ({ name, value })),
      rng,
    );
    d.ports = maybeShuffle(
      s.ports.map((p, i) => ({ ...p, name: null, appProtocol: null, path: indexPath(`${d.path}.ports`, i) })),
      rng,
    );
    d.expose = maybeShuffle(
      s.expose.map((e, i) => ({ ...e, path: indexPath(`${d.path}.expose`, i) })),
      rng,
    );
    d.mounts = maybeShuffle(
      [
        ...s.volumes.map(([volume, target], i) => ({
          type: 'volume' as const,
          volume,
          target,
          readOnly: false,
          subpath: null,
          path: indexPath(`${d.path}.volumes`, i),
        })),
        ...s.tmpfs.map((target, i) => ({ type: 'tmpfs' as const, target, sizeBytes: null, path: indexPath(`${d.path}.tmpfs`, i) })),
      ],
      rng,
    );
    d.files = maybeShuffle(
      s.files.map(([kind, source, target], i) => ({
        kind,
        source,
        target,
        mode: 0o444,
        uid: null,
        gid: null,
        path: indexPath(`${d.path}.${kind}s`, i),
      })),
      rng,
    );
    d.network.aliases = maybeShuffle(s.aliases, rng);
    if (s.networks.length > 0) d.network.networks = maybeShuffle(s.networks, rng);
    d.network.extraHosts = maybeShuffle(s.extraHosts, rng);
    d.security.capAdd = maybeShuffle(s.capAdd, rng);
    d.process.groupAdd = maybeShuffle(s.groupAdd, rng);
    d.routes = maybeShuffle(
      s.routes.map((r, i) => ({
        router: r.router,
        rule: 'Host(`shop.example.com`)',
        entryPoints: maybeShuffle(r.entryPoints, rng),
        tls: null,
        middlewares: r.middlewares,
        priority: null,
        port: 80,
        origin: 'labels' as const,
        path: indexPath(`${d.path}.routes`, i),
      })),
      rng,
    );
    d.containerLabels = rng === null ? { ...s.labels } : deepShuffleKeys(s.labels, rng);
    d.extension.loadBalancerSourceRanges = maybeShuffle(s.lbRanges, rng);
    if (s.fatal) f.ctx.markFatal(d.path);
    drafts.push(rng === null ? d : deepShuffleKeys(d, rng));
  }
  f.drafts.push(...drafts);
  return f;
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((v, i) => i === 0 || compareCodeUnits(values[i - 1], v) < 0);
}

function isSortedBy<T>(values: readonly T[], compare: (a: T, b: T) => number): boolean {
  return values.every((v, i) => i === 0 || compare(values[i - 1], v) <= 0);
}

/** DESIGN-CORE 3 and design-01 9 invariants of a finalized stack. */
function invariantViolations(stack: CanonicalStack, fatal: ReadonlySet<string>): string[] {
  const issues = undefinedPaths(stack).map((p) => `undefined at ${p}`);
  if (!isSortedBy(stack.services, (a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.composeName, b.composeName))) {
    issues.push('services not sorted by name');
  }
  const volumeKeys = new Set(stack.volumes.map((v) => v.key));
  const fileKeys = new Set(stack.files.map((s) => `${s.kind}/${s.key}`));
  const users = new Map<string, Set<string>>();
  for (const s of stack.services) {
    const at = `service ${s.composeName}`;
    if (fatal.has(s.composeName)) issues.push(`${at} is fatal`);
    if (!isSortedBy(s.environment, (a, b) => compareCodeUnits(a.name, b.name))) issues.push(`${at} environment`);
    const portOrder = (a: PortSpec, b: PortSpec) =>
      a.target - b.target || compareCodeUnits(a.protocol, b.protocol) || (a.published ?? -1) - (b.published ?? -1);
    if (!isSortedBy(s.ports, portOrder)) issues.push(`${at} ports`);
    if (!isSortedBy(s.expose, (a, b) => a.target - b.target || compareCodeUnits(a.protocol, b.protocol))) issues.push(`${at} expose`);
    if (!isSortedBy(s.mounts, (a, b) => compareCodeUnits(a.target, b.target))) issues.push(`${at} mounts`);
    if (!isSortedBy(s.files, (a, b) => compareCodeUnits(a.target, b.target))) issues.push(`${at} files`);
    if (!s.process.groupAdd.every((g, i) => i === 0 || s.process.groupAdd[i - 1] < g)) issues.push(`${at} groupAdd`);
    for (const [name, values] of [
      ['capAdd', s.security.capAdd],
      ['capDrop', s.security.capDrop],
      ['networks', s.network.networks],
      ['aliases', s.network.aliases],
      ['loadBalancerSourceRanges', s.extension.loadBalancerSourceRanges],
      ...s.routes.map((r): [string, string[]] => [`routes.${r.router}.entryPoints`, r.entryPoints]),
    ] as [string, string[]][]) {
      if (!isStrictlySorted(values)) issues.push(`${at} ${name}`);
    }
    if (!isSortedBy(s.network.extraHosts, (a, b) => compareCodeUnits(a.ip, b.ip) || compareCodeUnits(a.hostname, b.hostname))) {
      issues.push(`${at} extraHosts`);
    }
    if (!isSortedBy(s.routes, (a, b) => compareCodeUnits(a.router, b.router))) issues.push(`${at} routes`);
    for (const map of [s.containerLabels, s.serviceLabels, s.podAnnotations, s.security.sysctls, s.extension.nodeSelector, s.extension.podLabels]) {
      if (!isPlainMap(map)) issues.push(`${at} map is not plain`);
    }
    for (const m of s.mounts) {
      if (m.type !== 'volume') continue;
      if (!volumeKeys.has(m.volume)) issues.push(`${at} mounts ${m.volume}, absent from stack.volumes`);
      users.set(m.volume, (users.get(m.volume) ?? new Set()).add(s.composeName));
    }
    for (const file of s.files) {
      if (!fileKeys.has(`${file.kind}/${file.source}`)) issues.push(`${at} mounts ${file.kind} ${file.source}, absent from stack.files`);
    }
  }
  if (!isStrictlySorted(stack.volumes.map((v) => v.key))) issues.push('volumes not sorted by key');
  for (const v of stack.volumes) {
    const expected = [...(users.get(v.key) ?? [])].sort(compareCodeUnits);
    if (expected.length === 0) issues.push(`volume ${v.key} is not mounted`);
    if (canonicalJson(v.usedBy) !== canonicalJson(expected)) issues.push(`volume ${v.key} usedBy ${v.usedBy.join(',')}`);
  }
  const referenced = new Set(stack.services.flatMap((s) => s.files.map((f) => `${f.kind}/${f.source}`)));
  if (!isStrictlySorted(stack.files.map((s) => `${s.kind}/${s.key}`))) issues.push('files not sorted by (kind, key)');
  for (const s of stack.files) if (!referenced.has(`${s.kind}/${s.key}`)) issues.push(`file ${s.kind}/${s.key} is not mounted`);
  if (!isSortedBy(stack.middlewares, (a, b) => compareCodeUnits(a.name, b.name))) issues.push('middlewares not sorted');
  for (const m of stack.middlewares) if (m.users !== null && !isStrictlySorted(m.users)) issues.push(`middleware ${m.name} users`);
  return issues;
}

function runGenerated(gen: StackGen, rng: Rng | null): { stack: CanonicalStack; diagnostics: Diagnostic[]; usedBy: string } {
  const f = buildFixture(gen, rng);
  const { stack, diagnostics } = f.run();
  const usedBy = canonicalJson([...f.volumes.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([k, v]) => [k, v.usedBy]));
  return { stack, diagnostics, usedBy };
}

function expectOrderIndependent(gen: StackGen, seeds: readonly number[]): void {
  const base = runGenerated(gen, null);
  expect(invariantViolations(base.stack, new Set(gen.services.filter((s) => s.fatal).map((s) => s.key)))).toEqual([]);
  for (const seed of seeds) {
    const shuffled = runGenerated(gen, mulberry32(seed));
    expect(canonicalJson(shuffled.stack)).toBe(canonicalJson(base.stack));
    // plain objects are rebuilt with sorted keys: even the insertion order matches
    expect(JSON.stringify(shuffled.stack)).toBe(JSON.stringify(base.stack));
    expect(shuffled.diagnostics).toEqual(base.diagnostics);
    expect(shuffled.usedBy).toBe(base.usedBy);
  }
}

/** One stack touching every check and every order. */
const DET_STACK: StackGen = {
  role: 'app',
  services: [
    {
      ...genService(mulberry32(1), 'web'),
      fatal: false,
      workloadKind: 'Deployment',
      volumes: [
        ['data', '/data'],
        ['ghost', '/ghost'],
        ['pg_data', '/pg'],
      ],
      files: [
        ['secret', 'tls_cert', '/run/secrets/a'],
        ['secret', 'tls-cert', '/run/secrets/b'],
        ['config', 'ghost', '/etc/g'],
      ],
      aliases: ['www', 'db', 'web-lb'],
      networks: ['backend', 'ghost', 'default'],
    },
    { ...genService(mulberry32(2), 'web_app'), fatal: false, volumes: [], files: [] },
    { ...genService(mulberry32(3), 'Web.App'), fatal: false, volumes: [], files: [] },
    { ...genService(mulberry32(4), 'db'), fatal: false, workloadKind: 'StatefulSet', volumes: [['pg-data', '/pg']], files: [] },
    { ...genService(mulberry32(5), 'db-hl'), fatal: false, volumes: [], files: [] },
    { ...genService(mulberry32(6), 'worker'), fatal: true, volumes: [['logs', '/logs']], files: [] },
  ],
  volumes: [
    { key: 'data', external: false, name: 'data', perReplica: true, accessMode: 'ReadWriteOnce' },
    { key: 'pg_data', external: false, name: 'pg-data', perReplica: false, accessMode: 'ReadWriteOnce' },
    { key: 'pg-data', external: false, name: 'pg-data', perReplica: false, accessMode: 'ReadWriteOncePod' },
    { key: 'logs', external: false, name: 'logs', perReplica: false, accessMode: 'ReadWriteMany' },
    { key: 'shared', external: true, name: 'data', perReplica: false, accessMode: 'ReadWriteOnce' },
    { key: 'cache', external: false, name: 'cache', perReplica: false, accessMode: 'ReadWriteOnce' },
  ],
  files: [
    { kind: 'secret', key: 'tls_cert', content: 'A' },
    { kind: 'secret', key: 'tls-cert', content: 'A' },
    { kind: 'config', key: 'conf', content: 'B' },
    { kind: 'secret', key: 'api_key', content: null },
  ],
  networks: ['backend'],
  middlewares: [
    { name: 'strip', users: null },
    { name: 'auth', users: ['u2:$x', 'u1:$y', 'u2:$x'] },
  ],
  sibling: {
    services: [
      { key: 'redis', aliases: ['cache'] },
      { key: 'api', aliases: [] },
    ],
    volumes: [
      { key: 'logs', claimName: 'logs', external: false },
      { key: 'shared', claimName: 'data', external: true },
    ],
  },
  shuffleSeed: 7,
};

describe('DET-01 determinism', () => {
  test('permuting drafts, tables, sibling lists, mapping keys and every sorted array gives byte-identical output', () => {
    const base = runGenerated(DET_STACK, null);
    // the stack exercises the checks it is meant to hold still
    const codes = new Set(base.diagnostics.map((d) => d.code));
    for (const code of [
      'names.sanitize-collision',
      'names.derived-collision',
      'names.volume-collision',
      'names.file-collision',
      'volumes.role-collision',
      'volumes.undeclared',
      'files.undeclared',
      'network.undeclared',
      'extension.per-replica-kind',
      'volumes.unused',
      'files.unused',
    ]) {
      expect(codes.has(code)).toBe(true);
    }
    expectOrderIndependent(
      DET_STACK,
      Array.from({ length: 25 }, (_, i) => 1000 + i),
    );
  });

  forAll(
    'invariants on shuffled drafts: generated stacks keep the model invariants and ignore input order',
    (rng) => genStack(rng),
    (gen) => expectOrderIndependent(gen, [gen.shuffleSeed]),
  );
});
