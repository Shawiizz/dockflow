import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { sha256Hex } from '../../utils/hash';
import { DiagnosticSink } from '../../services/orchestrator/diagnostics';
import {
  assignPortNames,
  hashedObjectName,
  headlessServiceName,
  importedImageRef,
  isIanaSvcName,
  jobNameFor,
  leaseNameFor,
  loadBalancerServiceName,
  middlewareNameFor,
  NameRegistry,
  namespaceFor,
  nodeNameFor,
  portNameFor,
  releaseSecretName,
  releaseSlug,
  sanitizeDnsLabel,
  serviceNameFor,
  volumeClaimNameFor,
} from '../../services/orchestrator/kubernetes/naming';
import { isDnsLabel, isDnsSubdomain, isLabelValue } from '../../services/orchestrator/kubernetes/model/units';

const h = (input: string, length: number): string => sha256Hex(input).slice(0, length);

describe('DESIGN-CORE 5.4 examples (U-NAMING-01)', () => {
  it('serviceNameFor', () => {
    expect(serviceNameFor('web_app')).toEqual({ value: 'web-app', changed: true });
    expect(serviceNameFor('2fa')).toEqual({ value: 's-2fa', changed: true });
    expect(serviceNameFor('Api.V2')).toEqual({ value: 'api-v2', changed: true });
    expect(serviceNameFor('web')).toEqual({ value: 'web', changed: false });
  });

  it('volumeClaimNameFor and middlewareNameFor', () => {
    expect(volumeClaimNameFor('postgres_data')).toEqual({ value: 'postgres-data', changed: true });
    expect(volumeClaimNameFor('2data')).toEqual({ value: '2data', changed: false });
    expect(middlewareNameFor('Auth_Basic')).toEqual({ value: 'auth-basic', changed: true });
  });

  it('namespaceFor', () => {
    expect(namespaceFor('shop', 'production')).toBe('dockflow-shop-production');
  });

  it('nodeNameFor lowercases and replaces _ with -, nothing else', () => {
    expect(nodeNameFor('worker_1')).toBe('worker-1');
    expect(nodeNameFor('Worker_1')).toBe('worker-1');
    expect(nodeNameFor('Agent_1')).toBe('agent-1');
    expect(nodeNameFor('server-1')).toBe('server-1');
    expect(nodeNameFor('a__b')).toBe('a--b');
  });

  it('releaseSlug and releaseSecretName', () => {
    expect(releaseSlug('1.4.2')).toBe('1.4.2');
    expect(releaseSlug('1.4.2+Build_7')).toBe(`1.4.2-build-7-${h('1.4.2+Build_7', 8)}`);
    expect(releaseSecretName('1.4.2')).toBe('dockflow-release-1.4.2');
    expect(releaseSecretName('1.4.2+Build_7')).toBe(`dockflow-release-1.4.2-build-7-${h('1.4.2+Build_7', 8)}`);
  });

  it('importedImageRef', () => {
    expect(importedImageRef('shop-api-production:1.4.2')).toBe('dockflow.invalid/shop-api-production:1.4.2');
  });

  it('portNameFor falls back to <protocol>-<port>', () => {
    expect(portNameFor(8080, 'TCP', null)).toBe('tcp-8080');
    expect(portNameFor(53, 'UDP', null)).toBe('udp-53');
    expect(portNameFor(9, 'SCTP', null)).toBe('sctp-9');
  });

  it('jobNameFor, -lb, -hl, lease and hashed object names', () => {
    const checksum = sha256Hex('job spec');
    expect(jobNameFor('migrate', checksum)).toBe(`migrate-${checksum.slice(0, 8)}`);
    expect(jobNameFor('migrate', '0c1d2e3f4a5b')).toBe('migrate-0c1d2e3f');
    expect(loadBalancerServiceName('web')).toBe('web-lb');
    expect(headlessServiceName('db')).toBe('db-hl');
    expect(leaseNameFor('dockflow-shop-production')).toBe('lock-dockflow-shop-production');
    expect(hashedObjectName('web', 'env', '3f9a1c2e77aa')).toBe('web-env-3f9a1c2e');
    expect(hashedObjectName('tls_cert', 'secret', '9b1e0d4400ff')).toBe('tls-cert-secret-9b1e0d44');
    expect(hashedObjectName('nginx.conf', 'config', 'abcdef0123')).toBe('nginx-conf-config-abcdef01');
  });
});

describe('sanitizeDnsLabel (DESIGN-CORE 5.4 steps 1-8)', () => {
  const label = (input: string, max = 63, mustStartWithLetter = false) => sanitizeDnsLabel(input, { max, mustStartWithLetter });

  it('lowercases, replaces invalid characters, collapses and trims dashes', () => {
    expect(label('My__Service..V2')).toEqual({ value: 'my-service-v2', changed: true });
    expect(label('--edge--')).toEqual({ value: 'edge', changed: true });
    expect(label('ok-name')).toEqual({ value: 'ok-name', changed: false });
  });

  it('turns an empty result into x (N-ID-06)', () => {
    expect(label('')).toEqual({ value: 'x', changed: true });
    expect(label('___')).toEqual({ value: 'x', changed: true });
    expect(serviceNameFor('日本').value).toBe('x');
    expect(serviceNameFor('中国').value).toBe('x');
  });

  it('prefixes s- only when a letter is required and the name starts with a digit', () => {
    expect(label('9lives', 63, true).value).toBe('s-9lives');
    expect(label('9lives', 63, false).value).toBe('9lives');
    expect(label('x', 63, true).value).toBe('x');
  });

  it('truncates to max - 7, trims trailing dashes and appends 6 hex of the original input', () => {
    const input = `${'a'.repeat(40)}-${'b'.repeat(30)}`;
    const result = label(input, 42);
    expect(result.value).toBe(`${'a'.repeat(35)}-${h(input, 6)}`);
    expect(result.value.length).toBe(42);
    const dashed = `${'a'.repeat(34)}-${'b'.repeat(30)}`;
    expect(label(dashed, 42).value).toBe(`${'a'.repeat(34)}-${h(dashed, 6)}`);
  });

  it('N-ID-05: a 53-character service name keeps 45 characters plus 6 hex', () => {
    const input = 'a'.repeat(53);
    expect(serviceNameFor(input)).toEqual({ value: `${'a'.repeat(45)}-${h(input, 6)}`, changed: true });
    expect(serviceNameFor(input).value.length).toBe(52);
  });
});

describe('boundary rows (design-07 8.4)', () => {
  it('B-01: service name 52 / 53 characters', () => {
    expect(serviceNameFor('a'.repeat(52))).toEqual({ value: 'a'.repeat(52), changed: false });
    expect(serviceNameFor('a'.repeat(53)).value.length).toBe(52);
  });

  it('B-02: namespace raw 63 / 64 characters', () => {
    // 'dockflow-' (9) + project + '-' (1) + env
    const project63 = 'p'.repeat(40);
    const env63 = 'e'.repeat(13);
    expect(namespaceFor(project63, env63)).toBe(`dockflow-${project63}-${env63}`);
    expect(namespaceFor(project63, env63).length).toBe(63);
    const env64 = 'e'.repeat(14);
    const raw = `dockflow-${project63}-${env64}`;
    const hashed = namespaceFor(project63, env64);
    expect(hashed).toBe(`${raw.slice(0, 54)}-${h(raw, 8)}`);
    expect(hashed.length).toBe(63);
    expect(isDnsLabel(hashed)).toBe(true);
  });

  it('B-02: a dash at the cut is trimmed before the hash', () => {
    const project = 'p'.repeat(44);
    const env = 'production';
    const raw = `dockflow-${project}-${env}`;
    expect(raw[53]).toBe('-');
    expect(namespaceFor(project, env)).toBe(`${raw.slice(0, 53)}-${h(raw, 8)}`);
  });

  it('B-03: release version 40 valid characters / 41', () => {
    const v40 = `1.0.0-${'a'.repeat(34)}`;
    expect(releaseSlug(v40)).toBe(v40);
    const v41 = `1.0.0-${'a'.repeat(35)}`;
    expect(releaseSlug(v41)).toBe(`${v41.slice(0, 31)}-${h(v41, 8)}`);
    expect(releaseSlug(v41).length).toBe(40);
  });

  it('B-13: hashedObjectName with a 52-character service is 65 characters and a valid subdomain', () => {
    const name = hashedObjectName('s'.repeat(52), 'env', sha256Hex('env'));
    expect(name.length).toBe(65);
    expect(isDnsSubdomain(name)).toBe(true);
  });

  it('B-14: jobNameFor with a 52-character service is 61 characters', () => {
    expect(jobNameFor('j'.repeat(52), sha256Hex('spec')).length).toBe(61);
  });

  it('B-15: leaseNameFor with a 63-character stackId is 68 characters and a valid subdomain', () => {
    const lease = leaseNameFor(`dockflow-${'x'.repeat(54)}`);
    expect(lease.length).toBe(68);
    expect(isDnsSubdomain(lease)).toBe(true);
  });
});

describe('releaseSlug edge cases', () => {
  it('hashes any version that is not already a clean lowercase name', () => {
    expect(releaseSlug('V1.0')).toBe(`v1.0-${h('V1.0', 8)}`);
    expect(releaseSlug('feature/login')).toBe(`feature-login-${h('feature/login', 8)}`);
    expect(releaseSlug('-1.0-')).toBe(`1.0-${h('-1.0-', 8)}`);
  });

  it('keeps semver pre-releases and git hashes as they are', () => {
    expect(releaseSlug('1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(releaseSlug('3f9a1c2')).toBe('3f9a1c2');
  });

  it('collapses runs of dots and dashes so the Secret name stays a valid subdomain', () => {
    const slug = releaseSlug('1..2');
    expect(slug).toBe(`1-2-${h('1..2', 8)}`);
    expect(isDnsSubdomain(releaseSecretName('1..2'))).toBe(true);
    expect(isDnsSubdomain(releaseSecretName('1.-2'))).toBe(true);
  });

  it('a version with no usable character becomes its 8-hex hash', () => {
    expect(releaseSlug('+++')).toBe(h('+++', 8));
    expect(isLabelValue(releaseSlug('+++'))).toBe(true);
  });
});

describe('port names (DESIGN-CORE 5.4, design-02 6.7)', () => {
  it('sanitizes a requested name to IANA_SVC_NAME when that yields a valid name', () => {
    expect(portNameFor(80, 'TCP', 'http')).toBe('http');
    expect(portNameFor(80, 'TCP', 'HTTP')).toBe('http');
    expect(portNameFor(80, 'TCP', 'web_ui')).toBe('web-ui');
    expect(portNameFor(80, 'TCP', '--web--')).toBe('web');
    expect(portNameFor(80, 'TCP', 'metrics-exporter')).toBe('tcp-80');
    expect(portNameFor(80, 'TCP', '8080')).toBe('tcp-80');
    expect(portNameFor(80, 'TCP', '')).toBe('tcp-80');
    expect(portNameFor(80, 'TCP', '___')).toBe('tcp-80');
  });

  it('isIanaSvcName', () => {
    expect(isIanaSvcName('http')).toBe(true);
    expect(isIanaSvcName('tcp-65535')).toBe(true);
    expect(isIanaSvcName('a--b')).toBe(false);
    expect(isIanaSvcName('1234')).toBe(false);
    expect(isIanaSvcName('-a')).toBe(false);
    expect(isIanaSvcName('abcdefghijklmnop')).toBe(false);
  });

  it('the first entry in model order keeps a requested name; later duplicates fall back', () => {
    expect(
      assignPortNames([
        { port: 80, protocol: 'TCP', requested: 'http' },
        { port: 8080, protocol: 'TCP', requested: 'HTTP' },
        { port: 9090, protocol: 'TCP', requested: null },
        { port: 53, protocol: 'UDP', requested: 'dns' },
      ]),
    ).toEqual(['http', 'tcp-8080', 'tcp-9090', 'dns']);
  });

  it('a range expansion colliding with a named port falls back for the later entries', () => {
    expect(
      assignPortNames([
        { port: 8000, protocol: 'TCP', requested: 'api' },
        { port: 8001, protocol: 'TCP', requested: 'api' },
        { port: 8002, protocol: 'TCP', requested: 'api' },
      ]),
    ).toEqual(['api', 'tcp-8001', 'tcp-8002']);
  });

  it('TCP and UDP on one port get distinct names', () => {
    expect(
      assignPortNames([
        { port: 53, protocol: 'TCP', requested: null },
        { port: 53, protocol: 'UDP', requested: null },
      ]),
    ).toEqual(['tcp-53', 'udp-53']);
  });

  it("a request of another port's generated form is refused, whichever port comes first", () => {
    expect(
      assignPortNames([
        { port: 80, protocol: 'TCP', requested: null },
        { port: 81, protocol: 'TCP', requested: 'tcp-80' },
      ]),
    ).toEqual(['tcp-80', 'tcp-81']);
    expect(
      assignPortNames([
        { port: 80, protocol: 'TCP', requested: 'tcp-81' },
        { port: 81, protocol: 'TCP', requested: null },
      ]),
    ).toEqual(['tcp-80', 'tcp-81']);
    expect(
      assignPortNames([
        { port: 53, protocol: 'TCP', requested: 'UDP-53' },
        { port: 53, protocol: 'UDP', requested: null },
      ]),
    ).toEqual(['tcp-53', 'udp-53']);
  });

  it('the generated form is refused even when no port of the list has it, so adding that port renames nothing', () => {
    expect(assignPortNames([{ port: 80, protocol: 'TCP', requested: 'tcp-9000' }])).toEqual(['tcp-80']);
    expect(assignPortNames([{ port: 80, protocol: 'TCP', requested: 'tcp-080' }])).toEqual(['tcp-80']);
  });

  it("a request of the port's own generated form is kept, and blocks nobody", () => {
    expect(
      assignPortNames([
        { port: 80, protocol: 'TCP', requested: 'TCP-80' },
        { port: 81, protocol: 'TCP', requested: 'tcp-80' },
      ]),
    ).toEqual(['tcp-80', 'tcp-81']);
  });

  it('entries repeating a (port, protocol) key fall back to its one generated name; the caller tells them apart', () => {
    expect(
      assignPortNames([
        { port: 80, protocol: 'TCP', requested: null },
        { port: 80, protocol: 'TCP', requested: 'tcp-80' },
        { port: 80, protocol: 'TCP', requested: 'http' },
      ]),
    ).toEqual(['tcp-80', 'tcp-80', 'http']);
  });
});

describe('importedImageRef (DESIGN-CORE 5.7)', () => {
  it('prefixes plain references and references with a registry host', () => {
    expect(importedImageRef('app')).toBe('dockflow.invalid/app');
    expect(importedImageRef('ghcr.io/org/app:1.0')).toBe('dockflow.invalid/ghcr.io/org/app:1.0');
    expect(importedImageRef('app@sha256:abc')).toBe('dockflow.invalid/app@sha256:abc');
  });

  it('folds a registry host with a port or brackets into a valid path component', () => {
    expect(importedImageRef('localhost:5000/app:1.0')).toBe('dockflow.invalid/localhost-5000/app:1.0');
    expect(importedImageRef('registry.example.com:5000/team/app')).toBe('dockflow.invalid/registry.example.com-5000/team/app');
    expect(importedImageRef('[::1]:5000/app')).toBe('dockflow.invalid/1--5000/app');
    expect(importedImageRef('Registry.Example.com/app')).toBe('dockflow.invalid/registry.example.com/app');
  });
});

describe('NameRegistry (U-NAMING-02)', () => {
  it('a second owner produces one error diagnostic naming both paths', () => {
    const sink = new DiagnosticSink();
    const names = new NameRegistry(sink);
    expect(names.claim('service', 'api-v2', { description: 'service Api.V2', path: 'services.Api.V2' })).toBe(true);
    expect(names.claim('service', 'api-v2', { description: 'service api-v2', path: 'services.api-v2' })).toBe(false);
    expect(sink.list()).toEqual([
      {
        severity: 'error',
        code: 'names.sanitize-collision',
        path: 'services.api-v2',
        message: 'resolves to the Kubernetes name api-v2, already used by service Api.V2 (services.Api.V2)',
        hint: 'Rename one of the services.',
      },
    ]);
    expect(names.ownerOf('service', 'api-v2')).toEqual({ description: 'service Api.V2', path: 'services.Api.V2' });
  });

  it('the same owner twice is not a collision', () => {
    const sink = new DiagnosticSink();
    const names = new NameRegistry(sink);
    const owner = { description: 'service web', path: 'services.web' };
    expect(names.claim('service', 'web', owner)).toBe(true);
    expect(names.claim('service', 'web', { ...owner })).toBe(true);
    expect(sink.list()).toEqual([]);
  });

  it('spaces are independent', () => {
    const sink = new DiagnosticSink();
    const names = new NameRegistry(sink);
    names.claim('service', 'data', { description: 'service data', path: 'services.data' });
    names.claim('volume', 'data', { description: 'volume data', path: 'volumes.data' });
    names.claim('middleware', 'data', { description: 'middleware data', path: 'services.web.labels' });
    names.claim('file', 'data', { description: 'secret data', path: 'secrets.data' });
    expect(sink.hasErrors()).toBe(false);
    expect(names.ownerOf('volume', 'nope')).toBeNull();
  });

  it('default diagnostics of the volume, middleware and file spaces', () => {
    const sink = new DiagnosticSink();
    const names = new NameRegistry(sink);
    names.claim('volume', 'pg-data', { description: 'volume pg-data', path: 'volumes.pg-data' });
    names.claim('volume', 'pg-data', { description: 'volume pg_data', path: 'volumes.pg_data' });
    names.claim('middleware', 'auth', { description: 'middleware auth', path: 'services.web.labels' });
    names.claim('middleware', 'auth', { description: 'middleware Auth', path: 'services.api.labels' });
    names.claim('file', 'tls-cert-secret-9b1e0d44', { description: 'secret tls-cert', path: 'secrets.tls-cert' });
    names.claim('file', 'tls-cert-secret-9b1e0d44', { description: 'secret tls_cert', path: 'secrets.tls_cert' });
    expect(sink.list().map((d) => [d.code, d.path, d.message, d.hint])).toEqual([
      [
        'names.file-collision',
        'secrets.tls_cert',
        'secret tls_cert would create the object tls-cert-secret-9b1e0d44, already created for secret tls-cert (secrets.tls-cert)',
        'Rename one of them.',
      ],
      [
        'names.middleware-collision',
        'services.api.labels',
        'middleware Auth resolves to the middleware auth, already used by middleware auth (services.web.labels)',
        'Rename one of the middlewares.',
      ],
      [
        'names.volume-collision',
        'volumes.pg_data',
        'volume pg_data is stored in the claim pg-data, already used by volume pg-data (volumes.pg-data)',
        'Rename one of the volumes.',
      ],
    ]);
  });

  it('a caller-specific diagnostic replaces the default one', () => {
    const sink = new DiagnosticSink();
    const names = new NameRegistry(sink);
    names.claim('service', 'web-lb', { description: 'load balancer Service of web', path: 'services.web' });
    names.claim('service', 'web-lb', { description: 'service web-lb', path: 'services.web-lb' }, (c) => ({
      code: 'names.derived-collision',
      message: `resolves to ${c.name}, which is reserved for the load balancer Service of web`,
      hint: 'Rename the service.',
    }));
    expect(sink.list()).toEqual([
      {
        severity: 'error',
        code: 'names.derived-collision',
        path: 'services.web-lb',
        message: 'resolves to web-lb, which is reserved for the load balancer Service of web',
        hint: 'Rename the service.',
      },
    ]);
  });
});

describe('one nodeNameFor (cross-cutting rule 3)', () => {
  it('is defined once, in naming.ts', () => {
    const root = join(import.meta.dir, '..', '..');
    const definitions: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(path);
        } else if (entry.name.endsWith('.ts') && /(function\s+nodeNameFor\b|\bnodeNameFor\s*=)/.test(readFileSync(path, 'utf8'))) {
          definitions.push(relative(root, path).split(sep).join('/'));
        }
      }
    };
    walk(root);
    expect(definitions).toEqual(['services/orchestrator/kubernetes/naming.ts']);
  });
});
