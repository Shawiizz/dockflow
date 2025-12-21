/**
 * Lock release command - Release a deployment lock
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printError, printSuccess, printInfo } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerLockReleaseCommand(parent: Command): void {
  parent
    .command('release <env>')
    .description('Release a deployment lock')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--force', 'Force release without confirmation')
    .action(async (env: string, options: { server?: string; force?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const lockFile = `/var/lib/dockflow/locks/${stackName}.lock`;
      const spinner = ora();

      try {
        // Check if lock exists
        spinner.start('Checking lock status...');
        const checkResult = await sshExec(connection, `cat "${lockFile}" 2>/dev/null || echo "NO_LOCK"`);
        const output = checkResult.stdout.trim();

        if (output === 'NO_LOCK') {
          spinner.info(`No lock found for ${stackName}`);
          return;
        }

        // Show lock info before releasing
        spinner.stop();
        try {
          const lockInfo = JSON.parse(output);
          printInfo('Current lock:');
          console.log(chalk.gray(`  Holder:  ${lockInfo.performer}`));
          console.log(chalk.gray(`  Started: ${lockInfo.started_at}`));
          console.log(chalk.gray(`  Version: ${lockInfo.version}`));
          if (lockInfo.message) {
            console.log(chalk.gray(`  Message: ${lockInfo.message}`));
          }
          console.log('');
        } catch {
          // Ignore parse errors
        }

        // Release lock
        spinner.start('Releasing lock...');
        await sshExec(connection, `rm -f "${lockFile}"`);
        
        spinner.succeed(`Lock released for ${stackName}`);
        console.log(chalk.gray('  Deployments to this environment are now allowed.'));
      } catch (error) {
        spinner.fail('Failed to release lock');
        printError(`${error}`);
        process.exit(1);
      }
    });
}
