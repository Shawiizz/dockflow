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
   * Create external overlay networks (idempotent).
   */
  async createExternalNetworks(networks: string[]): Promise<void> {
    for (const name of networks) {
      printDebug(`Creating overlay network: ${name}`);
      await sshExec(
        this.connection,
        `docker network create --driver overlay --attachable ${name} 2>/dev/null || true`,
      );
    }
  }

  /**
   * Create external volumes (idempotent).
   */
  async createExternalVolumes(volumes: string[]): Promise<void> {
    for (const name of volumes) {
      printDebug(`Creating volume: ${name}`);
      await sshExec(
        this.connection,
        `docker volume create ${name} 2>/dev/null || true`,
      );
    }
  }

  /**
   * Detect services in a stuck state (rollback_paused, update_paused).
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

    const stuck: string[] = [];
    for (const svc of serviceNames) {
      const inspectResult = await sshExec(
        this.connection,
        `docker service inspect ${svc} --format '{{json .UpdateStatus}}' 2>/dev/null || echo '{}'`,
      );

      const raw = inspectResult.stdout.trim();
      try {
        const status = JSON.parse(raw);
        const state = (status?.State ?? '').toLowerCase();
        if (state === 'rollback_paused' || state === 'paused') {
          stuck.push(svc);
        }
      } catch {
        // Ignore unparseable output
      }
    }

    return stuck;
  }

  /**
   * Force-remove a stuck stack. Waits up to 60s for the stack to disappear.
   */
  async forceRemoveStack(stackName: string): Promise<void> {
    printWarning(`Removing stuck stack: ${stackName}`);
    await sshExec(this.connection, `docker stack rm ${stackName}`);

    for (let i = 0; i < STACK_REMOVAL_MAX_ATTEMPTS; i++) {
      await sleep(STACK_REMOVAL_POLL_INTERVAL_MS);

      const check = await sshExec(
        this.connection,
        `docker stack ls --format '{{.Name}}' | grep -w '^${stackName}$' || echo ""`,
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

    // 2. Deploy via stdin heredoc
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
      `docker stack ls --format '{{.Name}}' | grep -w '^${stackName}$' || echo ""`,
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
   */
  async waitConvergence(
    stackName: string,
    options?: { timeout?: number; interval?: number; context?: string },
  ): Promise<void> {
    const timeout = (options?.timeout ?? CONVERGENCE_TIMEOUT_S) * 1000;
    const interval = (options?.interval ?? CONVERGENCE_INTERVAL_S) * 1000;
    const ctx = options?.context ?? 'deployment';
    const deadline = Date.now() + timeout;

    printDim(`Waiting for ${ctx} convergence (timeout: ${timeout / 1000}s)...`);

    while (Date.now() < deadline) {
      const result = await sshExec(
        this.connection,
        `docker stack services ${stackName} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
      );

      const lines = result.stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        // Stack may not have services yet — wait
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

      if (allConverged) {
        printDebug(`All services converged: ${statuses.join(', ')}`);
        return;
      }

      printDebug(`Convergence: ${statuses.join(', ')}`);
      await sleep(interval);
    }

    // Timeout — collect details for error message
    const finalResult = await sshExec(
      this.connection,
      `docker stack services ${stackName} --format '{{.Name}}\t{{.Replicas}}' 2>/dev/null || echo ""`,
    );

    const notConverged = finalResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const replicas = line.split('\t')[1];
        if (!replicas || !replicas.includes('/')) return true;
        const [c, d] = replicas.split('/').map(Number);
        return c !== d;
      })
      .map((line) => line.replace('\t', ' '));

    throw new DeployError(
      `${ctx} convergence timeout after ${timeout / 1000}s. Non-converged services: ${notConverged.join(', ')}`,
      ErrorCode.DEPLOY_FAILED,
      'Check service logs with `dockflow logs <service>` for details.',
    );
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

    // 3. Pull images (best-effort, ignore errors)
    const escapedPullYaml = shellEscape(accessoriesComposeYaml);
    await sshExec(
      this.connection,
      `echo '${escapedPullYaml}' | docker compose -f - pull 2>/dev/null || true`,
    ).catch(() => {
      // Ignore pull errors entirely
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
