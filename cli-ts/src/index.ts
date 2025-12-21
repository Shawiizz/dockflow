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
import { registerAccessoriesCommands } from './commands/accessories';
import { registerLockCommands } from './commands/lock';
import { registerListCommands } from './commands/list';

const program = new Command();

program
  .name('dockflow')
  .description('A deployment framework for Docker applications, leveraging Swarm for orchestration')
  .version(version, '-v, --version', 'Show version information')
  .option('--no-color', 'Disable colored output');

// Register all commands
registerAppCommands(program);
registerAccessoriesCommands(program);
registerLockCommands(program);
registerListCommands(program);
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
  console.log('  dockflow init                   Initialize project structure');
  console.log('  dockflow deploy <env>           Deploy to environment');
  console.log('');
  console.log(chalk.yellow('Info & Listing:'));
  console.log('  dockflow list env               List available environments');
  console.log('  dockflow list svc <env>         List services (-t for tasks)');
  console.log('  dockflow list images <env>      List Docker images');
  console.log('  dockflow version <env>          Show deployed version');
  console.log('  dockflow logs <env>             View service logs');
  console.log('  dockflow audit <env>            Show deployment history');
  console.log('');
  console.log(chalk.yellow('Operations:'));
  console.log('  dockflow bash <env> <svc>       Open shell in container');
  console.log('  dockflow exec <env> <svc> <cmd> Execute command in container');
  console.log('  dockflow scale <env> <svc> <n>  Scale service replicas');
  console.log('  dockflow rollback <env>         Rollback to previous version');
  console.log('  dockflow restart <env>          Restart services');
  console.log('');
  console.log(chalk.yellow('Deployment locks:'));
  console.log('  dockflow lock status <env>      Check lock status');
  console.log('  dockflow lock acquire <env>     Block deployments');
  console.log('  dockflow lock release <env>     Allow deployments');
  console.log('');
  console.log(chalk.yellow('Accessories (databases, caches...):'));
  console.log('  dockflow accessories <cmd>      Manage stateful services');
});

// Error handling
program.showHelpAfterError('(add --help for additional information)');

// Parse arguments
program.parse(process.argv);
