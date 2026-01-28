/**
 * Lock acquire command - Manually acquire a deployment lock
 */

import type { Command } from 'commander';
import ora from 'ora';
import { sshExec } from '../../utils/ssh';
import { printSuccess, printWarning, colors } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { CLIError, ErrorCode, withErrorHandler } from '../../utils/errors';

export function registerLockAcquireCommand(parent: Command): void {
  parent
    .command('acquire <env>')
    .description('Acquire a deployment lock (prevents other deployments)')
    .option('-s, --server <name>', 'Target server (defaults to manager)')
    .option('-m, --message <message>', 'Lock message/reason')
    .option('--force', 'Force acquire even if already locked')
    .action(withErrorHandler(async (env: string, options: { server?: string; message?: string; force?: boolean }) => {
      const { stackName, connection } = validateEnv(env, options.server);
      
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
            console.log(colors.dim(`  Holder:  ${lockInfo.performer}`));
            console.log(colors.dim(`  Started: ${lockInfo.started_at}`));
            console.log(colors.dim(`  Version: ${lockInfo.version}`));
            console.log('');
            throw new CLIError('Use --force to override the existing lock.', ErrorCode.DEPLOY_LOCKED);
          } catch (e) {
            if (e instanceof CLIError) throw e;
            throw new CLIError('Lock file exists but could not be parsed. Use --force to override.', ErrorCode.DEPLOY_LOCKED);
          }
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
        console.log(colors.dim('  Deployments to this environment are now blocked.'));
        console.log(colors.dim('  Release with: dockflow lock release ' + env));
        
        if (options.message) {
          console.log(colors.dim(`  Reason: ${options.message}`));
        }
      } catch (error) {
        if (error instanceof CLIError) throw error;
        spinner.fail('Failed to acquire lock');
        throw new CLIError(`${error}`, ErrorCode.COMMAND_FAILED);
      }
    }));
}
