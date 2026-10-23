#!/usr/bin/env bun

/** Entry point: the Commander program, with a help that groups the commands. */

import { Command } from 'commander';
import { version } from '../package.json';
import { setVerbose, printSuccess, printBlank, printWarning, printRaw, colors } from './utils/output';
import { registerAllCommands } from './commands/register-all';

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

registerAllCommands(program);

// the order of the help groups; each command file names its own with .helpGroup()
const GROUP_ORDER = ['Setup', 'Deploy', 'Inspect', 'Operate', 'Resources', 'Other'];

function showHelp(): void {
  printSuccess('========================================================');
  printSuccess(`   Dockflow CLI v${version}`);
  printSuccess('========================================================');
  printBlank();
  printRaw(colors.dim('  Run `dockflow <command> --help` for command-specific options.'));
  printBlank();

  const grouped = new Map<string, Command[]>();
  for (const cmd of program.commands) {
    if (cmd.name() === 'help') continue;
    // Commander keeps the .helpGroup() heading in this private field
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
