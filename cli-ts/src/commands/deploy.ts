/**
 * Deploy command
 * Uses Docker to run Ansible playbooks
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { join } from 'path';
import { getProjectRoot, loadConfig, isDockerAvailable, getAnsibleDockerImage } from '../utils/config';
import { printError, printSuccess, printInfo, printHeader, printWarning } from '../utils/output';

/**
 * Register deploy command
 */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <env> [version]')
    .description('Deploy application to specified environment')
    .option('--services <services>', 'Comma-separated list of services to deploy')
    .option('--skip-build', 'Skip the build phase')
    .option('--force', 'Force deployment even if locked')
    .action(async (env: string, version: string | undefined, options: { services?: string; skipBuild?: boolean; force?: boolean }) => {
      printHeader(`Deploying to ${env}`);
      console.log('');

      // Check config exists
      const config = loadConfig();
      if (!config) {
        printError('.deployment/config.yml not found');
        printInfo('Run "dockflow init" to create project structure');
        process.exit(1);
      }

      // Check Docker is available
      const spinner = ora('Checking Docker availability...').start();
      const dockerAvailable = await isDockerAvailable();
      
      if (!dockerAvailable) {
        spinner.fail('Docker is not available');
        console.log('');
        printError('Docker is required for deployment');
        printInfo('Install Docker Desktop: https://www.docker.com/products/docker-desktop');
        console.log('');
        printInfo('On Windows, make sure Docker Desktop is running.');
        printInfo('On Linux, install Docker with: curl -fsSL https://get.docker.com | sh');
        process.exit(1);
      }
      spinner.succeed('Docker is available');

      // Check for .env.dockflow
      const envFile = join(getProjectRoot(), '.env.dockflow');
      if (!existsSync(envFile)) {
        printError('.env.dockflow not found');
        printInfo('Create a .env.dockflow file with your connection string:');
        console.log(`  ${env.toUpperCase()}_CONNECTION=<base64-encoded-connection-string>`);
        process.exit(1);
      }

      // Generate version if not provided
      const deployVersion = version || `${env}-${Date.now()}`;
      printInfo(`Version: ${deployVersion}`);
      printInfo(`Environment: ${env}`);
      if (options.services) {
        printInfo(`Services: ${options.services}`);
      }
      console.log('');

      // Build Docker command
      const projectRoot = getProjectRoot();
      const dockerImage = getAnsibleDockerImage();
      
      // Build environment variables
      const envVars: string[] = [
        `-e DEPLOY_ENV=${env}`,
        `-e DEPLOY_VERSION=${deployVersion}`,
        `-e ROOT_PATH=/project`,
      ];

      if (options.services) {
        envVars.push(`-e DEPLOY_DOCKER_SERVICES=${options.services}`);
      }
      if (options.skipBuild) {
        envVars.push(`-e SKIP_BUILD=true`);
      }
      if (options.force) {
        envVars.push(`-e FORCE_DEPLOY=true`);
      }

      // Build Docker command
      const dockerCmd = [
        'docker', 'run', '--rm',
        '-v', `${projectRoot}:/project`,
        '-v', `${process.env.HOME || process.env.USERPROFILE}/.ssh:/root/.ssh:ro`,
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        ...envVars,
        dockerImage,
        'deploy', env, deployVersion,
      ];

      console.log(chalk.dim(`Running: ${dockerCmd.join(' ')}`));
      console.log('');

      // Execute deployment
      const deploySpinner = ora('Starting deployment...').start();
      
      try {
        const proc = Bun.spawn(dockerCmd, {
          stdout: 'inherit',
          stderr: 'inherit',
          stdin: 'inherit',
        });

        deploySpinner.stop();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          console.log('');
          printSuccess(`Deployment to ${env} completed successfully!`);
        } else {
          console.log('');
          printError(`Deployment failed with exit code ${exitCode}`);
          process.exit(exitCode);
        }
      } catch (error) {
        deploySpinner.fail('Deployment failed');
        printError(`${error}`);
        process.exit(1);
      }
    });
}
