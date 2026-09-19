import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { stringify } from 'yaml';
import { M } from '../shared/messages.js';
import {
  detectFileType,
  formatValidationResult,
  K3S_NOTE,
  validateConfig,
  validateFile,
  validateServersOnly,
  type ConfigFileType,
  type Orchestrator,
} from '../validate.js';

type Doc = Record<string, unknown>;

const k3s = (extra: Doc = {}): Doc => ({ project_name: 'shop', orchestrator: 'k3s', ...extra });
const swarm = (extra: Doc = {}): Doc => ({ project_name: 'shop', ...extra });

const release = (extra: Doc = {}): Doc => ({
  name: 'web',
  chart: 'oci://registry.example.com/charts/web',
  version: '1.0.0',
  ...extra,
});
const withRelease = (extra: Doc = {}, top: Doc = {}): Doc => k3s({ helm: { releases: [release(extra)] }, ...top });
const proxy = (keys: Doc, top: Doc = k3s()): Doc => ({ ...top, proxy: { enabled: true, email: 'ops@example.com', ...keys } });

const server = (extra: Doc = {}): Doc => ({ host: '203.0.113.10', tags: ['production'], ...extra });
const servers = (entries: Record<string, Doc>): Doc => ({ servers: entries });
const labels = (nodeLabels: Doc): Doc => servers({ main: server({ node_labels: nodeLabels }) });

interface RuleCase {
  /** Catalogue entry whose rule the case exercises */
  key: keyof typeof M;
  title: string;
  file: ConfigFileType;
  orchestrator?: Orchestrator;
  valid: Doc;
  invalid: Doc;
  expected: string;
}

/** Catalogue entries that are not validation rules: a deploy warning, a deploy refusal, a hint */
const NOT_RULES: ReadonlyArray<keyof typeof M> = ['helmRepoPlaintext', 'helmOciPlainHttp', 'privateHostIpv6K3sSuggestion'];

const CASES: RuleCase[] = [
  {
    key: 'helmRequiresK3s',
    title: 'helm on swarm',
    file: 'config',
    valid: withRelease(),
    invalid: swarm({ helm: { releases: [release()] } }),
    expected: `helm: ${M.helmRequiresK3s}`,
  },
  {
    key: 'helmName',
    title: 'release name pattern',
    file: 'config',
    valid: withRelease({ name: 'web-2' }),
    invalid: withRelease({ name: 'Web' }),
    expected: `helm.releases[0].name: ${M.helmName}`,
  },
  {
    key: 'helmNameTooLong',
    title: 'release name length',
    file: 'config',
    valid: withRelease({ name: 'a'.repeat(53) }),
    invalid: withRelease({ name: 'a'.repeat(54) }),
    expected: `helm.releases[0].name: ${M.helmNameTooLong}`,
  },
  {
    key: 'helmChart',
    title: 'empty chart',
    file: 'config',
    valid: withRelease({ chart: 'podinfo', repo: 'https://charts.example.com' }),
    invalid: withRelease({ chart: '', repo: 'https://charts.example.com' }),
    expected: `helm.releases[0].chart: ${M.helmChart}`,
  },
  {
    key: 'helmRepoUrl',
    title: 'repository URL',
    file: 'config',
    valid: withRelease({ chart: 'podinfo', repo: 'http://charts.example.com' }),
    invalid: withRelease({ chart: 'podinfo', repo: 'ftp://charts.example.com' }),
    expected: `helm.releases[0].repo: ${M.helmRepoUrl}`,
  },
  {
    key: 'exactVersion',
    title: 'exact chart version',
    file: 'config',
    valid: withRelease({ version: 'v1.2.3-rc.1' }),
    invalid: withRelease({ version: '1.x' }),
    expected: `helm.releases[0].version: ${M.exactVersion}`,
  },
  {
    key: 'chartDigest',
    title: 'chart digest',
    file: 'config',
    valid: withRelease({ digest: 'a'.repeat(64) }),
    invalid: withRelease({ digest: 'A'.repeat(64) }),
    expected: `helm.releases[0].digest: ${M.chartDigest}`,
  },
  {
    key: 'namespaceLabel',
    title: 'release namespace',
    file: 'config',
    valid: withRelease({ namespace: 'team-a' }),
    invalid: withRelease({ namespace: 'team.a' }),
    expected: `helm.releases[0].namespace: ${M.namespaceLabel}`,
  },
  {
    key: 'duration',
    title: 'release timeout',
    file: 'config',
    valid: withRelease({ timeout: '1h30m' }),
    invalid: withRelease({ timeout: '90' }),
    expected: `helm.releases[0].timeout: ${M.duration}`,
  },
  {
    key: 'duration',
    title: 'default Helm timeout',
    file: 'config',
    valid: k3s({ helm: { timeout: '500ms' } }),
    invalid: k3s({ helm: { timeout: 300 } }),
    expected: `helm.timeout: ${M.duration}`,
  },
  {
    key: 'valuesFilePath',
    title: 'empty values file',
    file: 'config',
    valid: withRelease({ values_files: ['.dockflow/helm/web.yml'] }),
    invalid: withRelease({ values_files: [''] }),
    expected: `helm.releases[0].values_files[0]: ${M.valuesFilePath}`,
  },
  {
    key: 'valuesFileUnrendered',
    title: 'values file outside the rendered files',
    file: 'config',
    valid: withRelease({ values_files: ['helm/web.yml'] }, { templates: [{ src: 'tpl/web.yml', dest: './helm/web.yml' }] }),
    invalid: withRelease({ values_files: ['helm/web.yml'] }),
    expected: `helm.releases[0].values_files[0]: ${M.valuesFileUnrendered('helm/web.yml')}`,
  },
  {
    key: 'helmAuthField',
    title: 'registry login',
    file: 'config',
    valid: withRelease({ auth: { username: 'deploy', password: 's3cret' } }),
    invalid: withRelease({ auth: { username: 'deploy', password: '' } }),
    expected: `helm.releases[0].auth.password: ${M.helmAuthField}`,
  },
  {
    key: 'helmDuplicateName',
    title: 'release declared twice',
    file: 'config',
    valid: k3s({ helm: { releases: [release(), release({ name: 'api' })] } }),
    invalid: k3s({ helm: { releases: [release(), release()] } }),
    expected: `helm.releases[1].name: ${M.helmDuplicateName('web')}`,
  },
  {
    key: 'helmRepoWithOci',
    title: 'OCI chart with a repository',
    file: 'config',
    valid: withRelease(),
    invalid: withRelease({ repo: 'https://charts.example.com' }),
    expected: `helm.releases[0].repo: ${M.helmRepoWithOci}`,
  },
  {
    key: 'helmRepoRequired',
    title: 'repository chart without a repository',
    file: 'config',
    valid: withRelease({ chart: 'podinfo', repo: 'https://charts.example.com' }),
    invalid: withRelease({ chart: 'podinfo' }),
    expected: `helm.releases[0].repo: ${M.helmRepoRequired}`,
  },
  {
    key: 'remoteBuildK3s',
    title: 'remote_build on k3s',
    file: 'config',
    valid: swarm({ options: { remote_build: true } }),
    invalid: k3s({ options: { remote_build: true } }),
    expected: `options.remote_build: ${M.remoteBuildK3s}`,
  },
  ...(['manage', 'acme_ca_server', 'acme_ca_bundle', 'default_ingress_class'] as const).map((key): RuleCase => {
    const values: Doc = {
      manage: { manage: false },
      acme_ca_server: { acme_ca_server: 'https://ca.example.com/directory' },
      acme_ca_bundle: { acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: '.dockflow/ca.pem' },
      default_ingress_class: { default_ingress_class: true },
    };
    const keys = values[key] as Doc;
    return {
      key: 'proxyKeyRequiresK3s',
      title: `proxy.${key} on swarm`,
      file: 'config',
      valid: proxy(keys),
      invalid: proxy(keys, swarm()),
      expected: `proxy.${key}: ${M.proxyKeyRequiresK3s(`proxy.${key}`)}`,
    };
  }),
  {
    key: 'proxyManageNeedsEnabled',
    title: 'proxy.manage without proxy.enabled',
    file: 'config',
    valid: k3s({ proxy: { enabled: true, manage: false } }),
    invalid: k3s({ proxy: { manage: false } }),
    expected: `proxy.manage: ${M.proxyManageNeedsEnabled}`,
  },
  {
    key: 'acmeCaServerHttps',
    title: 'ACME CA server scheme',
    file: 'config',
    valid: proxy({ acme_ca_server: 'https://ca.example.com/directory' }),
    invalid: proxy({ acme_ca_server: 'http://ca.example.com/directory' }),
    expected: `proxy.acme_ca_server: ${M.acmeCaServerHttps}`,
  },
  {
    key: 'acmeCaNeedsAcme',
    title: 'ACME CA with ACME disabled',
    file: 'config',
    valid: proxy({ acme: true, acme_ca_server: 'https://ca.example.com/directory' }),
    invalid: proxy({ acme: false, acme_ca_server: 'https://ca.example.com/directory' }),
    expected: `proxy.acme_ca_server: ${M.acmeCaNeedsAcme}`,
  },
  {
    key: 'acmeCaBundleNeedsServer',
    title: 'ACME CA bundle without a server',
    file: 'config',
    valid: proxy({ acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: '.dockflow/ca.pem' }),
    invalid: proxy({ acme_ca_bundle: '.dockflow/ca.pem' }),
    expected: `proxy.acme_ca_bundle: ${M.acmeCaBundleNeedsServer}`,
  },
  {
    key: 'acmeCaBundlePath',
    title: 'empty ACME CA bundle',
    file: 'config',
    valid: proxy({ acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: '.dockflow/ca.pem' }),
    invalid: proxy({ acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: '' }),
    expected: `proxy.acme_ca_bundle: ${M.acmeCaBundlePath}`,
  },
  {
    key: 'acmeCaBundleUnrendered',
    title: 'ACME CA bundle outside the rendered files',
    file: 'config',
    valid: proxy({ acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: 'certs/ca.pem' }, k3s({ templates: ['certs/ca.pem'] })),
    invalid: proxy({ acme_ca_server: 'https://ca.example.com/directory', acme_ca_bundle: 'certs/ca.pem' }),
    expected: `proxy.acme_ca_bundle: ${M.acmeCaBundleUnrendered('certs/ca.pem')}`,
  },
  {
    key: 'privateHostIp',
    title: 'private_host address',
    file: 'servers',
    valid: servers({ main: server({ private_host: '2001:db8::10' }) }),
    invalid: servers({ main: server({ private_host: '10.0.0' }) }),
    expected: `servers.main.private_host: ${M.privateHostIp}`,
  },
  {
    key: 'labelKey',
    title: 'node label key pattern',
    file: 'servers',
    valid: labels({ 'topology.example.com/zone': 'eu' }),
    invalid: labels({ 'zone/': 'eu' }),
    expected: `servers.main.node_labels.zone/: ${M.labelKey}`,
  },
  {
    key: 'labelKeyTooLong',
    title: 'node label key length',
    file: 'servers',
    // 253 characters in all, then 254
    valid: labels({ [`${'a'.repeat(177)}.example.com/${'b'.repeat(63)}`]: 'x' }),
    invalid: labels({ [`${'a'.repeat(178)}.example.com/${'b'.repeat(63)}`]: 'x' }),
    expected: `servers.main.node_labels.${'a'.repeat(178)}.example.com/${'b'.repeat(63)}: ${M.labelKeyTooLong}`,
  },
  ...['kubernetes.io/role', 'node.k8s.io/pool', 'dockflow.shawiizz.dev/pool'].map((key): RuleCase => ({
    key: 'labelKeyReserved',
    title: `reserved node label key ${key}`,
    file: 'servers',
    valid: labels({ 'kubernetes-io/role': 'web' }),
    invalid: labels({ [key]: 'web' }),
    expected: `servers.main.node_labels.${key}: ${M.labelKeyReserved}`,
  })),
  {
    key: 'labelValue',
    title: 'node label value pattern',
    file: 'servers',
    valid: labels({ zone: '' }),
    invalid: labels({ zone: 'eu west' }),
    expected: `servers.main.node_labels.zone: ${M.labelValue}`,
  },
  {
    key: 'labelValueTooLong',
    title: 'node label value length',
    file: 'servers',
    valid: labels({ zone: 'b'.repeat(63) }),
    invalid: labels({ zone: 'b'.repeat(64) }),
    expected: `servers.main.node_labels.zone: ${M.labelValueTooLong}`,
  },
  {
    key: 'managerCount',
    title: 'even manager count on k3s',
    file: 'servers',
    orchestrator: 'k3s',
    valid: servers({ a: server(), b: server(), c: server() }),
    invalid: servers({ a: server(), b: server(), c: server(), d: server() }),
    expected: M.managerCount('production', 4),
  },
  {
    key: 'duplicateNode',
    title: 'two keys with one node name on k3s',
    file: 'servers',
    orchestrator: 'k3s',
    valid: servers({ web_1: server(), 'web-2': server({ role: 'worker' }) }),
    invalid: servers({ web_1: server(), 'web-1': server({ role: 'worker' }) }),
    expected: M.duplicateNode('web_1', 'web-1', 'web-1'),
  },
  {
    key: 'privateHostIpv6K3s',
    title: 'IPv6 cluster address on k3s',
    file: 'servers',
    orchestrator: 'k3s',
    valid: servers({ main: server({ host: '2001:db8::10', private_host: '10.0.0.10' }) }),
    invalid: servers({ main: server({ private_host: '2001:db8::10' }) }),
    expected: M.privateHostIpv6K3s('main'),
  },
];

function run(file: ConfigFileType, doc: Doc, orchestrator?: Orchestrator) {
  return validateFile(stringify(doc), file, { orchestrator });
}

describe('validate_config rules of the shared catalogue', () => {
  for (const c of CASES) {
    it(`${c.key}: ${c.title}`, () => {
      const valid = run(c.file, c.valid, c.orchestrator);
      assert.deepEqual(valid.errors, []);
      assert.equal(valid.valid, true);

      const invalid = run(c.file, c.invalid, c.orchestrator);
      assert.equal(invalid.valid, false);
      assert.ok(invalid.errors.includes(c.expected), `expected\n  ${c.expected}\nin\n  ${invalid.errors.join('\n  ')}`);
    });
  }

  it('covers every rule of the catalogue', () => {
    const covered = new Set(CASES.map((c) => c.key));
    const rules = (Object.keys(M) as Array<keyof typeof M>).filter((key) => !NOT_RULES.includes(key));
    assert.deepEqual(rules.filter((key) => !covered.has(key)), []);
  });

  it('writes no catalogue message of its own (they come from shared/messages.ts)', () => {
    const source = readFileSync(new URL('../validate.ts', import.meta.url), 'utf8');
    for (const [key, value] of Object.entries(M)) {
      if (typeof value === 'string') assert.ok(!source.includes(value), `validate.ts repeats M.${key}`);
    }
    assert.match(source, /from '\.\/shared\/messages\.js'/);
  });
});

describe('validate_config orchestrator handling', () => {
  const twoManagers = stringify(servers({ a: server(), b: server() }));

  it('applies the k3s topology rules to a servers.yml only when the orchestrator is k3s', () => {
    assert.deepEqual(validateServersOnly(twoManagers, { orchestrator: 'k3s' }).errors, [M.managerCount('production', 2)]);
    assert.equal(validateServersOnly(twoManagers).valid, true);
    assert.equal(validateServersOnly(twoManagers, { orchestrator: 'swarm' }).valid, true);
  });

  it('reads the orchestrator of a dockflow.yml from its content, swarm by default', () => {
    assert.deepEqual(validateConfig(stringify(k3s(servers({ a: server(), b: server() })))).errors, [M.managerCount('production', 2)]);
    assert.equal(validateConfig(stringify(swarm(servers({ a: server(), b: server() })))).valid, true);
  });

  it('checks the topology per environment tag', () => {
    const doc = servers({
      a: server({ tags: ['production', 'staging'] }),
      b: server({ tags: ['production'] }),
      c: server({ tags: ['production'] }),
      d: server({ tags: ['staging'] }),
    });
    assert.deepEqual(validateServersOnly(stringify(doc), { orchestrator: 'k3s' }).errors, [M.managerCount('staging', 2)]);
  });

  it('reports a duplicate node name only inside one environment', () => {
    const doc = servers({ web_1: server({ tags: ['production'] }), 'web-1': server({ tags: ['staging'] }) });
    assert.equal(validateServersOnly(stringify(doc), { orchestrator: 'k3s' }).valid, true);
  });

  it('accepts the k3s server fields on swarm', () => {
    const doc = servers({ main: server({ private_host: '2001:db8::10', node_labels: { zone: 'eu' } }) });
    assert.equal(validateServersOnly(stringify(doc), { orchestrator: 'swarm' }).valid, true);
  });

  it('appends the offline validate note to a valid k3s result only', () => {
    assert.deepEqual(validateConfig(stringify(k3s())).notes, [K3S_NOTE]);
    assert.deepEqual(validateConfig(stringify(swarm())).notes, []);
    assert.deepEqual(validateConfig(stringify(k3s({ options: { remote_build: true } }))).notes, []);
    assert.deepEqual(validateServersOnly(stringify(servers({ main: server() })), { orchestrator: 'k3s' }).notes, [K3S_NOTE]);
    assert.equal(
      formatValidationResult(validateConfig(stringify(k3s())), 'config.yml'),
      `✓ config.yml is valid.\n${K3S_NOTE}`,
    );
  });
});

describe('validate_config output', () => {
  it('lists errors in path order, one line per issue', () => {
    const doc = {
      project_name: 'Shop',
      orchestrator: 'k3s',
      proxy: { manage: false },
      options: { remote_build: true },
      helm: { releases: [release({ repo: 'https://charts.example.com' }), release({ name: 'api', version: 'latest' })] },
    };
    assert.deepEqual(validateConfig(stringify(doc)).errors, [
      `helm.releases[0].repo: ${M.helmRepoWithOci}`,
      `helm.releases[1].version: ${M.exactVersion}`,
      `options.remote_build: ${M.remoteBuildK3s}`,
      'project_name: Project name must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.',
      `proxy.manage: ${M.proxyManageNeedsEnabled}`,
    ]);
  });

  it('orders array entries by index', () => {
    const doc = k3s({ helm: { releases: Array.from({ length: 11 }, (_, i) => release({ name: `r${i}`, version: 'x' })) } });
    const errors = validateConfig(stringify(doc)).errors;
    assert.equal(errors.length, 11);
    assert.equal(errors[2], `helm.releases[2].version: ${M.exactVersion}`);
    assert.equal(errors[10], `helm.releases[10].version: ${M.exactVersion}`);
  });

  it('formats an invalid result with its error count', () => {
    const text = formatValidationResult(validateConfig(stringify(k3s({ options: { remote_build: true } }))), 'config.yml');
    assert.equal(text, `✗ config.yml has 1 error(s):\n\n  → options.remote_build: ${M.remoteBuildK3s}`);
  });

  it('refuses unknown keys in the helm section as the CLI schema does', () => {
    assert.deepEqual(validateConfig(stringify(withRelease({ value: {}, chart_version: '1' }))).errors, [
      'helm.releases[0]: Unrecognized keys: "value", "chart_version"',
    ]);
    assert.deepEqual(validateConfig(stringify(k3s({ helm: { release: [] } }))).errors, ['helm: Unrecognized key: "release"']);
  });

  it('checks the SSH user and port of a server and of the defaults', () => {
    const doc = { ...servers({ main: server({ user: '', port: 22.5 }) }), defaults: { user: 'deploy', port: 0 } };
    assert.deepEqual(validateServersOnly(stringify(doc)).errors, [
      'defaults.port: must be an integer between 1 and 65535',
      'servers.main.port: must be an integer between 1 and 65535',
      'servers.main.user: must be a user name of 1 to 32 characters',
    ]);
  });

  it('reports YAML that does not parse and a root that is not a map', () => {
    const broken = validateConfig('project_name: [shop');
    assert.equal(broken.valid, false);
    assert.match(broken.errors[0], /^YAML parse error: /);
    assert.deepEqual(validateServersOnly('- a\n- b\n').errors, ['Root must be a YAML object']);
  });

  it('treats a Nunjucks expression as an opaque value, since the CLI renders it first', () => {
    const content = [
      'project_name: shop',
      'orchestrator: k3s',
      'helm:',
      '  releases:',
      '    - name: api',
      '      chart: oci://registry.example.com/charts/api',
      '      version: 1.4.2',
      '      auth:',
      '        username: deploy',
      '        password: {{ current.env.registry_password | dump }}',
    ].join('\n');
    assert.deepEqual(validateConfig(content).errors, []);
  });
});

describe('detectFileType', () => {
  it('tells dockflow.yml, config.yml and servers.yml apart', () => {
    assert.equal(detectFileType(stringify(k3s(servers({ main: server() })))), 'root');
    assert.equal(detectFileType(stringify(servers({ main: server() }))), 'servers');
    assert.equal(detectFileType(stringify(k3s())), 'config');
    assert.equal(detectFileType('project_name: [shop'), 'config');
  });
});
