/**
 * `dockflow accessories stop` (design-06 3.16): scales accessories to 0 (data preserved), recording
 * the previous replica count so `accessories restart` resumes it. No deploy lock (2.8): it is a
 * reversible, low-risk operation an operator needs even while a deploy holds the lock.
 */

import type { Command } from 'commander';
import { DELETE_WAIT_TIMEOUT_S } from '../../constants';
import type { ServiceInfo } from '../../services/orchestrator/interfaces';
import { withServicesRequired } from '../../utils/errors';
import { createSpinner, printInfo, printNote, printWarning } from '../../utils/output';
import { confirmPrompt } from '../../utils/prompts';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2, resolveService } from '../shared/day2';
import { requireAccessories } from './utils';

export interface AccessoriesStopOptions {
  server?: string;
  yes?: boolean;
}

export async function runAccessoriesStop(env: string, service: string | undefined, options: AccessoriesStopOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  const ref = ctx.accessoryRef;
  // a named service gets its own not-found message from resolveService; the whole-role stop has no
  // such call to fall back on, so it checks the role is deployed itself.
  if (!service) await requireAccessories(ctx);
  const svc: ServiceInfo | null = service ? (await resolveService(ctx, ref, service, { noun: 'accessory' })).service : null;
  const targetDesc = svc ? `accessory '${svc.name}'` : 'all accessories';

  if (!options.yes) {
    printWarning(`This will stop ${targetDesc} (scale to 0 replicas)`);
    printInfo('Data in volumes will be preserved');
    const confirmed = await confirmPrompt({ message: `Are you sure you want to stop ${targetDesc}?`, initialValue: false });
    if (!confirmed) {
      printInfo('Cancelled');
      return;
    }
  }

  const spinner = createSpinner();
  spinner.start(svc ? `Stopping ${svc.name}...` : 'Stopping all accessories...');
  try {
    await ctx.orchestrator.stack.stop(ref, svc ? [svc.name] : null, { wait: true, timeoutS: DELETE_WAIT_TIMEOUT_S });
    ctx.invalidate(ref);
    spinner.succeed(svc ? `Accessory '${svc.name}' stopped` : 'All accessories stopped');
  } catch (error) {
    // a single named service still fails hard; only the "stop everything" scope keeps going (today's text)
    if (svc) throw error;
    spinner.warn('Some services failed to stop');
  }

  printNote(
    `To restart: dockflow accessories restart ${env}${svc ? ` ${svc.name}` : ''}\n` +
      `To remove:  dockflow accessories remove ${env}${svc ? ` ${svc.name}` : ''}`,
    'Next steps',
  );
}

export function registerAccessoriesStopCommand(program: Command): void {
  program
    .command('stop <env> [service]')
    .description('Stop accessory services (scale to 0, can be restarted)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .action(withServicesRequired(withResolvedEnv(runAccessoriesStop)));
}
