/**
 * Lock acquire command - Manually acquire a deployment lock
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printError, printSuccess, printWarning } from '../../utils/output';
import { validateEnvOrExit } from '../../utils/validation';

export function registerLockAcquireCommand(parent: Command): void {
  parent
    .command('acquire <env>')
    .description('Acquire a deployment lock (prevents other deployments)')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-m, --message <message>', 'Lock message/reason')
    .option('--force', 'Force acquire even if already locked')
    .action(async (env: string, options: { server?: string; message?: string; force?: boolean }) => {
      const { stackName, connection } = await validateEnvOrExit(env, options.server);
      
      const lockFile = `/var/lib/dockflow/locks/${stackName}.lock`;
      const lockDir = '/var/lib/dockflow/locks';
      const spinner = ora();

      try {
        // Check for existing lock
        spinner.start('Checking for existing lock...');
        const checkResult = await sshExec(connection, `cat "${lockFile}" 2>/dev/null || echo "NO_LOCK"`);
        const output = checkResult.stdout.trim();

        if (output !== 'NO_LOCK' && !options.force) {
          spinner.stop();
          try {
            const lockInfo = JSON.parse(output);
            printWarning('Deployment is already locked');
            console.log(chalk.gray(`  Holder:  ${lockInfo.performer}`));
            console.log(chalk.gray(`  Started: ${lockInfo.started_at}`));
            console.log(chalk.gray(`  Version: ${lockInfo.version}`));
            console.log('');
            console.log(chalk.yellow('Use --force to override the existing lock.'));
          } catch {
            printWarning('Lock file exists but could not be parsed. Use --force to override.');
          }
          process.exit(1);
        }

        // Create lock
        spinner.text = 'Acquiring lock...';
        const now = new Date();
        const lockContent = JSON.stringify({
          performer: `${process.env.USER || 'cli'}@${process.env.HOSTNAME || 'local'}`,
          started_at: now.toISOString(),
          timestamp: Math.floor(now.getTime() / 1000),
          version: 'manual-lock',
          stack: stackName,
          message: options.message || 'Manual lock via CLI'
        }, null, 2);

        await sshExec(connection, `mkdir -p "${lockDir}" && cat > "${lockFile}" << 'EOF'\n${lockContent}\nEOF`);
        
        spinner.succeed(`Lock acquired for ${stackName}`);
        console.log('');
        console.log(chalk.gray('  Deployments to this environment are now blocked.'));
        console.log(chalk.gray('  Release with: dockflow lock release ' + env));
        
        if (options.message) {
          console.log(chalk.gray(`  Reason: ${options.message}`));
        }
      } catch (error) {
        spinner.fail('Failed to acquire lock');
        printError(`${error}`);
        process.exit(1);
      }
    });
}
