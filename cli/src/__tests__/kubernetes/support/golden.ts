// Golden case harness (DESIGN-CORE 8.9; design-07 6; design-02 12; WORK-PACKAGES P51). The only
// file that reads `golden/<case>/` from disk: case discovery, the zod schema of `input.json`,
// `renderCase` (the exact rendering path golden.test.ts and update-golden.ts both use, through the
// pure `renderStackArtifact` of P38), comparison with diff output, and `writeExpectations` (used
// only by the update script). Sibling detail (D6 collisions, cross-role checks) comes from a pure
// pre-pass normalize of the other role's file, discarded once its service/volume/middleware names
// are read off (design-03 4 `siblingInput`); the real per-role render then runs with that detail.

import { readFileSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { loadFromString, type ParsedCompose } from '../../../services/compose';
import { ComposeTranslationError, type Diagnostic, DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import { createFileResolver } from '../../../services/orchestrator/file-resolver';
import type { DistributionTraits, ReservedHostPort } from '../../../services/orchestrator/kubernetes/distribution';
import { resolveHelmReleases, type ValuesFileLookup } from '../../../services/orchestrator/kubernetes/helm/resolve';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import type { CanonicalStack, StackIdentity } from '../../../services/orchestrator/kubernetes/model/types';
import { normalizeStack } from '../../../services/orchestrator/kubernetes/normalize';
import { renderStackArtifact, type RenderEnvironment, type StackRender } from '../../../services/orchestrator/kubernetes/render';
import type {
  HelmReleaseRecord,
  ImageDelivery,
  ResolvedHelmRelease,
  StackDeployInput,
  StackRole,
} from '../../../services/orchestrator/interfaces';
import type { HelmReleaseConfig } from '../../../utils/config';
import { ConfigError } from '../../../utils/errors';
import { DEFAULT_SERVER_NAMES, identity } from './builders';
import { lineDiff } from './diff';
import { deepShuffleKeys, fnv1a32, mulberry32 } from './prng';

const GOLDEN_ROOT = join(import.meta.dir, '..', 'golden');
export const UPDATE_SCRIPT = 'scripts/update-golden.ts';

// ---------------------------------------------------------------------------
// input.json schema (design-07 6.1, design-02 12's fields; unknown keys rejected)
// ---------------------------------------------------------------------------

const protocol = z.enum(['TCP', 'UDP', 'SCTP']);

const reservedHostPortSchema = z
  .object({ port: z.number().int().min(1).max(65535), protocol, reason: z.string().min(1) })
  .strict();

const identitySchema = z
  .object({ project: z.string().min(1).optional(), env: z.string().min(1).optional(), version: z.string().min(1).optional() })
  .strict();

const proxyDashboardSchema = z.object({ enabled: z.boolean().optional(), domain: z.string().optional() }).strict();

const proxySchema = z
  .object({
    enabled: z.boolean().optional(),
    email: z.string().optional(),
    acme: z.boolean().optional(),
    domains: z.record(z.string(), z.string()).optional(),
    dashboard: proxyDashboardSchema.optional(),
    manage: z.boolean().optional(),
    acme_ca_server: z.string().optional(),
    acme_ca_bundle: z.string().optional(),
    default_ingress_class: z.boolean().optional(),
  })
  .strict();

const imagesSchema = z
  .object({
    mode: z.enum(['import', 'registry', 'none']).optional(),
    built: z.array(z.string()).optional(),
    pullSecretName: z.string().nullable().optional(),
  })
  .strict();

const helmAuthSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

const helmReleaseSchema = z
  .object({
    name: z.string().min(1),
    chart: z.string().min(1),
    repo: z.string().optional(),
    version: z.string().min(1),
    digest: z.string().optional(),
    role: z.enum(['app', 'accessory']).optional(),
    namespace: z.string().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    values_files: z.array(z.string()).optional(),
    timeout: z.string().optional(),
    auth: helmAuthSchema.optional(),
  })
  .strict();

const helmSchema = z.object({ timeout: z.string().optional(), releases: z.array(helmReleaseSchema).optional() }).strict();

const expectRenderErrorSchema = z.object({ app: z.boolean().optional(), accessory: z.boolean().optional() }).strict();

export const GoldenInputSchema = z
  .object({
    description: z.string().min(1),
    identity: identitySchema.optional(),
    proxy: proxySchema.optional(),
    images: imagesSchema.optional(),
    /** NormalizeInput.imageDelivery; default 'import' (never derived from `images.mode`, K28) */
    imageDelivery: z.enum(['import', 'registry', 'none']).optional(),
    keepReleases: z.number().int().positive().optional(),
    /** servers.yml SSH ports of the default server; feeds the default extraReservedHostPorts */
    serverSshPorts: z.array(z.number().int().min(1).max(65535)).optional(),
    /** full override of the reservation set; when absent, derived from serverSshPorts */
    extraReservedHostPorts: z.array(reservedHostPortSchema).optional(),
    serverNames: z.array(z.string()).optional(),
    traits: z.record(z.string(), z.unknown()).optional(),
    /** files/ paths whose content G-11 must never find in plain text */
    secretFiles: z.array(z.string()).optional(),
    helm: helmSchema.optional(),
    traefikOnCluster: z.boolean().optional(),
    /** accessories rendered a second time with this version; bytes and digest must match */
    stabilityVersion: z.string().optional(),
    expectRenderError: expectRenderErrorSchema.optional(),
    /** load-time refusal cases (G-03's expectLoadError row): the exact ConfigError message */
    expectLoadError: z.string().optional(),
  })
  .strict();

export type GoldenInput = z.infer<typeof GoldenInputSchema>;

// ---------------------------------------------------------------------------
// Case discovery
// ---------------------------------------------------------------------------

export interface GoldenCase {
  name: string;
  dir: string;
  input: GoldenInput;
}

const CASE_FILES = new Set(['input.json', 'docker-compose.yml', 'accessories.yml', 'expected-app.yaml', 'expected-accessory.yaml', 'expected-helm.json', 'expected-diagnostics.json']);
const CASE_DIRS = new Set(['files', 'helm']);
const NON_CASE_ENTRIES = new Set(['README.md', 'input.schema.json']);

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every subdirectory of golden/ with a validated input.json, sorted by name. */
export async function discoverCases(): Promise<GoldenCase[]> {
  const entries = await readdir(GOLDEN_ROOT, { withFileTypes: true });
  const cases: GoldenCase[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || NON_CASE_ENTRIES.has(entry.name)) continue;
    const dir = join(GOLDEN_ROOT, entry.name);
    const raw = JSON.parse(await readFile(join(dir, 'input.json'), 'utf-8'));
    cases.push({ name: entry.name, dir, input: GoldenInputSchema.parse(raw) });
  }
  return cases.sort((a, b) => compareCodeUnits(a.name, b.name));
}

/** Structure checks that always run (design-07 6.4): unknown files, expected-accessory without accessories.yml. */
export async function checkCaseStructure(c: GoldenCase): Promise<string[]> {
  const problems: string[] = [];
  const entries = await readdir(c.dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!CASE_DIRS.has(entry.name)) problems.push(`${c.name}: unknown directory ${entry.name}`);
      continue;
    }
    if (!CASE_FILES.has(entry.name)) problems.push(`${c.name}: unknown file ${entry.name}`);
  }
  const hasAccessories = entries.some((e) => e.isFile() && e.name === 'accessories.yml');
  const hasExpectedAccessory = entries.some((e) => e.isFile() && e.name === 'expected-accessory.yaml');
  if (hasExpectedAccessory && !hasAccessories) problems.push(`${c.name}: expected-accessory.yaml without accessories.yml`);
  return problems;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type RoleRenderOutcome = { ok: true; render: StackRender } | { ok: false; error: ComposeTranslationError };

export interface GoldenRenderResult {
  app: RoleRenderOutcome | null;
  accessory: RoleRenderOutcome | null;
  /** present only when input.stabilityVersion is set and the accessory role rendered */
  accessoryStability?: { content: string; digest: string };
}

export type GoldenOutcome = { kind: 'rendered'; result: GoldenRenderResult } | { kind: 'load-error'; message: string };

export interface RenderCaseOptions {
  /** G-05: deep-shuffle mapping keys and service order before rendering, with this seed */
  shuffleSeed?: number;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** fnv1a32 of the case name (G-05's seed). */
export function caseSeed(name: string): number {
  return fnv1a32(name);
}

/** A copy of `compose` whose mapping keys (services included) are inserted in shuffled order. */
export function shuffleCompose(compose: ParsedCompose, seed: number): ParsedCompose {
  const raw = deepShuffleKeys(compose.raw, mulberry32(seed));
  return {
    raw,
    services: (raw.services ?? {}) as Record<string, Record<string, unknown>>,
    networks: raw.networks as Record<string, unknown> | undefined,
    volumes: raw.volumes as Record<string, unknown> | undefined,
  };
}

export function emptySibling(): StackDeployInput['sibling'] {
  return { services: [], volumes: [], middlewares: [] };
}

/** The sibling detail a real render needs (design-03 4 `siblingInput`), read off a pure normalize. */
export function siblingFromStack(stack: CanonicalStack): StackDeployInput['sibling'] {
  return {
    services: stack.services.map((s) => ({
      key: s.composeName,
      name: s.name,
      aliases: [...s.network.aliases],
      published: s.ports.filter((p) => p.published !== null).map((p) => ({ port: p.published as number, protocol: p.protocol })),
    })),
    volumes: stack.volumes.map((v) => ({ key: v.key, claimName: v.name, external: v.external })),
    middlewares: stack.middlewares.map((m) => m.name),
  };
}

function defaultReservations(ports: readonly number[]): ReservedHostPort[] {
  return [...new Set(ports)].sort((a, b) => a - b).map((port) => ({ port, protocol: 'TCP' as const, reason: 'SSH port of server_1' }));
}

function buildRenderEnvironment(input: GoldenInput): RenderEnvironment {
  return {
    traits: { ...structuredClone(k3sDistribution.traits), ...(input.traits ?? {}) } as DistributionTraits,
    imageDelivery: input.imageDelivery ?? 'import',
    keepReleases: input.keepReleases,
    extraReservedHostPorts: input.extraReservedHostPorts ?? defaultReservations(input.serverSshPorts ?? [22]),
  };
}

function buildImages(input: GoldenInput): ImageDelivery {
  return { mode: input.images?.mode ?? 'none', built: input.images?.built ?? [], pullSecretName: input.images?.pullSecretName ?? null };
}

function readCaseValuesFile(caseDir: string, path: string): ValuesFileLookup {
  const prefix = '.dockflow/helm/';
  if (!path.startsWith(prefix)) return { kind: 'missing' };
  try {
    return { kind: 'found', text: readFileSync(join(caseDir, 'helm', path.slice(prefix.length)), 'utf-8'), rendered: true };
  } catch {
    return { kind: 'missing' };
  }
}

/** Resolves the releases of one role (design-04 3.3/3.4), inline values read back with Helm's YAML rules. */
export function resolveHelmForRole(
  input: GoldenInput,
  role: StackRole,
  namespace: string,
  caseDir: string,
  composeServices: { app: string[]; accessory: string[] },
): ResolvedHelmRelease[] {
  const releases = input.helm?.releases ?? [];
  if (releases.length === 0) return [];
  const configText = stringify({ helm: { releases } });
  const { releases: resolved } = resolveHelmReleases({
    helm: { timeout: input.helm?.timeout, releases: releases as HelmReleaseConfig[] },
    role,
    stackNamespace: namespace,
    configSource: { file: 'config.yml', text: configText },
    readValuesFile: (path) => readCaseValuesFile(caseDir, path),
    composeServices,
    noServices: false,
  });
  return resolved;
}

function normalizePure(role: StackRole, compose: ParsedCompose, input: GoldenInput, id: StackIdentity, env: RenderEnvironment, files: StackDeployInput['files']): CanonicalStack {
  const { stack } = normalizeStack({
    compose,
    role,
    identity: id,
    proxy: input.proxy,
    sibling: emptySibling(),
    serverNames: input.serverNames ?? [...DEFAULT_SERVER_NAMES],
    imageDelivery: env.imageDelivery,
    files,
    traits: env.traits,
    sink: new DiagnosticSink(),
  });
  return stack;
}

function renderRole(
  role: StackRole,
  compose: ParsedCompose,
  input: GoldenInput,
  id: StackIdentity,
  env: RenderEnvironment,
  files: StackDeployInput['files'],
  sibling: StackDeployInput['sibling'],
  helm: ResolvedHelmRelease[],
): RoleRenderOutcome {
  const deployIn: StackDeployInput = {
    ref: { project: id.project, env: id.env, role },
    version: id.version,
    compose,
    proxy: input.proxy,
    services: null,
    previousVersion: null,
    force: false,
    images: buildImages(input),
    helm,
    helmDeclared: helm.map((r) => r.name),
    sibling,
    serverNames: input.serverNames ?? [...DEFAULT_SERVER_NAMES],
    files,
    rebindVolumes: false,
    traefikOnCluster: input.traefikOnCluster ?? input.proxy?.enabled === true,
  };
  try {
    return { ok: true, render: renderStackArtifact(deployIn, env) };
  } catch (error) {
    if (error instanceof ComposeTranslationError) return { ok: false, error };
    throw error;
  }
}

/**
 * The one rendering path golden.test.ts and update-golden.ts share (design-07 6.4): loads both
 * compose files (a load-time refusal short-circuits everything into `load-error`), derives each
 * role's sibling detail from a pure normalize of the other file, resolves Helm releases per role,
 * then renders through `renderStackArtifact` (P38). Never writes to disk.
 */
export async function renderCase(c: GoldenCase, options: RenderCaseOptions = {}): Promise<GoldenOutcome> {
  const appText = await readIfExists(join(c.dir, 'docker-compose.yml'));
  const accText = await readIfExists(join(c.dir, 'accessories.yml'));

  let appCompose: ParsedCompose | null = null;
  let accCompose: ParsedCompose | null = null;
  try {
    if (appText !== null) appCompose = loadFromString(appText, 'docker-compose.yml');
    if (accText !== null) accCompose = loadFromString(accText, 'accessories.yml');
  } catch (error) {
    if (error instanceof ConfigError) return { kind: 'load-error', message: error.message };
    throw error;
  }

  if (options.shuffleSeed !== undefined) {
    if (appCompose) appCompose = shuffleCompose(appCompose, options.shuffleSeed);
    if (accCompose) accCompose = shuffleCompose(accCompose, options.shuffleSeed);
  }

  const files = createFileResolver(new Map(), c.dir, c.dir);
  const id = identity(c.input.identity);
  const env = buildRenderEnvironment(c.input);
  const composeServices = { app: appCompose ? Object.keys(appCompose.services) : [], accessory: accCompose ? Object.keys(accCompose.services) : [] };

  const preApp = appCompose ? normalizePure('app', appCompose, c.input, id, env, files) : null;
  const preAcc = accCompose ? normalizePure('accessory', accCompose, c.input, id, env, files) : null;
  const appSibling = preAcc ? siblingFromStack(preAcc) : emptySibling();
  const accSibling = preApp ? siblingFromStack(preApp) : emptySibling();

  const appHelm = resolveHelmForRole(c.input, 'app', id.namespace, c.dir, composeServices);
  const accHelm = resolveHelmForRole(c.input, 'accessory', id.namespace, c.dir, composeServices);

  const result: GoldenRenderResult = {
    app: appCompose ? renderRole('app', appCompose, c.input, id, env, files, appSibling, appHelm) : null,
    accessory: accCompose ? renderRole('accessory', accCompose, c.input, id, env, files, accSibling, accHelm) : null,
  };

  if (c.input.stabilityVersion !== undefined && accCompose && result.accessory?.ok) {
    const stableId: StackIdentity = { ...id, version: c.input.stabilityVersion };
    const stable = renderRole('accessory', accCompose, c.input, stableId, env, files, accSibling, accHelm);
    if (stable.ok) result.accessoryStability = { content: stable.render.artifact.content, digest: stable.render.artifact.digest };
  }

  return { kind: 'rendered', result };
}

// ---------------------------------------------------------------------------
// Comparison (with diff output) and writing expectations
// ---------------------------------------------------------------------------

export function diagnosticsOf(outcome: RoleRenderOutcome | null): Diagnostic[] {
  if (outcome === null) return [];
  return outcome.ok ? outcome.render.artifact.diagnostics : outcome.error.diagnostics;
}

export async function readExpectedText(c: GoldenCase, fileName: string): Promise<string | null> {
  return readIfExists(join(c.dir, fileName));
}

export async function readExpectedJson<T>(c: GoldenCase, fileName: string): Promise<T | null> {
  const text = await readExpectedText(c, fileName);
  return text === null ? null : (JSON.parse(text) as T);
}

const DIFF_MAX_LINES = 120;

/** G-01: byte equality with a unified diff (first 120 lines) and the update-script hint on failure. */
export function compareExpectedFile(caseName: string, fileName: string, expected: string | null, actual: string | null): string | null {
  if (expected === actual) return null;
  const hint = `Run: bun run ${UPDATE_SCRIPT} ${caseName}`;
  if (expected === null) return `${fileName}: rendered but no expected file exists\n${hint}`;
  if (actual === null) return `${fileName}: expected file exists but nothing rendered\n${hint}`;
  const diff = lineDiff(expected, actual, { labels: { expected: `${fileName} (expected)`, actual: `${fileName} (rendered)` } });
  const lines = diff.split('\n');
  const shown = lines.length > DIFF_MAX_LINES ? [...lines.slice(0, DIFF_MAX_LINES), `... (${lines.length - DIFF_MAX_LINES} more lines)`] : lines;
  return `${shown.join('\n')}\n${hint}`;
}

async function rmIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * The update script's only write path (design-07 6.4): writes expected-<role>.yaml when the role
 * renders and deletes it otherwise, always rewrites expected-diagnostics.json, and writes or
 * removes expected-helm.json depending on whether the case declares Helm releases. Never called by
 * golden.test.ts.
 */
export async function writeExpectations(c: GoldenCase, outcome: GoldenOutcome): Promise<void> {
  if (outcome.kind === 'load-error') return;
  const { result } = outcome;
  for (const role of ['app', 'accessory'] as const) {
    const path = join(c.dir, `expected-${role}.yaml`);
    const roleOutcome = result[role];
    if (roleOutcome?.ok) await writeFile(path, roleOutcome.render.artifact.content, 'utf-8');
    else await rmIfExists(path);
  }
  const diagnostics = { app: diagnosticsOf(result.app), accessory: diagnosticsOf(result.accessory) };
  await writeFile(join(c.dir, 'expected-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf-8');

  const helmPath = join(c.dir, 'expected-helm.json');
  if ((c.input.helm?.releases?.length ?? 0) > 0) {
    const combined: HelmReleaseRecord[] = [
      ...(result.app?.ok ? result.app.render.artifact.helm : []),
      ...(result.accessory?.ok ? result.accessory.render.artifact.helm : []),
    ];
    await writeFile(helmPath, `${JSON.stringify(combined, null, 2)}\n`, 'utf-8');
  } else {
    await rmIfExists(helmPath);
  }
}
