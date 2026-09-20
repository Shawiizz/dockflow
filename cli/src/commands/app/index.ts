/**
 * App commands - Interact with deployed services
 * These commands go through the Orchestrator bundle (Swarm or Kubernetes, core 6.4).
 */

import type { Command } from 'commander';
import { registerCpCommand } from './cp';
import { registerDetailsCommand } from './details';
import { registerDiagnoseCommand } from './diagnose';
import { registerExecCommand } from './exec';
import { registerHistoryCommand } from './history';
import { registerHistorySyncCommand } from './history-sync';
import { registerLogsCommand } from './logs';
import { registerMetricsCommand } from './metrics';
import { registerPruneCommand } from './prune';
import { registerPsCommand } from './ps';
import { registerRestartCommand } from './restart';
import { registerRollbackCommand } from './rollback';
import { registerScaleCommand } from './scale';
import { registerSshCommand } from './ssh';
import { registerStatusCommand } from './status';
import { registerStopCommand } from './stop';
import { registerVersionCommand } from './version';

/**
 * Register all app commands
 */
export function registerAppCommands(program: Command): void {
  // Info commands
  registerVersionCommand(program);
  registerDetailsCommand(program);
  registerPsCommand(program);
  registerLogsCommand(program);
  registerHistoryCommand(program);
  registerHistorySyncCommand(program);
  registerMetricsCommand(program);
  registerDiagnoseCommand(program);
  registerStatusCommand(program);

  // Action commands
  registerExecCommand(program);
  registerCpCommand(program);
  registerRestartCommand(program);
  registerStopCommand(program);
  registerScaleCommand(program);
  registerRollbackCommand(program);
  registerPruneCommand(program);
  registerSshCommand(program);
}
