import type { Command } from 'commander';
import { registerAppCommands } from './app/index';
import { registerDeployCommand } from './deploy';
import { registerBuildCommand } from './build';
import { registerSetupCommand } from './setup';
import { registerInitCommand } from './init';
import { registerAccessoriesCommands } from './accessories';
import { registerBackupCommands } from './backup';
import { registerLockCommands } from './lock';
import { registerListCommands } from './list';
import { registerPluginsCommands } from './plugins';
import { registerConfigCommand } from './config';
import { registerUICommand } from './ui';
import { registerValidateCommand } from './validate';
import { registerCompletionCommand } from './completion';

/** Every command of the CLI, in the order `dockflow --help` lists them within a group. */
export function registerAllCommands(program: Command): void {
  registerAppCommands(program);
  registerAccessoriesCommands(program);
  registerBackupCommands(program);
  registerLockCommands(program);
  registerListCommands(program);
  registerPluginsCommands(program);
  registerConfigCommand(program);
  registerDeployCommand(program);
  registerBuildCommand(program);
  registerSetupCommand(program);
  registerInitCommand(program);
  registerUICommand(program);
  registerValidateCommand(program);
  registerCompletionCommand(program);
}
