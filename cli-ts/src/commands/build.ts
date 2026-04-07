/**
 * Build command
 *
 * Builds Docker images locally without deploying to a Swarm cluster.
 * Uses the BuildService and HookService directly — no Ansible container needed.
 *
 * Template rendering is entirely in-memory. Docker build contexts are
 * assembled as tar archives and piped to `docker build -` via stdin.
 * No temporary files are written to disk.
 */


import type { Command } from 'commander';
import { printInfo, printIntro, printDebug, printWarning, printDim, printBlank, printSuccess, setVerbose } from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { detectCIEnvironment, parseTagForDeployment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { withErrorHandler, ConfigError } from '../utils/errors';
import { loadConfig } from '../utils/config';
import { buildTemplateContext, getManagersForEnvironment } from '../utils/servers';
import { BuildService } from '../services/build-service';
import { HookService } from '../services/hook-service';
import { DistributionService } from '../services/distribution-service';
import { ComposeService } from '../services/compose-service';

interface BuildOptions {
  services?: string;
  debug?: boolean;
  push?: boolean;
  skipHooks?: boolean;
  branch?: string;
}

/**
 * Run build — can be called directly or via CLI command
 */
export async function runBuild(env: string | undefined, options: Partial<BuildOptions>): Promise<void> {
  if (options.debug) setVerbose(true);

  // Auto-detect env from CI environment when not provided
  let ciVersion: string | undefined;
  if (!env) {
    const ci = detectCIEnvironment();
    if (ci) {
      const params = ci.isTag && ci.tag
        ? parseTagForDeployment(ci.tag)
        : resolveDeployParams(ci);
      env = params.env;
      ciVersion = params.version;
      printInfo(`CI detected (${ci.provider}): building for ${env}`);
    } else {
      throw new ConfigError(
        'Environment is required',
        'Usage: dockflow build <env>\nIn CI, environment is auto-detected from git tag/branch.',
      );
    }
  }

  loadSecrets();
  printDebug('Secrets loaded from environment');

  printIntro(`Building Docker images for ${env}`);
  printBlank();

  // Load config
  let config = loadConfig();
  if (!config) {
    throw new ConfigError(
      'No config.yml found',
      'Run `dockflow init` to create a project configuration.',
    );
  }

  if (config.options?.enable_debug_logs) setVerbose(true);

  const branchName = options.branch || getCurrentBranch();

  // Display build info
  printInfo(`Project: ${config.project_name || 'app'}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Branch: ${branchName}`);
  if (options.services) printInfo(`Services: ${options.services}`);
  if (options.skipHooks) printInfo(`Hooks: Skipped`);
  printBlank();

  // Render templates and resolve compose content
  const managers = getManagersForEnvironment(env);
  const currentServerName = managers.length > 0 ? managers[0].name : undefined;
  const templateContext = currentServerName ? buildTemplateContext(env, currentServerName) : null;

  const { rendered, composeContent, composeDirPath, projectRoot } = ComposeService.renderAndResolveCompose(
    {
      env,
      version: ciVersion ?? 'build',
      branch: branchName,
      project_name: config.project_name,
      config,
    },
    templateContext,
  );

  // Re-parse config from rendered templates (resolves {{ current.env.xxx }})
  config = loadConfig({ content: rendered.get('.dockflow/config.yml'), silent: true }) ?? config;

  // Pre-build hook
  if (!options.skipHooks) {
    await HookService.runLocal('pre-build', projectRoot, config, rendered);
  }

  // Build images (targets resolved from rendered compose via stdin)
  const targets = BuildService.getBuildTargets(composeContent, composeDirPath, options.services);
  if (targets.length === 0) {
    printWarning('No build targets found in docker-compose.yml');
    return;
  }

  // Attach rendered overrides to each target
  for (const target of targets) {
    target.renderedOverrides = BuildService.getOverridesForTarget(rendered, target, projectRoot);
  }

  const result = await BuildService.buildAll(targets);

  // Post-build hook
  if (!options.skipHooks) {
    await HookService.runLocal('post-build', projectRoot, config, rendered);
  }

  // Push to registry if requested
  if (options.push && config.registry?.enabled && config.registry.url && config.registry.password) {
    printDim('Pushing images to registry...');
    // Login locally for push
    const proc = Bun.spawn(
      ['docker', 'login', config.registry.url, '-u', config.registry.username || '', '--password-stdin'],
      { stdin: new Response(config.registry.password).body!, stdout: 'pipe', stderr: 'pipe' },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new ConfigError(
        `Docker registry login failed (exit ${exitCode})${stderr ? ': ' + stderr.trim() : ''}`,
        'Check your registry credentials in config.yml (registry.username, registry.password).',
      );
    }
    await DistributionService.pushImages(result.images, config.registry.additional_tags?.length ? {
      tags: config.registry.additional_tags,
      env,
      version: 'latest',
      branch: branchName,
    } : undefined);
  }

  printBlank();
  printSuccess(`Build completed! ${result.images.length} image(s) built in ${(result.durationMs / 1000).toFixed(1)}s`);
}

/**
 * Register build command
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build [env]')
    .description('Build Docker images locally without deploying')
    .option('--services <services>', 'Comma-separated list of services to build')
    .option('--push', 'Push images to registry after build')
    .option('--skip-hooks', 'Skip pre-build and post-build hooks')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(async (env: string | undefined, options: BuildOptions) => {
      await runBuild(env, options);
    }));
}
