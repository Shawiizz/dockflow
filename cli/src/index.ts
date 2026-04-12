#!/usr/bin/env bun

/**
 * Dockflow CLI - Main entry point
 * A deployment framework for Docker applications, leveraging Swarm for orchestration
 */

import { Command } from 'commander';
import { version } from '../package.json';
import { setVerbose, printSuccess, printBlank, printWarning, printRaw, colors } from './utils/output';

// Commands
import { registerAppCommands } from './commands/app/index';
import { registerDeployCommand } from './commands/deploy';
import { registerBuildCommand } from './commands/build';
import { registerSetupCommand } from './commands/setup';
import { registerInitCommand } from './commands/init';
import { registerAccessoriesCommands } from './commands/accessories';
import { registerBackupCommands } from './commands/backup';
import { registerLockCommands } from './commands/lock';
import { registerListCommands } from './commands/list';
import { registerConfigCommand } from './commands/config';
import { registerUICommand } from './commands/ui';
import { registerValidateCommand } from './commands/validate';
import { registerCompletionCommand } from './commands/completion';

const program = new Command();

program
  .name('dockflow')
  .description('A deployment framework for Docker applications, leveraging Swarm for orchestration')
  .version(version, '-v, --version', 'Show version information')
  .option('--no-color', 'Disable colored output')
  .option('--verbose', 'Enable verbose/debug output')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals();
    if (opts.verbose) {
      setVerbose(true);
    }
  });

// Register all commands
registerAppCommands(program);
registerAccessoriesCommands(program);
registerBackupCommands(program);
registerLockCommands(program);
registerListCommands(program);
registerConfigCommand(program);
registerDeployCommand(program);
registerBuildCommand(program);
registerSetupCommand(program);
registerInitCommand(program);
registerUICommand(program);
registerValidateCommand(program);
registerCompletionCommand(program);

// Ordered group display sequence — groups are declared in each command file via .helpGroup()
const GROUP_ORDER = ['Setup', 'Deploy', 'Inspect', 'Operate', 'Resources', 'Other'];

// ─── Dynamic help ──────────────────────────────────────────────────────────────

function showHelp(): void {
  printSuccess('========================================================');
  printSuccess(`   Dockflow CLI v${version}`);
  printSuccess('========================================================');
  printBlank();
  printRaw(colors.dim('  Run `dockflow <command> --help` for command-specific options.'));
  printBlank();

  // Group commands from the live Commander tree
  const grouped = new Map<string, Command[]>();
  for (const cmd of program.commands) {
    if (cmd.name() === 'help') continue;
    // _helpGroupHeading is set by helpGroup() — fall back to 'Other'
    const group = (cmd as unknown as { _helpGroupHeading?: string })._helpGroupHeading ?? 'Other';
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(cmd);
  }

  const COL = 28;
  for (const group of GROUP_ORDER) {
    const cmds = grouped.get(group);
    if (!cmds || cmds.length === 0) continue;

    printWarning(`${group}:`);
    for (const cmd of cmds) {
      const name = `dockflow ${cmd.name()}`;
      const desc = cmd.description();
      const subCount = cmd.commands.filter((c) => c.name() !== 'help').length;
      const suffix = subCount > 0 ? colors.dim(` [${subCount} subcommands]`) : '';
      printRaw(`  ${colors.bold(name.padEnd(COL))} ${desc}${suffix}`);
    }
    printBlank();
  }
}

// ─── Help & default action ─────────────────────────────────────────────────────

program
  .command('help [command]')
  .alias('h')
  .description('Display help for a command')
  .allowUnknownOption()
  .action((cmd?: string) => {
    if (cmd) {
      const sub = program.commands.find((c) => c.name() === cmd || c.aliases().includes(cmd));
      if (sub) sub.help();
      else showHelp();
    } else {
      showHelp();
    }
  });

program.action(() => {
  showHelp();
});

program.showHelpAfterError('(add --help for additional information)');

program.parse(process.argv);
