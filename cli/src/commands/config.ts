/**
 * Config command - Display and validate project configuration
 */

import type { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  loadConfig,
  loadServersConfig,
  getLayout,
} from '../utils/config';
import { getAvailableEnvironments, getServerNamesForEnvironment } from '../utils/servers';
import { printSection, printError, printSuccess, printWarning, printDim, printSeparator, printBlank, printJSON, printRaw, colors } from '../utils/output';
import { withErrorHandler, ValidationError } from '../utils/errors';
import {
  validateConfig as validateConfigSchema,
  validateServersConfig as validateServersSchema,
  getSuggestion,
  type ValidationIssue
} from '../schemas';

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schemaErrors?: {
    config?: ValidationIssue[];
    servers?: ValidationIssue[];
  };
}

/**
 * Validate configuration files using Zod schemas
 */
function validateConfigFiles(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const schemaErrors: { config?: ValidationIssue[]; servers?: ValidationIssue[] } = {};
  const layout = getLayout();
  const { type: flat, root, configPath, serversPath } = layout;

  if (flat === 'flat') {
    try {
      const parsed = parseYaml(readFileSync(configPath, 'utf-8'));

      const configResult = validateConfigSchema(parsed);
      if (!configResult.success) {
        schemaErrors.config = configResult.error;
        errors.push(`dockflow.yml has ${configResult.error.length} config validation error(s)`);
      } else {
        const config = configResult.data;
        if (config.health_checks?.enabled && (!config.health_checks.endpoints || config.health_checks.endpoints.length === 0)) {
          warnings.push('Health checks enabled but no endpoints defined');
        }
      }

      const serversResult = validateServersSchema(parsed);
      if (!serversResult.success) {
        schemaErrors.servers = serversResult.error;
        errors.push(`dockflow.yml has ${serversResult.error.length} servers validation error(s)`);
      }
    } catch (e) {
      errors.push(`dockflow.yml parse error: ${e}`);
    }
  } else {
    if (!existsSync(join(root, '.dockflow'))) {
      errors.push('.dockflow directory not found');
      return { valid: false, errors, warnings };
    }

    if (!existsSync(configPath)) {
      errors.push('config.yml not found');
    } else {
      try {
        const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
        const result = validateConfigSchema(parsed);
        if (!result.success) {
          schemaErrors.config = result.error;
          errors.push(`config.yml has ${result.error.length} validation error(s)`);
        } else {
          const config = result.data;
          if (config.health_checks?.enabled && (!config.health_checks.endpoints || config.health_checks.endpoints.length === 0)) {
            warnings.push('Health checks enabled but no endpoints defined');
          }
        }
      } catch (e) {
        errors.push(`config.yml parse error: ${e}`);
      }
    }

    if (!existsSync(serversPath)) {
      errors.push('servers.yml not found');
    } else {
      try {
        const parsed = parseYaml(readFileSync(serversPath, 'utf-8'));
        const result = validateServersSchema(parsed);
        if (!result.success) {
          schemaErrors.servers = result.error;
          errors.push(`servers.yml has ${result.error.length} validation error(s)`);
        }
      } catch (e) {
        errors.push(`servers.yml parse error: ${e}`);
      }
    }
  }

  if (!layout.composePath) {
    warnings.push('docker-compose.yml not found (required for deployment)');
  }

  return { valid: errors.length === 0, errors, warnings, schemaErrors };
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Display and validate project configuration')
    .helpGroup('Other');

  // config show (default)
  configCmd
    .command('show', { isDefault: true })
    .description('Display current configuration')
    .option('-j, --json', 'Output as JSON')
    .action(withErrorHandler(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const servers = loadServersConfig();
      const envs = getAvailableEnvironments();

      if (options.json) {
        printJSON({
          config,
          servers,
          environments: envs
        });
        return;
      }

      printBlank();
      
      // Project info
      if (config) {
        printSection('Project Configuration');
        printBlank();
        printRaw(`  ${colors.dim('Project:')}      ${colors.info(config.project_name)}`);

        if (config.registry) {
          const regType = config.registry.type || 'local';
          const regUrl = config.registry.url || '(local registry)';
          printRaw(`  ${colors.dim('Registry:')}     ${regType} ${colors.dim(`(${regUrl})`)}`);
        } else {
          printRaw(`  ${colors.dim('Registry:')}     ${colors.warning('not configured')}`);
        }

        if (config.options) {
          const opts = [];
          if (config.options.remote_build) opts.push('remote-build');
          if (config.options.image_auto_tag !== false) opts.push('image-auto-tag');
          if (opts.length > 0) {
            printRaw(`  ${colors.dim('Options:')}      ${opts.join(', ')}`);
          }
        }

        if (config.health_checks?.enabled) {
          const count = config.health_checks.endpoints?.length || 0;
          printRaw(`  ${colors.dim('Health:')}       ${colors.success('enabled')} ${colors.dim(`(${count} endpoint${count !== 1 ? 's' : ''})`)}`);
        }

        if (config.hooks?.enabled !== false) {
          const hooks = [];
          if (config.hooks?.['pre-build']) hooks.push('pre-build');
          if (config.hooks?.['post-build']) hooks.push('post-build');
          if (config.hooks?.['pre-deploy']) hooks.push('pre-deploy');
          if (config.hooks?.['post-deploy']) hooks.push('post-deploy');
          if (hooks.length > 0) {
            printRaw(`  ${colors.dim('Hooks:')}        ${hooks.join(', ')}`);
          }
        }
      } else {
        printError('No config.yml found');
        printDim('Run `dockflow init` to create project structure');
        return;
      }

      // Environments
      printBlank();
      printSection('Environments');
      printBlank();
      
      if (envs.length === 0) {
        printWarning('  No environments configured');
      } else {
        for (const env of envs) {
          const serverNames = getServerNamesForEnvironment(env);
          const envColor = env === 'production' ? colors.error : env === 'staging' ? colors.warning : colors.primary;
          printRaw(`  ${envColor('●')} ${env.padEnd(15)} ${colors.dim(`${serverNames.length} server(s)`)}`);
        }
      }

      // Files
      printBlank();
      printSection('Configuration Files');
      printBlank();
      
      const { type: layoutType, root, configPath, serversPath, composePath, accessoriesPath } = getLayout();
      const files = layoutType === 'flat' ? [
        { name: 'dockflow.yml', path: configPath },
        { name: 'docker-compose.yml', path: composePath ?? join(root, 'docker-compose.yml') },
        { name: 'accessories.yml', path: accessoriesPath ?? join(root, 'accessories.yml') },
      ] : [
        { name: 'config.yml', path: configPath },
        { name: 'servers.yml', path: serversPath },
        { name: 'docker-compose.yml', path: composePath ?? join(root, '.dockflow', 'docker', 'docker-compose.yml') },
        { name: 'accessories.yml', path: accessoriesPath ?? join(root, '.dockflow', 'docker', 'accessories.yml') },
      ];

      for (const file of files) {
        const exists = existsSync(file.path);
        const icon = exists ? colors.success('✓') : colors.dim('○');
        const name = exists ? file.name : colors.dim(file.name);
        printRaw(`  ${icon} ${name}`);
      }

      printBlank();
    }));

  // config validate
  configCmd
    .command('validate')
    .alias('check')
    .description('Validate configuration files against schemas')
    .option('--verbose', 'Show detailed validation output')
    .option('-j, --json', 'Output validation results as JSON')
    .action(withErrorHandler(async (options: { verbose?: boolean; json?: boolean }) => {
      const result = validateConfigFiles();

      if (options.json) {
        printJSON({
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          schemaErrors: result.schemaErrors
        });
        if (!result.valid) {
          throw new ValidationError('Configuration validation failed');
        }
        return;
      }

      printBlank();
      printSection('Configuration Validation');
      printBlank();

      const { type: layoutType } = getLayout();

      // Show schema errors in detail
      if (result.schemaErrors?.config && result.schemaErrors.config.length > 0) {
        printError(`  ${layoutType === 'flat' ? 'dockflow.yml' : 'config.yml'} schema errors:`);
        printBlank();
        for (const error of result.schemaErrors.config) {
          printRaw(`    ${colors.error('✗')} ${colors.warning(error.path)}`);
          printRaw(`      ${error.message}`);
          const suggestion = getSuggestion(error);
          if (suggestion && options.verbose) {
            printDim(`      💡 ${suggestion}`);
          }
        }
        printBlank();
      }

      if (result.schemaErrors?.servers && result.schemaErrors.servers.length > 0) {
        printError(`  ${layoutType === 'flat' ? 'dockflow.yml' : 'servers.yml'} servers schema errors:`);
        printBlank();
        for (const error of result.schemaErrors.servers) {
          printRaw(`    ${colors.error('✗')} ${colors.warning(error.path)}`);
          printRaw(`      ${error.message}`);
          const suggestion = getSuggestion(error);
          if (suggestion && options.verbose) {
            printDim(`      💡 ${suggestion}`);
          }
        }
        printBlank();
      }

      // Show general errors (file not found, etc.)
      const generalErrors = result.errors.filter(e => 
        !e.includes('validation error(s)')
      );
      if (generalErrors.length > 0) {
        printError('  General errors:');
        for (const error of generalErrors) {
          printRaw(`    ${colors.error('✗')} ${error}`);
        }
        printBlank();
      }

      if (result.warnings.length > 0) {
        printWarning('  Warnings:');
        for (const warning of result.warnings) {
          printRaw(`    ${colors.warning('⚠')} ${warning}`);
        }
        printBlank();
      }

      // Summary
      printSeparator(50);
      printBlank();

      if (result.valid) {
        if (result.warnings.length === 0) {
          printSuccess('All configuration files are valid!');
        } else {
          printWarning('Configuration valid with warnings');
        }
      } else {
        printError('Configuration has validation errors');
        printBlank();
        printDim('  Fix the errors above and run again.');
        printDim('  Documentation: https://dockflow.shawiizz.dev/configuration');
      }
      printBlank();

      if (!result.valid) {
        throw new ValidationError('Configuration has validation errors');
      }
    }));

  // config path
  configCmd
    .command('path')
    .description('Show configuration directory path')
    .action(withErrorHandler(async () => {
      const { type, root, configPath } = getLayout();
      printRaw(type === 'flat' ? configPath : join(root, '.dockflow'));
    }));
}
