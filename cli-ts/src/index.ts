#!/usr/bin/env bun

/**
 * Dockflow CLI - Main entry point
 * A deployment framework for Docker applications, leveraging Swarm for orchestration
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { version, name } from '../package.json';

// Commands
import { registerAppCommands } from './commands/app';
import { registerDeployCommand } from './commands/deploy';
import { registerSetupCommand } from './commands/setup';
import { registerInitCommand } from './commands/init';

const program = new Command();

program
  .name('dockflow')
  .description('A deployment framework for Docker applications, leveraging Swarm for orchestration')
  .version(version, '-v, --version', 'Show version information')
  .option('--no-color', 'Disable colored output');

// Register all commands
registerAppCommands(program);
registerDeployCommand(program);
registerSetupCommand(program);
registerInitCommand(program);

// Default action (no command) - show help or interactive mode
program.action(async () => {
  console.log(chalk.green('========================================================'));
  console.log(chalk.green(`   Dockflow CLI v${version}`));
  console.log(chalk.green('========================================================'));
  console.log('');
  console.log(chalk.cyan('Run with --help to see available commands'));
  console.log('');
  console.log(chalk.yellow('Quick start:'));
  console.log('  dockflow init              Initialize project structure');
  console.log('  dockflow deploy <env>      Deploy to environment');
  console.log('  dockflow logs <env>        View service logs');
  console.log('  dockflow details <env>     Show stack details');
});

// Error handling
program.showHelpAfterError('(add --help for additional information)');

// Parse arguments
program.parse(process.argv);
