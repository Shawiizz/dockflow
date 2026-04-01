/**
 * Build command
 *
 * Builds Docker images locally without deploying to a Swarm cluster.
 * Uses the BuildService and HookService directly — no Ansible container needed.
 */

import type { Command } from 'commander';
import { printInfo, printIntro, printDebug, printWarning, printDim, printBlank, printSuccess, setVerbose } from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { getCurrentBranch } from '../utils/git';
import { withErrorHandler, ConfigError } from '../utils/errors';
import { getProjectRoot, loadConfig, getComposePath } from '../utils/config';
import { buildTemplateContext, getManagersForEnvironment } from '../utils/servers';
import { BuildService } from '../services/build-service';
import { HookService } from '../services/hook-service';
import { DistributionService } from '../services/distribution-service';
import { ComposeService } from '../services/compose-service';
import type { ComposeRenderContext } from '../services/compose-service';

interface BuildOptions {
  services?: string;
  debug?: boolean;
  push?: boolean;
  skipHooks?: boolean;
}

/**
 * Run build — can be called directly or via CLI command
 */
export async function runBuild(env: string, options: Partial<BuildOptions>): Promise<void> {
  if (options.debug) setVerbose(true);

  loadSecrets();
  printDebug('Secrets loaded from environment');

  printIntro(`Building Docker images for ${env}`);
  printBlank();

  // Load config
  const config = loadConfig();
  if (!config) {
    throw new ConfigError(
      'No config.yml found',
      'Run `dockflow init` to create a project configuration.',
    );
  }

  const branchName = getCurrentBranch();
  const projectRoot = getProjectRoot();

  // Display build info
  printInfo(`Project: ${config.project_name || 'app'}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Branch: ${branchName}`);
  if (options.services) printInfo(`Services: ${options.services}`);
  if (options.skipHooks) printInfo(`Hooks: Skipped`);
  printBlank();

  // Render templates (needed for compose files with Jinja2)
  const managers = getManagersForEnvironment(env);
  const currentServerName = managers.length > 0 ? managers[0].name : undefined;
  const templateContext = currentServerName ? buildTemplateContext(env, currentServerName) : null;

  const renderCtx: ComposeRenderContext = {
    env,
    version: 'build',
    branch: branchName,
    project_name: config.project_name,
    config,
    current: templateContext?.current ?? {},
    servers: templateContext?.servers ?? {},
    cluster: templateContext?.cluster ?? {},
  };
  await ComposeService.renderTemplates(projectRoot, renderCtx);

  // Get compose path
  const composePath = getComposePath();
  if (!composePath) {
    throw new ConfigError(
      'No docker-compose.yml found',
      'Expected at .dockflow/docker/docker-compose.yml',
    );
  }

  // Pre-build hook
  if (!options.skipHooks) {
    await HookService.runLocal('pre-build', projectRoot, config);
  }

  // Build images
  const targets = await BuildService.getBuildTargets(composePath, options.services);
  if (targets.length === 0) {
    printWarning('No build targets found in docker-compose.yml');
    return;
  }

  const result = await BuildService.buildAll(targets);

  // Post-build hook
  if (!options.skipHooks) {
    await HookService.runLocal('post-build', projectRoot, config);
  }

  // Push to registry if requested
  if (options.push && config.registry?.enabled && config.registry.url && config.registry.password) {
    printDim('Pushing images to registry...');
    // Login locally for push
    const proc = Bun.spawn(
      ['docker', 'login', config.registry.url, '-u', config.registry.username || '', '--password-stdin'],
      { stdin: new Response(config.registry.password).body!, stdout: 'pipe', stderr: 'pipe' },
    );
    await proc.exited;
    await DistributionService.pushImages(result.images);
  }

  printBlank();
  printSuccess(`Build completed! ${result.images.length} image(s) built in ${(result.durationMs / 1000).toFixed(1)}s`);
}

/**
 * Register build command
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build <env>')
    .description('Build Docker images locally without deploying')
    .option('--services <services>', 'Comma-separated list of services to build')
    .option('--push', 'Push images to registry after build')
    .option('--skip-hooks', 'Skip pre-build and post-build hooks')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(async (env: string, options: BuildOptions) => {
      await runBuild(env, options);
    }));
}
