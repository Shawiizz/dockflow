import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  DockflowConfigSchema,
  HelmConfigSchema,
  HelmReleaseSchema,
  isRenderedPath,
  ProxyConfigSchema,
} from '../../../schemas/config.schema';
import { RootConfigSchema } from '../../../schemas/root-config.schema';
import { ServerConfigSchema, ServersBaseSchema } from '../../../schemas/servers.schema';
import { M } from '../../../services/orchestrator/messages';

interface Issue {
  path: string;
  message: string;
  code: string;
}

function issuesOf(schema: z.ZodType, input: unknown): Issue[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }));
}

const config = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  project_name: 'shop',
  orchestrator: 'k3s',
  ...extra,
});

const release = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'postgres',
  chart: 'postgresql',
  repo: 'https://charts.example.org',
  version: '16.7.4',
  ...extra,
});

const withRelease = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> =>
  config({ helm: { releases: [release(extra)] }, ...top });

const proxy = (keys: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> =>
  config({ proxy: { enabled: true, email: 'ops@example.com', ...keys }, ...top });

// ---------------------------------------------------------------------------
// U-SCHEMA-MSG-01: every constraint carries an explicit message
// ---------------------------------------------------------------------------

interface ZodNode {
  _zod: { def: ZodDef };
}

interface ZodDef {
  type?: string;
  check?: string;
  format?: string;
  fn?: unknown;
  error?: (issue: unknown) => unknown;
  checks?: ZodNode[];
  shape?: Record<string, ZodNode>;
  innerType?: ZodNode;
  element?: ZodNode;
  keyType?: ZodNode;
  valueType?: ZodNode;
  options?: ZodNode[];
}

interface Constraint {
  where: string;
  message: string | null;
}

const messageOf = (def: ZodDef): string | null => {
  const rendered = def.error?.({ code: 'custom', input: undefined });
  return typeof rendered === 'string' ? rendered : null;
};

/** Constraints of a schema tree: string formats, length and pattern checks, refinements. */
function constraintsOf(schema: z.ZodType, where: string): Constraint[] {
  const out: Constraint[] = [];
  const visit = (node: ZodNode, at: string): void => {
    const def = node._zod.def;
    if (def.format !== undefined) out.push({ where: `${at} (${def.format})`, message: messageOf(def) });
    if (def.type === 'union') out.push({ where: `${at} (union)`, message: messageOf(def) });
    for (const check of def.checks ?? []) {
      const c = check._zod.def;
      // superRefine callbacks carry their messages in addIssue, asserted row by row below
      if (c.check === 'custom' && c.fn === undefined) continue;
      out.push({ where: `${at} (${c.format ?? c.check})`, message: messageOf(c) });
    }
    for (const [key, child] of Object.entries(def.shape ?? {})) visit(child, `${at}.${key}`);
    for (const child of [def.innerType, def.element, def.keyType, def.valueType]) {
      if (child !== undefined) visit(child, at);
    }
    for (const option of def.options ?? []) visit(option, at);
  };
  visit(schema as unknown as ZodNode, where);
  return out;
}

/** DESIGN-CORE 8.1: one sentence, no trailing period, never zod's bare "Invalid" */
function expectMessageStyle(message: string): void {
  expect(message).not.toMatch(/\.$/);
  expect(message).not.toContain('\n');
  expect(message).not.toMatch(/^Invalid\b/);
  expect(message.length).toBeGreaterThan(10);
}

describe('U-SCHEMA-MSG-01: explicit messages on every added constraint', () => {
  const proxyShape = ProxyConfigSchema.shape;
  const serverShape = ServerConfigSchema.shape;
  const added: [string, z.ZodType][] = [
    ['helm', HelmConfigSchema],
    ['helm.releases[]', HelmReleaseSchema],
    ['proxy.manage', proxyShape.manage],
    ['proxy.acme_ca_server', proxyShape.acme_ca_server],
    ['proxy.acme_ca_bundle', proxyShape.acme_ca_bundle],
    ['proxy.default_ingress_class', proxyShape.default_ingress_class],
    ['servers.<key>.private_host', serverShape.private_host],
    ['servers.<key>.node_labels', serverShape.node_labels],
  ];

  it('finds a constraint without a message (walker self-check)', () => {
    const bare = constraintsOf(z.object({ v: z.string().regex(/^x$/).max(3, 'at most 3') }), 'probe');
    expect(bare.map((c) => [c.where, c.message])).toEqual([
      ['probe.v (regex)', null],
      ['probe.v (max_length)', 'at most 3'],
    ]);
  });

  for (const [where, schema] of added) {
    it(`${where}: every constraint names what is wrong`, () => {
      const constraints = constraintsOf(schema, where);
      expect(constraints.filter((c) => c.message === null).map((c) => c.where)).toEqual([]);
      for (const c of constraints) expectMessageStyle(c.message as string);
    });
  }

  it('walks every constraint the Helm release schema declares', () => {
    const wheres = constraintsOf(HelmReleaseSchema, 'r').map((c) => c.where);
    for (const expected of [
      'r.name (max_length)',
      'r.name (regex)',
      'r.chart (min_length)',
      'r.repo (url)',
      'r.version (regex)',
      'r.digest (regex)',
      'r.namespace (max_length)',
      'r.namespace (regex)',
      'r.values_files (min_length)',
      'r.timeout (regex)',
      'r.auth.username (min_length)',
      'r.auth.password (min_length)',
    ]) {
      expect(wheres).toContain(expected);
    }
  });

  it('cross-field messages follow the same style', () => {
    for (const message of [
      M.helmRequiresK3s,
      M.helmDuplicateName('web'),
      M.helmRepoWithOci,
      M.helmRepoRequired,
      M.valuesFileUnrendered('helm/values.yml'),
      M.remoteBuildK3s,
      M.proxyKeyRequiresK3s('proxy.manage'),
      M.proxyManageNeedsEnabled,
      M.acmeCaNeedsAcme,
      M.acmeCaBundleNeedsServer,
      M.acmeCaBundleUnrendered('certs/ca.pem'),
    ]) {
      expectMessageStyle(message);
    }
  });

  it('a record key error surfaces the key message, not "Invalid key in record"', () => {
    const issues = issuesOf(ServerConfigSchema, { tags: ['production'], node_labels: { 'bad key': 'x' } });
    expect(issues).toEqual([{ path: 'node_labels.bad key', message: M.labelKey, code: 'invalid_key' }]);
  });
});

// ---------------------------------------------------------------------------
// design-07 13.2 rows
// ---------------------------------------------------------------------------

describe('config.yml helm section (DESIGN-CORE 7.1, design-07 13.2)', () => {
  it('accepts a complete release and fills the defaults', () => {
    const parsed = DockflowConfigSchema.parse(withRelease());
    expect(parsed.helm).toEqual({
      timeout: '5m',
      releases: [
        {
          name: 'postgres',
          chart: 'postgresql',
          repo: 'https://charts.example.org',
          version: '16.7.4',
          role: 'app',
          values: {},
          values_files: [],
        },
      ],
    });
    expect(DockflowConfigSchema.parse(config({ helm: {} })).helm).toEqual({ timeout: '5m', releases: [] });
  });

  it('accepts the design-04 3.2 examples', () => {
    const helm = {
      timeout: '10m',
      releases: [
        release({ role: 'accessory', values_files: ['.dockflow/helm/postgres.yaml'], values: { primary: { persistence: { size: '2Gi' } } } }),
        { name: 'search', chart: 'oci://registry.example.com/charts/search', version: '2.4.1', auth: { username: 'ci', password: 'secret-token' } },
        { name: 'example-operator', role: 'accessory', chart: 'oci://registry.example.com/charts/example-operator', version: 'v1.18.2', namespace: 'example-operator', timeout: '15m' },
        { name: 'billing', chart: 'billing', repo: 'https://charts.internal.example.com/stable', version: '0.9.3', digest: 'a'.repeat(64) },
      ],
    };
    expect(issuesOf(DockflowConfigSchema, config({ helm }))).toEqual([]);
  });

  it('U-SCHEMA-HELM-01: helm with orchestrator swarm, written or defaulted, is refused at helm', () => {
    const expected = [{ path: 'helm', message: M.helmRequiresK3s, code: 'custom' }];
    expect(issuesOf(DockflowConfigSchema, withRelease({}, { orchestrator: 'swarm' }))).toEqual(expected);
    expect(issuesOf(DockflowConfigSchema, { project_name: 'shop', helm: { releases: [release()] } })).toEqual(expected);
    expect(issuesOf(DockflowConfigSchema, { project_name: 'shop', helm: {} })).toEqual(expected);
  });

  it('U-SCHEMA-HELM-02: a duplicate name is reported on the second release', () => {
    const helm = { releases: [release({ name: 'web' }), release({ name: 'api' }), release({ name: 'web' })] };
    expect(issuesOf(DockflowConfigSchema, config({ helm }))).toEqual([
      { path: 'helm.releases.2.name', message: 'Helm release "web" is declared twice', code: 'custom' },
    ]);
    expect(issuesOf(DockflowConfigSchema, config({ helm: { releases: [release({ name: 'web' }), release({ name: 'web' })] } }))).toEqual([
      { path: 'helm.releases.1.name', message: M.helmDuplicateName('web'), code: 'custom' },
    ]);
  });

  it('U-SCHEMA-HELM-03: an oci:// chart with repo is refused', () => {
    expect(issuesOf(DockflowConfigSchema, withRelease({ chart: 'oci://registry.example.com/charts/search' }))).toEqual([
      { path: 'helm.releases.0.repo', message: 'repo must not be set for an oci:// chart', code: 'custom' },
    ]);
  });

  it('U-SCHEMA-HELM-04: a repository chart without repo is refused', () => {
    expect(issuesOf(DockflowConfigSchema, withRelease({ repo: undefined }))).toEqual([
      { path: 'helm.releases.0.repo', message: 'repo is required unless chart starts with oci://', code: 'custom' },
    ]);
  });

  it('U-SCHEMA-HELM-05: only exact versions are accepted', () => {
    for (const version of ['^1.2.0', '~1.2', '>=1', '1.x', 'latest', '1.2', '01.2.3', '1.2.3 ']) {
      expect(issuesOf(HelmReleaseSchema, release({ version }))).toEqual([
        { path: 'version', message: M.exactVersion, code: 'invalid_format' },
      ]);
    }
    for (const version of ['1.2.3', 'v1.18.2', '1.2.3-rc.1+b', '0.0.0']) {
      expect(issuesOf(HelmReleaseSchema, release({ version }))).toEqual([]);
    }
    // YAML reads `version: 1.2` as a number
    expect(issuesOf(HelmReleaseSchema, release({ version: 1.2 }))).toEqual([
      { path: 'version', message: M.exactVersion, code: 'invalid_type' },
    ]);
    expect(issuesOf(HelmReleaseSchema, release({ version: undefined })).map((i) => i.message)).toEqual([M.exactVersion]);
  });

  it('U-SCHEMA-HELM-06: names must be DNS labels of at most 53 characters', () => {
    expect(issuesOf(HelmReleaseSchema, release({ name: 'Web' }))).toEqual([{ path: 'name', message: M.helmName, code: 'invalid_format' }]);
    expect(issuesOf(HelmReleaseSchema, release({ name: '-web' }))).toEqual([{ path: 'name', message: M.helmName, code: 'invalid_format' }]);
    expect(issuesOf(HelmReleaseSchema, release({ name: 'web.api' }))).toEqual([{ path: 'name', message: M.helmName, code: 'invalid_format' }]);
    expect(issuesOf(HelmReleaseSchema, release({ name: 'a'.repeat(54) }))).toEqual([
      { path: 'name', message: M.helmNameTooLong, code: 'too_big' },
    ]);
    expect(issuesOf(HelmReleaseSchema, release({ name: 'a'.repeat(53) }))).toEqual([]);
    expect(issuesOf(HelmReleaseSchema, release({ name: 'web-1' }))).toEqual([]);
  });

  it('U-SCHEMA-HELM-07: options.remote_build is refused on k3s only', () => {
    expect(issuesOf(DockflowConfigSchema, config({ options: { remote_build: true } }))).toEqual([
      {
        path: 'options.remote_build',
        message: 'options.remote_build is not supported with orchestrator: k3s (k3s nodes run containerd only); build locally or push to a registry',
        code: 'custom',
      },
    ]);
    expect(issuesOf(DockflowConfigSchema, config({ options: { remote_build: false } }))).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, config({ orchestrator: 'swarm', options: { remote_build: true } }))).toEqual([]);
  });

  it('U-SCHEMA-HELM-08: unknown keys under a release or under helm are errors', () => {
    const typo = issuesOf(DockflowConfigSchema, withRelease({ value: { replicas: 2 } }));
    expect(typo.map((i) => [i.path, i.code])).toEqual([['helm.releases.0', 'unrecognized_keys']]);
    expect(typo[0].message).toContain('value');
    const top = issuesOf(DockflowConfigSchema, config({ helm: { releases: [], timout: '5m' } }));
    expect(top.map((i) => [i.path, i.code])).toEqual([['helm', 'unrecognized_keys']]);
  });

  it('U-SCHEMA-HELM-09: timeouts must be Go durations', () => {
    expect(issuesOf(HelmReleaseSchema, release({ timeout: '5 minutes' }))).toEqual([
      { path: 'timeout', message: M.duration, code: 'invalid_format' },
    ]);
    expect(issuesOf(HelmConfigSchema, { timeout: '5 minutes' })).toEqual([{ path: 'timeout', message: M.duration, code: 'invalid_format' }]);
    for (const timeout of ['90s', '5m', '1h30m', '1.5h', '500ms']) {
      expect(issuesOf(HelmReleaseSchema, release({ timeout }))).toEqual([]);
    }
    for (const timeout of ['5', 'm', '-5m', '5M']) {
      expect(issuesOf(HelmReleaseSchema, release({ timeout })).map((i) => i.message)).toEqual([M.duration]);
    }
  });

  it('U-SCHEMA-HELM-10: a values file outside .dockflow/ and not in templates is refused with the K34 (b) message', () => {
    expect(issuesOf(DockflowConfigSchema, withRelease({ values_files: ['helm/values.yml'] }))).toEqual([
      {
        path: 'helm.releases.0.values_files.0',
        message: 'values file "helm/values.yml" is not rendered: Dockflow only renders files under .dockflow/ and files listed in templates',
        code: 'custom',
      },
    ]);
  });

  it('U-SCHEMA-HELM-10: files under .dockflow/ and templates destinations are rendered', () => {
    const files = ['.dockflow/helm/wiki.yaml', './.dockflow/helm/wiki.production.yaml', 'helm/listed.yml', 'helm/out.yml'];
    const templates = ['helm/listed.yml', { src: 'helm/in.tpl', dest: 'helm/out.yml' }];
    expect(issuesOf(DockflowConfigSchema, withRelease({ values_files: files }, { templates }))).toEqual([]);
    const escaping = issuesOf(DockflowConfigSchema, withRelease({ values_files: ['.dockflow/../helm/values.yml', '/etc/values.yml'] }));
    expect(escaping.map((i) => [i.path, i.message])).toEqual([
      ['helm.releases.0.values_files.0', M.valuesFileUnrendered('.dockflow/../helm/values.yml')],
      ['helm.releases.0.values_files.1', M.valuesFileUnrendered('/etc/values.yml')],
    ]);
    // the rendered map holds the destination, so the source of a templates entry is not rendered
    expect(issuesOf(DockflowConfigSchema, withRelease({ values_files: ['helm/in.tpl'] }, { templates })).map((i) => i.path)).toEqual([
      'helm.releases.0.values_files.0',
    ]);
  });

  it('U-SCHEMA-HELM-10: an empty values_files entry has its own message and no rendering noise', () => {
    expect(issuesOf(DockflowConfigSchema, withRelease({ values_files: [''] }))).toEqual([
      { path: 'helm.releases.0.values_files.0', message: M.valuesFilePath, code: 'too_small' },
    ]);
  });

  it('U-SCHEMA-HELM-11: http:// repositories are accepted, other schemes are not', () => {
    expect(issuesOf(DockflowConfigSchema, withRelease({ repo: 'http://charts.example.com' }))).toEqual([]);
    for (const repo of ['ftp://charts.example.com', 'charts.example.com', 'oci://registry.example.com/charts']) {
      expect(issuesOf(HelmReleaseSchema, release({ repo }))).toEqual([{ path: 'repo', message: M.helmRepoUrl, code: 'invalid_format' }]);
    }
  });

  it('digest must be the 64 hexadecimal characters of the archive sha256', () => {
    expect(issuesOf(HelmReleaseSchema, release({ digest: 'ab'.repeat(32) }))).toEqual([]);
    for (const digest of [`sha256:${'ab'.repeat(32)}`, 'AB'.repeat(32), 'ab'.repeat(31)]) {
      expect(issuesOf(HelmReleaseSchema, release({ digest }))).toEqual([{ path: 'digest', message: M.chartDigest, code: 'invalid_format' }]);
    }
  });

  it('namespace must be a DNS-1123 label, never a subdomain', () => {
    expect(issuesOf(HelmReleaseSchema, release({ namespace: 'example-operator' }))).toEqual([]);
    expect(issuesOf(HelmReleaseSchema, release({ namespace: 'example.operator' }))).toEqual([
      { path: 'namespace', message: M.namespaceLabel, code: 'invalid_format' },
    ]);
    expect(issuesOf(HelmReleaseSchema, release({ namespace: 'a'.repeat(64) })).map((i) => i.message)).toEqual([M.namespaceLabel]);
    expect(issuesOf(HelmReleaseSchema, release({ namespace: 'a'.repeat(63) }))).toEqual([]);
  });

  it('chart, role and auth constraints', () => {
    expect(issuesOf(HelmReleaseSchema, release({ chart: '' }))).toEqual([{ path: 'chart', message: M.helmChart, code: 'too_small' }]);
    expect(issuesOf(HelmReleaseSchema, release({ role: 'accessory' }))).toEqual([]);
    expect(issuesOf(HelmReleaseSchema, release({ role: 'database' })).map((i) => i.path)).toEqual(['role']);
    expect(issuesOf(HelmReleaseSchema, release({ auth: { username: '', password: 'secret-token' } }))).toEqual([
      { path: 'auth.username', message: M.helmAuthField, code: 'too_small' },
    ]);
  });

  it('reports every rule of a release, not only the first', () => {
    const helm = {
      releases: [
        { name: 'web', chart: 'oci://registry.example.com/charts/web', repo: 'https://charts.example.org', version: '1.0.0', values_files: ['a.yml'] },
        { name: 'web', chart: 'web', version: '1.0.0' },
      ],
    };
    expect(issuesOf(DockflowConfigSchema, config({ orchestrator: 'swarm', helm })).map((i) => [i.path, i.message])).toEqual([
      ['helm', M.helmRequiresK3s],
      ['helm.releases.0.repo', M.helmRepoWithOci],
      ['helm.releases.0.values_files.0', M.valuesFileUnrendered('a.yml')],
      ['helm.releases.1.name', M.helmDuplicateName('web')],
      ['helm.releases.1.repo', M.helmRepoRequired],
    ]);
  });
});

describe('config.yml proxy keys for Kubernetes (design-04 2.3.1)', () => {
  it('U-SCHEMA-HELM-12: proxy.manage defaults to true and false is accepted on k3s', () => {
    const parsed = DockflowConfigSchema.parse(proxy({}));
    expect(parsed.proxy?.manage).toBe(true);
    expect(parsed.proxy?.default_ingress_class).toBe(false);
    expect(parsed.proxy?.acme_ca_server).toBeUndefined();
    expect(issuesOf(DockflowConfigSchema, proxy({ manage: false }))).toEqual([]);
    expect(DockflowConfigSchema.parse(config()).proxy).toBeUndefined();
  });

  it('U-SCHEMA-HELM-12: proxy.manage: false is refused on Swarm with the k3s-only message', () => {
    expect(issuesOf(DockflowConfigSchema, proxy({ manage: false }, { orchestrator: 'swarm' }))).toEqual([
      { path: 'proxy.manage', message: 'proxy.manage requires orchestrator: k3s', code: 'custom' },
    ]);
  });

  it('proxy.manage: false needs proxy.enabled', () => {
    expect(issuesOf(DockflowConfigSchema, config({ proxy: { manage: false } }))).toEqual([
      { path: 'proxy.manage', message: M.proxyManageNeedsEnabled, code: 'custom' },
    ]);
  });

  it('no stack needs an email, managing ACME or not (Let’s Encrypt accounts may have no contact)', () => {
    expect(issuesOf(DockflowConfigSchema, config({ proxy: { enabled: true, manage: false } }))).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, config({ proxy: { enabled: true } }))).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, config({ proxy: { enabled: true, acme: false } }))).toEqual([]);
  });

  it('U-SCHEMA-HELM-13: acme_ca_server must be an https:// URL', () => {
    const staging = 'https://acme-staging-v02.api.letsencrypt.org/directory';
    expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: staging }))).toEqual([]);
    expect(DockflowConfigSchema.parse(proxy({ acme_ca_server: staging })).proxy?.acme_ca_server).toBe(staging);
    for (const url of ['http://pebble.example.com/dir', 'pebble:14000/dir', 'not a url']) {
      expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: url }))).toEqual([
        { path: 'proxy.acme_ca_server', message: 'proxy.acme_ca_server must be an https:// URL', code: 'invalid_format' },
      ]);
    }
  });

  it('U-SCHEMA-HELM-13: the CA keys need ACME', () => {
    const keys = { acme: false, acme_ca_server: 'https://pebble.example.com/dir', acme_ca_bundle: '.dockflow/pebble.pem' };
    expect(issuesOf(DockflowConfigSchema, proxy(keys))).toEqual([
      { path: 'proxy.acme_ca_server', message: M.acmeCaNeedsAcme, code: 'custom' },
      { path: 'proxy.acme_ca_bundle', message: M.acmeCaNeedsAcme, code: 'custom' },
    ]);
  });

  it('U-SCHEMA-HELM-13: a bundle without a custom server is refused', () => {
    expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_bundle: '.dockflow/pebble.pem' }))).toEqual([
      { path: 'proxy.acme_ca_bundle', message: 'proxy.acme_ca_bundle only applies to a custom proxy.acme_ca_server', code: 'custom' },
    ]);
  });

  it('U-SCHEMA-HELM-13: a bundle must be rendered, by the values_files rule', () => {
    const server = 'https://pebble.example.com/dir';
    expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: server, acme_ca_bundle: '.dockflow/pebble.pem' }))).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: server, acme_ca_bundle: 'certs/pebble.pem' }))).toEqual([
      {
        path: 'proxy.acme_ca_bundle',
        message: 'proxy.acme_ca_bundle "certs/pebble.pem" is not rendered: Dockflow only renders files under .dockflow/ and files listed in templates',
        code: 'custom',
      },
    ]);
    expect(
      issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: server, acme_ca_bundle: 'certs/pebble.pem' }, { templates: ['certs/pebble.pem'] })),
    ).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, proxy({ acme_ca_server: server, acme_ca_bundle: '' }))).toEqual([
      { path: 'proxy.acme_ca_bundle', message: M.acmeCaBundlePath, code: 'too_small' },
    ]);
  });

  it('proxy.default_ingress_class is accepted on k3s', () => {
    expect(issuesOf(DockflowConfigSchema, proxy({ default_ingress_class: true }))).toEqual([]);
    expect(DockflowConfigSchema.parse(proxy({ default_ingress_class: true })).proxy?.default_ingress_class).toBe(true);
  });

  it('every Kubernetes-only proxy key is refused on Swarm, the defaults are not', () => {
    const keys = {
      manage: false,
      acme_ca_server: 'https://pebble.example.com/dir',
      acme_ca_bundle: '.dockflow/pebble.pem',
      default_ingress_class: true,
    };
    expect(issuesOf(DockflowConfigSchema, proxy(keys, { orchestrator: 'swarm' })).map((i) => [i.path, i.message])).toEqual([
      ['proxy.manage', M.proxyKeyRequiresK3s('proxy.manage')],
      ['proxy.acme_ca_server', M.proxyKeyRequiresK3s('proxy.acme_ca_server')],
      ['proxy.acme_ca_bundle', M.proxyKeyRequiresK3s('proxy.acme_ca_bundle')],
      ['proxy.default_ingress_class', M.proxyKeyRequiresK3s('proxy.default_ingress_class')],
    ]);
    expect(issuesOf(DockflowConfigSchema, proxy({ manage: true, default_ingress_class: false }, { orchestrator: 'swarm' }))).toEqual([]);
    expect(issuesOf(DockflowConfigSchema, { project_name: 'shop', proxy: { enabled: true, acme: false } })).toEqual([]);
  });
});

describe('flat layout: dockflow.yml keeps the config.yml rules', () => {
  const servers = { servers: { main: { host: '10.0.0.10', tags: ['production'] } } };

  it('RootConfigSchema accepts helm on k3s', () => {
    const parsed = RootConfigSchema.parse({ ...withRelease({ values_files: ['.dockflow/helm/postgres.yaml'] }), ...servers });
    expect(parsed.helm?.releases?.[0]?.name).toBe('postgres');
    expect(parsed.servers.main.host).toBe('10.0.0.10');
  });

  it('RootConfigSchema applies the cross-field rules', () => {
    expect(issuesOf(RootConfigSchema, { ...withRelease({}, { orchestrator: 'swarm' }), ...servers })).toEqual([
      { path: 'helm', message: M.helmRequiresK3s, code: 'custom' },
    ]);
    expect(issuesOf(RootConfigSchema, { ...withRelease({ values_files: ['helm/values.yml'] }), ...servers })).toEqual([
      { path: 'helm.releases.0.values_files.0', message: M.valuesFileUnrendered('helm/values.yml'), code: 'custom' },
    ]);
    expect(issuesOf(RootConfigSchema, { ...withRelease({ values_files: ['helm/values.yml'] }, { templates: ['helm/values.yml'] }), ...servers })).toEqual(
      [],
    );
    expect(issuesOf(RootConfigSchema, { ...config({ options: { remote_build: true } }), ...servers }).map((i) => i.message)).toEqual([
      M.remoteBuildK3s,
    ]);
  });

  it('RootConfigSchema still requires a manager per tag', () => {
    const workers = { servers: { main: { role: 'worker', host: '10.0.0.10', tags: ['production'] } } };
    expect(issuesOf(RootConfigSchema, { ...config(), ...workers }).map((i) => i.message)).toEqual([
      'Each environment tag must have at least one manager server',
    ]);
  });

  it('any merge of the config schema keeps the rules', () => {
    const merged = DockflowConfigSchema.merge(ServersBaseSchema);
    expect(issuesOf(merged, { ...config({ options: { remote_build: true } }), ...servers }).map((i) => i.message)).toEqual([
      M.remoteBuildK3s,
    ]);
  });
});

describe('isRenderedPath', () => {
  it('accepts .dockflow/ paths and templates destinations after POSIX normalization', () => {
    expect(isRenderedPath('.dockflow/helm/a.yaml', undefined)).toBe(true);
    expect(isRenderedPath('.dockflow\\helm\\a.yaml', undefined)).toBe(true);
    expect(isRenderedPath('./.dockflow/./helm/a.yaml', undefined)).toBe(true);
    expect(isRenderedPath('.dockflowx/a.yaml', undefined)).toBe(false);
    expect(isRenderedPath('.dockflow/../a.yaml', undefined)).toBe(false);
    expect(isRenderedPath('helm/a.yaml', ['./helm/a.yaml'])).toBe(true);
    expect(isRenderedPath('helm/a.yaml', [{ src: 'helm/a.tpl', dest: 'helm\\a.yaml' }])).toBe(true);
    expect(isRenderedPath('helm/a.tpl', [{ src: 'helm/a.tpl', dest: 'helm/a.yaml' }])).toBe(false);
  });
});
