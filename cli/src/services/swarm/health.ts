/**
 * Swarm's own view of a stack's health: every task of each service running, and no rollback of
 * this deploy.
 */

import type { SSHKeyConnection } from '../../types';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug, createTimedSpinner } from '../../utils/output';
import type { SwarmClock } from './clock';
import type { InternalHealthResult } from './types';

export async function checkInternalHealth(
  connection: SSHKeyConnection,
  clock: SwarmClock,
  stackName: string,
  timeoutSeconds: number,
  intervalSeconds: number,
  servicesFilter?: string[],
  deployStartedAt?: Date,
): Promise<InternalHealthResult> {
  const timeout = timeoutSeconds * 1000;
  const interval = intervalSeconds * 1000;
  const deadline = clock.now() + timeout;

  const spinner = createTimedSpinner();
  spinner.start(`Checking Swarm health (timeout: ${timeoutSeconds}s)...`);

  let lastUnhealthy: string[] = [];

  while (clock.now() < deadline) {
    const result = await pollHealth(connection, stackName, servicesFilter, deployStartedAt);

    if (result.rolledBack.length > 0) {
      spinner.fail(`Swarm auto-rolled back: ${result.rolledBack.join(', ')}`);
      return {
        healthy: false,
        rolledBack: true,
        failedService: result.rolledBack[0],
        message: `Swarm auto-rolled back: ${result.rolledBack.join(', ')}`,
      };
    }

    if (result.unhealthy.length === 0) {
      spinner.succeed(`All services healthy: ${result.healthy.join(', ')}`);
      return { healthy: true, rolledBack: false };
    }

    lastUnhealthy = result.unhealthy;
    printDebug(`Health: healthy=[${result.healthy.join(', ')}] unhealthy=[${result.unhealthy.join(', ')}]`);
    spinner.update(`Checking Swarm health: ${result.unhealthy.length} unhealthy`);
    await clock.sleep(interval);
  }

  spinner.fail(`Health check timeout after ${timeoutSeconds}s`);

  if (lastUnhealthy.length > 0) {
    return {
      healthy: false,
      rolledBack: false,
      failedService: lastUnhealthy[0],
      message: `Health check timeout after ${timeoutSeconds}s. Unhealthy services: ${lastUnhealthy.join(', ')}`,
    };
  }

  return { healthy: true, rolledBack: false };
}

async function pollHealth(
  connection: SSHKeyConnection,
  stackName: string,
  servicesFilter?: string[],
  deployStartedAt?: Date,
): Promise<{ healthy: string[]; unhealthy: string[]; rolledBack: string[] }> {
  const listResult = await sshExec(
    connection,
    `docker stack services ${shellQuote(stackName)} --format '{{.Name}}' 2>/dev/null || echo ""`,
  );

  let serviceNames = listResult.stdout.trim().split('\n').filter(Boolean);
  if (servicesFilter?.length) {
    const filterSet = new Set(servicesFilter.map(s => `${stackName}_${s}`));
    serviceNames = serviceNames.filter(s => filterSet.has(s));
  }
  if (serviceNames.length === 0) {
    return { healthy: [], unhealthy: [], rolledBack: [] };
  }

  const results = await Promise.all(
    serviceNames.map((serviceName) => serviceHealth(connection, serviceName, deployStartedAt)),
  );

  const healthy: string[] = [];
  const unhealthy: string[] = [];
  const rolledBack: string[] = [];

  for (const r of results) {
    switch (r.status) {
      case 'healthy':
        healthy.push(r.name);
        break;
      case 'rolled_back':
        rolledBack.push(r.name);
        break;
      default:
        unhealthy.push(r.name);
        break;
    }
  }

  return { healthy, unhealthy, rolledBack };
}

async function serviceHealth(
  connection: SSHKeyConnection,
  serviceName: string,
  deployStartedAt?: Date,
): Promise<{ name: string; status: 'healthy' | 'unhealthy' | 'rolled_back' }> {
  // state and completion time of the last update, in one call
  const inspectResult = await sshExec(
    connection,
    `docker service inspect ${shellQuote(serviceName)} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}|{{.UpdateStatus.CompletedAt}}{{end}}' 2>/dev/null`,
  );
  const raw = inspectResult.stdout.trim();
  if (raw) {
    const [state, completedAtStr] = raw.split('|');
    const updateState = state.trim().toLowerCase();

    if (updateState === 'rollback_started') {
      // rolling back right now: always a failure
      return { name: serviceName, status: 'rolled_back' };
    }

    if (updateState === 'rollback_completed') {
      // only a rollback that finished after this deploy started counts: an older
      // rollback_completed means the service runs fine on the rolled-back image
      if (!deployStartedAt) {
        return { name: serviceName, status: 'rolled_back' };
      }
      const completedAt = completedAtStr?.trim() ? new Date(completedAtStr.trim()) : null;
      if (!completedAt || isNaN(completedAt.getTime()) || completedAt >= deployStartedAt) {
        return { name: serviceName, status: 'rolled_back' };
      }
    }
  }

  const psResult = await sshExec(
    connection,
    `docker service ps ${shellQuote(serviceName)} --filter 'desired-state=running' --format '{{.CurrentState}}' --no-trunc 2>/dev/null`,
  );
  const tasks = psResult.stdout.trim().split('\n').filter(Boolean);
  if (tasks.length === 0) {
    return { name: serviceName, status: 'unhealthy' };
  }

  const allRunning = tasks.every((t) => t.trim().toLowerCase().startsWith('running'));
  return { name: serviceName, status: allRunning ? 'healthy' : 'unhealthy' };
}
