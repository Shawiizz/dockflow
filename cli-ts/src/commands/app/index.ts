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
import { registerVersionCommand } from './version';
import { registerAuditCommand } from './audit';
import { registerBashCommand } from './bash';
import { registerMetricsCommand } from './metrics';

/**
 * Register all app commands
 */
export function registerAppCommands(program: Command): void {
  // Info commands
  registerVersionCommand(program);
  registerDetailsCommand(program);
  registerPsCommand(program);
  registerLogsCommand(program);
  registerAuditCommand(program);
  registerMetricsCommand(program);
  
  // Action commands
  registerBashCommand(program);
  registerExecCommand(program);
  registerRestartCommand(program);
  registerStopCommand(program);
  registerScaleCommand(program);
  registerRollbackCommand(program);
  registerPruneCommand(program);
  registerSshCommand(program);
}
