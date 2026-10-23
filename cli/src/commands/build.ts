/**
 * The `build` command: builds the images locally without deploying. Build contexts are assembled
 * in memory as tar archives and piped to `docker build -`, so no temporary file is written.
 */


import type { Command } from 'commander';
import { printInfo, printIntro, printDebug, printWarning, printDim, printBlank, printSuccess, setVerbose } from '../utils/output';
import { loadSecrets } from '../utils/secrets';
import { detectCIEnvironment, parseTagForDeployment, resolveDeployParams } from '../utils/ci';
import { getCurrentBranch } from '../utils/git';
import { withErrorHandler, ConfigError } from '../utils/errors';
import { resolveEnvironmentPrefix } from '../utils/validation';
import { loadConfig, getLayout } from '../utils/config';
import { validateConfig as validateConfigSchema, validateServersConfig as validateServersSchema } from '../schemas';
import { existsSync, readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { buildTemplateContext, getManagersForEnvironment } from '../utils/servers';
import * as Build from '../services/build';
import * as Hook from '../services/hook';
import * as Distribution from '../services/distribution';
import * as Compose from '../services/compose';
import * as Plugin from '../services/plugin';

interface BuildOptions {
  only?: string;
  debug?: boolean;
  push?: boolean;
  skipHooks?: boolean;
  branch?: string;
}

/** Fails fast, before secrets or templates, when the config or servers file is missing or invalid. */
function quickValidateConfig(): void {
  const layout = getLayout();

  if (layout.type === 'flat') {
    if (!existsSync(layout.configPath)) {
      throw new ConfigError('No dockflow.yml found', 'Run `dockflow init` to initialize the project.');
    }
    return;
  }

  const configPath = layout.configPath;
  const serversPath = layout.serversPath;

  if (!existsSync(configPath)) {
    throw new ConfigError('No .dockflow/config.yml found', 'Run `dockflow init` to initialize the project.');
  }
  if (!existsSync(serversPath)) {
    throw new ConfigError('No .dockflow/servers.yml found', 'Run `dockflow init` to initialize the project.');
  }

  const configResult = validateConfigSchema(parseYaml(readFileSync(configPath, 'utf-8')));
  if (!configResult.success) {
    const msg = configResult.error.map(e => `  ${e.path}: ${e.message}`).join('\n');
    throw new ConfigError(`config.yml is invalid:\n${msg}`, 'Run `dockflow config validate` for details.');
  }

  const serversResult = validateServersSchema(parseYaml(readFileSync(serversPath, 'utf-8')));
  if (!serversResult.success) {
    const msg = serversResult.error.map(e => `  ${e.path}: ${e.message}`).join('\n');
    throw new ConfigError(`servers.yml is invalid:\n${msg}`, 'Run `dockflow config validate` for details.');
  }
}

export async function runBuild(env: string | undefined, options: Partial<BuildOptions>): Promise<void> {
  if (options.debug) setVerbose(true);

  quickValidateConfig();

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
      env = 'build';
      printWarning('No environment specified — using "build". Template variables like {{ env }} will be "build".');
    }
  }

  loadSecrets();
  printDebug('Secrets loaded from environment');

  env = resolveEnvironmentPrefix(env);

  printIntro(`Building Docker images for ${env}`);
  printBlank();

  let config = loadConfig();
  if (!config) {
    throw new ConfigError(
      'No config.yml found',
      'Run `dockflow init` to create a project configuration.',
    );
  }

  if (config.options?.enable_debug_logs) setVerbose(true);

  if (config.no_services) {
    printInfo('This project deploys files only (no_services): there is nothing to build.');
    return;
  }

  const branchName = options.branch || getCurrentBranch();

  printInfo(`Project: ${config.project_name || 'app'}`);
  printInfo(`Environment: ${env}`);
  printInfo(`Branch: ${branchName}`);
  if (options.only) printInfo(`Services: ${options.only}`);
  if (options.skipHooks) printInfo(`Hooks: Skipped`);
  printBlank();

  const managers = getManagersForEnvironment(env);
  if (managers.length === 0) {
    printWarning(`Environment "${env}" not found in servers.yml — {{ current.env.* }} variables will be empty.`);
  }
  const currentServerName = managers.length > 0 ? managers[0].name : undefined;
  const templateContext = currentServerName ? buildTemplateContext(env, currentServerName) : null;

  const { rendered, composeContent, composeDirPath, projectRoot, renderContext } = Compose.renderAndResolveCompose(
    {
      env,
      version: ciVersion ?? 'build',
      branch: branchName,
      project_name: config.project_name,
      config,
    },
    templateContext,
  );

  // re-parse the config from the rendered templates (resolves {{ current.env.xxx }}), then expand
  // plugins so their build hooks run here exactly as they do on deploy
  ({ config } = await Plugin.loadConfigWithPlugins({ rendered, fallback: config, projectRoot, projectContext: renderContext }));

  if (!options.skipHooks) {
    await Hook.runHook('pre-build', projectRoot, config, rendered);
  }

  const targets = Build.getBuildTargets(composeContent, composeDirPath, options.only);
  if (targets.length === 0) {
    printWarning('No build targets found in docker-compose.yml');
    return;
  }

  for (const target of targets) {
    target.renderedOverrides = Build.getOverridesForTarget(rendered, target, projectRoot);
    target.engine = config.container_engine;
  }

  const result = await Build.buildAll(targets);

  if (!options.skipHooks) {
    await Hook.runHook('post-build', projectRoot, config, rendered);
  }

  if (options.push && config.registry && Compose.usesRegistry(config)) {
    printDim('Pushing images to registry...');
    await Distribution.registryLoginLocal({
      url: config.registry.url!,
      username: config.registry.username,
      password: Compose.registryPassword(config)!,
    }, config.container_engine);
    await Distribution.pushImages(result.images, config.registry.additional_tags?.length ? {
      tags: config.registry.additional_tags,
      env,
      version: 'latest',
      branch: branchName,
    } : undefined, config.container_engine);
  }

  printBlank();
  printSuccess(`Build completed! ${result.images.length} image(s) built in ${(result.durationMs / 1000).toFixed(1)}s`);
}

export function registerBuildCommand(program: Command): void {
  program
    .command('build [env]')
    .description('Build Docker images locally without deploying')
    .helpGroup('Deploy')
    .option('--only <services>', 'Comma-separated list of services to build')
    .option('--push', 'Push images to registry after build')
    .option('--skip-hooks', 'Skip pre-build and post-build hooks')
    .option('--branch <branch>', 'Override auto-detected git branch')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(async (env: string | undefined, options: BuildOptions) => {
      await runBuild(env, options);
    }));
}
