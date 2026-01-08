/**
 * Lock release command - Release a deployment lock
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printSuccess, printInfo } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockReleaseCommand(parent: Command): void {
  parent
    .command('release <env>')
    .description('Release a deployment lock')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('--force', 'Force release without confirmation')
    .action(withErrorHandler(async (env: string, options: { server?: string; force?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      
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
        const removeResult = sshExec(connection, `rm -f "${lockFile}"`);
        
        if (removeResult.exitCode !== 0) {
          spinner.fail('Failed to remove lock file');
          throw new CLIError(`Failed to remove lock: ${removeResult.stderr}`, ErrorCode.COMMAND_FAILED);
        }

        // Verify the lock was actually removed
        const verifyResult = sshExec(connection, `test -f "${lockFile}" && echo "EXISTS" || echo "REMOVED"`);
        if (verifyResult.stdout.trim() === 'EXISTS') {
          spinner.fail('Lock file still exists after removal attempt');
          throw new CLIError(
            'Could not remove lock file. Check permissions on the server.',
            ErrorCode.COMMAND_FAILED
          );
        }
        
        spinner.succeed(`Lock released for ${stackName}`);
        console.log(chalk.gray('  Deployments to this environment are now allowed.'));
      } catch (error) {
        if (error instanceof CLIError) throw error;
        spinner.fail('Failed to release lock');
        throw new CLIError(`${error}`, ErrorCode.COMMAND_FAILED);
      }
    }));
}
