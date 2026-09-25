import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Diagnostic, DiagnosticSink } from '../../services/orchestrator/diagnostics';
import { createFileResolver, resolutionDigest, withDigests } from '../../services/orchestrator/file-resolver';
import type { ResolvedHelmRelease, StackDeployInput } from '../../services/orchestrator/interfaces';
import { importedImageRef } from '../../services/orchestrator/kubernetes/naming';
import { isNormalizeCode, NORMALIZE_CODES, normalizeCode } from '../../services/orchestrator/kubernetes/normalize/keys';
import {
  composeFileFor,
  DEFAULT_KEEP_RELEASES,
  type RenderEnvironment,
  renderStackArtifact,
  reservedHostPortsFromConfig,
  revisionHistoryLimitFor,
  type StackRender,
} from '../../services/orchestrator/kubernetes/render';
import type { Deployment } from '../../services/orchestrator/kubernetes/resources/apps';
import type { ManifestObject } from '../../services/orchestrator/kubernetes/resources/registry';
import { TRANSLATE_CODES, TRANSLATOR_CODES } from '../../services/orchestrator/kubernetes/translate';
import { isTranslatorCode } from '../../services/orchestrator/kubernetes/translate/diagnostics';
import { emitManifests, parseManifests } from '../../services/orchestrator/kubernetes/yaml';
import type { ServersConfig } from '../../types/servers';
import { ComposeTranslationError } from '../../utils/errors';
import { canonicalJson, sha256Hex } from '../../utils/hash';
import { config, type DeployInputOverrides, deployInput, traits } from './support/builders';
import { deepShuffleKeys, fnv1a32, mulberry32 } from './support/prng';

const K = join(import.meta.dir, '..', '..', 'services', 'orchestrator', 'kubernetes');

function environment(overrides: Partial<RenderEnvironment> = {}): RenderEnvironment {
  return { traits: traits(), imageDelivery: 'import', extraReservedHostPorts: [{ port: 22, protocol: 'TCP', reason: 'SSH' }], ...overrides };
}

function render(overrides: DeployInputOverrides = {}, env: Partial<RenderEnvironment> = {}): StackRender {
  return renderStackArtifact(deployInput(overrides), environment(env));
}

function renderError(overrides: DeployInputOverrides, env: Partial<RenderEnvironment> = {}): ComposeTranslationError {
  try {
    render(overrides, env);
  } catch (error) {
    expect(error).toBeInstanceOf(ComposeTranslationError);
    return error as ComposeTranslationError;
  }
  throw new Error('the render did not throw');
}

function find<Kind extends ManifestObject['kind']>(objects: readonly ManifestObject[], kind: Kind, name: string): Extract<ManifestObject, { kind: Kind }> {
  const found = objects.find((o) => o.kind === kind && o.metadata.name === name);
  if (found === undefined) throw new Error(`${kind}/${name} was not rendered`);
  return found as Extract<ManifestObject, { kind: Kind }>;
}

function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** A stack touching most handlers and modules, with warnings from both layers and no error. */
const RICH = {
  services: {
    web: {
      image: 'nginx:1.27',
      ports: ['8080:80'],
      environment: { B: '2', A: '1' },
      labels: { 'com.example.team': 'shop', 'com.example.tier': 'front' },
      volumes: ['data:/data', 'cache:/cache'],
      secrets: ['api_key'],
      deploy: { resources: { limits: { cpus: '0.5', memory: '256M' } }, labels: { 'com.example.owner': 'ops' } },
      healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost'], interval: '10s' },
      depends_on: ['api'],
    },
    api: {
      build: '.',
      image: 'shop-api-production:1.4.2',
      expose: ['3000'],
      environment: ['Z=26', 'Y=25'],
      tty: 'yes',
      configs: [{ source: 'settings', target: '/etc/api/settings.json', mode: 288 }],
    },
    Worker_1: { image: 'busybox:1.36', command: ['sh', '-c', 'sleep 3600'], ports: ['3000'] },
  },
  volumes: { data: {}, cache: { 'x-dockflow': { size: '2Gi' } } },
  secrets: { api_key: { file: './api_key.txt' } },
  configs: { settings: { content: '{"debug": false}' } },
};

const RICH_FILES = { 'api_key.txt': 'not-a-real-key' };
const PROXY = { enabled: true, acme: true, email: 'ops@example.com', domains: { production: 'shop.example.com' } };

function helmRelease(values: Record<string, unknown> = { replicaCount: 2 }): ResolvedHelmRelease {
  return {
    name: 'search',
    role: 'app',
    namespace: 'dockflow-shop-production',
    chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'search' },
    version: '2.4.1',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 300,
    auth: { username: 'robot', password: 'hunter2-example' },
    declaredDigest: 'a'.repeat(64),
  };
}

describe('one sink, two disjoint catalogues (U-DIAG-02..04, PD-11 (b))', () => {
  test('U-DIAG-02 the normalizer and translator catalogues are disjoint; TRANSLATE_CODES is TRANSLATOR_CODES', () => {
    expect(TRANSLATE_CODES).toBe(TRANSLATOR_CODES);
    const translator = new Set<string>(TRANSLATE_CODES.map((e) => e.code));
    expect(NORMALIZE_CODES.filter((e) => translator.has(e.code)).map((e) => e.code)).toEqual([]);
  });

  test('U-DIAG-02 every code a normalize/* file emits is a normalizer code with its severity; translate/* reports only through the catalogue', () => {
    const SEVERITY = { error: 'error', warn: 'warning', info: 'info' } as const;
    const problems: string[] = [];
    for (const file of readdirSync(join(K, 'normalize'))) {
      const text = readFileSync(join(K, 'normalize', file), 'utf8');
      for (const m of text.matchAll(/\.(error|warn|info)\(\s*'([^']+)'/g)) {
        const entry = normalizeCode(m[2]);
        if (entry === null) problems.push(`normalize/${file}: ${m[2]} is not in NORMALIZE_CODES`);
        else if (entry.severity !== SEVERITY[m[1] as keyof typeof SEVERITY]) problems.push(`normalize/${file}: ${m[2]} reported as ${m[1]}, catalogued ${entry.severity}`);
        if (isTranslatorCode(m[2])) problems.push(`normalize/${file}: ${m[2]} is a translator code`);
      }
    }
    for (const file of readdirSync(join(K, 'translate'))) {
      const text = readFileSync(join(K, 'translate', file), 'utf8');
      for (const m of text.matchAll(/\.sink\.(error|warn|info)\(/g)) problems.push(`translate/${file}: reports without the catalogue (${m[0]})`);
      for (const m of text.matchAll(/reportTranslator\([^,]+,\s*'([^']+)'/g)) {
        if (!isTranslatorCode(m[1])) problems.push(`translate/${file}: ${m[1]} is not in TRANSLATE_CODES`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('U-DIAG-02 every code of a render belongs to exactly one catalogue', () => {
    const { artifact } = render({ compose: RICH, files: RICH_FILES, proxy: PROXY });
    for (const d of artifact.diagnostics) expect(`${d.code} ${isNormalizeCode(d.code) !== isTranslatorCode(d.code)}`).toBe(`${d.code} true`);
  });

  test('U-DIAG-03 the merged catalogue has each code once, with a severity and its documentation', () => {
    const merged = [
      ...NORMALIZE_CODES.map((e) => ({ code: e.code, severity: e.severity as string, documented: e.module.length > 0 })),
      ...TRANSLATE_CODES.map((e) => ({ code: e.code, severity: e.severity as string, documented: e.path.length > 0 && typeof e.message === 'function' })),
    ];
    const codes = merged.map((e) => e.code);
    expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
    for (const e of merged) {
      expect(e.code).toMatch(/^[a-z_]+\.[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(`${e.code} ${['error', 'warning', 'info', 'default-aware'].includes(e.severity)} ${e.documented}`).toBe(`${e.code} true true`);
    }
  });

  describe('U-DIAG-04 render() builds one sink', () => {
    const proto = DiagnosticSink.prototype;
    const originals = { error: proto.error, warn: proto.warn, info: proto.info };
    afterEach(() => {
      Object.assign(proto, originals);
    });

    test('both layers report into the same sink, and the artifact carries its list once, deduplicated and sorted', () => {
      const calls: { sink: DiagnosticSink; code: string; path: string }[] = [];
      for (const name of ['error', 'warn', 'info'] as const) {
        const original = originals[name];
        proto[name] = function (this: DiagnosticSink, ...args: Parameters<DiagnosticSink['error']>): void {
          calls.push({ sink: this, code: args[0], path: args[1] });
          original.apply(this, args);
        };
      }
      const { artifact } = render({
        compose: { services: { web: { image: 'nginx:1.27', ports: ['3000'], volumes: ['app_data:/a', 'app_data:/b'] } }, volumes: { app_data: {} } },
      });
      Object.assign(proto, originals);

      expect(new Set(calls.map((c) => c.sink)).size).toBe(1);
      const codes = codesOf(artifact.diagnostics);
      expect(codes.some(isNormalizeCode)).toBe(true);
      expect(codes.some(isTranslatorCode)).toBe(true);
      // the claim-name info is reported at each mount of the volume, and listed once
      expect(calls.filter((c) => c.code === 'names.volume-sanitized')).toHaveLength(2);
      expect(artifact.diagnostics.filter((d) => d.code === 'names.volume-sanitized')).toHaveLength(1);
      const pairs = artifact.diagnostics.map((d) => `${d.path} ${d.code}`);
      expect(pairs).toEqual([...new Set(calls.map((c) => `${c.path} ${c.code}`))].sort());
    });
  });
});

describe('renderStackArtifact (design-03 4)', () => {
  test('header lines of DESIGN-CORE 4.2 rule 1; the accessory header has no version', () => {
    const app = render({ version: '1.4.2' }).artifact.content.split('\n').slice(0, 5);
    expect(app).toEqual(['# dockflow-artifact: k8s-manifests/1', '# stack: shop-production', '# role: app', '# version: 1.4.2', '---']);
    const accessory = render({ ref: { role: 'accessory' }, compose: { services: { db: { image: 'postgres:16' } } } }).artifact;
    expect(accessory.content.split('\n').slice(0, 4)).toEqual(['# dockflow-artifact: k8s-manifests/1', '# stack: shop-production', '# role: accessory', '# version: -']);
    expect(accessory).toMatchObject({ format: 'k8s-manifests/1', role: 'accessory' });
  });

  test('digest = sha256Hex(content + "\\n" + canonicalJson(helm)); Helm records keep values, drop credentials, pin the chart', () => {
    const { artifact } = render({ helm: [helmRelease()] });
    expect(artifact.digest).toBe(sha256Hex(`${artifact.content}\n${canonicalJson(artifact.helm)}`));
    expect(artifact.helm).toEqual([
      {
        name: 'search',
        role: 'app',
        namespace: 'dockflow-shop-production',
        chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'search' },
        version: '2.4.1',
        values: { replicaCount: 2 },
        valuesSha256: sha256Hex(canonicalJson({ replicaCount: 2 })),
        timeoutS: 300,
        chartSha256: 'a'.repeat(64),
      },
    ]);
    expect(JSON.stringify(artifact)).not.toContain('hunter2-example');
    const other = render({ helm: [helmRelease({ replicaCount: 3 })] }).artifact;
    expect(other.content).toBe(artifact.content);
    expect(other.digest).not.toBe(artifact.digest);
    expect(render().artifact.digest).toBe(sha256Hex(`${render().artifact.content}\n[]`));
  });

  test('accessories are byte-identical across release versions (DESIGN-CORE 4.2 rule 9)', () => {
    const accessory = (version: string) =>
      render({ version, ref: { role: 'accessory' }, compose: { services: { db: { image: 'postgres:16', ports: ['5432:5432'], environment: { PGDATA: '/data' } } } } }).artifact;
    const [first, second] = [accessory('1.4.2'), accessory('1.5.0')];
    expect(second.content).toBe(first.content);
    expect(second.digest).toBe(first.digest);
    expect(first.content).not.toContain('1.4.2');
    // the app role carries the version in its header and P/release only
    expect(render({ version: '1.5.0' }).artifact.content).not.toBe(render({ version: '1.4.2' }).artifact.content);
  });

  test('determinism: shuffled mapping keys give the same bytes, digest and diagnostics', () => {
    const base = render({ compose: RICH, files: RICH_FILES, proxy: PROXY });
    expect(base.artifact.diagnostics.some((d) => d.severity === 'warning')).toBe(true);
    for (const seed of [1, 2, 3].map((i) => fnv1a32(`render-shuffle-${i}`))) {
      const shuffled = render({ compose: deepShuffleKeys(RICH, mulberry32(seed)), files: RICH_FILES, proxy: PROXY });
      expect(shuffled.artifact.content).toBe(base.artifact.content);
      expect(shuffled.artifact.digest).toBe(base.artifact.digest);
      expect(shuffled.artifact.diagnostics).toEqual(base.artifact.diagnostics);
    }
    expect(render({ compose: RICH, files: RICH_FILES, proxy: PROXY }).artifact.content).toBe(base.artifact.content);
  });

  test('objects are the parsed artifact; failure actions by compose name', () => {
    const result = render({
      compose: { services: { web: { image: 'nginx:1.27' }, api: { image: 'nginx:1.27', deploy: { update_config: { failure_action: 'pause' } } } } },
    });
    expect(result.objects).toEqual(parseManifests(result.artifact.content));
    const header = { format: 'k8s-manifests/1' as const, stackName: 'shop-production', role: 'app' as const, version: '1.4.2' };
    expect(emitManifests(result.objects, header)).toBe(result.artifact.content);
    expect(result.failureActions).toEqual({ api: 'pause', web: 'rollback' });
    expect(result.stack.services.map((s) => s.composeName)).toEqual(['api', 'web']);
  });

  test('a normalizer error throws before the translator runs; a translator error throws with the merged list', () => {
    const normalizer = renderError({ compose: { services: { web: { image: 'Nginx', ports: ['22:22'] } } } });
    expect(normalizer.message).toBe('docker-compose.yml cannot be deployed with orchestrator: k3s (1 error(s))');
    expect(codesOf(normalizer.diagnostics)).toEqual(['image.invalid-reference']);

    const translator = renderError({ ref: { role: 'accessory' }, compose: { services: { db: { image: 'postgres:16', ports: ['22:22'], tty: 'yes' } } } });
    expect(translator.message).toBe('accessories.yml cannot be deployed with orchestrator: k3s (1 error(s))');
    expect(translator.diagnostics.map((d) => [d.severity, d.code, d.path])).toEqual([
      ['error', 'ports.reserved-host-port', 'services.db.ports[0]'],
      ['warning', 'values.yaml11-boolean', 'services.db.tty'],
    ]);
    expect(composeFileFor('app')).toBe('docker-compose.yml');
  });

  test('reservations: configuration ports, the Traefik on the cluster and the sibling role published ports (PD-2)', () => {
    const reasons = (overrides: DeployInputOverrides, env: Partial<RenderEnvironment> = {}): string[] =>
      renderError(overrides, env).diagnostics.filter((d) => d.code === 'ports.reserved-host-port').map((d) => d.message);
    const ports = (list: string[]) => ({ services: { web: { image: 'nginx:1.27', ports: list } } });
    expect(reasons({ compose: ports(['2222:80']) }, { extraReservedHostPorts: [{ port: 2222, protocol: 'TCP', reason: 'SSH' }] })).toEqual([
      'services.web.ports[0] publishes 2222/tcp, which is reserved on the nodes (SSH)',
    ]);
    expect(reasons({ compose: ports(['80:80']), traefikOnCluster: true })).toEqual([
      'services.web.ports[0] publishes 80/tcp, which is reserved on the nodes (Dockflow Traefik)',
    ]);
    const published = [{ port: 8080, protocol: 'TCP' as const }];
    const sibling = (keys: string[]) => ({ services: keys.map((key) => ({ key, name: key, aliases: [], published })) });
    expect(reasons({ compose: ports(['8080:80']), sibling: sibling(['queue', 'cache']) })).toEqual([
      'services.web.ports[0] publishes 8080/tcp, which is reserved on the nodes (published by accessories service cache)',
    ]);
    // the reason never depends on the order of the sibling detail
    expect(reasons({ compose: ports(['8080:80']), sibling: sibling(['cache', 'queue']) })).toEqual(reasons({ compose: ports(['8080:80']), sibling: sibling(['queue', 'cache']) }));
    expect(
      reasons({ ref: { role: 'accessory' }, compose: { services: { db: { image: 'postgres:16', ports: ['8080:5432'] } } }, sibling: sibling(['web']) }),
    ).toEqual(['services.db.ports[0] publishes 8080/tcp, which is reserved on the nodes (published by app service web)']);
  });

  test('imageDelivery comes from the environment, never from images.mode; the pull Secret from the input', () => {
    const compose = { services: { api: { build: '.', image: 'shop-api-production:1.4.2' } } };
    const image = (result: StackRender): string => find(result.objects, 'Deployment', 'api').spec.template.spec.containers[0].image;
    expect(image(render({ compose, images: { mode: 'none' } }, { imageDelivery: 'import' }))).toBe(importedImageRef('shop-api-production:1.4.2'));
    const registry = render({ compose, images: { mode: 'registry', pullSecretName: 'dockflow-registry' } }, { imageDelivery: 'registry' });
    expect(image(registry)).toBe('shop-api-production:1.4.2');
    expect(find(registry.objects, 'Deployment', 'api').spec.template.spec.imagePullSecrets).toEqual([{ name: 'dockflow-registry' }]);
  });

  test('revisionHistoryLimit = max(1, keep_releases - 1): the old revisions of the kept releases', () => {
    const limit = (keepReleases: number | undefined): number | undefined =>
      (find(render({}, { keepReleases }).objects, 'Deployment', 'web') as Deployment).spec.revisionHistoryLimit;
    expect(DEFAULT_KEEP_RELEASES).toBe(3);
    expect([limit(undefined), limit(1), limit(2), limit(5)]).toEqual([2, 1, 1, 4]);
    expect(revisionHistoryLimitFor(0)).toBe(1);
  });

  test('files are read through input.files only', () => {
    const reads: string[] = [];
    const files: StackDeployInput['files'] = (path) => {
      reads.push(path);
      return { ok: true, bytes: new TextEncoder().encode('value'), rendered: true };
    };
    const result = render({ compose: { services: { web: { image: 'nginx:1.27', secrets: ['token'] } }, secrets: { token: { file: './token.txt' } } }, files });
    expect(reads).toEqual(['token.txt']);
    expect(result.objects.filter((o) => o.kind === 'Secret').map((o) => o.metadata.name)).toHaveLength(1);
  });
});

describe('reservedHostPortsFromConfig (design-03 4)', () => {
  const servers: ServersConfig = {
    defaults: { user: 'dockflow', port: 2200 },
    servers: {
      server_1: { tags: ['production'], port: 22 },
      server_2: { tags: ['production'] },
      agent_1: { tags: ['production', 'staging'], port: 2222 },
      staging_1: { tags: ['staging'], port: 3333 },
    },
  };

  test('the distinct SSH ports of the environment servers, then the nginx plugin listen ports, ascending', () => {
    const cfg = config({
      plugins: [
        { use: 'nginx', with: { domain: 'shop.example.com', port: 8080 } },
        { use: 'nginx', id: 'admin', with: { domain: 'admin.example.com', listen: '8443' } },
        { use: 'nginx', id: 'broken', with: { domain: 'x.example.com', listen: 'not-a-port' } },
        { use: 'systemd', with: { listen: 9000 } },
      ],
    });
    expect(reservedHostPortsFromConfig(cfg, servers, 'production')).toEqual([
      { port: 22, protocol: 'TCP', reason: 'SSH' },
      { port: 80, protocol: 'TCP', reason: 'nginx plugin' },
      { port: 2200, protocol: 'TCP', reason: 'SSH' },
      { port: 2222, protocol: 'TCP', reason: 'SSH' },
      { port: 8443, protocol: 'TCP', reason: 'nginx plugin' },
    ]);
  });

  test('servers without a port use servers.yml defaults, then 22; an SSH port wins over the plugin', () => {
    const plain: ServersConfig = { servers: { server_1: { tags: ['production'] } } };
    expect(reservedHostPortsFromConfig(config(), plain, 'production')).toEqual([{ port: 22, protocol: 'TCP', reason: 'SSH' }]);
    expect(reservedHostPortsFromConfig(config({ plugins: [{ use: 'nginx', with: { listen: 22 } }] }), plain, 'production')).toEqual([
      { port: 22, protocol: 'TCP', reason: 'SSH' },
    ]);
    expect(reservedHostPortsFromConfig(config(), plain, 'staging')).toEqual([]);
  });
});

describe('createFileResolver (design-01 1.5)', () => {
  let root = '';
  const BINARY = new Uint8Array([0x30, 0x82, 0xff, 0xfe, 0x00, 0x01]);
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dockflow-resolver-'));
    mkdirSync(join(root, '.dockflow', 'docker', 'files'), { recursive: true });
    writeFileSync(join(root, '.dockflow', 'docker', 'app.env'), 'A={{ value }}\n');
    writeFileSync(join(root, '.dockflow', 'docker', 'files', 'keystore.p12'), BINARY);
    writeFileSync(join(root, 'plain.txt'), 'plain\n');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function resolver() {
    const rendered = new Map([
      ['.dockflow/docker/app.env', 'A=rendered\n'],
      // renderTemplates decoded the binary file as UTF-8: the resolver must not return this text
      ['.dockflow/docker/files/keystore.p12', 'corrupted �'],
      ['.dockflow/docker/generated.txt', 'only in the map\n'],
    ]);
    return createFileResolver(rendered, root, join(root, '.dockflow', 'docker'));
  }

  test('rendered text for a UTF-8 file of the map, raw bytes for a binary one and for files outside the map', () => {
    const files = resolver();
    expect(files('app.env')).toEqual({ ok: true, bytes: new TextEncoder().encode('A=rendered\n'), rendered: true });
    expect(files('files/keystore.p12')).toEqual({ ok: true, bytes: BINARY, rendered: false });
    expect(files('generated.txt')).toEqual({ ok: true, bytes: new TextEncoder().encode('only in the map\n'), rendered: true });
    expect(files('../../plain.txt')).toEqual({ ok: true, bytes: new TextEncoder().encode('plain\n'), rendered: false });
  });

  test('failure reasons: missing, directory, outside-project, unreadable', () => {
    const files = resolver();
    // any other failure of the file system is `unreadable` (here: a path the OS refuses)
    expect(files('bad name.env')).toEqual({ ok: false, reason: 'unreadable' });
    expect(files('nope.env')).toEqual({ ok: false, reason: 'missing' });
    expect(files('files/nope/deeper.env')).toEqual({ ok: false, reason: 'missing' });
    expect(files('files')).toEqual({ ok: false, reason: 'directory' });
    expect(files('../..')).toEqual({ ok: false, reason: 'directory' });
    expect(files('../../../etc/passwd')).toEqual({ ok: false, reason: 'outside-project' });
    expect(createFileResolver(new Map(), join(root, '.dockflow'))('../plain.txt')).toEqual({ ok: false, reason: 'outside-project' });
  });

  test('symbolic links: one leading out of the project is outside-project, a loop is unreadable', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dockflow-resolver-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    // directory links: the one form an unprivileged process can create on every platform
    symlinkSync(outside, join(root, 'escape'), 'junction');
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'), 'junction');
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'), 'junction');
    try {
      // renderTemplates followed the link too: the file is refused all the same
      expect(createFileResolver(new Map([['escape/secret.txt', 'rendered']]), root)('escape/secret.txt')).toEqual({ ok: false, reason: 'outside-project' });
      expect(createFileResolver(new Map(), root)('escape/secret.txt')).toEqual({ ok: false, reason: 'outside-project' });
      expect(createFileResolver(new Map(), root)('loop-a')).toEqual({ ok: false, reason: 'unreadable' });
    } finally {
      for (const link of ['escape', 'loop-a', 'loop-b']) rmSync(join(root, link), { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('digests() records every resolved path with the digest of what it returned', () => {
    const files = resolver();
    files('app.env');
    files('nope.env');
    files('files/keystore.p12');
    expect(files.digests()).toEqual({
      'app.env': sha256Hex('A=rendered\n'),
      'files/keystore.p12': sha256Hex(BINARY),
      'nope.env': '!missing',
    });
    expect(Object.keys(files.digests())).toEqual(['app.env', 'files/keystore.p12', 'nope.env']);
    expect(resolutionDigest(files('app.env'))).toBe(files.digests()['app.env']);
  });

  test('withDigests wraps any resolver, and the render reads through it', () => {
    const files = withDigests(() => ({ ok: true, bytes: new TextEncoder().encode('value'), rendered: true }));
    render({ compose: { services: { web: { image: 'nginx:1.27', env_file: ['web.env'] } } }, files });
    expect(files.digests()).toEqual({ 'web.env': sha256Hex('value') });
  });
});
