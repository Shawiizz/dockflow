/**
 * `docker stack deploy` and what goes with it: the external networks and volumes created first,
 * a stack stuck in a paused update removed before, and the accessories stack deployed only when
 * its compose changed.
 */

import type { SSHKeyConnection } from '../../types';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug, printInfo, printWarning, printSuccess } from '../../utils/output';
import { DeployError, ErrorCode } from '../../utils/errors';
import { accessoriesDigest } from '../compose';
import { DOCKFLOW_ACCESSORIES_DIR, STACK_REMOVAL_MAX_ATTEMPTS, STACK_REMOVAL_POLL_INTERVAL_MS } from '../../constants';
import type { SwarmClock } from './clock';
import { waitForConvergence } from './convergence';

/** The cause of a failed `docker stack deploy`, without the warnings it prints first about keys Swarm ignores. */
export function stackDeployFailure(stderr: string): string {
  const lines = stderr.trim().split('\n');
  const cause = lines.filter((line) => !/^Ignoring (unsupported|deprecated) options:/.test(line.trim()));
  return (cause.length > 0 ? cause : lines).join('\n').trim();
}

/** Creates the external overlay networks and volumes (idempotent, parallel). */
export async function createExternalResources(connection: SSHKeyConnection, networks: string[], volumes: string[]): Promise<void> {
  await Promise.all([
    ...networks.map((name) => {
      printDebug(`Creating overlay network: ${name}`);
      return sshExec(connection, `docker network create --driver overlay --attachable ${shellQuote(name)} 2>/dev/null || true`);
    }),
    ...volumes.map((name) => {
      printDebug(`Creating volume: ${name}`);
      return sshExec(connection, `docker volume create ${shellQuote(name)} 2>/dev/null || true`);
    }),
  ]);
}

/** Services of the stack stuck in a paused update or rollback. */
async function stuckServices(connection: SSHKeyConnection, stackName: string): Promise<string[]> {
  const listResult = await sshExec(
    connection,
    `docker stack services ${shellQuote(stackName)} --format '{{.Name}}' 2>/dev/null || true`,
  );

  const serviceNames = listResult.stdout
    .trim()
    .split('\n')
    .filter(Boolean);

  if (serviceNames.length === 0) return [];

  const results = await Promise.all(serviceNames.map(async (svc) => {
    const inspectResult = await sshExec(
      connection,
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
      // unparseable output counts as not stuck
    }
    return null;
  }));

  return results.filter((s): s is string => s !== null);
}

/** Removes a stack and waits up to 60s for it to disappear. */
export async function removeStackAndWait(connection: SSHKeyConnection, clock: SwarmClock, stackName: string): Promise<void> {
  const rmResult = await sshExec(connection, `docker stack rm ${shellQuote(stackName)}`);
  if (rmResult.exitCode !== 0) {
    printWarning(`docker stack rm failed (exit ${rmResult.exitCode}): ${rmResult.stderr.trim()}`);
  }

  for (let i = 0; i < STACK_REMOVAL_MAX_ATTEMPTS; i++) {
    await clock.sleep(STACK_REMOVAL_POLL_INTERVAL_MS);

    const check = await sshExec(
      connection,
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
 * Deploys a stack from its compose, sent on stdin: it carries the stack's secrets. A stack stuck
 * in a paused update is removed first. Resolves to the manager's clock when the deploy started, in
 * milliseconds, null when it could not be read.
 */
export async function deployStack(
  connection: SSHKeyConnection,
  clock: SwarmClock,
  stackName: string,
  composeYaml: string,
  options?: { prune?: boolean; withRegistryAuth?: boolean },
): Promise<number | null> {
  const prune = options?.prune !== false;
  const registryAuth = options?.withRegistryAuth !== false;

  const stuck = await stuckServices(connection, stackName);
  if (stuck.length > 0) {
    printWarning(`Stuck services detected: ${stuck.join(', ')}; removing stack ${stackName} before deploying`);
    await removeStackAndWait(connection, clock, stackName);
    await clock.sleep(3000);
  }

  const flags = [
    prune ? '--prune' : '',
    registryAuth ? '--with-registry-auth' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const serverNow = await sshExec(connection, 'date -u +%s').catch(() => null);
  const seconds = Number(serverNow?.stdout.trim());
  const startedAt = serverNow && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;

  const result = await sshExec(connection, `docker stack deploy ${flags} -c - ${shellQuote(stackName)}`, { stdin: composeYaml });

  if (result.exitCode !== 0) {
    throw new DeployError(
      `docker stack deploy failed (exit ${result.exitCode}): ${stackDeployFailure(result.stderr)}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  const verify = await sshExec(
    connection,
    `docker stack ls --format '{{.Name}}' | grep -xF ${shellQuote(stackName)} || echo ""`,
  );

  if (!verify.stdout.trim()) {
    throw new DeployError(
      `Stack ${stackName} not found after deploy`,
      ErrorCode.DEPLOY_FAILED,
    );
  }

  printDebug(`Stack ${stackName} deployed`);
  return startedAt;
}

/** The digest of the accessories compose last deployed for the stack, null when none was. */
export async function readAccessoriesDigest(connection: SSHKeyConnection, stackName: string): Promise<string | null> {
  const result = await sshExec(
    connection,
    `cat ${shellQuote(`${DOCKFLOW_ACCESSORIES_DIR}/${stackName}/.hash`)} 2>/dev/null || echo ""`,
  );
  return result.stdout.trim() || null;
}

/**
 * Deploys the accessories stack of `stackName`, skipped when its compose is the one last deployed
 * and its stack still runs (unless `force`). Resolves to whether a deploy ran.
 */
export async function deployAccessories(
  connection: SSHKeyConnection,
  clock: SwarmClock,
  stackName: string,
  accessoriesComposeYaml: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const accessoriesStackName = `${stackName}-accessories`;
  const hashDir = `${DOCKFLOW_ACCESSORIES_DIR}/${stackName}`;
  const hashFile = `${hashDir}/.hash`;

  const localHash = accessoriesDigest(accessoriesComposeYaml);

  if (!options?.force) {
    const remoteResult = await sshExec(
      connection,
      `cat ${shellQuote(hashFile)} 2>/dev/null || echo ""`,
    );
    const remoteHash = remoteResult.stdout.trim();

    if (remoteHash === localHash) {
      // a stack removed by hand leaves its hash behind
      const present = await sshExec(
        connection,
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

  // pulled first (best-effort), from stdin like the deploy itself
  try {
    await sshExec(connection, `docker compose -f - pull 2>/dev/null || true`, { stdin: accessoriesComposeYaml });
  } catch {
    printDebug('Accessories image pull skipped (compose v2 not available or pull failed)');
  }

  const deployStartedAt = await deployStack(connection, clock, accessoriesStackName, accessoriesComposeYaml, {
    prune: true,
    withRegistryAuth: true,
  });

  await waitForConvergence(connection, clock, accessoriesStackName, { context: 'accessories', deployStartedAt });

  // recorded only once they converged: a failed deploy is tried again next time
  await sshExec(
    connection,
    `mkdir -p ${shellQuote(hashDir)} && echo ${shellQuote(localHash)} > ${shellQuote(hashFile)}`,
  );

  printSuccess('Accessories deployed');
  return true;
}
