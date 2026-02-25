/**
 * Accessories Deploy Command
 * Deploy accessories (databases, caches, etc.) to the environment
 *
 * This is a convenience wrapper around: dockflow deploy <env> --accessories
 */

import type { Command } from 'commander';
import { printHeader, printInfo, printBlank } from '../../utils/output';
import { withErrorHandler } from '../../utils/errors';

/**
 * Register the accessories deploy command
 */
export function registerAccessoriesDeployCommand(program: Command): void {
  program
    .command('deploy <env> [version]')
    .description('Deploy accessories (databases, caches, etc.)')
    .option('--skip-docker-install', 'Skip Docker installation')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(async (
      env: string,
      version: string | undefined,
      options: { skipDockerInstall?: boolean; debug?: boolean }
    ) => {
      printHeader(`Deploying Accessories to ${env}`);
      printBlank();
      printInfo('Redirecting to: dockflow deploy --accessories');
      printBlank();

      const { runDeploy } = await import('../deploy');

      await runDeploy(env, version, {
        accessories: true,
        skipDockerInstall: options.skipDockerInstall,
        debug: options.debug,
      });
    }));
}
