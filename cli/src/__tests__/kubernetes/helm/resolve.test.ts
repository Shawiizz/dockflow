import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { DockflowConfigSchema } from '../../../schemas/config.schema';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { HelmReleaseRecord, ResolvedHelmRelease, StackRole } from '../../../services/orchestrator/interfaces';
import {
  chartDisplay,
  checkAdoptNames,
  checkOnlyNames,
  HelmConfigError,
  type HelmResolveInput,
  type HelmResolveResult,
  helmReleaseRecord,
  helmSpecHash,
  renderedValuesFileLookup,
  resolveHelmReleases,
  syncNonTargetedHelmRecords,
  type ValuesFileLookup,
} from '../../../services/orchestrator/kubernetes/helm/resolve';
import { M } from '../../../services/orchestrator/messages';
import type { DockflowConfig, HelmConfig } from '../../../utils/config';
import { ConfigError, ValidationError } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { Redactor } from '../../../utils/redact';

const CONFIG_FILE = '.dockflow/config.yml';
const STACK_NS = 'dockflow-shop-production';
const REPO = 'https://charts.example.com';
const DIGEST = sha256Hex('chart archive bytes');

// ---------------------------------------------------------------------------
// Scenario helpers: config.yml text parsed like the loader does (YAML 1.2), and the same text
// handed to the resolver as its config source
// ---------------------------------------------------------------------------

interface Scenario {
  /** the `helm.releases` list, as YAML */
  releases: string;
  /** `helm.timeout` */
  timeout?: string;
  /** top-level config.yml keys (templates, no_services), as YAML */
  top?: string;
  role?: StackRole;
  /** rendered map: project path -> text */
  files?: Record<string, string>;
  lookup?: (path: string) => ValuesFileLookup;
  compose?: { app?: string[]; accessory?: string[] };
  composeFiles?: { app: string; accessory: string };
}

/** YAML written indented inside the test: surrounding blank lines and the common indent removed */
function dedent(text: string): string {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent)).join('\n');
}

const indent = (text: string, by: string): string[] => (text === '' ? [] : dedent(text).split('\n').map((line) => `${by}${line}`));

/** a release block: `- name: <name>` then the fields */
function release(name: string, fields: string): string {
  return [`- name: ${name}`, ...indent(fields, '  ')].join('\n');
}

/** the release `web` from the https repository, plus extra fields */
function web(extra = ''): string {
  return release('web', `chart: web\nrepo: ${REPO}\nversion: 1.2.3\n${extra === '' ? '' : dedent(extra)}`);
}

function sourceOf(scenario: Scenario): string {
  const lines = ['project_name: shop', 'orchestrator: k3s'];
  if (scenario.top) lines.push(dedent(scenario.top));
  lines.push('helm:');
  if (scenario.timeout) lines.push(`  timeout: ${scenario.timeout}`);
  lines.push('  releases:', ...indent(scenario.releases, '    '));
  return `${lines.join('\n')}\n`;
}

function inputOf(scenario: Scenario): HelmResolveInput {
  const text = sourceOf(scenario);
  const config = parse(text, { logLevel: 'error' }) as DockflowConfig;
  return {
    helm: config.helm,
    role: scenario.role ?? 'app',
    stackNamespace: STACK_NS,
    configSource: { file: CONFIG_FILE, text },
    readValuesFile: scenario.lookup ?? renderedValuesFileLookup(new Map(Object.entries(scenario.files ?? {}))),
    composeServices: { app: scenario.compose?.app ?? [], accessory: scenario.compose?.accessory ?? [] },
    noServices: config.no_services === true,
    templates: config.templates,
    ...(scenario.composeFiles ? { composeFiles: scenario.composeFiles } : {}),
  };
}

const resolve = (scenario: Scenario): HelmResolveResult => resolveHelmReleases(inputOf(scenario));
const only = (scenario: Scenario): ResolvedHelmRelease => {
  const { releases } = resolve(scenario);
  expect(releases).toHaveLength(1);
  return releases[0];
};

function refusal(scenario: Scenario): HelmConfigError {
  try {
    resolve(scenario);
  } catch (error) {
    if (error instanceof HelmConfigError) return error;
    throw error;
  }
  throw new Error('resolveHelmReleases accepted the configuration');
}

const err = (code: string, path: string, message: string, hint?: string): Diagnostic =>
  hint === undefined ? { severity: 'error', code, path, message } : { severity: 'error', code, path, message, hint };
const warn = (code: string, path: string, message: string, hint?: string): Diagnostic =>
  hint === undefined ? { severity: 'warning', code, path, message } : { severity: 'warning', code, path, message, hint };

// ---------------------------------------------------------------------------
// design-07 13.1 and design-04 4.1
// ---------------------------------------------------------------------------

describe('resolveHelmReleases: releases (U-HELM-RESOLVE-01, -02, -07, -08)', () => {
  const MIXED: Scenario = {
    releases: [
      web(),
      release('postgres', `chart: postgresql\nrepo: ${REPO}\nversion: 16.7.4\nrole: accessory`),
      release('search', 'chart: oci://registry.example.com/charts/search\nversion: 2.4.1\nrole: app'),
    ].join('\n'),
  };

  test('U-HELM-RESOLVE-01: only releases of the requested role, in config order', () => {
    expect(resolve(MIXED).releases.map((r) => r.name)).toEqual(['web', 'search']);
    expect(resolve({ ...MIXED, role: 'accessory' }).releases.map((r) => r.name)).toEqual(['postgres']);
  });

  test('a repository release resolves to the complete ResolvedHelmRelease', () => {
    expect(resolve(MIXED).releases[0]).toEqual({
      name: 'web',
      role: 'app',
      namespace: STACK_NS,
      chart: { kind: 'repo', repo: REPO, chart: 'web' },
      version: '1.2.3',
      values: {},
      valuesSha256: sha256Hex('{}'),
      timeoutS: 300,
      auth: null,
      declaredDigest: null,
    });
  });

  test('chart source kinds: repository chart and OCI reference', () => {
    const [webRelease, search] = resolve(MIXED).releases;
    expect(webRelease.chart).toEqual({ kind: 'repo', repo: REPO, chart: 'web' });
    expect(search.chart).toEqual({ kind: 'oci', ref: 'oci://registry.example.com/charts/search' });
    expect(only({ releases: release('search', 'chart: oci://registry.example.com:5000/charts/search\nversion: v2.4.1') }).chart).toEqual({
      kind: 'oci',
      ref: 'oci://registry.example.com:5000/charts/search',
    });
  });

  test('U-HELM-RESOLVE-02: the stack namespace by default, an explicit namespace kept', () => {
    expect(only({ releases: web() }).namespace).toBe(STACK_NS);
    expect(only({ releases: web('namespace: search') }).namespace).toBe('search');
    expect(only({ releases: web(`namespace: ${STACK_NS}`) }).namespace).toBe(STACK_NS);
  });

  test('U-HELM-RESOLVE-07: release timeout > helm.timeout > 5m, in whole seconds', () => {
    expect(only({ releases: web() }).timeoutS).toBe(300);
    expect(only({ releases: web(), timeout: '10m' }).timeoutS).toBe(600);
    expect(only({ releases: web('timeout: 90s'), timeout: '10m' }).timeoutS).toBe(90);
    expect(only({ releases: web('timeout: 1m30.5s') }).timeoutS).toBe(91);
    expect(only({ releases: web('timeout: 30s') }).timeoutS).toBe(30);
    expect(only({ releases: web('timeout: 1h') }).timeoutS).toBe(3600);
  });

  test('declaredDigest comes from digest:, auth from auth:', () => {
    const resolved = only({ releases: web(`digest: ${DIGEST}\nauth:\n  username: ci\n  password: repo-password-1`) });
    expect(resolved.declaredDigest).toBe(DIGEST);
    expect(resolved.auth).toEqual({ username: 'ci', password: 'repo-password-1' });
  });

  test('U-HELM-RESOLVE-08: the release record never carries auth', () => {
    const resolved = only({ releases: web(`digest: ${DIGEST}\nauth:\n  username: ci\n  password: repo-password-1\nvalues:\n  replicaCount: 2`) });
    const record = helmReleaseRecord(resolved);
    expect(record).toEqual({
      name: 'web',
      role: 'app',
      namespace: STACK_NS,
      chart: { kind: 'repo', repo: REPO, chart: 'web' },
      version: '1.2.3',
      values: { replicaCount: 2 },
      valuesSha256: resolved.valuesSha256,
      timeoutS: 300,
      chartSha256: DIGEST,
    });
    expect(Object.hasOwn(record, 'auth')).toBe(false);
    expect(Object.hasOwn(record, 'declaredDigest')).toBe(false);
    expect(JSON.stringify(record)).not.toContain('repo-password-1');
    (record.values as { replicaCount: number }).replicaCount = 9;
    expect(resolved.values).toEqual({ replicaCount: 2 });
  });

  test('the schema output (defaults filled in by zod) resolves like the raw config', () => {
    const scenario: Scenario = { releases: web('values:\n  enabled: yes') };
    const input = inputOf(scenario);
    const parsed = DockflowConfigSchema.parse(parse(input.configSource.text));
    const fromSchema = resolveHelmReleases({ ...input, helm: parsed.helm as HelmConfig });
    expect(fromSchema).toEqual(resolve(scenario));
    expect(fromSchema.releases[0].values).toEqual({ enabled: true });
  });

  test('no helm section resolves nothing', () => {
    const input = inputOf({ releases: web() });
    expect(resolveHelmReleases({ ...input, helm: undefined })).toEqual({ releases: [], diagnostics: [], sensitiveValues: [] });
  });
});

describe('resolveHelmReleases: values (U-HELM-RESOLVE-03 to -06)', () => {
  const A = ['image:', '  repository: registry.example.com/web', '  tag: "1.0"', 'replicas: 1', 'list: [1, 2]', 'drop: chart-value', 'nested:', '  a: 1', '  b: {x: 1}', ''].join('\n');
  const B = ['image:', '  tag: "2.0"', 'list: [3]', 'nested:', '  b: {z: 2}', 'onlyB: b', ''].join('\n');
  const LAYERED: Scenario = {
    releases: web(`
      values_files:
        - .dockflow/helm/a.yaml
        - .dockflow/helm/b.yaml
      values:
        replicas: 3
        drop: null
        onlyB: inline
        nested:
          c: 3
    `),
    files: { '.dockflow/helm/a.yaml': A, '.dockflow/helm/b.yaml': B },
  };

  test('U-HELM-RESOLVE-03: files in order, then inline; maps merged, lists and scalars replaced, null kept', () => {
    const { values } = only(LAYERED);
    expect(values).toEqual({
      image: { repository: 'registry.example.com/web', tag: '2.0' },
      replicas: 3,
      list: [3],
      drop: null,
      onlyB: 'inline',
      nested: { a: 1, b: { x: 1, z: 2 }, c: 3 },
    });
    // PD-9: a null reaches Helm, where it deletes the chart default (design-04 I3)
    expect(Object.hasOwn(values, 'drop')).toBe(true);
  });

  test('U-HELM-RESOLVE-04: the rendered map is the only source of values files', () => {
    const resolved = only({
      releases: web('values_files:\n  - .dockflow/helm/web.yaml'),
      files: { '.dockflow/helm/web.yaml': 'database:\n  password: "rendered-db-password"\n' },
    });
    expect(resolved.values).toEqual({ database: { password: 'rendered-db-password' } });
  });

  test('the lookup receives the POSIX-normalized project path', () => {
    const asked: string[] = [];
    const lookup = (path: string): ValuesFileLookup => {
      asked.push(path);
      return { kind: 'found', text: 'a: 1\n', rendered: true };
    };
    resolve({
      releases: web('values_files:\n  - ./.dockflow/helm/./a.yaml\n  - .dockflow\\helm\\b.yaml\n  - .dockflow/x/../helm/c.yaml'),
      lookup,
    });
    expect(asked).toEqual(['.dockflow/helm/a.yaml', '.dockflow/helm/b.yaml', '.dockflow/helm/c.yaml']);
  });

  test('inline values are re-read from the config source with Helm rules', () => {
    const scenario: Scenario = { releases: web('values:\n  enabled: yes\n  mode: 0644\n  quoted: "yes"\n  kept: "0644"') };
    // what the YAML 1.2 loader made of them
    expect(inputOf(scenario).helm?.releases?.[0].values).toEqual({ enabled: 'yes', mode: 644, quoted: 'yes', kept: '0644' });
    expect(only(scenario).values).toEqual({ enabled: true, mode: 420, quoted: 'yes', kept: '0644' });
  });

  test('a caller without a config source keeps the loaded inline values', () => {
    const input = inputOf({ releases: web('values:\n  replicaCount: 2') });
    const { releases } = resolveHelmReleases({ ...input, configSource: { file: CONFIG_FILE, text: '' } });
    expect(releases[0].values).toEqual({ replicaCount: 2 });
  });

  test('U-HELM-RESOLVE-06: valuesSha256 is sha256Hex(canonicalJson(values)) and ignores key order', () => {
    const first = only({ releases: web('values:\n  b: 1\n  a:\n    d: 2\n    c: 3') });
    const second = only({ releases: web('values:\n  a:\n    c: 3\n    d: 2\n  b: 1') });
    const fromFile = only({
      releases: web('values_files:\n  - .dockflow/helm/web.yaml'),
      files: { '.dockflow/helm/web.yaml': 'a: {d: 2, c: 3}\nb: 1\n' },
    });
    expect(first.valuesSha256).toBe(sha256Hex(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })));
    expect(first.valuesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.valuesSha256).toBe(first.valuesSha256);
    expect(fromFile.valuesSha256).toBe(first.valuesSha256);
    expect(only({ releases: web('values:\n  b: 2') }).valuesSha256).not.toBe(first.valuesSha256);
  });

  test('U-HELM-RESOLVE-05b: values files under .dockflow/ or listed in templates resolve, in both layouts', () => {
    const files = {
      '.dockflow/helm/web.yaml': 'a: 1\n',
      'helm/values.yml': 'b: 2\n',
      'deploy/values.yml': 'c: 3\n',
      'values.yaml': 'd: 4\n',
    };
    const listed = only({
      top: 'templates:\n  - helm/values.yml\n  - src: deploy/values.tpl.yml\n    dest: deploy/values.yml',
      releases: web('values_files:\n  - .dockflow/helm/web.yaml\n  - helm/values.yml\n  - deploy/values.yml'),
      files,
    });
    expect(listed.values).toEqual({ a: 1, b: 2, c: 3 });
    // flat layout: dockflow.yml at the root, no .dockflow/ directory; the same rule on the root
    const flat = only({ top: 'templates:\n  - values.yaml', releases: web('values_files:\n  - values.yaml'), files });
    expect(flat.values).toEqual({ d: 4 });
    expect(refusal({ releases: web('values_files:\n  - values.yaml'), files }).diagnostics).toEqual([
      err('helm.values-file-unrendered', 'helm.releases[0].values_files[0]', M.valuesFileUnrendered('values.yaml'), 'Move it under .dockflow/, or list it in `templates:`.'),
    ]);
  });
});

describe('resolveHelmReleases: design-04 3.3 codes, exact message and path', () => {
  const ALIAS_HINT = 'Set `chart: postgresql` and `repo: <repository URL>`.';
  const COLLISION_HINT =
    'Rename the release or the service, because `--only`, `dockflow rollback <env> <name>` and their Kubernetes objects would collide.';
  const OCI_MESSAGE = (ref: string): string => `chart "${ref}" must be oci://<registry>/<path>/<chart> without a tag or digest`;
  const OCI_HINT = "Put the chart version in `version:` and the archive's sha256 in `digest:`.";
  const NS_INVALID_HINT = 'Use lowercase letters, digits and hyphens (at most 63 characters).';
  const NS_RESERVED_HINT = 'Omit `namespace` to use the stack namespace, or choose another name.';
  const DIGEST_HINT = 'Copy it from `dockflow helm status <env> web`, or from `sha256sum` of the chart archive.';
  const TIMEOUT_MESSAGE = 'timeout must be between 30s and 1h';
  const FILE_HINT = 'Put it under .dockflow/ (it is then rendered with Nunjucks), or check the path.';
  const WEB_FILE = '.dockflow/helm/web.yaml';
  const withFile = (text: string): Scenario => ({ releases: web(`values_files:\n  - ${WEB_FILE}`), files: { [WEB_FILE]: text } });
  const oci = (ref: string): Scenario => ({ releases: release('search', `chart: ${ref}\nversion: 2.4.1`) });

  const rows: [string, Scenario, Diagnostic[]][] = [
    [
      'helm.reserved-name',
      { releases: release('dockflow-web', `chart: web\nrepo: ${REPO}\nversion: 1.2.3`) },
      [err('helm.reserved-name', 'helm.releases[0].name', 'Helm release name "dockflow-web" is reserved: names starting with dockflow- belong to Dockflow', 'Rename the release.')],
    ],
    [
      'helm.name-collision with an application service key',
      { releases: web(), compose: { app: ['web'] } },
      [err('helm.name-collision', 'helm.releases[0].name', 'Helm release "web" has the same name as the compose service "web" in docker-compose.yml', COLLISION_HINT)],
    ],
    [
      'helm.name-collision with the Kubernetes name of an accessory',
      { releases: release('web-app', `chart: web\nrepo: ${REPO}\nversion: 1.2.3`), compose: { accessory: ['web_app'] } },
      [err('helm.name-collision', 'helm.releases[0].name', 'Helm release "web-app" has the same name as the compose service "web_app" in accessories.yml', COLLISION_HINT)],
    ],
    [
      'helm.name-collision naming the compose file in use',
      { releases: web(), compose: { app: ['web'] }, composeFiles: { app: 'compose.yaml', accessory: 'accessories.yml' } },
      [err('helm.name-collision', 'helm.releases[0].name', 'Helm release "web" has the same name as the compose service "web" in compose.yaml', COLLISION_HINT)],
    ],
    [
      'helm.repo-scheme',
      { releases: release('web', 'chart: web\nrepo: ftp://charts.example.com\nversion: 1.2.3') },
      [err('helm.repo-scheme', 'helm.releases[0].repo', M.helmRepoUrl, "Use the repository's https:// URL.")],
    ],
    [
      'helm.repo-auth-plaintext (with the helm.repo-plaintext warning)',
      { releases: release('web', 'chart: web\nrepo: http://charts.example.com\nversion: 1.2.3\nauth:\n  username: ci\n  password: repo-password-1') },
      [
        warn('helm.repo-plaintext', 'helm.releases[0].repo', M.helmRepoPlaintext('http://charts.example.com'), 'Serve the repository over HTTPS, or pin the archive with `digest:`.'),
        err('helm.repo-auth-plaintext', 'helm.releases[0].auth', 'auth for web would send the repository password in clear text over http://', 'Serve the repository over HTTPS, or remove `auth`.'),
      ],
    ],
    [
      'helm.repo-alias',
      { releases: release('postgres', `chart: charts/postgresql\nrepo: ${REPO}\nversion: 16.7.4`) },
      [err('helm.repo-alias', 'helm.releases[0].chart', 'chart "charts/postgresql" looks like a repository alias; Dockflow has no repository aliases', ALIAS_HINT)],
    ],
    [
      'helm.chart-name',
      { releases: release('web', `chart: -web\nrepo: ${REPO}\nversion: 1.2.3`) },
      [err('helm.chart-name', 'helm.releases[0].chart', 'chart "-web" is not a valid chart name')],
    ],
    [
      'helm.oci-ref with a tag',
      oci('oci://registry.example.com/charts/search:2.4.1'),
      [err('helm.oci-ref', 'helm.releases[0].chart', OCI_MESSAGE('oci://registry.example.com/charts/search:2.4.1'), OCI_HINT)],
    ],
    [
      'helm.oci-ref with @sha256: (PD-4)',
      oci(`oci://registry.example.com/charts/search@sha256:${DIGEST}`),
      [err('helm.oci-ref', 'helm.releases[0].chart', OCI_MESSAGE(`oci://registry.example.com/charts/search@sha256:${DIGEST}`), OCI_HINT)],
    ],
    [
      'helm.oci-ref without a path',
      oci('oci://registry.example.com'),
      [err('helm.oci-ref', 'helm.releases[0].chart', OCI_MESSAGE('oci://registry.example.com'), OCI_HINT)],
    ],
    [
      'helm.oci-ref with an uppercase path',
      oci('oci://registry.example.com/Charts/search'),
      [err('helm.oci-ref', 'helm.releases[0].chart', OCI_MESSAGE('oci://registry.example.com/Charts/search'), OCI_HINT)],
    ],
    [
      'repo beside an oci:// chart (zod rule repeated)',
      { releases: release('search', `chart: oci://registry.example.com/charts/search\nrepo: ${REPO}\nversion: 2.4.1`) },
      [err('helm.repo-with-oci', 'helm.releases[0].repo', M.helmRepoWithOci)],
    ],
    [
      'no repo for a chart name (zod rule repeated)',
      { releases: release('web', 'chart: web\nversion: 1.2.3') },
      [err('helm.repo-required', 'helm.releases[0].repo', M.helmRepoRequired)],
    ],
    [
      'helm.namespace-invalid with a dot',
      { releases: web('namespace: search.example') },
      [err('helm.namespace-invalid', 'helm.releases[0].namespace', 'namespace "search.example" is not a valid Kubernetes namespace name', NS_INVALID_HINT)],
    ],
    [
      'helm.namespace-invalid with 64 characters',
      { releases: web(`namespace: ${'n'.repeat(64)}`) },
      [err('helm.namespace-invalid', 'helm.releases[0].namespace', `namespace "${'n'.repeat(64)}" is not a valid Kubernetes namespace name`, NS_INVALID_HINT)],
    ],
    ...['dockflow-system', 'kube-public', 'kube-node-lease', 'dockflow-shop-staging'].map(
      (ns): [string, Scenario, Diagnostic[]] => [
        `helm.namespace-reserved ${ns}`,
        { releases: web(`namespace: ${ns}`) },
        [err('helm.namespace-reserved', 'helm.releases[0].namespace', `namespace "${ns}" is reserved`, NS_RESERVED_HINT)],
      ],
    ),
    [
      'helm.timeout-range on a release',
      { releases: web('timeout: 29s') },
      [err('helm.timeout-range', 'helm.releases[0].timeout', TIMEOUT_MESSAGE)],
    ],
    [
      'helm.timeout-range above one hour',
      { releases: web('timeout: 61m') },
      [err('helm.timeout-range', 'helm.releases[0].timeout', TIMEOUT_MESSAGE)],
    ],
    ['helm.timeout-range on helm.timeout', { releases: web(), timeout: '10s' }, [err('helm.timeout-range', 'helm.timeout', TIMEOUT_MESSAGE)]],
    [
      'helm.values-file-missing',
      { releases: web('values_files:\n  - .dockflow/helm/missing.yaml') },
      [err('helm.values-file-missing', 'helm.releases[0].values_files[0]', 'values file .dockflow/helm/missing.yaml not found', FILE_HINT)],
    ],
    ...['../x.yaml', '/etc/x', '.dockflow/../../x.yaml', 'C:\\x.yaml'].map((file): [string, Scenario, Diagnostic[]] => [
      `helm.values-file-outside ${file}`,
      { releases: web(`values_files:\n  - '${file}'`) },
      [err('helm.values-file-outside', 'helm.releases[0].values_files[0]', `values file ${file} must be a path inside the project`)],
    ]),
    [
      'helm.values-file-unrendered',
      { releases: web('values_files:\n  - helm/values.yml'), files: { 'helm/values.yml': 'a: 1\n' } },
      [err('helm.values-file-unrendered', 'helm.releases[0].values_files[0]', M.valuesFileUnrendered('helm/values.yml'), 'Move it under .dockflow/, or list it in `templates:`.')],
    ],
    [
      'helm.chart-digest with a sha256: prefix',
      { releases: web(`digest: sha256:${DIGEST}`) },
      [err('helm.chart-digest', 'helm.releases[0].digest', M.chartDigest, DIGEST_HINT)],
    ],
    [
      'helm.chart-digest in uppercase',
      { releases: web(`digest: ${DIGEST.toUpperCase()}`) },
      [err('helm.chart-digest', 'helm.releases[0].digest', M.chartDigest, DIGEST_HINT)],
    ],
    [
      'helm.values-yaml for a duplicate key',
      withFile('a: 1\nb: 2\na: 3\n'),
      [err('helm.values-yaml', 'helm.releases[0].values_files[0]', `${WEB_FILE}: duplicate key at line 3`)],
    ],
    [
      'helm.values-not-map for a values file',
      withFile('- a\n- b\n'),
      [err('helm.values-not-map', 'helm.releases[0].values_files[0]', `${WEB_FILE} must contain a mapping at the top level`)],
    ],
    [
      'helm.values-not-map for inline values',
      { releases: web('values: [1, 2]') },
      [err('helm.values-not-map', 'helm.releases[0].values', 'helm.releases[0].values must contain a mapping at the top level')],
    ],
    [
      'helm.values-non-finite in inline values',
      { releases: web('values:\n  limits:\n    ratio: .inf') },
      [err('helm.values-non-finite', 'helm.releases[0].values.limits.ratio', 'limits.ratio is .inf, which Helm values cannot carry through JSON', 'Quote it if a string was meant.')],
    ],
    [
      'helm.values-non-finite in a values file',
      withFile('limits:\n  ratio: .nan\n'),
      [err('helm.values-non-finite', 'helm.releases[0].values_files[0]', `limits.ratio in ${WEB_FILE} is .nan, which Helm values cannot carry through JSON`, 'Quote it if a string was meant.')],
    ],
    [
      'helm.values-tag',
      { releases: web('values:\n  blob: !!binary aGVsbG8=') },
      [err('helm.values-tag', 'helm.releases[0].values.blob', 'blob uses the YAML tag !!binary, which is not supported in Helm values')],
    ],
    [
      'helm.no-services',
      { top: 'no_services: true', releases: web() },
      [err('helm.no-services', 'no_services', 'no_services cannot be combined with Helm releases of role app', 'Remove `no_services`, because Helm releases are deployed like services.')],
    ],
  ];

  test.each(rows)('%s', (_name, scenario, expected) => {
    expect(refusal(scenario).diagnostics).toEqual(expected);
  });

  test('warnings do not stop the resolution: helm.repo-plaintext, helm.namespace-kube-system, helm.values-large-int', () => {
    const result = resolve({
      releases: [
        release('web', 'chart: web\nrepo: http://charts.example.com\nversion: 1.2.3\nvalues:\n  big: 9007199254740993'),
        release('agent', `chart: agent\nrepo: ${REPO}\nversion: 1.0.0\nnamespace: kube-system`),
      ].join('\n'),
    });
    expect(result.releases.map((r) => [r.name, r.namespace])).toEqual([
      ['web', STACK_NS],
      ['agent', 'kube-system'],
    ]);
    expect(result.releases[0].values).toEqual({ big: 9007199254740992 });
    expect(result.diagnostics).toEqual([
      warn('helm.repo-plaintext', 'helm.releases[0].repo', 'Chart repository http://charts.example.com is not encrypted; chart contents cannot be authenticated in transit', 'Serve the repository over HTTPS, or pin the archive with `digest:`.'),
      warn('helm.values-large-int', 'helm.releases[0].values.big', 'big (9007199254740993) loses precision: Helm decodes numbers as float64', 'Quote it if the chart expects a string.'),
      warn('helm.namespace-kube-system', 'helm.releases[1].namespace', "the release shares kube-system with the cluster's own components"),
    ]);
  });

  test('no_services with accessory releases only is accepted', () => {
    const scenario: Scenario = { top: 'no_services: true', releases: release('postgres', `chart: postgresql\nrepo: ${REPO}\nversion: 16.7.4\nrole: accessory`) };
    expect(resolve({ ...scenario, role: 'accessory' }).releases.map((r) => r.name)).toEqual(['postgres']);
  });

  test('values file lookups that are not rendered or leave the project are refused', () => {
    const scenario = (lookup: ValuesFileLookup): Scenario => ({ releases: web(`values_files:\n  - ${WEB_FILE}`), lookup: () => lookup });
    expect(refusal(scenario({ kind: 'found', text: 'a: 1\n', rendered: false })).diagnostics).toEqual([
      err('helm.values-file-unrendered', 'helm.releases[0].values_files[0]', M.valuesFileUnrendered(WEB_FILE), 'Move it under .dockflow/, or list it in `templates:`.'),
    ]);
    expect(refusal(scenario({ kind: 'outside-project' })).diagnostics).toEqual([
      err('helm.values-file-outside', 'helm.releases[0].values_files[0]', `values file ${WEB_FILE} must be a path inside the project`),
    ]);
  });

  test('U-HELM-RESOLVE-05: any error throws one ConfigError naming the config file and each finding', () => {
    const error = refusal({ releases: web('values_files:\n  - .dockflow/helm/missing.yaml') });
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe('.dockflow/config.yml: 1 Helm configuration error(s)');
    expect(error.suggestion).toBe(`helm.releases[0].values_files[0]: values file .dockflow/helm/missing.yaml not found (${FILE_HINT})`);
    expect(refusal({ releases: web('timeout: 2h') }).suggestion).toBe(`helm.releases[0].timeout: ${TIMEOUT_MESSAGE}`);
  });

  test('both roles are validated whatever the requested role, and every error is collected', () => {
    const error = refusal({
      role: 'accessory',
      releases: [
        release('dockflow-web', `chart: web\nrepo: ${REPO}\nversion: 1.2.3\ntimeout: 2h`),
        release('postgres', `chart: postgresql\nrepo: ${REPO}\nversion: 16.7.4\nrole: accessory`),
      ].join('\n'),
    });
    expect(error.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ['helm.reserved-name', 'helm.releases[0].name'],
      ['helm.timeout-range', 'helm.releases[0].timeout'],
    ]);
    expect(error.message).toBe('.dockflow/config.yml: 2 Helm configuration error(s)');
  });

  test('the suggestion lists at most 20 findings', () => {
    const releases = Array.from({ length: 25 }, (_, i) => release(`dockflow-web-${i}`, `chart: web\nrepo: ${REPO}\nversion: 1.2.3`)).join('\n');
    const error = refusal({ releases });
    const lines = (error.suggestion ?? '').split('\n');
    expect(error.message).toBe('.dockflow/config.yml: 25 Helm configuration error(s)');
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe('helm.releases[0].name: Helm release name "dockflow-web-0" is reserved: names starting with dockflow- belong to Dockflow (Rename the release.)');
    expect(lines[20]).toBe('... and 5 more');
    expect(error.diagnostics).toHaveLength(25);
  });
});

describe('--only and --adopt names (design-04 3.3)', () => {
  const HELM: HelmConfig = {
    releases: [
      { name: 'search', chart: 'oci://registry.example.com/charts/search', version: '2.4.1' },
      { name: 'postgres', chart: 'postgresql', repo: REPO, version: '16.7.4', role: 'accessory' },
    ],
  };

  /** the ValidationError `run` throws, as message and suggestion */
  function refused(run: () => void): { message: string; suggestion: string | undefined } {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const { message, suggestion } = error as ValidationError;
      return { message, suggestion };
    }
    throw new Error('the names were accepted');
  }

  test('compose services and app releases are accepted', () => {
    expect(() => checkOnlyNames(['web', 'search'], ['web', 'worker'], HELM)).not.toThrow();
    expect(() => checkOnlyNames([], ['web'], undefined)).not.toThrow();
  });

  test('helm.only-accessory', () => {
    expect(refused(() => checkOnlyNames(['web', 'postgres'], ['web'], HELM))).toEqual({
      message: 'postgres is an accessory Helm release; --only targets the application',
      suggestion: 'Deploy accessories with `dockflow deploy <env> --accessories`.',
    });
  });

  test('helm.only-unknown lists what exists', () => {
    expect(refused(() => checkOnlyNames(['ghost'], ['web', 'worker'], HELM))).toEqual({
      message: 'Unknown service or Helm release ghost (services: web, worker; Helm releases: search)',
      suggestion: 'Use exact compose service or Helm release names.',
    });
  });

  test('a Helm-only project has no compose services to name', () => {
    expect(refused(() => checkOnlyNames(['web'], [], HELM)).message).toBe('Unknown service or Helm release web (services: none; Helm releases: search)');
    expect(() => checkOnlyNames(['search'], [], HELM)).not.toThrow();
  });

  test('helm.adopt-system and helm.adopt-unknown', () => {
    expect(() => checkAdoptNames(['postgres', 'search'], HELM)).not.toThrow();
    expect(refused(() => checkAdoptNames(['dockflow-traefik'], HELM))).toEqual({
      message: "dockflow-traefik is Dockflow's own proxy release and is never adopted",
      suggestion: 'Remove it from `--adopt`; the proxy follows `proxy.*` settings (`dockflow helm status <env> --system`).',
    });
    expect(refused(() => checkAdoptNames(['ghost'], HELM))).toEqual({
      message: '--adopt names ghost, which is not a Helm release declared in config.yml',
      suggestion: 'Declare the release in `helm.releases` with the chart and version that are running, then re-run with `--adopt ghost`.',
    });
  });
});

describe('sensitiveValues (U-HELM-RESOLVE-09)', () => {
  const scenario: Scenario = {
    releases: [
      web(`
        auth:
          username: ci
          password: repo-password-1
        values:
          replicaCount: 3
          image:
            tag: v1.2.3
          apiKey: api-key-12345
          database:
            password: db-password-1
          ingress:
            annotations:
              traefik.io/auth-secret: auth-secret-name
          extraSecrets:
            - first-secret-1
      `),
      release('postgres', `chart: postgresql\nrepo: ${REPO}\nversion: 16.7.4\nrole: accessory\nvalues:\n  auth:\n    postgresPassword: accessory-password-1`),
    ].join('\n'),
  };

  test('string leaves under sensitive key paths and auth passwords, not other values', () => {
    const { sensitiveValues } = resolve(scenario);
    expect([...sensitiveValues].sort()).toEqual(
      ['accessory-password-1', 'api-key-12345', 'auth-secret-name', 'db-password-1', 'first-secret-1', 'repo-password-1'].sort(),
    );
    expect(sensitiveValues).not.toContain('v1.2.3');
    expect(sensitiveValues).not.toContain('ci');
  });

  test('registered with the Redactor, they never reach output', () => {
    const redactor = new Redactor(resolve(scenario).sensitiveValues);
    expect(redactor.redact('login db-password-1 with api-key-12345 for v1.2.3')).toBe('login *** with *** for v1.2.3');
  });
});

describe('helmSpecHash (PD-3)', () => {
  const base: Pick<HelmReleaseRecord, 'name' | 'namespace' | 'role' | 'chart' | 'version' | 'values'> = {
    name: 'web',
    namespace: STACK_NS,
    role: 'app',
    chart: { kind: 'repo', repo: REPO, chart: 'web' },
    version: '1.2.3',
    values: { replicaCount: 2, image: { tag: 'v1' } },
  };

  test('32 hex characters of the sha256 over chart, name, namespace, role, values and version', () => {
    const hash = helmSpecHash(base);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe(sha256Hex(canonicalJson({ chart: base.chart, name: 'web', namespace: STACK_NS, role: 'app', values: base.values, version: '1.2.3' })).slice(0, 32));
  });

  test('stable across calls and value key order', () => {
    expect(helmSpecHash(base)).toBe(helmSpecHash({ ...base }));
    expect(helmSpecHash({ ...base, values: { image: { tag: 'v1' }, replicaCount: 2 } })).toBe(helmSpecHash(base));
  });

  test('changes with values, version, role, namespace, chart and name', () => {
    const variants = [
      { ...base, values: { replicaCount: 3, image: { tag: 'v1' } } },
      { ...base, version: '1.2.4' },
      { ...base, role: 'accessory' as const },
      { ...base, namespace: 'search' },
      { ...base, chart: { kind: 'repo' as const, repo: 'https://charts.example.org', chart: 'web' } },
      { ...base, chart: { kind: 'oci' as const, ref: 'oci://registry.example.com/charts/web' } },
      { ...base, name: 'web2' },
    ];
    const hashes = new Set([helmSpecHash(base), ...variants.map(helmSpecHash)]);
    expect(hashes.size).toBe(variants.length + 1);
  });

  test('a leading v is ignored; timeout, digests and credentials are not part of the spec', () => {
    expect(helmSpecHash({ ...base, version: 'v1.2.3' })).toBe(helmSpecHash(base));
    const short = only({ releases: web('timeout: 90s\nvalues:\n  replicaCount: 2') });
    const long = only({ releases: web(`timeout: 10m\ndigest: ${DIGEST}\nauth:\n  username: ci\n  password: repo-password-1\nvalues:\n  replicaCount: 2`) });
    expect(helmSpecHash(short)).toBe(helmSpecHash(long));
    expect(helmSpecHash(helmReleaseRecord(long))).toBe(helmSpecHash(long));
  });
});

describe('syncNonTargetedHelmRecords (3.4.5)', () => {
  const resolved = (name: string, values: Record<string, unknown>, auth: ResolvedHelmRelease['auth'] = null): ResolvedHelmRelease => ({
    name,
    role: 'app',
    namespace: STACK_NS,
    chart: { kind: 'repo', repo: REPO, chart: name },
    version: '2.0.0',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 300,
    auth,
    declaredDigest: null,
  });
  const record = (name: string, values: Record<string, unknown>, chartSha256: string | null): HelmReleaseRecord => ({
    name,
    role: 'app',
    namespace: STACK_NS,
    chart: { kind: 'repo', repo: REPO, chart: name },
    version: '1.0.0',
    values,
    valuesSha256: sha256Hex(canonicalJson(values)),
    timeoutS: 600,
    chartSha256,
  });
  const AUTH = { username: 'ci', password: 'repo-password-1' };
  const CONFIG = [resolved('api', { v: 'config' }), resolved('search', { v: 'config' }, AUTH), resolved('fresh', { v: 'config' })];
  const PREVIOUS = [record('search', { v: 'running' }, DIGEST), record('gone', { v: 'running' }, null), record('api', { v: 'running' }, null)];

  /** the record as an input entry: what runs, with `declaredDigest = record.chartSha256` */
  const fromRecord = (source: HelmReleaseRecord, auth: ResolvedHelmRelease['auth']): ResolvedHelmRelease => {
    const { chartSha256, ...rest } = source;
    return { ...rest, auth, declaredDigest: chartSha256 };
  };

  test('the four rows: targeted from config, non-targeted from the record, new ones omitted, removed ones kept', () => {
    expect(syncNonTargetedHelmRecords(CONFIG, PREVIOUS, ['api'])).toEqual([
      // in config, named in --only: from config
      CONFIG[0],
      // in config, not named, recorded: the record, auth from config by name
      fromRecord(PREVIOUS[0], AUTH),
      // `fresh` (in config, not named, not recorded) is omitted; `gone` (recorded only) keeps running
      fromRecord(PREVIOUS[1], null),
    ]);
    expect(syncNonTargetedHelmRecords(CONFIG, PREVIOUS, ['api'])[1].declaredDigest).toBe(DIGEST);
  });

  test('entries follow config order, then records no longer in config in record order', () => {
    const entries = syncNonTargetedHelmRecords(CONFIG, [record('zeta', {}, null), ...PREVIOUS], ['fresh']);
    expect(entries.map((entry) => entry.name)).toEqual(['api', 'search', 'fresh', 'zeta', 'gone']);
  });

  test('a full deploy passes the config releases unchanged', () => {
    expect(syncNonTargetedHelmRecords(CONFIG, PREVIOUS, [])).toEqual(CONFIG);
  });

  test('without a previous release only the targeted releases are deployed', () => {
    expect(syncNonTargetedHelmRecords(CONFIG, null, ['search', 'web'])).toEqual([CONFIG[1]]);
  });

  test('entries built from records do not alias them', () => {
    const [, search] = syncNonTargetedHelmRecords(CONFIG, PREVIOUS, ['api']);
    (search.values as { v: string }).v = 'changed';
    expect(PREVIOUS[0].values).toEqual({ v: 'running' });
  });
});

describe('small helpers', () => {
  test('chartDisplay formats', () => {
    expect(chartDisplay({ kind: 'repo', repo: 'https://charts.example.org', chart: 'postgresql' }, '16.7.4')).toBe(
      'postgresql 16.7.4 from https://charts.example.org',
    );
    expect(chartDisplay({ kind: 'oci', ref: 'oci://registry.example.com/charts/search' }, '2.4.1')).toBe(
      'oci://registry.example.com/charts/search 2.4.1',
    );
  });

  test('renderedValuesFileLookup reads the rendered map only', () => {
    const lookup = renderedValuesFileLookup(new Map([['.dockflow/helm/web.yaml', 'a: 1\n']]));
    expect(lookup('.dockflow/helm/web.yaml')).toEqual({ kind: 'found', text: 'a: 1\n', rendered: true });
    expect(lookup('.dockflow/helm/other.yaml')).toEqual({ kind: 'missing' });
  });
});
