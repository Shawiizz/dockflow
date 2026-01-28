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
  getProjectRoot, 
  loadConfigWithErrors, 
  loadServersConfigWithErrors 
} from '../utils/config';
import { getAvailableEnvironments, getServerNamesForEnvironment } from '../utils/servers';
import { printSection, printError, printSuccess, printWarning, printDim, printSeparator, colors } from '../utils/output';
import { 
  validateConfig as validateConfigSchema, 
  validateServersConfig as validateServersSchema,
  printValidationReport,
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
  const root = getProjectRoot();
  const deploymentDir = join(root, '.dockflow');

  // Check .dockflow directory
  if (!existsSync(deploymentDir)) {
    errors.push('.dockflow directory not found');
    return { valid: false, errors, warnings };
  }

  // Check and validate config.yml with schema
  const configPath = join(deploymentDir, 'config.yml');
  if (!existsSync(configPath)) {
    errors.push('config.yml not found');
  } else {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = parseYaml(content);
      const result = validateConfigSchema(parsed);
      
      if (!result.success) {
        schemaErrors.config = result.error;
        errors.push(`config.yml has ${result.error.length} validation error(s)`);
      } else {
        const config = result.data;
        // Additional semantic warnings
        if (config.health_checks?.enabled && (!config.health_checks.endpoints || config.health_checks.endpoints.length === 0)) {
          warnings.push('Health checks enabled but no endpoints defined');
        }
      }
    } catch (e) {
      errors.push(`config.yml parse error: ${e}`);
    }
  }

  // Check and validate servers.yml with schema
  const serversPath = join(deploymentDir, 'servers.yml');
  if (!existsSync(serversPath)) {
    errors.push('servers.yml not found');
  } else {
    try {
      const content = readFileSync(serversPath, 'utf-8');
      const parsed = parseYaml(content);
      const result = validateServersSchema(parsed);
      
      if (!result.success) {
        schemaErrors.servers = result.error;
        errors.push(`servers.yml has ${result.error.length} validation error(s)`);
      }
    } catch (e) {
      errors.push(`servers.yml parse error: ${e}`);
    }
  }

  // Check docker-compose.yml
  const composePath = join(deploymentDir, 'docker', 'docker-compose.yml');
  const composeYmlPath = join(deploymentDir, 'docker', 'docker-compose.yaml');
  if (!existsSync(composePath) && !existsSync(composeYmlPath)) {
    warnings.push('docker-compose.yml not found in .dockflow/docker/ (required for deployment)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    schemaErrors
  };
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Display and validate project configuration');

  // config show (default)
  configCmd
    .command('show', { isDefault: true })
    .description('Display current configuration')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const servers = loadServersConfig();
      const envs = getAvailableEnvironments();

      if (options.json) {
        console.log(JSON.stringify({
          config,
          servers,
          environments: envs
        }, null, 2));
        return;
      }

      console.log('');
      
      // Project info
      if (config) {
        printSection('Project Configuration');
        console.log('');
        console.log(`  ${colors.dim('Project:')}      ${colors.info(config.project_name)}`);
        
        if (config.registry) {
          const regType = config.registry.type || 'local';
          const regUrl = config.registry.url || '(local registry)';
          console.log(`  ${colors.dim('Registry:')}     ${regType} ${colors.dim(`(${regUrl})`)}`);
        } else {
          console.log(`  ${colors.dim('Registry:')}     ${colors.warning('not configured')}`);
        }

        if (config.options) {
          const opts = [];
          if (config.options.remote_build) opts.push('remote-build');
          if (config.options.image_auto_tag !== false) opts.push('image-auto-tag');
          if (opts.length > 0) {
            console.log(`  ${colors.dim('Options:')}      ${opts.join(', ')}`);
          }
        }

        if (config.health_checks?.enabled) {
          const count = config.health_checks.endpoints?.length || 0;
          console.log(`  ${colors.dim('Health:')}       ${colors.success('enabled')} ${colors.dim(`(${count} endpoint${count !== 1 ? 's' : ''})`)}`);
        }

        if (config.hooks?.enabled !== false) {
          const hooks = [];
          if (config.hooks?.['pre-build']) hooks.push('pre-build');
          if (config.hooks?.['post-build']) hooks.push('post-build');
          if (config.hooks?.['pre-deploy']) hooks.push('pre-deploy');
          if (config.hooks?.['post-deploy']) hooks.push('post-deploy');
          if (hooks.length > 0) {
            console.log(`  ${colors.dim('Hooks:')}        ${hooks.join(', ')}`);
          }
        }
      } else {
        printError('No config.yml found');
        printDim('Run `dockflow init` to create project structure');
        return;
      }

      // Environments
      console.log('');
      printSection('Environments');
      console.log('');
      
      if (envs.length === 0) {
        console.log(colors.warning('  No environments configured'));
      } else {
        for (const env of envs) {
          const serverNames = getServerNamesForEnvironment(env);
          const envColor = env === 'production' ? colors.error : env === 'staging' ? colors.warning : colors.primary;
          console.log(`  ${envColor('●')} ${env.padEnd(15)} ${colors.dim(`${serverNames.length} server(s)`)}`);
        }
      }

      // Files
      console.log('');
      printSection('Configuration Files');
      console.log('');
      
      const root = getProjectRoot();
      const files = [
        { name: 'config.yml', path: join(root, '.dockflow', 'config.yml') },
        { name: 'servers.yml', path: join(root, '.dockflow', 'servers.yml') },
        { name: 'docker-compose.yml', path: join(root, '.dockflow', 'docker', 'docker-compose.yml') },
        { name: 'accessories.yml', path: join(root, '.dockflow', 'accessories.yml') },
      ];

      for (const file of files) {
        const exists = existsSync(file.path);
        const icon = exists ? colors.success('✓') : colors.dim('○');
        const name = exists ? file.name : colors.dim(file.name);
        console.log(`  ${icon} ${name}`);
      }

      console.log('');
    });

  // config validate
  configCmd
    .command('validate')
    .alias('check')
    .description('Validate configuration files against schemas')
    .option('--verbose', 'Show detailed validation output')
    .option('--json', 'Output validation results as JSON')
    .action(async (options: { verbose?: boolean; json?: boolean }) => {
      const result = validateConfigFiles();

      if (options.json) {
        console.log(JSON.stringify({
          valid: result.valid,
          errors: result.errors,
          warnings: result.warnings,
          schemaErrors: result.schemaErrors
        }, null, 2));
        process.exit(result.valid ? 0 : 1);
        return;
      }

      console.log('');
      printSection('Configuration Validation');
      console.log('');

      // Show schema errors in detail
      if (result.schemaErrors?.config && result.schemaErrors.config.length > 0) {
        console.log(colors.error('  config.yml schema errors:'));
        console.log('');
        for (const error of result.schemaErrors.config) {
          console.log(`    ${colors.error('✗')} ${colors.warning(error.path)}`);
          console.log(`      ${error.message}`);
          const suggestion = getSuggestion(error);
          if (suggestion && options.verbose) {
            console.log(colors.dim(`      💡 ${suggestion}`));
          }
        }
        console.log('');
      }

      if (result.schemaErrors?.servers && result.schemaErrors.servers.length > 0) {
        console.log(colors.error('  servers.yml schema errors:'));
        console.log('');
        for (const error of result.schemaErrors.servers) {
          console.log(`    ${colors.error('✗')} ${colors.warning(error.path)}`);
          console.log(`      ${error.message}`);
          const suggestion = getSuggestion(error);
          if (suggestion && options.verbose) {
            console.log(colors.dim(`      💡 ${suggestion}`));
          }
        }
        console.log('');
      }

      // Show general errors (file not found, etc.)
      const generalErrors = result.errors.filter(e => 
        !e.includes('validation error(s)')
      );
      if (generalErrors.length > 0) {
        console.log(colors.error('  General errors:'));
        for (const error of generalErrors) {
          console.log(`    ${colors.error('✗')} ${error}`);
        }
        console.log('');
      }

      if (result.warnings.length > 0) {
        console.log(colors.warning('  Warnings:'));
        for (const warning of result.warnings) {
          console.log(`    ${colors.warning('⚠')} ${warning}`);
        }
        console.log('');
      }

      // Summary
      printSeparator(50);
      console.log('');

      if (result.valid) {
        if (result.warnings.length === 0) {
          console.log(colors.success('  ✓ All configuration files are valid!'));
        } else {
          console.log(colors.warning('  ⚠ Configuration valid with warnings'));
        }
      } else {
        console.log(colors.error('  ✗ Configuration has validation errors'));
        console.log('');
        printDim('  Fix the errors above and run again.');
        printDim('  Documentation: https://dockflow.shawiizz.dev/configuration');
      }
      console.log('');

      process.exit(result.valid ? 0 : 1);
    });

  // config path
  configCmd
    .command('path')
    .description('Show configuration directory path')
    .action(() => {
      const root = getProjectRoot();
      console.log(join(root, '.dockflow'));
    });
}
