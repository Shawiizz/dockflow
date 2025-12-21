/**
 * Config command - Display and validate project configuration
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, loadServersConfig, getProjectRoot } from '../utils/config';
import { getAvailableEnvironments, getServerNamesForEnvironment } from '../utils/servers';
import { printSection, printError, printSuccess, printWarning } from '../utils/output';

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = getProjectRoot();
  const deploymentDir = join(root, '.deployment');

  // Check .deployment directory
  if (!existsSync(deploymentDir)) {
    errors.push('.deployment directory not found');
    return { valid: false, errors, warnings };
  }

  // Check config.yml
  const configPath = join(deploymentDir, 'config.yml');
  if (!existsSync(configPath)) {
    errors.push('config.yml not found');
  } else {
    const config = loadConfig();
    if (!config) {
      errors.push('config.yml is invalid or empty');
    } else {
      if (!config.project_name) {
        errors.push('project_name is required in config.yml');
      }
      if (config.registry?.type && !['local', 'dockerhub', 'ghcr', 'gitlab', 'custom'].includes(config.registry.type)) {
        warnings.push(`Unknown registry type: ${config.registry.type}`);
      }
      if (config.health_checks?.enabled && (!config.health_checks.endpoints || config.health_checks.endpoints.length === 0)) {
        warnings.push('Health checks enabled but no endpoints defined');
      }
    }
  }

  // Check servers.yml
  const serversPath = join(deploymentDir, 'servers.yml');
  if (!existsSync(serversPath)) {
    errors.push('servers.yml not found');
  } else {
    const servers = loadServersConfig();
    if (!servers) {
      errors.push('servers.yml is invalid or empty');
    } else {
      if (!servers.servers || Object.keys(servers.servers).length === 0) {
        errors.push('No servers defined in servers.yml');
      }
      
      // Check each environment has at least one manager
      const envs = getAvailableEnvironments();
      for (const env of envs) {
        const serverNames = getServerNamesForEnvironment(env);
        if (serverNames.length === 0) {
          warnings.push(`Environment "${env}" has no servers`);
        }
      }
    }
  }

  // Check docker-compose.yml
  const composePath = join(deploymentDir, 'docker', 'docker-compose.yml');
  const composeYmlPath = join(deploymentDir, 'docker', 'docker-compose.yaml');
  if (!existsSync(composePath) && !existsSync(composeYmlPath)) {
    warnings.push('docker-compose.yml not found in .deployment/docker/ (required for deployment)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
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
        console.log(`  ${chalk.gray('Project:')}      ${chalk.cyan(config.project_name)}`);
        
        if (config.registry) {
          const regType = config.registry.type || 'local';
          const regUrl = config.registry.url || '(local registry)';
          console.log(`  ${chalk.gray('Registry:')}     ${regType} ${chalk.gray(`(${regUrl})`)}`);
        } else {
          console.log(`  ${chalk.gray('Registry:')}     ${chalk.yellow('not configured')}`);
        }

        if (config.options) {
          const opts = [];
          if (config.options.remote_build) opts.push('remote-build');
          if (config.options.environmentize) opts.push('environmentize');
          if (opts.length > 0) {
            console.log(`  ${chalk.gray('Options:')}      ${opts.join(', ')}`);
          }
        }

        if (config.health_checks?.enabled) {
          const count = config.health_checks.endpoints?.length || 0;
          console.log(`  ${chalk.gray('Health:')}       ${chalk.green('enabled')} ${chalk.gray(`(${count} endpoint${count !== 1 ? 's' : ''})`)}`);
        }

        if (config.hooks?.enabled !== false) {
          const hooks = [];
          if (config.hooks?.['pre-build']) hooks.push('pre-build');
          if (config.hooks?.['post-build']) hooks.push('post-build');
          if (config.hooks?.['pre-deploy']) hooks.push('pre-deploy');
          if (config.hooks?.['post-deploy']) hooks.push('post-deploy');
          if (hooks.length > 0) {
            console.log(`  ${chalk.gray('Hooks:')}        ${hooks.join(', ')}`);
          }
        }
      } else {
        printError('No config.yml found');
        console.log(chalk.gray('Run `dockflow init` to create project structure'));
        return;
      }

      // Environments
      console.log('');
      printSection('Environments');
      console.log('');
      
      if (envs.length === 0) {
        console.log(chalk.yellow('  No environments configured'));
      } else {
        for (const env of envs) {
          const serverNames = getServerNamesForEnvironment(env);
          const envColor = env === 'production' ? chalk.red : env === 'staging' ? chalk.yellow : chalk.blue;
          console.log(`  ${envColor('●')} ${env.padEnd(15)} ${chalk.gray(`${serverNames.length} server(s)`)}`);
        }
      }

      // Files
      console.log('');
      printSection('Configuration Files');
      console.log('');
      
      const root = getProjectRoot();
      const files = [
        { name: 'config.yml', path: join(root, '.deployment', 'config.yml') },
        { name: 'servers.yml', path: join(root, '.deployment', 'servers.yml') },
        { name: 'docker-compose.yml', path: join(root, '.deployment', 'docker', 'docker-compose.yml') },
        { name: 'accessories.yml', path: join(root, '.deployment', 'accessories.yml') },
      ];

      for (const file of files) {
        const exists = existsSync(file.path);
        const icon = exists ? chalk.green('✓') : chalk.gray('○');
        const name = exists ? chalk.white(file.name) : chalk.gray(file.name);
        console.log(`  ${icon} ${name}`);
      }

      console.log('');
    });

  // config validate
  configCmd
    .command('validate')
    .alias('check')
    .description('Validate configuration files')
    .action(async () => {
      console.log('');
      printSection('Validating Configuration');
      console.log('');

      const result = validateConfig();

      if (result.errors.length > 0) {
        console.log(chalk.red('Errors:'));
        for (const error of result.errors) {
          console.log(`  ${chalk.red('✗')} ${error}`);
        }
        console.log('');
      }

      if (result.warnings.length > 0) {
        console.log(chalk.yellow('Warnings:'));
        for (const warning of result.warnings) {
          console.log(`  ${chalk.yellow('⚠')} ${warning}`);
        }
        console.log('');
      }

      if (result.valid) {
        if (result.warnings.length === 0) {
          printSuccess('Configuration is valid');
        } else {
          printWarning('Configuration is valid with warnings');
        }
      } else {
        printError('Configuration has errors');
        process.exit(1);
      }
      console.log('');
    });

  // config path
  configCmd
    .command('path')
    .description('Show configuration directory path')
    .action(() => {
      const root = getProjectRoot();
      console.log(join(root, '.deployment'));
    });
}
