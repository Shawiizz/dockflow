/**
 * Waiting for a stack to converge: every service at its replica count, no update running. A
 * rollback, a paused update or a crash loop fails at once, with the errors of the tasks.
 */

import type { SSHKeyConnection } from '../../types';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug, createTimedSpinner } from '../../utils/output';
import { DeployError, ErrorCode } from '../../utils/errors';
import { CONVERGENCE_TIMEOUT_S, CONVERGENCE_INTERVAL_S } from '../../constants';
import type { SwarmClock } from './clock';

interface UpdateState {
  state: string;
  startedAt: string | null;
}

/** A stack that did not converge, and how. */
export class ConvergenceError extends DeployError {
  constructor(message: string, readonly outcome: 'rolled-back' | 'paused' | 'timeout' | 'crash-loop', suggestion?: string) {
    super(message, ErrorCode.DEPLOY_FAILED, suggestion);
    this.name = 'ConvergenceError';
  }
}

/** Failed tasks of one service, counted since the convergence started, after which it is a crash loop. */
export const CRASH_LOOP_FAILURES = 10;

/**
 * Failed tasks of `docker stack ps --format '{{.ID}}|{{.Name}}|{{.CurrentState}}|{{.Error}}'`, by
 * service. Swarm keeps only a few tasks per slot, so the caller accumulates them across polls.
 */
export function failedTasksByService(stackPs: string): Map<string, Map<string, string>> {
  const byService = new Map<string, Map<string, string>>();
  for (const line of stackPs.trim().split('\n')) {
    const [id, name, state, error] = line.split('|');
    if (!id || !name || state === undefined || !/^(Failed|Rejected)\b/.test(state.trim())) continue;
    const service = name.replace(/\.[^.]*$/, '');
    if (!byService.has(service)) byService.set(service, new Map());
    byService.get(service)?.set(id, (error ?? '').trim());
  }
  return byService;
}

export interface ConvergenceOptions {
  timeout?: number;
  interval?: number;
  context?: string;
  servicesFilter?: string[];
  /** the manager's clock when the stack deploy started: update states before it are an earlier deploy's */
  deployStartedAt?: number | null;
}

/**
 * Polls until every service of the stack reached its replica count and no update runs. Throws a
 * ConvergenceError on a rollback of this deploy, a paused update, a crash loop or the timeout.
 */
export async function waitForConvergence(
  connection: SSHKeyConnection,
  clock: SwarmClock,
  stackName: string,
  options: ConvergenceOptions = {},
): Promise<void> {
  const timeout = (options.timeout ?? CONVERGENCE_TIMEOUT_S) * 1000;
  const interval = (options.interval ?? CONVERGENCE_INTERVAL_S) * 1000;
  const ctx = options.context ?? 'deployment';
  const deadline = clock.now() + timeout;

  const filterSet = options.servicesFilter?.length
    ? new Set(options.servicesFilter.map(s => `${stackName}_${s}`))
    : null;

  const spinner = createTimedSpinner();
  spinner.start(`Waiting for ${ctx} convergence (timeout: ${timeout / 1000}s)...`);

  let lastStatuses: string[] = [];
  // failed tasks seen before this convergence started belong to an earlier deploy
  let earlierFailures: Set<string> | null = null;
  const failures = new Map<string, Map<string, string>>();

  while (clock.now() < deadline) {
    const result = await sshExec(
      connection,
      `docker stack services ${shellQuote(stackName)} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
    );

    let lines = result.stdout.trim().split('\n').filter(Boolean);
    if (filterSet) lines = lines.filter(l => filterSet.has(l.split('\t')[0]));
    if (lines.length === 0) {
      await clock.sleep(interval);
      continue;
    }

    let allConverged = true;
    const statuses: string[] = [];

    for (const line of lines) {
      const [name, replicas] = line.split('\t');
      if (!replicas || !replicas.includes('/')) {
        allConverged = false;
        statuses.push(`${name} ?/?`);
        continue;
      }

      // a job service reads `0/1 (1/1 completed)`: it converged once every task completed
      const job = /\((\d+)\/(\d+) completed\)/.exec(replicas);
      const [currentStr, desiredStr] = (job ? `${job[1]}/${job[2]}` : replicas).split('/');
      const current = parseInt(currentStr, 10);
      const desired = parseInt(desiredStr, 10);

      if (current !== desired) {
        allConverged = false;
      }
      statuses.push(`${name} ${current}/${desired}`);
    }

    lastStatuses = statuses;

    // Single SSH call to get all update states (used for both convergence check and failure detection)
    const updateStates = await serviceUpdateStates(connection, lines);

    if (allConverged) {
      // Before declaring convergence, verify no service has an in-progress update.
      // During a redeploy, old replicas may already match the desired count before
      // the rolling update starts. We must wait for the update to finish.
      const updating = updatingServices(updateStates);
      if (updating.length > 0) {
        printDebug(`Update in progress: ${updating.join(', ')}`);
        spinner.update(`Waiting for ${ctx} convergence: update in progress`);
        await clock.sleep(interval);
        continue;
      }

      spinner.succeed(`All services converged: ${statuses.join(', ')}`);
      return;
    }

    // Detect rollback/crash-loop states from the same inspection data
    try {
      detectFailingFromStates(updateStates, options.deployStartedAt ?? null);
    } catch (error) {
      spinner.fail('Convergence failed');
      if (error instanceof DeployError) {
        const taskErrors = await failedTaskErrors(connection, stackName).catch(() => '');
        if (taskErrors) {
          const message = `${error.message}\n\nFailed tasks:\n${taskErrors}`;
          throw error instanceof ConvergenceError
            ? new ConvergenceError(message, error.outcome, error.suggestion)
            : new DeployError(message, error.code, error.suggestion);
        }
      }
      throw error;
    }

    const failed = await failedTasks(connection, stackName);
    if (earlierFailures === null) {
      earlierFailures = new Set([...failed.values()].flatMap((tasks) => [...tasks.keys()]));
    } else {
      for (const [service, tasks] of failed) {
        if (filterSet && !filterSet.has(service)) continue;
        const seen = failures.get(service) ?? new Map<string, string>();
        for (const [id, error] of tasks) if (!earlierFailures.has(id)) seen.set(id, error);
        failures.set(service, seen);
      }
      const looping = [...failures].find(([, tasks]) => tasks.size >= CRASH_LOOP_FAILURES);
      if (looping) {
        const [service, tasks] = looping;
        const lastError = [...tasks.values()].filter(Boolean).pop();
        spinner.fail('Convergence failed');
        throw new ConvergenceError(
          `${service} keeps failing: ${tasks.size} of its tasks failed since the deploy started${lastError ? `, the last with: ${lastError}` : ''}`,
          'crash-loop',
        );
      }
    }

    printDebug(`Convergence: ${statuses.join(', ')}`);
    spinner.update(`Waiting for ${ctx} convergence: ${statuses.join(', ')}`);

    await clock.sleep(interval);
  }

  // Timeout — use last known statuses
  const notConverged = lastStatuses.filter((s) => {
    const match = s.match(/(\d+)\/(\d+)$/);
    return !match || match[1] !== match[2];
  });

  spinner.fail(`Convergence timeout after ${timeout / 1000}s`);

  const [pending, failed] = await Promise.all([
    pendingTaskErrors(connection, stackName).catch(() => ''),
    failedTaskErrors(connection, stackName).catch(() => ''),
  ]);
  const why = [pending, failed].filter(Boolean).join('\n');
  throw new ConvergenceError(
    `${ctx} convergence timeout after ${timeout / 1000}s. Non-converged services: ${notConverged.join(', ')}${why ? `\n\nTask errors:\n${why}` : ''}`,
    'timeout',
  );
}

/**
 * Fetch the UpdateStatus.State for all services in a single SSH call.
 * Returns a Map of service name → state (lowercase).
 */
async function serviceUpdateStates(connection: SSHKeyConnection, serviceLines: string[]): Promise<Map<string, UpdateState>> {
  const serviceNames = serviceLines.map((l) => l.split('\t')[0]).filter(Boolean);
  if (serviceNames.length === 0) return new Map();

  const quoted = serviceNames.map(shellQuote).join(' ');
  const result = await sshExec(
    connection,
    `for svc in ${quoted}; do ` +
      `STATE=$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}|{{.UpdateStatus.StartedAt}}{{end}}' 2>/dev/null); ` +
      `echo "$svc\t$STATE"; ` +
    `done`,
  );

  const states = new Map<string, UpdateState>();
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const [svc, status = ''] = line.split('\t');
    const [state = '', startedAt = ''] = status.split('|');
    states.set(svc, { state: state.toLowerCase(), startedAt: startedAt.trim() || null });
  }
  return states;
}

function startedByThisDeploy(startedAt: string | null, deployStartedAt: number | null): boolean {
  if (deployStartedAt === null || startedAt === null) return true;
  const started = Date.parse(startedAt);
  return Number.isNaN(started) || started >= deployStartedAt;
}

/**
 * Detect services in rollback or crash-loop states during convergence.
 * Throws immediately on detection.
 */
function detectFailingFromStates(states: Map<string, UpdateState>, deployStartedAt: number | null): void {
  const rolledBack: string[] = [];
  const stuck: string[] = [];

  for (const [svc, { state, startedAt }] of states) {
    if (state === 'rollback_started' || state === 'rollback_completed') {
      // a rollback left by an earlier deploy on a service this one did not change is not this deploy's
      if (!startedByThisDeploy(startedAt, deployStartedAt)) continue;
      rolledBack.push(svc);
    } else if (state === 'rollback_paused' || state === 'paused') {
      stuck.push(svc);
    }
  }

  if (rolledBack.length > 0) {
    throw new ConvergenceError(
      `Swarm auto-rolled back services: ${rolledBack.join(', ')}`,
      'rolled-back',
      'The new version failed Swarm health checks. Check service logs for details.',
    );
  }

  if (stuck.length > 0) {
    throw new ConvergenceError(
      `Services stuck in ${states.get(stuck[0])?.state}: ${stuck.join(', ')}`,
      'paused',
      'Try `dockflow deploy --force` to force a fresh deployment.',
    );
  }
}

/** Return service names that have an in-progress update (state = "updating"). */
function updatingServices(states: Map<string, UpdateState>): string[] {
  return [...states.entries()]
    .filter(([, { state }]) => state === 'updating')
    .map(([svc]) => svc);
}

async function failedTasks(connection: SSHKeyConnection, stackName: string): Promise<Map<string, Map<string, string>>> {
  const result = await sshExec(
    connection,
    `docker stack ps ${shellQuote(stackName)} --no-trunc --filter 'desired-state=shutdown' --format '{{.ID}}|{{.Name}}|{{.CurrentState}}|{{.Error}}' 2>/dev/null || echo ""`,
  ).catch(() => null);
  return failedTasksByService(result?.stdout ?? '');
}

function failedTaskErrors(connection: SSHKeyConnection, stackName: string): Promise<string> {
  return taskErrors(connection, stackName, 'shutdown');
}

/** Errors of tasks meant to run that never started: no node can take them, an image cannot be pulled. */
function pendingTaskErrors(connection: SSHKeyConnection, stackName: string): Promise<string> {
  return taskErrors(connection, stackName, 'running');
}

async function taskErrors(connection: SSHKeyConnection, stackName: string, desiredState: 'shutdown' | 'running'): Promise<string> {
  const result = await sshExec(
    connection,
    `docker stack ps ${shellQuote(stackName)} --no-trunc --filter 'desired-state=${desiredState}' --format '{{.Name}}|{{.Error}}' 2>/dev/null || echo ""`,
  );
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const errors = lines
    .map((line) => {
      const pipe = line.indexOf('|');
      if (pipe === -1) return null;
      const name = line.slice(0, pipe).trim();
      const error = line.slice(pipe + 1).trim();
      return error ? `  ${name}: ${error}` : null;
    })
    .filter((l): l is string => l !== null);
  return errors.join('\n');
}
