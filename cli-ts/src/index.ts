#!/usr/bin/env bun

/**
 * Dockflow CLI - Main entry point
 * A deployment framework for Docker applications, leveraging Swarm for orchestration
 */

import { Command } from 'commander';
import { version, name } from '../package.json';
import { setVerbose, printSuccess, printBlank, printInfo, printWarning, printRaw } from './utils/output';

// Commands
import { registerAppCommands } from './commands/app';
import { registerDeployCommand } from './commands/deploy';
import { registerBuildCommand } from './commands/build';
import { registerSetupCommand } from './commands/setup';
import { registerInitCommand } from './commands/init';
import { registerAccessoriesCommands } from './commands/accessories';
import { registerLockCommands } from './commands/lock';
import { registerListCommands } from './commands/list';
import { registerConfigCommand } from './commands/config';
import { registerUICommand } from './commands/ui';

const program = new Command();

program
  .name('dockflow')
  .description('A deployment framework for Docker applications, leveraging Swarm for orchestration')
  .version(version, '-v, --version', 'Show version information')
  .option('--no-color', 'Disable colored output')
  .option('--verbose', 'Enable verbose/debug output')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.verbose) {
      setVerbose(true);
    }
  });

// Register all commands
registerAppCommands(program);
registerAccessoriesCommands(program);
registerLockCommands(program);
registerListCommands(program);
registerConfigCommand(program);
registerDeployCommand(program);
registerBuildCommand(program);
registerSetupCommand(program);
registerInitCommand(program);
registerUICommand(program);

// Default action (no command) - show help or interactive mode
program.action(async () => {
  printSuccess('========================================================');
  printSuccess(`   Dockflow CLI v${version}`);
  printSuccess('========================================================');
  printBlank();
  printInfo('Run with --help to see available commands');
  printBlank();
  printWarning('Quick start:');
  printRaw('  dockflow init                   Initialize project structure');
  printRaw('  dockflow build                  Build Docker images locally');
  printRaw('  dockflow deploy <env>           Deploy to environment');
  printBlank();
  printWarning('Info & Listing:');
  printRaw('  dockflow list env               List available environments');
  printRaw('  dockflow list svc <env>         List services (-t for tasks)');
  printRaw('  dockflow list images <env>      List Docker images');
  printRaw('  dockflow version <env>          Show deployed version');
  printRaw('  dockflow logs <env>             View service logs');
  printRaw('  dockflow audit <env>            Show deployment history');
  printBlank();
  printWarning('Operations:');
  printRaw('  dockflow bash <env> <svc>       Open shell in container');
  printRaw('  dockflow exec <env> <svc> <cmd> Execute command in container');
  printRaw('  dockflow scale <env> <svc> <n>  Scale service replicas');
  printRaw('  dockflow rollback <env>         Rollback to previous version');
  printRaw('  dockflow restart <env>          Restart services');
  printBlank();
  printWarning('Deployment locks:');
  printRaw('  dockflow lock status <env>      Check lock status');
  printRaw('  dockflow lock acquire <env>     Block deployments');
  printRaw('  dockflow lock release <env>     Allow deployments');
  printBlank();
  printWarning('Accessories (databases, caches...):');
  printRaw('  dockflow accessories <cmd>      Manage stateful services');
});

// Error handling
program.showHelpAfterError('(add --help for additional information)');

// Parse arguments
program.parse(process.argv);
