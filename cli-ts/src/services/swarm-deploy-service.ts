/**
 * Swarm Deploy Service
 *
 * Replaces the Ansible roles `docker-swarm`, `accessories`,
 * `_shared/wait-convergence`, and `_shared/create-resources`.
 *
 * Handles external resource creation, stack deployment via
 * `docker stack deploy`, stuck-service recovery, convergence
 * polling, and hash-based accessories change detection.
 */

import { createHash } from 'crypto';
import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printDim, printInfo, printWarning, printSuccess } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import {
  DOCKFLOW_ACCESSORIES_DIR,
  STACK_REMOVAL_MAX_ATTEMPTS,
  STACK_REMOVAL_POLL_INTERVAL_MS,
  CONVERGENCE_TIMEOUT_S,
  CONVERGENCE_INTERVAL_S,
} from '../constants';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SwarmDeployService {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Create external overlay networks (idempotent, parallel).
   */
  async createExternalNetworks(networks: string[]): Promise<void> {
    if (networks.length === 0) return;
    await Promise.all(networks.map((name) => {
      printDebug(`Creating overlay network: ${name}`);
      return sshExec(
        this.connection,
        `docker network create --driver overlay --attachable ${name} 2>/dev/null || true`,
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
        `docker volume create ${name} 2>/dev/null || true`,
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
      `docker stack services ${stackName} --format '{{.Name}}' 2>/dev/null || true`,
    );

    const serviceNames = listResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean);

    if (serviceNames.length === 0) return [];

    const results = await Promise.all(serviceNames.map(async (svc) => {
      const inspectResult = await sshExec(
        this.connection,
        `docker service inspect ${svc} --format '{{json .UpdateStatus}}' 2>/dev/null || echo '{}'`,
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
   * Force-remove a stuck stack. Waits up to 60s for the stack to disappear.
   */
  async forceRemoveStack(stackName: string): Promise<void> {
    printWarning(`Removing stuck stack: ${stackName}`);
    const rmResult = await sshExec(this.connection, `docker stack rm ${stackName}`);
    if (rmResult.exitCode !== 0) {
      printWarning(`docker stack rm failed (exit ${rmResult.exitCode}): ${rmResult.stderr.trim()}`);
    }

    for (let i = 0; i < STACK_REMOVAL_MAX_ATTEMPTS; i++) {
      await sleep(STACK_REMOVAL_POLL_INTERVAL_MS);

      const check = await sshExec(
        this.connection,
        `docker stack ls --format '{{.Name}}' | grep -xF '${stackName}' || echo ""`,
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
   * 2. Pipes compose YAML via heredoc to `docker stack deploy -c -`.
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
      printWarning(`Stuck services detected: ${stuck.join(', ')}`);
      await this.forceRemoveStack(stackName);
      await sleep(3000);
    }

    // 2. Deploy via stdin
    const flags = [
      prune ? '--prune' : '',
      registryAuth ? '--with-registry-auth' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const escapedYaml = shellEscape(composeYaml);

    const result = await sshExec(
      this.connection,
      `echo '${escapedYaml}' | docker stack deploy ${flags} -c - ${stackName}`,
    );

    if (result.exitCode !== 0) {
      throw new DeployError(
        `docker stack deploy failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    // 3. Verify stack exists
    const verify = await sshExec(
      this.connection,
      `docker stack ls --format '{{.Name}}' | grep -xF '${stackName}' || echo ""`,
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
    options?: { timeout?: number; interval?: number; context?: string },
  ): Promise<void> {
    const timeout = (options?.timeout ?? CONVERGENCE_TIMEOUT_S) * 1000;
    const interval = (options?.interval ?? CONVERGENCE_INTERVAL_S) * 1000;
    const ctx = options?.context ?? 'deployment';
    const deadline = Date.now() + timeout;
    const progressIntervalMs = 30_000;
    let lastProgressAt = Date.now();

    printDim(`Waiting for ${ctx} convergence (timeout: ${timeout / 1000}s)...`);

    let lastStatuses: string[] = [];

    while (Date.now() < deadline) {
      const result = await sshExec(
        this.connection,
        `docker stack services ${stackName} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
      );

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        await sleep(interval);
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

        const [currentStr, desiredStr] = replicas.split('/');
        const current = parseInt(currentStr, 10);
        const desired = parseInt(desiredStr, 10);

        if (current !== desired) {
          allConverged = false;
        }
        statuses.push(`${name} ${current}/${desired}`);
      }

      lastStatuses = statuses;

      if (allConverged) {
        printDebug(`All services converged: ${statuses.join(', ')}`);
        return;
      }

      // Detect rollback/crash-loop states (parallel inspect)
      await this.detectFailingServices(stackName, lines);

      printDebug(`Convergence: ${statuses.join(', ')}`);

      // Progress indicator every 30s for non-verbose mode
      const now = Date.now();
      if (now - lastProgressAt >= progressIntervalMs) {
        const elapsed = Math.round((now - (deadline - timeout)) / 1000);
        printDim(`  Still waiting (${elapsed}s): ${statuses.join(', ')}`);
        lastProgressAt = now;
      }

      await sleep(interval);
    }

    // Timeout — use last known statuses
    const notConverged = lastStatuses.filter((s) => {
      const match = s.match(/(\d+)\/(\d+)$/);
      return !match || match[1] !== match[2];
    });

    throw new DeployError(
      `${ctx} convergence timeout after ${timeout / 1000}s. Non-converged services: ${notConverged.join(', ')}`,
      ErrorCode.DEPLOY_FAILED,
      'Check service logs with `dockflow logs <service>` for details.',
    );
  }

  /**
   * Detect services in rollback or crash-loop states during convergence.
   * Inspects UpdateStatus in parallel and throws immediately on detection.
   */
  private async detectFailingServices(stackName: string, serviceLines: string[]): Promise<void> {
    const serviceNames = serviceLines.map((l) => l.split('\t')[0]).filter(Boolean);
    if (serviceNames.length === 0) return;

    // Single SSH call: inspect all services at once, output name\tstate pairs
    const quoted = serviceNames.map((s) => `'${shellEscape(s)}'`).join(' ');
    const result = await sshExec(
      this.connection,
      `for svc in ${quoted}; do ` +
        `STATE=$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null); ` +
        `echo "$svc\t$STATE"; ` +
      `done`,
    );

    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const parsed = lines.map((l) => {
      const [svc, state] = l.split('\t');
      return { svc, state: (state || '').toLowerCase() };
    });

    const rolledBack = parsed.filter((r) =>
      r.state === 'rollback_started' || r.state === 'rollback_completed',
    );
    if (rolledBack.length > 0) {
      throw new DeployError(
        `Swarm auto-rolled back services: ${rolledBack.map((r) => r.svc).join(', ')}`,
        ErrorCode.DEPLOY_FAILED,
        'The new version failed Swarm health checks. Check service logs for details.',
      );
    }

    const stuck = parsed.filter((r) =>
      r.state === 'rollback_paused' || r.state === 'paused',
    );
    if (stuck.length > 0) {
      throw new DeployError(
        `Services stuck in ${stuck[0].state}: ${stuck.map((r) => r.svc).join(', ')}`,
        ErrorCode.DEPLOY_FAILED,
        'Try `dockflow deploy --force` to force a fresh deployment.',
      );
    }
  }

  /**
   * Deploy accessories stack with hash-based change detection.
   *
   * Skips deploy if the compose content hasn't changed since last deploy
   * (unless `options.force` is true).
   */
  async deployAccessories(
    stackName: string,
    accessoriesComposePath: string,
    accessoriesComposeYaml: string,
    options?: { force?: boolean },
  ): Promise<void> {
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
        `cat "${hashFile}" 2>/dev/null || echo ""`,
      );
      const remoteHash = remoteResult.stdout.trim();

      if (remoteHash === localHash) {
        printInfo('Accessories unchanged, skipping');
        return;
      }
    }

    printInfo('Deploying accessories...');

    // 3. Pull images (best-effort)
    const escapedPullYaml = shellEscape(accessoriesComposeYaml);
    await sshExec(
      this.connection,
      `echo '${escapedPullYaml}' | docker compose -f - pull 2>/dev/null || true`,
    ).catch(() => {
      printDebug('Accessories image pull skipped (compose v2 not available or pull failed)');
    });

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
      `mkdir -p "${hashDir}" && echo '${localHash}' > "${hashFile}"`,
    );

    printSuccess('Accessories deployed');
  }
}
