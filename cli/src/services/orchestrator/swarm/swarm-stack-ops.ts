/**
 * Low-level Swarm stack operations for SwarmStackBackend: external resource creation, stuck-service
 * recovery, `docker stack deploy` over stdin, convergence polling, stack removal and the
 * accessories hash file. The hash is only read here at deploy time; the backend writes it in
 * `finalize`, after convergence.
 */

import {
  CONVERGENCE_INTERVAL_S,
  CONVERGENCE_TIMEOUT_S,
  DOCKFLOW_ACCESSORIES_DIR,
  STACK_REMOVAL_MAX_ATTEMPTS,
  STACK_REMOVAL_POLL_INTERVAL_MS,
} from '../../../constants';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { createTimedSpinner, printDebug, printWarning } from '../../../utils/output';
import { shellQuote } from '../../../utils/ssh';
import type { ClusterNodeRef } from '../interfaces';
import { endOf, errorText, onText, type SwarmExecResult, type SwarmSsh, swarmTransportError } from './swarm-utils';

const q = shellQuote;

/** Time source of the Swarm wait loops; tests pass a fake one. */
export interface SwarmClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const swarmClock: SwarmClock = {
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/** Pause after a stuck stack was removed, before deploying it again. */
const STUCK_STACK_SETTLE_MS = 3000;

/** Runs `command` with `input` on its stdin; secrets in `input` never reach a file or an argv. */
export async function execWithStdin(
  ssh: SwarmSsh,
  node: ClusterNodeRef,
  command: string,
  input: string,
): Promise<SwarmExecResult> {
  const channel = await ssh.channel(node, command);
  let stdout = '';
  let stderr = '';
  onText(channel.stdout, (text) => {
    stdout += text;
  });
  onText(channel.stderr, (text) => {
    stderr += text;
  });
  channel.stdin.end(input);
  const [{ exitCode }] = await Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]);
  return { exitCode, stdout, stderr };
}

/** One Swarm service a failed convergence names, by its docker name (`<stack>_<svc>`). */
export interface SwarmServiceProblem {
  nativeName: string;
  reason: 'TaskFailed' | 'Paused' | 'Timeout';
  detail: string;
}

export type SwarmConvergence =
  | { status: 'converged' }
  | {
      status: 'reverted' | 'failed' | 'timeout';
      message: string;
      suggestion?: string;
      services: SwarmServiceProblem[];
    };

export interface SwarmWaitOptions {
  timeoutS?: number;
  intervalS?: number;
  /** spinner wording: `deployment`, `accessories` */
  context?: string;
  /** compose names; null or empty waits for every service of the stack */
  servicesFilter?: string[] | null;
}

function lines(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

export class SwarmStackOps {
  constructor(
    private readonly ssh: SwarmSsh,
    private readonly node: ClusterNodeRef,
    private readonly env: string,
    private readonly clock: SwarmClock = swarmClock,
  ) {}

  /** One command on the control plane; a lost connection is an OrchestratorUnavailableError. */
  async run(command: string): Promise<SwarmExecResult> {
    try {
      return await this.ssh.exec(this.node, command);
    } catch (error) {
      throw swarmTransportError(this.node, this.env, error);
    }
  }

  private async runWithStdin(command: string, input: string): Promise<SwarmExecResult> {
    try {
      return await execWithStdin(this.ssh, this.node, command, input);
    } catch (error) {
      throw swarmTransportError(this.node, this.env, error);
    }
  }

  // -------------------------------------------------------------------------
  // External resources
  // -------------------------------------------------------------------------

  /** External overlay networks, by the name Docker knows them by (idempotent, parallel). */
  async createExternalNetworks(networks: string[]): Promise<void> {
    await Promise.all(
      networks.map((name) => {
        printDebug(`Creating overlay network: ${name}`);
        return this.run(`docker network create --driver overlay --attachable ${q(name)} 2>/dev/null || true`);
      }),
    );
  }

  /** External volumes, by the name Docker knows them by (idempotent, parallel). */
  async createExternalVolumes(volumes: string[]): Promise<void> {
    await Promise.all(
      volumes.map((name) => {
        printDebug(`Creating volume: ${name}`);
        return this.run(`docker volume create ${q(name)} 2>/dev/null || true`);
      }),
    );
  }

  async createExternalResources(networks: string[], volumes: string[]): Promise<void> {
    await Promise.all([this.createExternalNetworks(networks), this.createExternalVolumes(volumes)]);
  }

  // -------------------------------------------------------------------------
  // Deploy
  // -------------------------------------------------------------------------

  /** Services whose update or rollback is paused; a new deploy cannot move them. */
  async getStuckServices(stackName: string): Promise<string[]> {
    const listed = await this.run(`docker stack services ${q(stackName)} --format '{{.Name}}' 2>/dev/null || true`);
    const services = lines(listed.stdout);
    const states = await Promise.all(
      services.map(async (service) => {
        const inspected = await this.run(
          `docker service inspect ${q(service)} --format '{{json .UpdateStatus}}' 2>/dev/null || echo '{}'`,
        );
        const state = updateStateOf(inspected.stdout);
        return state === 'rollback_paused' || state === 'paused' ? service : null;
      }),
    );
    return states.filter((service): service is string => service !== null);
  }

  /** `docker stack rm`, then waits up to 60 s for the stack to disappear. */
  async removeStackAndWait(stackName: string): Promise<void> {
    const removed = await this.run(`docker stack rm ${q(stackName)}`);
    if (removed.exitCode !== 0) {
      printWarning(`docker stack rm failed (exit ${removed.exitCode}): ${removed.stderr.trim()}`);
    }

    for (let attempt = 0; attempt < STACK_REMOVAL_MAX_ATTEMPTS; attempt++) {
      await this.clock.sleep(STACK_REMOVAL_POLL_INTERVAL_MS);
      if (!(await this.stackListed(stackName))) {
        printDebug(`Stack ${stackName} removed`);
        return;
      }
    }

    throw new DeployError(
      `Stack ${stackName} still present after ${(STACK_REMOVAL_MAX_ATTEMPTS * STACK_REMOVAL_POLL_INTERVAL_MS) / 1000}s`,
      ErrorCode.DEPLOY_FAILED,
      'The stack may have resources preventing deletion. Check with `docker stack ps`.',
    );
  }

  private async stackListed(stackName: string): Promise<boolean> {
    const check = await this.run(`docker stack ls --format '{{.Name}}' | grep -xF ${q(stackName)} || echo ""`);
    return check.stdout.trim().length > 0;
  }

  /**
   * `docker stack deploy -c -` with the compose on stdin: it carries the stack's secrets, and a
   * file in /tmp would be readable by every local user for the whole deploy. A stack whose
   * services are stuck is removed first. `onStarted` fires right before the deploy is issued.
   */
  async deployStack(
    stackName: string,
    composeYaml: string,
    options: { prune?: boolean; withRegistryAuth?: boolean; onStarted?: () => void } = {},
  ): Promise<void> {
    const stuck = await this.getStuckServices(stackName);
    if (stuck.length > 0) {
      printWarning(`Stuck services detected: ${stuck.join(', ')}`);
      printWarning(`Removing stuck stack: ${stackName}`);
      await this.removeStackAndWait(stackName);
      await this.clock.sleep(STUCK_STACK_SETTLE_MS);
    }

    const parts = ['docker stack deploy'];
    if (options.prune !== false) parts.push('--prune');
    if (options.withRegistryAuth !== false) parts.push('--with-registry-auth');
    parts.push('-c -', q(stackName));

    options.onStarted?.();
    const result = await this.runWithStdin(parts.join(' '), composeYaml);
    if (result.exitCode !== 0) {
      throw new DeployError(
        `docker stack deploy failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    if (!(await this.stackListed(stackName))) {
      throw new DeployError(`Stack ${stackName} not found after deploy`, ErrorCode.DEPLOY_FAILED);
    }
    printDebug(`Stack ${stackName} deployed`);
  }

  /** Best effort, from stdin like the deploy itself; `docker compose` may be missing on the node. */
  async pullImages(composeYaml: string): Promise<void> {
    try {
      await this.runWithStdin('docker compose -f - pull 2>/dev/null || true', composeYaml);
    } catch (error) {
      printDebug(`Accessories image pull skipped: ${errorText(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Convergence
  // -------------------------------------------------------------------------

  /**
   * Polls until every service reached its desired replica count and no update is in progress.
   * A Swarm rollback or a paused update ends the wait early. Never throws for a failed
   * convergence; transport errors propagate.
   */
  async waitConvergence(stackName: string, options: SwarmWaitOptions = {}): Promise<SwarmConvergence> {
    const timeoutS = options.timeoutS ?? CONVERGENCE_TIMEOUT_S;
    const intervalMs = (options.intervalS ?? CONVERGENCE_INTERVAL_S) * 1000;
    const context = options.context ?? 'deployment';
    const deadline = this.clock.now() + timeoutS * 1000;
    const filterSet = options.servicesFilter?.length
      ? new Set(options.servicesFilter.map((service) => `${stackName}_${service}`))
      : null;

    const spinner = createTimedSpinner();
    spinner.start(`Waiting for ${context} convergence (timeout: ${timeoutS}s)...`);

    let lastReplicas: { name: string; current: number | null; desired: number | null }[] = [];
    try {
      while (this.clock.now() < deadline) {
        const listed = await this.run(
          `docker stack services ${q(stackName)} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
        );
        let rows = lines(listed.stdout).map(parseReplicaRow);
        if (filterSet) rows = rows.filter((row) => filterSet.has(row.name));
        if (rows.length === 0) {
          await this.clock.sleep(intervalMs);
          continue;
        }

        lastReplicas = rows;
        const statuses = rows.map(replicaStatus);
        const allConverged = rows.every((row) => row.current !== null && row.current === row.desired);
        const states = await this.getServiceUpdateStates(rows.map((row) => row.name));

        if (allConverged) {
          // During a redeploy the old replicas already match the desired count before the rolling
          // update starts; the update itself has to finish too.
          const updating = [...states.entries()].filter(([, state]) => state === 'updating').map(([name]) => name);
          if (updating.length === 0) {
            spinner.succeed(`All services converged: ${statuses.join(', ')}`);
            return { status: 'converged' };
          }
          printDebug(`Update in progress: ${updating.join(', ')}`);
          spinner.update(`Waiting for ${context} convergence: update in progress`);
          await this.clock.sleep(intervalMs);
          continue;
        }

        const failing = failingFromStates(states);
        if (failing) {
          spinner.fail('Convergence failed');
          const taskErrors = await this.getFailedTaskErrors(stackName).catch(() => '');
          return taskErrors ? { ...failing, message: `${failing.message}\n\nFailed tasks:\n${taskErrors}` } : failing;
        }

        printDebug(`Convergence: ${statuses.join(', ')}`);
        spinner.update(`Waiting for ${context} convergence: ${statuses.join(', ')}`);
        await this.clock.sleep(intervalMs);
      }
    } catch (error) {
      spinner.fail('Convergence failed');
      throw error;
    }

    const notConverged = lastReplicas.filter((row) => row.current === null || row.current !== row.desired);
    spinner.fail(`Convergence timeout after ${timeoutS}s`);
    return {
      status: 'timeout',
      message: `${context} convergence timeout after ${timeoutS}s. Non-converged services: ${notConverged.map(replicaStatus).join(', ')}`,
      suggestion: 'Check service logs with `dockflow logs <service>` for details.',
      services: notConverged.map((row) => ({ nativeName: row.name, reason: 'Timeout', detail: replicaStatus(row) })),
    };
  }

  /** `UpdateStatus.State` (lowercase, '' when none) of every service, in one SSH call. */
  private async getServiceUpdateStates(services: string[]): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    if (services.length === 0) return states;
    const result = await this.run(
      `for svc in ${services.map(q).join(' ')}; do ` +
        `STATE=$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null); ` +
        `printf '%s\\t%s\\n' "$svc" "$STATE"; ` +
        'done',
    );
    for (const line of lines(result.stdout)) {
      const [service, state = ''] = line.split('\t');
      states.set(service.trim(), state.trim().toLowerCase());
    }
    return states;
  }

  /** Errors of recently shut down tasks, to say why a rollback happened. */
  private async getFailedTaskErrors(stackName: string): Promise<string> {
    const result = await this.run(
      `docker stack ps ${q(stackName)} --no-trunc --filter 'desired-state=shutdown' --format '{{.Name}}|{{.Error}}' 2>/dev/null || echo ""`,
    );
    return lines(result.stdout)
      .map((line) => {
        const pipe = line.indexOf('|');
        if (pipe === -1) return null;
        const name = line.slice(0, pipe).trim();
        const error = line.slice(pipe + 1).trim();
        return error ? `  ${name}: ${error}` : null;
      })
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  /** `docker stack rm`, then waits until `docker stack ps` lists no task (accessories removal). */
  async removeStackAndDrain(stackName: string): Promise<void> {
    const removed = await this.run(`docker stack rm ${q(stackName)}`);
    if (removed.exitCode !== 0) {
      throw new DeployError(removed.stderr.trim() || 'Failed to remove stack', ErrorCode.DEPLOY_FAILED);
    }
    for (let attempt = 0; attempt < STACK_REMOVAL_MAX_ATTEMPTS; attempt++) {
      const check = await this.run(`docker stack ps ${q(stackName)} 2>&1 | grep -v "Nothing found" | wc -l`);
      // only the header line, or nothing
      if (Number.parseInt(check.stdout.trim(), 10) <= 1) return;
      await this.clock.sleep(STACK_REMOVAL_POLL_INTERVAL_MS);
    }
  }

  /**
   * Removes the volumes of a removed stack. A container still draining holds its volume, so
   * failures are reported by name instead of claiming the data was destroyed.
   */
  async removeStackVolumes(stackName: string): Promise<{ removed: string[]; failed: string[] }> {
    const listed = await this.run(
      `docker volume ls --filter ${q(`label=com.docker.stack.namespace=${stackName}`)} --format '{{.Name}}'`,
    );
    const volumes = lines(listed.stdout).map((line) => line.trim());
    const removed: string[] = [];
    const failed: string[] = [];
    for (const volume of volumes) {
      const result = await this.run(`docker volume rm ${q(volume)}`);
      if (result.exitCode === 0) removed.push(volume);
      else failed.push(`${volume}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    if (failed.length > 0) {
      for (const failure of failed) printWarning(`Volume not removed — ${failure}`);
      printWarning('Retry in a few seconds once the containers are gone: docker volume rm <name>');
    }
    return { removed, failed };
  }

  // -------------------------------------------------------------------------
  // Accessories hash (change detection of the accessory role)
  // -------------------------------------------------------------------------

  /** Directory of the hash file, named after the application stack (`<project>-<env>`). */
  static accessoriesStateDir(stackName: string): string {
    return `${DOCKFLOW_ACCESSORIES_DIR}/${stackName}`;
  }

  async readAccessoriesHash(stackName: string): Promise<string> {
    const file = `${SwarmStackOps.accessoriesStateDir(stackName)}/.hash`;
    const result = await this.run(`cat ${q(file)} 2>/dev/null || echo ""`);
    return result.stdout.trim();
  }

  async writeAccessoriesHash(stackName: string, hash: string): Promise<void> {
    const dir = SwarmStackOps.accessoriesStateDir(stackName);
    const result = await this.run(`mkdir -p ${q(dir)} && printf '%s\\n' ${q(hash)} > ${q(`${dir}/.hash`)}`);
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to record the accessories hash of ${stackName}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${dir}.`,
      );
    }
  }

  /** Forgets the accessories hash, so the next deploy re-creates removed accessories. */
  async clearAccessoriesHash(stackName: string): Promise<void> {
    await this.run(`rm -rf ${q(SwarmStackOps.accessoriesStateDir(stackName))}`);
  }
}

function updateStateOf(json: string): string {
  let value: unknown;
  try {
    value = JSON.parse(json.trim());
  } catch {
    return '';
  }
  if (value === null || typeof value !== 'object') return '';
  const state = (value as Record<string, unknown>).State;
  return typeof state === 'string' ? state.toLowerCase() : '';
}

function parseReplicaRow(line: string): { name: string; current: number | null; desired: number | null } {
  const [name = '', replicas = ''] = line.split('\t');
  const match = /^\s*(\d+)\/(\d+)/.exec(replicas);
  if (!match) return { name: name.trim(), current: null, desired: null };
  return { name: name.trim(), current: Number(match[1]), desired: Number(match[2]) };
}

function replicaStatus(row: { name: string; current: number | null; desired: number | null }): string {
  return row.current === null ? `${row.name} ?/?` : `${row.name} ${row.current}/${row.desired}`;
}

/** A Swarm rollback (the new version failed its checks) or a paused update. */
function failingFromStates(states: Map<string, string>): Exclude<SwarmConvergence, { status: 'converged' }> | null {
  const rolledBack: string[] = [];
  const stuck: string[] = [];
  for (const [service, state] of states) {
    if (state === 'rollback_started' || state === 'rollback_completed') rolledBack.push(service);
    else if (state === 'rollback_paused' || state === 'paused') stuck.push(service);
  }

  if (rolledBack.length > 0) {
    return {
      status: 'reverted',
      message: `Swarm auto-rolled back services: ${rolledBack.join(', ')}`,
      suggestion: 'The new version failed Swarm health checks. Check service logs for details.',
      services: rolledBack.map((nativeName) => ({
        nativeName,
        reason: 'TaskFailed',
        detail: `Swarm rolled back ${nativeName}`,
      })),
    };
  }
  if (stuck.length > 0) {
    const state = states.get(stuck[0]) ?? 'paused';
    return {
      status: 'failed',
      message: `Services stuck in ${state}: ${stuck.join(', ')}`,
      suggestion: 'Try `dockflow deploy --force` to force a fresh deployment.',
      services: stuck.map((nativeName) => ({
        nativeName,
        reason: 'Paused',
        detail: `${nativeName} is stuck in ${states.get(nativeName) ?? state}`,
      })),
    };
  }
  return null;
}
