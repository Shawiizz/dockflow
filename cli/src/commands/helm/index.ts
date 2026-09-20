// `dockflow helm` command group (design-04 3.12.1): Helm release management on k3s.

import type { Command } from 'commander';
import { registerHelmHistoryCommand } from './history';
import { registerHelmListCommand } from './list';
import { registerHelmRollbackCommand } from './rollback';
import { registerHelmStatusCommand } from './status';
import { registerHelmUninstallCommand } from './uninstall';
import { registerHelmValuesCommand } from './values';

export function registerHelmCommands(program: Command): void {
  const helm = program.command('helm').description('Manage Helm releases (orchestrator: k3s)').helpGroup('Resources');

  registerHelmListCommand(helm);
  registerHelmStatusCommand(helm);
  registerHelmHistoryCommand(helm);
  registerHelmValuesCommand(helm);
  registerHelmRollbackCommand(helm);
  registerHelmUninstallCommand(helm);
}
