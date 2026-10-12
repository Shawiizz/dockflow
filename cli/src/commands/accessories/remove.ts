/**
 * Accessories Remove Command
 * Remove the accessories stack entirely
 */

import type { Command } from 'commander';
import { sshExec, shellQuote } from '../../utils/ssh';
import type { SSHKeyConnection } from '../../types/connection';
import { createLock, type Lock } from '../../services/lock';
import { stopIfInterrupted, withDeployLock } from '../with-lock';
import { confirmPrompt, dangerousConfirmPrompt } from '../../utils/prompts';
import { printInfo, printIntro, printOutro, printNote, printWarning, printError, printBlank, printRaw, colors, createSpinner } from '../../utils/output';
import { resolveEnv, withResolvedEnv } from '../../utils/validation';
import { validateAccessoriesStack } from './utils';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';
import { nodesOf, onEveryNode, type NodeRef } from '../app/nodes';
import { STACK_REMOVAL_MAX_ATTEMPTS, STACK_REMOVAL_POLL_INTERVAL_MS, DOCKFLOW_ACCESSORIES_DIR } from '../../constants';

/**
 * Register the accessories remove command
 */
export function registerAccessoriesRemoveCommand(program: Command): void {
  program
    .command('remove <env>')
    .alias('rm')
    .description('Remove the accessories stack entirely')
    .option('-v, --volumes', 'Also remove associated volumes (DESTRUCTIVE)')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('-s, --server <name>', 'Target manager (defaults to the leader, or the first manager that answers)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      options: RemoveOptions
    ) => {
      const { connection, stackName, config, serverName } = await resolveEnv(env, options.server);
      const nodes = nodesOf(env, { name: serverName, connection });
      await removeAccessories(nodes, env, stackName, options, createLock(connection, stackName, config.lock?.stale_threshold_minutes));
    })));
}

interface RemoveOptions { volumes?: boolean; yes?: boolean; server?: string }

interface NodeVolumes {
  node: NodeRef;
  volumes: string[];
}

/** A local volume lives on the node that ran its task: every node is asked. */
async function listStackVolumes(nodes: readonly NodeRef[], stackName: string): Promise<NodeVolumes[]> {
  const listed = await onEveryNode(nodes, async (node) => {
    const result = await sshExec(node.connection, `docker volume ls --filter ${shellQuote(`label=com.docker.stack.namespace=${stackName}`)} --format '{{.Name}}'`);
    if (result.exitCode !== 0) throw new DockerError(result.stderr.trim() || `exit ${result.exitCode}`);
    return result.stdout.trim().split('\n').filter(Boolean);
  });
  return listed.map(({ node, value }) => ({ node, volumes: value })).filter(({ volumes }) => volumes.length > 0);
}

/**
 * Remove the accessories stack of `appStackName`; `nodes` starts with the manager to act through.
 * With `volumes`, a stack already gone whose volumes remain (an earlier removal interrupted) only
 * has its volumes deleted, on whichever nodes hold them.
 */
export async function removeAccessories(
  nodes: readonly NodeRef[],
  env: string,
  appStackName: string,
  options: RemoveOptions,
  lock?: Lock,
): Promise<void> {
  printIntro(`Removing Accessories - ${env}`);
  printBlank();

  const { connection } = nodes[0];
  const validation = await validateAccessoriesStack(connection, env);
  const { stackName, services } = validation;
  const volumes = options.volumes ? await listStackVolumes(nodes, stackName) : [];

  if (!validation.exists && volumes.length === 0) {
    throw new DockerError(
      'Accessories stack not found',
      { code: ErrorCode.STACK_NOT_FOUND, suggestion: 'Nothing to remove.' }
    );
  }

  if (services.length > 0) {
    printWarning('The following services will be removed:');
    const servicesResult = await sshExec(connection,
      `docker stack services ${stackName} --format "{{.Name}}\t{{.Replicas}}"`
    );
    for (const line of servicesResult.stdout.trim().split('\n')) {
      const [name, replicas] = line.split('\t');
      const shortName = name.replace(`${stackName}_`, '');
      printRaw(`  ${colors.info(shortName)} ${colors.dim(`(${replicas})`)}`);
    }
  }

  if (volumes.length > 0) {
    printBlank();
    printError('⚠ The following volumes will be PERMANENTLY DELETED:');
    for (const { node, volumes: names } of volumes) {
      for (const vol of names) printRaw(`  ${colors.error(vol)} ${colors.dim(`(${node.name})`)}`);
    }
  }

  printBlank();

  if (!options.yes) {
    const warningMessage = options.volumes
      ? 'This will PERMANENTLY DELETE the accessories stack and their data!'
      : 'This will remove the accessories stack (volumes will be preserved)';

    printWarning(warningMessage);

    if (options.volumes) {
      const confirmed = await dangerousConfirmPrompt({
        message: `Type '${env}' to confirm removal with volumes:`,
        expectedText: env,
      });

      if (!confirmed) {
        printInfo('Cancelled - text did not match');
        return;
      }
    } else {
      const confirmed = await confirmPrompt({
        message: 'Are you sure you want to remove the accessories stack?',
        initialValue: false,
      });

      if (!confirmed) {
        printInfo('Cancelled');
        return;
      }
    }
  }

  printBlank();

  const remove = async (signal?: AbortSignal) => {
    if (validation.exists) {
      await removeStack(connection, stackName);
    }

    // The next deploy compares against this hash: without it, it redeploys the accessories.
    await sshExec(connection, `rm -rf ${shellQuote(`${DOCKFLOW_ACCESSORIES_DIR}/${appStackName}`)}`);

    if (options.volumes) {
      if (signal) stopIfInterrupted(signal, 'deleting the volumes');
      await removeVolumes(env, stackName, await listStackVolumes(nodes, stackName));
    }
  };
  if (lock) await withDeployLock(lock, 'Remove accessories', remove);
  else await remove();

  printBlank();
  if (!options.volumes) {
    printNote(
      `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}"\n` +
      `docker volume rm <volume_name>`,
      'Volumes preserved — remove manually'
    );
  }
  printOutro('Accessories removed successfully');
}

async function removeStack(connection: SSHKeyConnection, stackName: string): Promise<void> {
  const spinner = createSpinner();
  spinner.start('Removing accessories stack...');

  const result = await sshExec(connection, `docker stack rm ${shellQuote(stackName)}`);
  if (result.exitCode !== 0) {
    spinner.fail('Remove failed');
    throw new DockerError(result.stderr || 'Failed to remove stack');
  }

  spinner.text = 'Waiting for stack removal...';
  for (let attempts = 0; attempts < STACK_REMOVAL_MAX_ATTEMPTS; attempts++) {
    const checkResult = await sshExec(connection,
      `docker stack ps ${shellQuote(stackName)} 2>&1 | grep -v "Nothing found" | wc -l`
    );
    if (parseInt(checkResult.stdout.trim(), 10) <= 1) {
      spinner.succeed('Accessories stack removed');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, STACK_REMOVAL_POLL_INTERVAL_MS));
  }

  spinner.fail('Accessories stack still being removed');
  throw new DockerError(`${stackName} still has tasks after ${STACK_REMOVAL_MAX_ATTEMPTS * STACK_REMOVAL_POLL_INTERVAL_MS / 1000}s`, {
    suggestion: 'Swarm keeps removing it; run the command again in a moment to finish.',
  });
}

/** Waits up to a minute for the stack's containers to leave the node: until then they hold their volumes. */
export function containersGoneCommand(stackName: string): string {
  const filter = shellQuote(`label=com.docker.stack.namespace=${stackName}`);
  return `for i in $(seq 1 30); do [ -z "$(docker ps -aq --filter ${filter})" ] && exit 0; sleep 2; done; exit 1`;
}

async function removeVolumes(env: string, stackName: string, found: NodeVolumes[]): Promise<void> {
  const total = found.reduce((sum, { volumes }) => sum + volumes.length, 0);
  if (total === 0) return;

  const spinner = createSpinner();
  spinner.start('Removing volumes...');

  const failed: string[] = [];
  for (const { node, volumes } of found) {
    await sshExec(node.connection, containersGoneCommand(stackName));
    for (const vol of volumes) {
      const rmResult = await sshExec(node.connection, `docker volume rm ${shellQuote(vol)}`);
      if (rmResult.exitCode !== 0) {
        failed.push(`${vol} on ${node.name}: ${rmResult.stderr.trim() || `exit ${rmResult.exitCode}`}`);
      }
    }
  }

  if (failed.length === 0) {
    spinner.succeed(`Removed ${total} volume(s)`);
    return;
  }

  spinner.fail(`Removed ${total - failed.length}/${total} volume(s)`);
  for (const failure of failed) {
    printWarning(`Volume not removed — ${failure}`);
  }
  throw new DockerError(`${failed.length} volume(s) could not be removed`, {
    suggestion: `Retry in a few seconds, once the containers are gone: dockflow accessories remove ${env} --volumes`,
  });
}
