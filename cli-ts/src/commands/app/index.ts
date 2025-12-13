/**
 * App commands - Interact with deployed services
 * These commands use SSH directly (no Ansible/Docker needed locally)
 */

import type { Command } from 'commander';
import { registerLogsCommand } from './logs';
import { registerExecCommand } from './exec';
import { registerRestartCommand } from './restart';
import { registerStopCommand } from './stop';
import { registerDetailsCommand } from './details';
import { registerSshCommand } from './ssh';
import { registerScaleCommand } from './scale';
import { registerRollbackCommand } from './rollback';
import { registerPsCommand } from './ps';
import { registerPruneCommand } from './prune';

/**
 * Register all app commands
 */
export function registerAppCommands(program: Command): void {
  registerLogsCommand(program);
  registerExecCommand(program);
  registerRestartCommand(program);
  registerStopCommand(program);
  registerDetailsCommand(program);
  registerSshCommand(program);
  registerScaleCommand(program);
  registerRollbackCommand(program);
  registerPsCommand(program);
  registerPruneCommand(program);
}
