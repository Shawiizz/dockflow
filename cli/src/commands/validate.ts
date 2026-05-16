/**
 * Validate command
 *
 * Validates all .dockflow configuration files without connecting to any server.
 * Checks:
 *   - config.yml   schema + Zod validation
 *   - servers.yml  schema + Zod validation
 *   - docker-compose file existence
 *
 * Exit codes:
 *   0 — all checks passed
 *   60 — one or more validation errors (VALIDATION_FAILED)
 */

import type { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  loadConfig,
  loadServersConfig,
  getComposePath,
  getLayout,
} from '../utils/config';
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
import { ValidationError, withErrorHandler } from '../utils/errors';

interface ValidateOptions {
  env?: string;
}

/**
 * Run all validation checks and return whether everything passed.
 */
async function runValidate(options: ValidateOptions): Promise<void> {
  loadSecrets();

  const layout = getLayout();
  const { type: layoutType, root: projectRoot, configPath, serversPath } = layout;
  const flat = layoutType === 'flat';

  printSection('Validating Dockflow configuration');
  printBlank();

  let hasErrors = false;

  // ── 1. Project directory ────────────────────────────────────────────────────

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

  // ── 2. config / dockflow.yml ────────────────────────────────────────────────

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

      const features: string[] = [];
      if (config.registry) features.push(`registry (${config.registry.type})`);
      if (config.proxy?.enabled) features.push('proxy (Traefik)');
      if (config.notifications?.webhooks?.length) {
        features.push(`notifications (${config.notifications.webhooks.length} webhook(s))`);
      }
      if (config.hooks && (
        config.hooks['pre-build'] ||
        config.hooks['post-build'] ||
        config.hooks['pre-deploy'] ||
        config.hooks['post-deploy']
      )) features.push('hooks');
      if (config.backup) features.push('backup');
      if (features.length > 0) {
        printTableRow('Features:', features.join(', '));
      }
    }
  }

  printBlank();

  // ── 3. servers ──────────────────────────────────────────────────────────────

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
      // Derive environments from server tags
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

      // If --env specified, check that env exists
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

  // ── 4. Docker Compose file ──────────────────────────────────────────────────

  printSection('docker-compose');

  const composePath = getComposePath();
  if (!composePath) {
    printWarning('No docker-compose.yml / docker-compose.yaml found in .dockflow/docker/');
    printWarning('This is fine for accessories-only projects.');
  } else {
    printSuccess(`docker-compose found: ${composePath.replace(projectRoot, '.')}`);
  }

  printBlank();

  // ── 5. Result ───────────────────────────────────────────────────────────────

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
    .command('validate')
    .description('Validate .dockflow configuration files without connecting to any server')
    .helpGroup('Setup')
    .option('--env <env>', 'Also check that a specific environment exists in servers.yml')
    .action(withErrorHandler(async (options: ValidateOptions) => {
      await runValidate(options);
    }));
}
