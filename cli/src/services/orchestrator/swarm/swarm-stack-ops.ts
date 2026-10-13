/**
 * Low-level Swarm stack operations.
 *
 * Helper for SwarmStackBackend — owns the mechanics of `docker stack deploy`:
 * external resource creation, stuck-service recovery, convergence polling,
 * hash-based accessories change detection.
 *
 * Not exported through services/index.ts — consumers should use
 * SwarmStackBackend (via createStackBackend) instead.
 */

import { createHash } from 'crypto';
import type { SSHKeyConnection } from '../../../types';
import { shellQuote, sshExec, sshExecChannel } from '../../../utils/ssh';
import { printDebug, printInfo, printWarning, printSuccess, createTimedSpinner } from '../../../utils/output';
import { DeployError, ErrorCode } from '../../../utils/errors';
import {
  DOCKFLOW_ACCESSORIES_DIR,
  STACK_REMOVAL_MAX_ATTEMPTS,
  STACK_REMOVAL_POLL_INTERVAL_MS,
  CONVERGENCE_TIMEOUT_S,
  CONVERGENCE_INTERVAL_S,
} from '../../../constants';

export interface SwarmClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: SwarmClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

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

/** The cause of a failed `docker stack deploy`, without the warnings it prints first about keys Swarm ignores. */
export function stackDeployFailure(stderr: string): string {
  const lines = stderr.trim().split('\n');
  const cause = lines.filter((line) => !/^Ignoring (unsupported|deprecated) options:/.test(line.trim()));
  return (cause.length > 0 ? cause : lines).join('\n').trim();
}

export class SwarmStackOps {
  /** the manager's clock when the last stack deploy started: a service's update states are compared with it */
  private deployStartedAt: number | null = null;

  constructor(
    private readonly connection: SSHKeyConnection,
    private readonly clock: SwarmClock = realClock,
  ) {}

  private startedByThisDeploy(startedAt: string | null): boolean {
    if (this.deployStartedAt === null || startedAt === null) return true;
    const started = Date.parse(startedAt);
    return Number.isNaN(started) || started >= this.deployStartedAt;
  }

  /**
   * Create external overlay networks (idempotent, parallel).
   */
  async createExternalNetworks(networks: string[]): Promise<void> {
    if (networks.length === 0) return;
    await Promise.all(networks.map((name) => {
      printDebug(`Creating overlay network: ${name}`);
      return sshExec(
        this.connection,
        `docker network create --driver overlay --attachable ${shellQuote(name)} 2>/dev/null || true`,
      );
    }));
  }

  /**
   * Create external volumes (idempotent, parallel).
   */
  async createExternalVolumes(volumes: string[]): Promise<void> {
    if (volumes.length === 0) return;
    await Promise.all(volumes.map((name) => {
      printDebug(`Creating volume: ${name}`);
      return sshExec(
        this.connection,
        `docker volume create ${shellQuote(name)} 2>/dev/null || true`,
      );
    }));
  }

  /**
   * Create both external networks and volumes in parallel.
   */
  async createExternalResources(networks: string[], volumes: string[]): Promise<void> {
    await Promise.all([
      this.createExternalNetworks(networks),
      this.createExternalVolumes(volumes),
    ]);
  }

  /**
   * Detect services in a stuck state (rollback_paused, update_paused).
   * Inspects all services in parallel.
   */
  async getStuckServices(stackName: string): Promise<string[]> {
    const listResult = await sshExec(
      this.connection,
      `docker stack services ${shellQuote(stackName)} --format '{{.Name}}' 2>/dev/null || true`,
    );

    const serviceNames = listResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean);

    if (serviceNames.length === 0) return [];

    const results = await Promise.all(serviceNames.map(async (svc) => {
      const inspectResult = await sshExec(
        this.connection,
        `docker service inspect ${shellQuote(svc)} --format '{{json .UpdateStatus}}' 2>/dev/null || echo '{}'`,
      );

      const raw = inspectResult.stdout.trim();
      try {
        const status = JSON.parse(raw);
        const state = (status?.State ?? '').toLowerCase();
        if (state === 'rollback_paused' || state === 'paused') {
          return svc;
        }
      } catch {
        // Ignore unparseable output
      }
      return null;
    }));

    return results.filter((s): s is string => s !== null);
  }

  /**
   * Remove a stack and wait up to 60s for it to disappear.
   */
  async removeStackAndWait(stackName: string): Promise<void> {
    const rmResult = await sshExec(this.connection, `docker stack rm ${shellQuote(stackName)}`);
    if (rmResult.exitCode !== 0) {
      printWarning(`docker stack rm failed (exit ${rmResult.exitCode}): ${rmResult.stderr.trim()}`);
    }

    for (let i = 0; i < STACK_REMOVAL_MAX_ATTEMPTS; i++) {
      await this.clock.sleep(STACK_REMOVAL_POLL_INTERVAL_MS);

      const check = await sshExec(
        this.connection,
        `docker stack ls --format '{{.Name}}' | grep -xF ${shellQuote(stackName)} || echo ""`,
      );

      if (!check.stdout.trim()) {
        printDebug(`Stack ${stackName} removed`);
        return;
      }
    }

    throw new DeployError(
      `Stack ${stackName} still present after ${STACK_REMOVAL_MAX_ATTEMPTS * STACK_REMOVAL_POLL_INTERVAL_MS / 1000}s`,
      ErrorCode.DEPLOY_FAILED,
      'The stack may have resources preventing deletion. Check with `docker stack ps`.',
    );
  }

  /**
   * Deploy a Docker stack.
   *
   * 1. Checks for stuck services and force-removes the stack if any.
   * 2. Pipes the compose YAML over stdin to `docker stack deploy -c -`.
   * 3. Verifies the stack exists after deploy.
   */
  async deployStack(
    stackName: string,
    composeYaml: string,
    options?: { prune?: boolean; withRegistryAuth?: boolean },
  ): Promise<void> {
    const prune = options?.prune !== false;
    const registryAuth = options?.withRegistryAuth !== false;

    // 1. Handle stuck services
    const stuck = await this.getStuckServices(stackName);
    if (stuck.length > 0) {
      printWarning(`Stuck services detected: ${stuck.join(', ')}; removing stack ${stackName} before deploying`);
      await this.removeStackAndWait(stackName);
      await this.clock.sleep(3000);
    }

    // 2. Deploy from stdin. The compose carries the stack's secrets: a file in
    //    /tmp would be readable by every local user for the whole deploy.
    const flags = [
      prune ? '--prune' : '',
      registryAuth ? '--with-registry-auth' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const serverNow = await sshExec(this.connection, 'date -u +%s').catch(() => null);
    const seconds = Number(serverNow?.stdout.trim());
    this.deployStartedAt = serverNow && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;

    const { stream, done } = await sshExecChannel(
      this.connection,
      `docker stack deploy ${flags} -c - ${shellQuote(stackName)}`,
    );
    stream.end(composeYaml);
    const result = await done;

    if (result.exitCode !== 0) {
      throw new DeployError(
        `docker stack deploy failed (exit ${result.exitCode}): ${stackDeployFailure(result.stderr)}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    // 3. Verify stack exists
    const verify = await sshExec(
      this.connection,
      `docker stack ls --format '{{.Name}}' | grep -xF ${shellQuote(stackName)} || echo ""`,
    );

    if (!verify.stdout.trim()) {
      throw new DeployError(
        `Stack ${stackName} not found after deploy`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    printDebug(`Stack ${stackName} deployed`);
  }

  /**
   * Poll until all services in a stack have reached their desired replica count.
   *
   * Detects rollback/crash-loop states early via `docker service inspect`
   * and fails fast instead of waiting the full timeout.
   * Prints a progress line every 30s in non-verbose mode.
   */
  async waitConvergence(
    stackName: string,
    options?: { timeout?: number; interval?: number; context?: string; servicesFilter?: string[] },
  ): Promise<void> {
    const timeout = (options?.timeout ?? CONVERGENCE_TIMEOUT_S) * 1000;
    const interval = (options?.interval ?? CONVERGENCE_INTERVAL_S) * 1000;
    const ctx = options?.context ?? 'deployment';
    const deadline = this.clock.now() + timeout;

    const filterSet = options?.servicesFilter?.length
      ? new Set(options.servicesFilter.map(s => `${stackName}_${s}`))
      : null;

    const spinner = createTimedSpinner();
    spinner.start(`Waiting for ${ctx} convergence (timeout: ${timeout / 1000}s)...`);

    let lastStatuses: string[] = [];
    // failed tasks seen before this convergence started belong to an earlier deploy
    let earlierFailures: Set<string> | null = null;
    const failures = new Map<string, Map<string, string>>();

    while (this.clock.now() < deadline) {
      const result = await sshExec(
        this.connection,
        `docker stack services ${shellQuote(stackName)} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
      );

      let lines = result.stdout.trim().split('\n').filter(Boolean);
      if (filterSet) lines = lines.filter(l => filterSet.has(l.split('\t')[0]));
      if (lines.length === 0) {
        await this.clock.sleep(interval);
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
      const updateStates = await this.getServiceUpdateStates(lines);

      if (allConverged) {
        // Before declaring convergence, verify no service has an in-progress update.
        // During a redeploy, old replicas may already match the desired count before
        // the rolling update starts. We must wait for the update to finish.
        const updating = this.getUpdatingFromStates(updateStates);
        if (updating.length > 0) {
          printDebug(`Update in progress: ${updating.join(', ')}`);
          spinner.update(`Waiting for ${ctx} convergence: update in progress`);
          await this.clock.sleep(interval);
          continue;
        }

        spinner.succeed(`All services converged: ${statuses.join(', ')}`);
        return;
      }

      // Detect rollback/crash-loop states from the same inspection data
      try {
        this.detectFailingFromStates(updateStates);
      } catch (error) {
        spinner.fail('Convergence failed');
        if (error instanceof DeployError) {
          const taskErrors = await this.getFailedTaskErrors(stackName).catch(() => '');
          if (taskErrors) {
            const message = `${error.message}\n\nFailed tasks:\n${taskErrors}`;
            throw error instanceof ConvergenceError
              ? new ConvergenceError(message, error.outcome, error.suggestion)
              : new DeployError(message, error.code, error.suggestion);
          }
        }
        throw error;
      }

      const failed = await this.failedTasks(stackName);
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

      await this.clock.sleep(interval);
    }

    // Timeout — use last known statuses
    const notConverged = lastStatuses.filter((s) => {
      const match = s.match(/(\d+)\/(\d+)$/);
      return !match || match[1] !== match[2];
    });

    spinner.fail(`Convergence timeout after ${timeout / 1000}s`);

    const [pending, failed] = await Promise.all([
      this.getPendingTaskErrors(stackName).catch(() => ''),
      this.getFailedTaskErrors(stackName).catch(() => ''),
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
  private async getServiceUpdateStates(serviceLines: string[]): Promise<Map<string, UpdateState>> {
    const serviceNames = serviceLines.map((l) => l.split('\t')[0]).filter(Boolean);
    if (serviceNames.length === 0) return new Map();

    const quoted = serviceNames.map(shellQuote).join(' ');
    const result = await sshExec(
      this.connection,
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

  /**
   * Detect services in rollback or crash-loop states during convergence.
   * Throws immediately on detection.
   */
  private detectFailingFromStates(states: Map<string, UpdateState>): void {
    const rolledBack: string[] = [];
    const stuck: string[] = [];

    for (const [svc, { state, startedAt }] of states) {
      if (state === 'rollback_started' || state === 'rollback_completed') {
        // a rollback left by an earlier deploy on a service this one did not change is not this deploy's
        if (!this.startedByThisDeploy(startedAt)) continue;
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

  /**
   * Fetch error messages from recently failed tasks in a stack.
   * Used to enrich rollback error messages with the actual failure reason.
   */
  private async failedTasks(stackName: string): Promise<Map<string, Map<string, string>>> {
    const result = await sshExec(
      this.connection,
      `docker stack ps ${shellQuote(stackName)} --no-trunc --filter 'desired-state=shutdown' --format '{{.ID}}|{{.Name}}|{{.CurrentState}}|{{.Error}}' 2>/dev/null || echo ""`,
    ).catch(() => null);
    return failedTasksByService(result?.stdout ?? '');
  }

  private getFailedTaskErrors(stackName: string): Promise<string> {
    return this.taskErrors(stackName, 'shutdown');
  }

  /** Errors of tasks meant to run that never started: no node can take them, an image cannot be pulled. */
  private getPendingTaskErrors(stackName: string): Promise<string> {
    return this.taskErrors(stackName, 'running');
  }

  private async taskErrors(stackName: string, desiredState: 'shutdown' | 'running'): Promise<string> {
    const result = await sshExec(
      this.connection,
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

  /**
   * Return service names that have an in-progress update (state = "updating").
   */
  private getUpdatingFromStates(states: Map<string, UpdateState>): string[] {
    return [...states.entries()]
      .filter(([, { state }]) => state === 'updating')
      .map(([svc]) => svc);
  }

  /**
   * Deploy accessories stack with hash-based change detection.
   *
   * Skips deploy if the compose content hasn't changed since last deploy
   * (unless `options.force` is true). Returns whether a deploy ran.
   */
  async deployAccessories(
    stackName: string,
    accessoriesComposePath: string,
    accessoriesComposeYaml: string,
    options?: { force?: boolean },
  ): Promise<boolean> {
    const accessoriesStackName = `${stackName}-accessories`;
    const hashDir = `${DOCKFLOW_ACCESSORIES_DIR}/${stackName}`;
    const hashFile = `${hashDir}/.hash`;

    // 1. Compute local hash
    const localHash = createHash('sha256')
      .update(accessoriesComposeYaml)
      .digest('hex');

    // 2. Read remote hash
    if (!options?.force) {
      const remoteResult = await sshExec(
        this.connection,
        `cat ${shellQuote(hashFile)} 2>/dev/null || echo ""`,
      );
      const remoteHash = remoteResult.stdout.trim();

      if (remoteHash === localHash) {
        // a stack removed by hand leaves its hash behind
        const present = await sshExec(
          this.connection,
          `docker stack ls --format '{{.Name}}' | grep -xF ${shellQuote(accessoriesStackName)} || echo ""`,
        );
        if (present.stdout.trim()) {
          printInfo('Accessories unchanged, skipping');
          return false;
        }
        printInfo('Accessories unchanged but their stack is gone');
      }
    }

    printInfo('Deploying accessories...');

    // 3. Pull images (best-effort), from stdin like the deploy itself
    try {
      const { stream: pullStream, done: pullDone } = await sshExecChannel(
        this.connection,
        `docker compose -f - pull 2>/dev/null || true`,
      );
      pullStream.end(accessoriesComposeYaml);
      await pullDone;
    } catch {
      printDebug('Accessories image pull skipped (compose v2 not available or pull failed)');
    }

    // 4. Deploy
    await this.deployStack(accessoriesStackName, accessoriesComposeYaml, {
      prune: true,
      withRegistryAuth: true,
    });

    // 5. Wait for convergence
    await this.waitConvergence(accessoriesStackName, { context: 'accessories' });

    // 6. Write hash
    await sshExec(
      this.connection,
      `mkdir -p ${shellQuote(hashDir)} && echo ${shellQuote(localHash)} > ${shellQuote(hashFile)}`,
    );

    printSuccess('Accessories deployed');
    return true;
  }
}
