/**
 * The `validate` command: checks the configuration files, the plugins and the compose files
 * without connecting to any server. Exits 0 when everything passes, 60 (VALIDATION_FAILED) on any
 * validation error.
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
} from '../utils/config';
import * as Plugin from '../services/plugin';
import {
  printSuccess,
  printError,
  printInfo,
  printWarning,
  printBlank,
  printSection,
  printTableRow,
  colors,
} from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import {
  findShellPlaceholders,
  describeShellPlaceholders,
  findAccessoriesWithBuild,
} from '../services/compose-lint';
import { CLIError, ValidationError, withErrorHandler } from '../utils/errors';
import { registryWithoutCredentials } from '../services/compose';
import {
  findUnknownConfigKeys,
  findUnknownServersKeys,
  findUnknownRootKeys,
  type UnknownKey,
} from '../schemas';

/** Warns about keys the schema does not declare: Zod strips them silently, so a typo is ignored without any error. */
function warnUnknownKeys(filePath: string, finder: (data: unknown) => UnknownKey[]): void {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(filePath, 'utf-8'));
  } catch {
    return; // unreadable/invalid YAML is already reported by the schema validation
  }

  for (const { path, suggestion } of finder(raw)) {
    printWarning(
      `Unknown key "${path}" — it is ignored.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
    );
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
  env?: string;
}

export function resolveValidateEnv(positional: string | undefined, flag: string | undefined): string | undefined {
  if (positional && flag && positional !== flag) {
    throw new ValidationError(
      `Two different environments given: "${positional}" and --env "${flag}"`,
      'Pass the environment once, either as an argument or with --env.',
    );
  }
  return positional ?? flag;
}

/** Runs every check, then throws a ValidationError if any failed. */
async function runValidate(options: ValidateOptions): Promise<void> {
  loadSecrets();

  const layout = getLayout();
  const { type: layoutType, root: projectRoot, configPath, serversPath } = layout;
  const flat = layoutType === 'flat';

  printSection('Validating Dockflow configuration');
  printBlank();

  let hasErrors = false;

  if (!flat && !existsSync(join(projectRoot, '.dockflow'))) {
    printError('No dockflow.yml or .dockflow/ directory found');
    printWarning(`Expected dockflow.yml at: ${projectRoot}`);
    printWarning("Run 'dockflow init' to create a project configuration.");
    throw new ValidationError(
      'No Dockflow configuration found',
      "Run 'dockflow init' to initialize this project.",
    );
  }

  printInfo(`Project root: ${projectRoot} (${flat ? 'flat layout' : 'standard layout'})`);
  printBlank();

  printSection(flat ? 'dockflow.yml' : 'config.yml');

  if (!existsSync(configPath)) {
    printError(`${flat ? 'dockflow.yml' : 'config.yml'} not found`);
    hasErrors = true;
  } else {
    const config = loadConfig({ validate: true, silent: false });
    if (!config) {
      hasErrors = true;
    } else {
      printSuccess(`${flat ? 'dockflow.yml' : 'config.yml'} — OK (project: ${colors.bold(config.project_name)})`);
      warnUnknownKeys(configPath, flat ? findUnknownRootKeys : findUnknownConfigKeys);

      const features: string[] = [];
      if (config.registry) features.push(`registry (${config.registry.type})`);
      if (config.proxy?.enabled) features.push('proxy (Traefik)');
      if (config.notifications?.webhooks?.length) {
        features.push(`notifications (${config.notifications.webhooks.length} webhook(s))`);
      }
      if (HOOK_PHASES.some((phase) => config.hooks?.[phase]?.length)) features.push('hooks');
      if (config.backup) features.push('backup');
      if (features.length > 0) {
        printTableRow('Features:', features.join(', '));
      }
      const unusedRegistry = registryWithoutCredentials(config);
      if (unusedRegistry) printWarning(unusedRegistry);

      // expanded against the unrendered config: `with:` values that are templates pass through
      // verbatim, which is enough to catch an unknown plugin, a missing input, a bad manifest or
      // two uploads writing one path
      if (config.plugins?.length) {
        try {
          const expansion = await Plugin.expandPlugins(config.plugins, {
            projectRoot,
            projectContext: { env: options.env ?? '', version: '', project_name: config.project_name, config },
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

  printSection(flat ? 'servers (from dockflow.yml)' : 'servers.yml');

  if (!flat && !existsSync(serversPath)) {
    printError('servers.yml not found');
    hasErrors = true;
  } else {
    const servers = loadServersConfig({ validate: true, silent: false });
    if (!servers) {
      // loadServersConfig already printed the validation errors
      hasErrors = true;
    } else {
      // environments are the tags of the servers
      const tagMap: Record<string, { managers: number; workers: number }> = {};
      for (const server of Object.values(servers.servers)) {
        for (const tag of server.tags) {
          if (!tagMap[tag]) tagMap[tag] = { managers: 0, workers: 0 };
          if ((server.role ?? 'manager') === 'manager') {
            tagMap[tag].managers++;
          } else {
            tagMap[tag].workers++;
          }
        }
      }
      const envNames = Object.keys(tagMap);
      printSuccess(`${flat ? 'dockflow.yml' : 'servers.yml'} — OK (${envNames.length} environment(s): ${envNames.join(', ')})`);
      // flat layout: dockflow.yml was already checked above (the root schema covers servers)
      if (!flat) {
        warnUnknownKeys(serversPath, findUnknownServersKeys);
      }

      if (options.env) {
        if (!tagMap[options.env]) {
          printError(`Environment "${options.env}" not found in servers.yml`);
          printWarning(`Available: ${envNames.join(', ')}`);
          hasErrors = true;
        } else {
          const { managers, workers } = tagMap[options.env];
          printTableRow(`${options.env}:`, `${managers} manager(s), ${workers} worker(s)`);
        }
      }
    }
  }

  printBlank();

  printSection('docker-compose');

  const composePath = getComposePath();
  if (!composePath) {
    printWarning('No docker-compose.yml / docker-compose.yaml found in .dockflow/docker/');
    printWarning('This is fine for accessories-only projects.');
  } else {
    printSuccess(`docker-compose found: ${composePath.replace(projectRoot, '.')}`);
  }

  // shell-style placeholders resolve to an empty string at deploy time, which is silent in
  // production: validate treats them as an error rather than a warning
  const declaredKeys = collectDeclaredEnvKeys();
  for (const stackFile of [composePath, getAccessoriesPath()]) {
    if (!stackFile) continue;
    const placeholders = findShellPlaceholders(readFileSync(stackFile, 'utf-8'), declaredKeys);
    for (const line of describeShellPlaceholders(placeholders)) {
      printError(`${relative(projectRoot, stackFile).split(sep).join('/')} ${line}`);
    }
    if (placeholders.length > 0) hasErrors = true;
  }

  const accessoriesPath = getAccessoriesPath();
  if (accessoriesPath) {
    for (const name of findAccessoriesWithBuild(readFileSync(accessoriesPath, 'utf-8'))) {
      printWarning(`accessories.yml: ${name} has a build section, which Dockflow never builds; it deploys the image as it is`);
    }
  }

  printBlank();

  if (hasErrors) {
    throw new ValidationError(
      'Configuration validation failed — fix the errors above before deploying.',
    );
  }

  printSuccess('All configuration files are valid.');
  printBlank();
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate [env]')
    .description('Validate .dockflow configuration files without connecting to any server')
    .helpGroup('Setup')
    .option('--env <env>', 'Also check that a specific environment exists in servers.yml')
    .action(withErrorHandler(async (envArg: string | undefined, options: ValidateOptions) => {
      await runValidate({ ...options, env: resolveValidateEnv(envArg, options.env) });
    }));
}
