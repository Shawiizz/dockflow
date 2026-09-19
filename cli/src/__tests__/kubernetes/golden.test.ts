// Golden harness assertions (DESIGN-CORE 8.9; design-07 6.3 G-01..G-13, plus the load-time
// expectLoadError row and the U-REG-01 "every kind found in golden outputs is registered" clause,
// PD-11 (e)). Every case is rendered through `renderCase`, the exact path `update-golden.ts` uses,
// so this file never writes a file and no environment variable can switch it into an update mode
// (DESIGN-CORE 8.9): `cli/scripts/update-golden.ts` is the only way to change an expectation.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import nunjucks from 'nunjucks';
import { describe, expect, test } from 'bun:test';
import { loadFromString } from '../../services/compose';
import type { Diagnostic } from '../../services/orchestrator/diagnostics';
import { createFileResolver } from '../../services/orchestrator/file-resolver';
import { HelmConfigError, resolveHelmReleases, type HelmResolveInput } from '../../services/orchestrator/kubernetes/helm/resolve';
import { k3sDistribution } from '../../services/orchestrator/kubernetes/k3s/distribution';
import { K8S_REGISTRY_SECRET } from '../../services/orchestrator/kubernetes/constants';
import { renderStackArtifact, type RenderEnvironment } from '../../services/orchestrator/kubernetes/render';
import { isManifestKind, KIND_REGISTRY, type ManifestObject } from '../../services/orchestrator/kubernetes/resources/registry';
import { emitManifests } from '../../services/orchestrator/kubernetes/yaml';
import type { HelmReleaseRecord, StackDeployInput, StackRole } from '../../services/orchestrator/interfaces';
import { M } from '../../services/orchestrator/messages';
import { canonicalJson, sha256Hex } from '../../utils/hash';
import { DEFAULT_SERVER_NAMES, identity } from './support/builders';
import {
  caseSeed,
  checkCaseStructure,
  compareExpectedFile,
  diagnosticsOf,
  discoverCases,
  emptySibling,
  type GoldenCase,
  type GoldenOutcome,
  type GoldenRenderResult,
  readExpectedJson,
  readExpectedText,
  renderCase,
  siblingFromStack,
} from './support/golden';
import { failures, formatIssues, validateArtifact } from './support/schema/semantic';
import { stackExternalNames } from './support/translate';

const allCases = await discoverCases();
// Not a single compose pair: renders an explicit list of existing Swarm e2e fixtures instead (its
// own describe block below). Excluded from the generic per-case assertions.
const cases = allCases.filter((c) => c.name !== 'swarm-fixtures');

describe('golden cases', () => {
  test('at least one case was discovered', () => {
    expect(allCases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    describe(c.name, () => {
      test('structure', async () => {
        expect(await checkCaseStructure(c)).toEqual([]);
      });

      test('renders as expected (G-01, G-02, G-03, G-06..G-12)', async () => {
        await assertCase(c, await renderCase(c));
      });

      if (c.input.expectLoadError === undefined) {
        test('G-04: two renders are byte-identical', async () => {
          const [first, second] = [await renderCase(c), await renderCase(c)];
          assertSameOutcome(first, second);
        });

        test('G-05: order-independent (deep-shuffled mapping keys and services)', async () => {
          const plain = await renderCase(c);
          const shuffled = await renderCase(c, { shuffleSeed: caseSeed(c.name) });
          assertSameOutcome(plain, shuffled);
        });
      }
    });
  }

  test('U-REG-01: every kind found in a golden output is registered', async () => {
    for (const c of cases) {
      const outcome = await renderCase(c);
      if (outcome.kind === 'load-error') continue;
      for (const role of ['app', 'accessory'] as const) {
        const roleOutcome = outcome.result[role];
        if (!roleOutcome?.ok) continue;
        for (const object of roleOutcome.render.objects) expect(isManifestKind(object.kind)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Per-case assertions
// ---------------------------------------------------------------------------

async function assertCase(c: GoldenCase, outcome: GoldenOutcome): Promise<void> {
  if (c.input.expectLoadError !== undefined) {
    if (outcome.kind !== 'load-error') throw new Error(`${c.name}: expected a load-time refusal, but the file loaded`);
    expect(outcome.message).toBe(c.input.expectLoadError);
    return;
  }
  if (outcome.kind !== 'rendered') throw new Error(`${c.name}: ${outcome.message}`);
  const { result } = outcome;

  for (const role of ['app', 'accessory'] as const) {
    const roleOutcome = result[role];
    const expectError = c.input.expectRenderError?.[role] === true;
    const expectedYaml = await readExpectedText(c, `expected-${role}.yaml`);

    if (roleOutcome === null) {
      expect(expectedYaml).toBeNull(); // no compose file for this role: nothing to render
      continue;
    }
    if (expectError) {
      // G-03: render throws for this role; no expected YAML exists
      expect(roleOutcome.ok).toBe(false);
      expect(expectedYaml).toBeNull();
      continue;
    }
    if (!roleOutcome.ok) throw new Error(`${c.name} (${role}): ${roleOutcome.error.message}\n${roleOutcome.error.suggestion}`);

    const { render } = roleOutcome;

    // G-01
    const diff = compareExpectedFile(c.name, `expected-${role}.yaml`, expectedYaml, render.artifact.content);
    if (diff !== null) throw new Error(diff);

    // G-06: header lines exactly as DESIGN-CORE 4.2 rule 1
    const lines = render.artifact.content.split('\n');
    expect(lines[0]).toBe('# dockflow-artifact: k8s-manifests/1');
    expect(lines[1]).toBe(`# stack: ${render.stack.identity.stackName}`);
    expect(lines[2]).toBe(`# role: ${role}`);
    expect(lines[3]).toBe(`# version: ${role === 'app' ? render.stack.identity.version : '-'}`);

    // G-07: rank/name order, one trailing newline, no tabs/anchors/null/stringData
    assertDocumentOrder(render.objects);
    expect(render.artifact.content.includes('\t')).toBe(false);
    expect(/^\s*stringData:/m.test(render.artifact.content)).toBe(false);
    expect(/:\s*null\s*$/m.test(render.artifact.content)).toBe(false);
    expect(render.artifact.content.endsWith('\n')).toBe(true);
    expect(render.artifact.content.endsWith('\n\n')).toBe(false);

    // G-08: emitManifests(parseManifests(content), header) === content
    const header = { format: 'k8s-manifests/1' as const, stackName: render.stack.identity.stackName, role, version: role === 'app' ? render.stack.identity.version : '-' };
    expect(emitManifests(render.objects, header)).toBe(render.artifact.content);

    // G-09: every document passes structural and semantic validation
    const issues = validateArtifact(render.objects, {
      namespace: render.stack.identity.namespace,
      externalNames: externalNamesFor(role, render.stack, result),
      strictMiddlewares: true,
      serverNames: c.input.serverNames ?? [...DEFAULT_SERVER_NAMES],
    });
    expect(formatIssues(failures(issues))).toBe('');

    // G-10
    expect(render.artifact.digest).toBe(sha256Hex(`${render.artifact.content}\n${canonicalJson(render.artifact.helm)}`));

    // G-11: secretFiles content never appears in plain text, only base64 inside Secret.data
    for (const relPath of c.input.secretFiles ?? []) {
      const raw = await readCaseFileBytes(c, relPath);
      if (raw === null) continue;
      const text = tryDecodeUtf8(raw);
      if (text !== null && text.length > 0) expect(render.artifact.content.includes(text)).toBe(false);
      expect(render.artifact.content.includes(Buffer.from(raw).toString('base64'))).toBe(true);
    }
  }

  // G-02: merged diagnostics equal expected-diagnostics.json exactly
  const expectedDiagnostics = await readExpectedJson<{ app: Diagnostic[]; accessory: Diagnostic[] }>(c, 'expected-diagnostics.json');
  expect(expectedDiagnostics).not.toBeNull();
  expect(diagnosticsOf(result.app)).toEqual(expectedDiagnostics?.app ?? []);
  expect(diagnosticsOf(result.accessory)).toEqual(expectedDiagnostics?.accessory ?? []);

  // G-12: expected-helm.json
  const expectedHelm = await readExpectedJson<HelmReleaseRecord[]>(c, 'expected-helm.json');
  if ((c.input.helm?.releases?.length ?? 0) > 0) {
    expect(expectedHelm).not.toBeNull();
    const combined: HelmReleaseRecord[] = [
      ...(result.app?.ok ? result.app.render.artifact.helm : []),
      ...(result.accessory?.ok ? result.accessory.render.artifact.helm : []),
    ];
    expect(canonicalJson(combined)).toBe(canonicalJson(expectedHelm ?? []));
    for (const record of combined) {
      expect(Object.keys(record)).not.toContain('auth');
      expect(record.valuesSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.valuesSha256).toBe(sha256Hex(canonicalJson(record.values)));
    }
  } else {
    expect(expectedHelm).toBeNull();
  }

  if (c.input.stabilityVersion !== undefined) {
    expect(result.accessoryStability).toBeDefined();
    if (result.accessoryStability && result.accessory?.ok) {
      expect(result.accessoryStability.content).toBe(result.accessory.render.artifact.content);
      expect(result.accessoryStability.digest).toBe(result.accessory.render.artifact.digest);
    }
  }
}

function assertDocumentOrder(objects: readonly ManifestObject[]): void {
  for (let i = 1; i < objects.length; i++) {
    const previousRank = KIND_REGISTRY[objects[i - 1].kind].rank;
    const currentRank = KIND_REGISTRY[objects[i].kind].rank;
    if (previousRank !== currentRank) {
      expect(currentRank).toBeGreaterThan(previousRank);
    } else {
      expect(objects[i].metadata.name >= objects[i - 1].metadata.name).toBe(true);
    }
  }
}

/** design-02 14.5: claim/object names the artifact may reference without containing them. */
function externalNamesFor(role: StackRole, stack: Parameters<typeof stackExternalNames>[0], result: GoldenRenderResult): string[] {
  const own = stackExternalNames(stack);
  const sibling = role === 'app' ? result.accessory : result.app;
  if (!sibling?.ok) return own;
  const siblingNames = sibling.render.objects.filter((o) => o.kind === 'Service' || o.kind === 'Middleware').map((o) => o.metadata.name);
  return [...own, ...siblingNames];
}

function assertSameOutcome(a: GoldenOutcome, b: GoldenOutcome): void {
  expect(a.kind).toBe(b.kind);
  if (a.kind !== 'rendered' || b.kind !== 'rendered') return;
  for (const role of ['app', 'accessory'] as const) {
    const ra = a.result[role];
    const rb = b.result[role];
    expect(ra === null).toBe(rb === null);
    if (ra === null || rb === null) continue;
    expect(ra.ok).toBe(rb.ok);
    if (ra.ok && rb.ok) {
      expect(rb.render.artifact.content).toBe(ra.render.artifact.content);
      expect(rb.render.artifact.digest).toBe(ra.render.artifact.digest);
    }
  }
}

async function readCaseFileBytes(c: GoldenCase, relPath: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(c.dir, relPath)));
  } catch {
    return null;
  }
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// G-13: a values_files entry outside .dockflow/ (and not listed in templates) is refused
// ---------------------------------------------------------------------------

describe('G-13: helm values_files outside .dockflow/', () => {
  test('is refused with the config-schema message (DESIGN-CORE 7.1, K34 (b))', () => {
    const input: HelmResolveInput = {
      helm: { releases: [{ name: 'demo', chart: 'demo', repo: 'https://charts.example.com', version: '1.0.0', values_files: ['helm/values.yml'] }] },
      role: 'app',
      stackNamespace: 'dockflow-shop-production',
      configSource: { file: 'config.yml', text: 'helm:\n  releases:\n    - name: demo\n' },
      readValuesFile: () => ({ kind: 'missing' }),
      composeServices: { app: [], accessory: [] },
      noServices: false,
    };
    let thrown: unknown;
    try {
      resolveHelmReleases(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HelmConfigError);
    const diagnostics = (thrown as HelmConfigError).diagnostics;
    expect(diagnostics.some((d) => d.message === M.valuesFileUnrendered('helm/values.yml'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// swarm-fixtures: the existing Swarm e2e fixtures must still render under k3s (WORK-PACKAGES P51)
// ---------------------------------------------------------------------------

interface SwarmFixture {
  name: string;
  project: string;
  hasAccessories: boolean;
  proxy: StackDeployInput['proxy'];
  imageDelivery: 'import' | 'registry';
  pullSecretName: string | null;
}

const SWARM_FIXTURES: readonly SwarmFixture[] = [
  { name: 'test-app', project: 'test-app', hasAccessories: true, proxy: { enabled: true, acme: false, domains: { test: 'test.local' } }, imageDelivery: 'import', pullSecretName: null },
  { name: 'test-app-registry', project: 'test-app-reg', hasAccessories: false, proxy: undefined, imageDelivery: 'registry', pullSecretName: K8S_REGISTRY_SECRET },
  { name: 'test-app-remote', project: 'test-app-remote', hasAccessories: false, proxy: undefined, imageDelivery: 'import', pullSecretName: null },
  { name: 'test-app-rollback', project: 'test-app-rb', hasAccessories: false, proxy: undefined, imageDelivery: 'import', pullSecretName: null },
  { name: 'test-app-uploads', project: 'test-app-up', hasAccessories: false, proxy: undefined, imageDelivery: 'import', pullSecretName: null },
];

const REPO_ROOT = join(import.meta.dir, '../../../..');
/** The one Nunjucks variable every fixture's docker-compose.yml reads. */
const E2E_CONTEXT = { current: { name: 'server_1', env: { web_port: '8091' } } };

describe('golden case: swarm-fixtures', () => {
  const njk = nunjucks.configure({ autoescape: false, noCache: true });

  for (const fixture of SWARM_FIXTURES) {
    test(fixture.name, async () => {
      const dockerDir = join(REPO_ROOT, 'testing/e2e/fixtures', fixture.name, '.dockflow/docker');
      const appText = njk.renderString(await readFile(join(dockerDir, 'docker-compose.yml'), 'utf-8'), E2E_CONTEXT);
      const appCompose = loadFromString(appText, 'docker-compose.yml');
      const files = createFileResolver(new Map(), dockerDir, dockerDir);
      const id = identity({ project: fixture.project });
      const env: RenderEnvironment = {
        traits: structuredClone(k3sDistribution.traits),
        imageDelivery: fixture.imageDelivery,
        extraReservedHostPorts: [{ port: 22, protocol: 'TCP', reason: 'SSH port of server_1' }],
      };
      const serverNames = [...DEFAULT_SERVER_NAMES];

      const baseInput = (role: StackRole, compose: typeof appCompose, sibling: StackDeployInput['sibling']): StackDeployInput => ({
        ref: { project: fixture.project, env: id.env, role },
        version: id.version,
        compose,
        proxy: fixture.proxy,
        services: null,
        previousVersion: null,
        force: false,
        images: { mode: fixture.imageDelivery, built: [], pullSecretName: fixture.pullSecretName },
        helm: [],
        helmDeclared: [],
        sibling,
        serverNames,
        files,
        rebindVolumes: false,
        traefikOnCluster: fixture.proxy?.enabled === true,
      });

      const appRender = renderStackArtifact(baseInput('app', appCompose, emptySibling()), env);
      expect(appRender.artifact.diagnostics.some((d) => d.severity === 'error')).toBe(false);

      if (fixture.hasAccessories) {
        const accText = njk.renderString(await readFile(join(dockerDir, 'accessories.yml'), 'utf-8'), E2E_CONTEXT);
        const accCompose = loadFromString(accText, 'accessories.yml');
        const accRender = renderStackArtifact(baseInput('accessory', accCompose, siblingFromStack(appRender.stack)), env);
        expect(accRender.artifact.diagnostics.some((d) => d.severity === 'error')).toBe(false);
      }
    });
  }
});
