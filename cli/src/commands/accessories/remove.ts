/**
 * Accessories Remove Command
 * Remove the accessories stack entirely
 */

import type { Command } from 'commander';
import { sshExec, shellQuote } from '../../utils/ssh';
import type { SSHKeyConnection } from '../../types/connection';
import { confirmPrompt, dangerousConfirmPrompt } from '../../utils/prompts';
import { printInfo, printIntro, printOutro, printNote, printWarning, printError, printBlank, printRaw, colors, createSpinner } from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { validateAccessoriesStack } from './utils';
import { DockerError, ErrorCode, withErrorHandler } from '../../utils/errors';
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
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .action(withErrorHandler(withResolvedEnv(async (
      env: string,
      options: RemoveOptions
    ) => {
      const { connection, stackName } = validateEnv(env, options.server);
      await removeAccessories(connection, env, stackName, options);
    })));
}

interface RemoveOptions { volumes?: boolean; yes?: boolean; server?: string }

function listStackVolumes(connection: SSHKeyConnection, stackName: string): Promise<string[]> {
  return sshExec(connection,
    `docker volume ls --filter "label=com.docker.stack.namespace=${stackName}" --format "{{.Name}}"`
  ).then((result) => result.stdout.trim().split('\n').filter(Boolean));
}

/**
 * Remove the accessories stack of `appStackName`. With `volumes`, a stack already gone
 * whose volumes remain (an earlier removal interrupted) only has its volumes deleted.
 */
export async function removeAccessories(
  connection: SSHKeyConnection,
  env: string,
  appStackName: string,
  options: RemoveOptions
): Promise<void> {
  printIntro(`Removing Accessories - ${env}`);
  printBlank();

  const validation = await validateAccessoriesStack(connection, env);
  const { stackName, services } = validation;
  const volumes = options.volumes ? await listStackVolumes(connection, stackName) : [];

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
    for (const vol of volumes) {
      printRaw(`  ${colors.error(vol)}`);
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

  if (validation.exists) {
    await removeStack(connection, stackName);
  }

  // The next deploy compares against this hash: without it, it redeploys the accessories.
  await sshExec(connection, `rm -rf ${shellQuote(`${DOCKFLOW_ACCESSORIES_DIR}/${appStackName}`)}`);

  if (options.volumes) {
    await removeVolumes(connection, env, await listStackVolumes(connection, stackName));
  }

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

  const result = await sshExec(connection, `docker stack rm ${stackName}`);
  if (result.exitCode !== 0) {
    spinner.fail('Remove failed');
    throw new DockerError(result.stderr || 'Failed to remove stack');
  }

  spinner.text = 'Waiting for stack removal...';
  for (let attempts = 0; attempts < STACK_REMOVAL_MAX_ATTEMPTS; attempts++) {
    const checkResult = await sshExec(connection,
      `docker stack ps ${stackName} 2>&1 | grep -v "Nothing found" | wc -l`
    );
    if (parseInt(checkResult.stdout.trim(), 10) <= 1) break;
    await new Promise(resolve => setTimeout(resolve, STACK_REMOVAL_POLL_INTERVAL_MS));
  }

  spinner.succeed('Accessories stack removed');
}

async function removeVolumes(connection: SSHKeyConnection, env: string, volumes: string[]): Promise<void> {
  if (volumes.length === 0) return;

  const spinner = createSpinner();
  spinner.start('Removing volumes...');

  // Right after `docker stack rm`, a draining container can still hold its volume.
  const failed: string[] = [];
  for (const vol of volumes) {
    const rmResult = await sshExec(connection, `docker volume rm ${shellQuote(vol)}`);
    if (rmResult.exitCode !== 0) {
      failed.push(`${vol}: ${rmResult.stderr.trim() || `exit ${rmResult.exitCode}`}`);
    }
  }

  if (failed.length === 0) {
    spinner.succeed(`Removed ${volumes.length} volume(s)`);
    return;
  }

  spinner.fail(`Removed ${volumes.length - failed.length}/${volumes.length} volume(s)`);
  for (const failure of failed) {
    printWarning(`Volume not removed — ${failure}`);
  }
  throw new DockerError(`${failed.length} volume(s) could not be removed`, {
    suggestion: `Retry in a few seconds, once the containers are gone: dockflow accessories remove ${env} --volumes`,
  });
}
