/**
 * Validate command (DESIGN-CORE 2.6): schema and lint checks, unchanged; with an environment
 * argument and `orchestrator: k3s`, also an OFFLINE render of both roles (no SSH, no kubectl, no
 * Helm, no registry call — `deploy --dry-run` is the live check, this one never resolves an
 * orchestrator target).
 *
 * Exit codes:
 *   0 — all checks passed (warnings only still exit 0)
 *   11 — config.yml / dockflow.yml failed schema validation (CONFIG_INVALID, DESIGN-CORE 8.1)
 *   60 — any other validation error: servers.yml, compose lint, or the k3s render (VALIDATION_FAILED)
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  HOOK_PHASES,
  loadConfig,
  loadServersConfig,
  getComposePath,
  getLayout,
  getAccessoriesPath,
  type DockflowConfig,
} from '../utils/config';
import * as Plugin from '../services/plugin';
import * as Compose from '../services/compose';
import { createFileResolver } from '../services/orchestrator/file-resolver';
import { k3sDistribution } from '../services/orchestrator/kubernetes/k3s/distribution';
import { namespaceFor } from '../services/orchestrator/kubernetes/naming';
import { normalizeStack } from '../services/orchestrator/kubernetes/normalize';
import type { NormalizeInput } from '../services/orchestrator/kubernetes/normalize/context';
import { renderStackArtifact, reservedHostPortsFromConfig, type RenderEnvironment } from '../services/orchestrator/kubernetes/render';
import { HelmConfigError, renderedValuesFileLookup, resolveHelmReleases } from '../services/orchestrator/kubernetes/helm/resolve';
import { DiagnosticSink, type Diagnostic } from '../services/orchestrator/diagnostics';
import type { FileResolver, StackDeployInput, StackRole } from '../services/orchestrator/interfaces';
import type { TopologyServer } from '../schemas/servers.schema';
import { k3sTopologyIssues } from '../schemas/servers.schema';
import { resolveImageDelivery, declaredHelmNames } from './deploy-phases';
import { buildTemplateContext } from '../utils/servers';
import { getCurrentBranch } from '../utils/git';
import {
  printSuccess,
  printError,
  printInfo,
  printWarning,
  printDebug,
  printBlank,
  printSection,
  printTableRow,
  printDim,
  colors,
} from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { findShellPlaceholders, describeShellPlaceholders } from '../services/compose-lint';
import { CLIError, ComposeTranslationError, ConfigError, ValidationError, withErrorHandler } from '../utils/errors';
import { findUnknownConfigKeys, findUnknownServersKeys, findUnknownRootKeys, type UnknownKey } from '../schemas';

/**
 * Warn about keys the schema does not declare (Zod strips them silently, so a
 * typo means the setting is ignored without any error).
 */
function warnUnknownKeys(filePath: string, finder: (data: unknown) => UnknownKey[]): void {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, 'utf-8'));
  } catch {
    return; // unreadable/invalid YAML is already reported by the schema validation
  }

  for (const { path, suggestion } of finder(raw)) {
    printWarning(`Unknown key "${path}" — it is ignored.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`);
  }
}

/**
 * Every env key declared in servers.yml, across servers and environments. Used to tell a
 * plain typo apart from a variable the user really did define.
 */
function collectDeclaredEnvKeys(): string[] {
  const servers = loadServersConfig({ silent: true });
  if (!servers) return [];

  const keys = new Set<string>();
  for (const server of Object.values(servers.servers)) {
    for (const key of Object.keys(server.env ?? {})) keys.add(key);
  }
  return [...keys];
}

interface ValidateOptions {
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// k3s offline render (DESIGN-CORE 2.6, design-07 U-FLOW-08)
// ---------------------------------------------------------------------------

function printDiagnostics(file: string, diagnostics: readonly Diagnostic[]): boolean {
  let hasErrors = false;
  for (const d of diagnostics) {
    if (d.severity === 'error') {
      hasErrors = true;
      printError(`${file} ${d.path}: ${d.message}`);
    } else if (d.severity === 'warning') {
      printWarning(`${file} ${d.path}: ${d.message}`);
    } else {
      // an info line is shown with --debug only, and so is its hint
      printDebug(`${file} ${d.path}: ${d.message}${d.hint ? ` (${d.hint})` : ''}`);
      continue;
    }
    if (d.hint) printDim(`  ${d.hint}`);
  }
  return hasErrors;
}

function accessoriesRelPathFor(projectRoot: string): string {
  const layout = getLayout();
  return layout.accessoriesPath ? relative(projectRoot, layout.accessoriesPath).replace(/\\/g, '/') : '.dockflow/docker/accessories.yml';
}

function configSourceFor(projectRoot: string, rendered: ReadonlyMap<string, string>): { file: string; text: string } {
  const layout = getLayout();
  const file = relative(projectRoot, layout.configPath).replace(/\\/g, '/');
  return { file, text: rendered.get(file) ?? '' };
}

/** The other role, normalized with an empty sibling first (pure, diagnostics discarded): design-01 1.3. */
function siblingFor(
  other: Compose.ParsedCompose | null,
  role: StackRole,
  identity: NormalizeInput['identity'],
  config: DockflowConfig,
  serverNames: string[],
  imageDelivery: NormalizeInput['imageDelivery'],
  files: FileResolver,
): StackDeployInput['sibling'] {
  const empty: StackDeployInput['sibling'] = { services: [], volumes: [], middlewares: [] };
  if (!other) return empty;

  const { stack } = normalizeStack({
    compose: other,
    role: role === 'app' ? 'accessory' : 'app',
    identity,
    proxy: config.proxy,
    sibling: empty,
    serverNames,
    imageDelivery,
    files,
    traits: k3sDistribution.traits,
    sink: new DiagnosticSink(),
  });

  return {
    services: stack.services.map((s) => ({
      key: s.composeName,
      name: s.name,
      aliases: s.network.aliases,
      published: s.ports.filter((p) => p.published !== null).map((p) => ({ port: p.published as number, protocol: p.protocol })),
    })),
    volumes: stack.volumes.map((v) => ({ key: v.key, claimName: v.name, external: v.external })),
    middlewares: stack.middlewares.map((m) => m.name),
  };
}

/** The synthetic `StackDeployInput` of DESIGN-CORE 2.6's table, for one role. */
function buildValidateInput(
  config: DockflowConfig,
  env: string,
  role: StackRole,
  compose: Compose.ParsedCompose,
  other: Compose.ParsedCompose | null,
  serverNames: string[],
  files: FileResolver,
  helmReleases: ReturnType<typeof resolveHelmReleases>['releases'],
): StackDeployInput {
  const project = config.project_name;
  const identity = { project, env, stackName: `${project}-${env}`, namespace: namespaceFor(project, env), version: '0.0.0-validate' };
  const delivery = resolveImageDelivery(config, role === 'app' ? compose : (other ?? compose));

  return {
    ref: { project, env, role },
    version: '0.0.0-validate',
    compose,
    proxy: config.proxy,
    services: null,
    previousVersion: null,
    force: false,
    images: delivery,
    helm: helmReleases,
    helmDeclared: declaredHelmNames(config, role),
    sibling: siblingFor(other, role, identity, config, serverNames, delivery.mode, files),
    serverNames,
    files,
    rebindVolumes: false,
    traefikOnCluster: config.proxy?.enabled === true,
  };
}

/** Renders one role offline and prints its diagnostics; returns whether it carried an error. */
function renderRoleOffline(label: string, input: StackDeployInput, env: RenderEnvironment): boolean {
  try {
    const { artifact } = renderStackArtifact(input, env);
    return printDiagnostics(label, artifact.diagnostics);
  } catch (error) {
    if (error instanceof ComposeTranslationError) {
      // the same headline deploy fails with, then every diagnostic in full
      printError(error.message);
      printDiagnostics(label, error.diagnostics);
      return true;
    }
    throw error;
  }
}

/**
 * The FS-independent core of the k3s offline render (DESIGN-CORE 2.6): everything from the already
 * rendered templates onward. Split out so it can be unit-tested without `getProjectRoot()`'s global,
 * process-wide cache (`utils/config.ts` has no reset hook) — the CLI wrapper below gathers its
 * arguments from the real project, a test builds them in memory.
 */
export function renderK3sOfflineCore(
  config: DockflowConfig,
  env: string,
  serverNames: readonly string[],
  serversConfig: import('../types/servers').ServersConfig,
  rendered: ReadonlyMap<string, string>,
  composeContent: string,
  projectRoot: string,
  composeDirPath: string,
): boolean {
  const compose = Compose.loadFromString(composeContent);
  const accessoriesContent = rendered.get(accessoriesRelPathFor(projectRoot));
  const accessoriesCompose = accessoriesContent ? Compose.loadFromString(accessoriesContent) : null;
  if (accessoriesCompose) Compose.injectAccessoriesDefaults(accessoriesCompose, 'k3s');

  const files = createFileResolver(rendered, projectRoot, composeDirPath);

  let hasErrors = false;
  let appHelm: ReturnType<typeof resolveHelmReleases>['releases'] = [];
  let accHelm: ReturnType<typeof resolveHelmReleases>['releases'] = [];
  try {
    const configSource = configSourceFor(projectRoot, rendered);
    const composeServices = { app: Object.keys(compose.services), accessory: Object.keys(accessoriesCompose?.services ?? {}) };
    const readValuesFile = renderedValuesFileLookup(rendered);
    appHelm = resolveHelmReleases({ helm: config.helm, role: 'app', stackNamespace: namespaceFor(config.project_name, env), configSource, readValuesFile, composeServices, noServices: config.no_services === true, templates: config.templates }).releases;
    accHelm = resolveHelmReleases({ helm: config.helm, role: 'accessory', stackNamespace: namespaceFor(config.project_name, env), configSource, readValuesFile, composeServices, noServices: config.no_services === true, templates: config.templates }).releases;
  } catch (error) {
    if (error instanceof HelmConfigError) {
      hasErrors = printDiagnostics(configSourceFor(projectRoot, rendered).file, error.diagnostics) || hasErrors;
    } else {
      throw error;
    }
  }

  const renderEnv: RenderEnvironment = {
    traits: k3sDistribution.traits,
    imageDelivery: resolveImageDelivery(config, compose).mode,
    keepReleases: config.stack_management?.keep_releases,
    extraReservedHostPorts: reservedHostPortsFromConfig(config, serversConfig, env),
  };
  const appInput = buildValidateInput(config, env, 'app', compose, accessoriesCompose, serverNames as string[], files, appHelm);
  hasErrors = renderRoleOffline('docker-compose.yml', appInput, renderEnv) || hasErrors;

  if (accessoriesCompose || accHelm.length > 0) {
    const accInput = buildValidateInput(config, env, 'accessory', accessoriesCompose ?? Compose.emptyCompose(), compose, serverNames as string[], files, accHelm);
    hasErrors = renderRoleOffline('accessories.yml', accInput, renderEnv) || hasErrors;
  }

  return hasErrors;
}

/**
 * DESIGN-CORE 2.6: offline normalize + translate of both roles, plus the two k3s topology rules of
 * 7.2 (`M.managerCount`, `M.duplicateNode`, design-07 U-SETUP-PLAN-03/04). No SSH, no kubectl, no
 * Helm, no registry call, no orchestrator target resolved.
 */
async function runK3sOfflineRender(rootConfig: DockflowConfig, env: string): Promise<boolean> {
  const serversConfig = loadServersConfig({ silent: true });
  if (!serversConfig) return false; // the servers.yml section above already reported the failure

  const topology: Record<string, TopologyServer> = {};
  for (const [name, server] of Object.entries(serversConfig.servers)) {
    topology[name] = { role: server.role, host: server.host, private_host: server.private_host, tags: server.tags };
  }
  let hasErrors = printDiagnostics('servers.yml', k3sTopologyIssues(topology, env));

  const serverNames = Object.keys(serversConfig.servers).filter((name) => serversConfig.servers[name].tags.includes(env));
  if (serverNames.length === 0) {
    printWarning(`No servers found with tag "${env}"; the k3s render is skipped`);
    return hasErrors;
  }

  const templateContext = buildTemplateContext(env, serverNames[0]);
  let rendered: ReadonlyMap<string, string>;
  let composeContent: string;
  let composeDirPath: string;
  let resolvedRoot: string;
  let config = rootConfig;
  try {
    const result = Compose.renderAndResolveCompose(
      { env, version: '0.0.0-validate', branch: getCurrentBranch(), project_name: rootConfig.project_name, config: rootConfig },
      templateContext,
      { uploadOnly: rootConfig.no_services === true },
    );
    rendered = result.rendered;
    composeContent = result.composeContent;
    composeDirPath = result.composeDirPath;
    resolvedRoot = result.projectRoot;
    if (rootConfig.plugins?.length) {
      const pluginsLoaded = await Plugin.loadConfigWithPlugins({ rendered: rendered as Map<string, string>, fallback: rootConfig, projectRoot: resolvedRoot, projectContext: result.renderContext });
      config = pluginsLoaded.config;
    }
  } catch (error) {
    printError(error instanceof CLIError ? error.message : String(error));
    return true;
  }

  return hasErrors || renderK3sOfflineCore(config, env, serverNames, serversConfig, rendered, composeContent, resolvedRoot, composeDirPath);
}

// ---------------------------------------------------------------------------
// Run all validation checks and return whether everything passed.
// ---------------------------------------------------------------------------

async function runValidate(env: string | undefined, options: ValidateOptions): Promise<void> {
  loadSecrets();

  const layout = getLayout();
  const { type: layoutType, root: projectRoot, configPath, serversPath } = layout;
  const flat = layoutType === 'flat';

  printSection('Validating Dockflow configuration');
  printBlank();

  let hasErrors = false;
  // config.yml / servers.yml present but schema-invalid is CONFIG_INVALID (DESIGN-CORE 8.1), not the
  // generic VALIDATION_FAILED every other section below falls back to.
  let configInvalid = false;

  // ── 1. Project directory ────────────────────────────────────────────────────

  if (!flat && !existsSync(join(projectRoot, '.dockflow'))) {
    printError('No dockflow.yml or .dockflow/ directory found');
    printWarning(`Expected dockflow.yml at: ${projectRoot}`);
    printWarning("Run 'dockflow init' to create a project configuration.");
    throw new ValidationError('No Dockflow configuration found', "Run 'dockflow init' to initialize this project.");
  }

  printInfo(`Project root: ${projectRoot} (${flat ? 'flat layout' : 'standard layout'})`);
  printBlank();

  // ── 2. config / dockflow.yml ────────────────────────────────────────────────

  printSection(flat ? 'dockflow.yml' : 'config.yml');

  let config: DockflowConfig | null = null;
  if (!existsSync(configPath)) {
    printError(`${flat ? 'dockflow.yml' : 'config.yml'} not found`);
    hasErrors = true;
  } else {
    config = loadConfig({ validate: true, silent: false });
    if (!config) {
      hasErrors = true;
      configInvalid = true;
    } else {
      printSuccess(`${flat ? 'dockflow.yml' : 'config.yml'} — OK (project: ${colors.bold(config.project_name)})`);
      warnUnknownKeys(configPath, flat ? findUnknownRootKeys : findUnknownConfigKeys);

      const features: string[] = [];
      if (config.registry) features.push(`registry (${config.registry.type})`);
      if (config.proxy?.enabled) features.push('proxy (Traefik)');
      if (config.notifications?.webhooks?.length) features.push(`notifications (${config.notifications.webhooks.length} webhook(s))`);
      if (HOOK_PHASES.some((phase) => config?.hooks?.[phase]?.length)) features.push('hooks');
      if (config.backup) features.push('backup');
      if (config.orchestrator === 'k3s') features.push('orchestrator (k3s)');
      if (features.length > 0) printTableRow('Features:', features.join(', '));

      if (config.plugins?.length) {
        try {
          const expansion = await Plugin.expandPlugins(config.plugins, {
            projectRoot,
            projectContext: { env: env ?? '', version: '', project_name: config.project_name, config },
          });
          Plugin.applyPluginExpansion(config, new Map(), expansion, projectRoot);
          for (const line of expansion.summary) printTableRow('Plugin:', line);
        } catch (error) {
          printError(error instanceof Error ? error.message : String(error));
          if (error instanceof CLIError && error.suggestion) printWarning(error.suggestion);
          hasErrors = true;
        }
      }
    }
  }

  printBlank();

  // ── 3. servers ──────────────────────────────────────────────────────────────

  printSection(flat ? 'servers (from dockflow.yml)' : 'servers.yml');

  let envExists = false;
  if (!flat && !existsSync(serversPath)) {
    printError('servers.yml not found');
    hasErrors = true;
  } else {
    const servers = loadServersConfig({ validate: true, silent: false });
    if (!servers) {
      hasErrors = true;
    } else {
      const tagMap: Record<string, { managers: number; workers: number }> = {};
      for (const server of Object.values(servers.servers)) {
        for (const tag of server.tags) {
          if (!tagMap[tag]) tagMap[tag] = { managers: 0, workers: 0 };
          if ((server.role ?? 'manager') === 'manager') tagMap[tag].managers++;
          else tagMap[tag].workers++;
        }
      }
      const envNames = Object.keys(tagMap);
      printSuccess(`${flat ? 'dockflow.yml' : 'servers.yml'} — OK (${envNames.length} environment(s): ${envNames.join(', ')})`);
      if (!flat) warnUnknownKeys(serversPath, findUnknownServersKeys);

      if (env) {
        if (!tagMap[env]) {
          printError(`Environment "${env}" not found in servers.yml`);
          printWarning(`Available: ${envNames.join(', ')}`);
          hasErrors = true;
        } else {
          envExists = true;
          const { managers, workers } = tagMap[env];
          printTableRow(`${env}:`, `${managers} manager(s), ${workers} worker(s)`);
        }
      }
    }
  }

  printBlank();

  // ── 4. Docker Compose file ──────────────────────────────────────────────────

  printSection('docker-compose');

  const composePath = getComposePath();
  if (!composePath) {
    printWarning('No docker-compose.yml / docker-compose.yaml found in .dockflow/docker/');
    printWarning('This is fine for accessories-only projects.');
  } else {
    printSuccess(`docker-compose found: ${composePath.replace(projectRoot, '.')}`);
  }

  const declaredKeys = collectDeclaredEnvKeys();
  for (const stackFile of [composePath, getAccessoriesPath()]) {
    if (!stackFile) continue;
    const placeholders = findShellPlaceholders(readFileSync(stackFile, 'utf-8'), declaredKeys);
    for (const line of describeShellPlaceholders(placeholders)) {
      printError(`${relative(projectRoot, stackFile).split(sep).join('/')} ${line}`);
    }
    if (placeholders.length > 0) hasErrors = true;
  }

  printBlank();

  // ── 5. k3s offline render (DESIGN-CORE 2.6) ─────────────────────────────────
  // Only with an env, on k3s, and once every earlier section succeeded enough to name servers.

  if (env && envExists && config && (config.orchestrator ?? 'swarm') === 'k3s') {
    printSection(`k3s render (${env})`);
    const renderHasErrors = await runK3sOfflineRender(config, env);
    if (renderHasErrors) hasErrors = true;
    else printSuccess(`k3s render — OK`);
    printBlank();
  }

  // ── 6. Result ───────────────────────────────────────────────────────────────

  if (configInvalid) {
    throw new ConfigError(`${flat ? 'dockflow.yml' : 'config.yml'} failed schema validation — fix the errors above before deploying.`);
  }
  if (hasErrors) {
    throw new ValidationError('Configuration validation failed — fix the errors above before deploying.');
  }

  printSuccess('All configuration files are valid.');
  printBlank();
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate [env]')
    .description('Validate .dockflow configuration files without connecting to any server')
    .helpGroup('Setup')
    .option('--debug', 'Enable debug output')
    .action(
      withErrorHandler(async (env: string | undefined, options: ValidateOptions) => {
        await runValidate(env, options);
      }),
    );
}
