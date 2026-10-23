/**
 * Build phase: build the images (locally or on the manager), then push them to the registry or
 * distribute them to the nodes; also the registry login of the manager.
 */

import { printWarning } from '../../utils/output';
import { sshExec, sh } from '../../utils/ssh';
import * as Compose from '../../services/compose';
import type { ParsedCompose } from '../../services/compose';
import * as Build from '../../services/build';
import * as Distribution from '../../services/distribution';
import type { DockflowConfig } from '../../utils/config';
import type { DeployContext } from '../deploy-context';
import { detectContainerEngine } from './container-engine';
import { runDeployHook } from './hooks';
import { activeNodes, otherNodes } from './shared';

export interface BuildResult {
  images: string[];
  engine: 'docker' | 'podman';
  usedRegistry: boolean;
}

function registryLogin(config: DockflowConfig): Distribution.RegistryLogin {
  const registry = config.registry!;
  return { url: registry.url!, username: registry.username, password: Compose.registryPassword(config)! };
}

/** The fallback to SSH distribution is deliberate, not silent. */
function warnRegistryWithoutPassword(config: DockflowConfig): void {
  const unused = Compose.registryWithoutCredentials(config);
  if (unused) printWarning(unused);
}

/** `docker stack deploy --with-registry-auth` hands the manager's registry login to the nodes that pull. */
export async function loginManagerToRegistry(ctx: DeployContext): Promise<void> {
  if (!Compose.usesRegistry(ctx.config)) return;
  const engine = await detectContainerEngine(ctx.cluster.manager.connection, ctx.config.container_engine);
  await Distribution.registryLogin(ctx.cluster.manager.connection, registryLogin(ctx.config), engine);
}

export async function buildAndDistribute(
  ctx: DeployContext,
  compose: ParsedCompose,
): Promise<BuildResult | null> {
  if (ctx.options.skipBuild || !ctx.deployApp) return null;
  if (!Compose.hasServices(compose)) return null;

  warnRegistryWithoutPassword(ctx.config);

  await runDeployHook(ctx, 'pre-build');

  const engine = await detectContainerEngine(ctx.cluster.manager.connection, ctx.config.container_engine);
  let images: string[] = [];
  let usedRegistry = false;

  if (ctx.config.options?.remote_build) {
    ({ images } = await Build.buildRemote(ctx.cluster.manager.connection, {
      projectRoot: ctx.projectRoot,
      composeContent: Compose.serialize(compose),
      composeDirPath: ctx.composeDirPath,
      projectName: ctx.config.project_name,
      env: ctx.env,
      branch: ctx.branchName,
      servicesFilter: ctx.options.only,
      engine,
    }));

    const others = otherNodes(ctx.cluster);
    if (images.length > 0 && others.length > 0) {
      await Distribution.distributeFromRemote(images, ctx.cluster.manager.connection, others, engine);
    }
  } else {
    const targets = Build.getBuildTargets(
      Compose.serialize(compose),
      ctx.composeDirPath,
      ctx.options.only,
    );

    if (targets.length > 0) {
      const archResult = await sshExec(ctx.cluster.manager.connection, sh`uname -m`);
      const remoteArch = archResult.stdout.trim();
      const platform = (remoteArch === 'aarch64' || remoteArch === 'arm64') ? 'linux/arm64' : 'linux/amd64';

      for (const target of targets) {
        target.renderedOverrides = Build.getOverridesForTarget(ctx.rendered, target, ctx.projectRoot);
        target.platform = platform;
        target.engine = engine;
        target.noDefaultAttestations = !Compose.usesRegistry(ctx.config);
      }

      ({ images } = await Build.buildAll(targets));

      if (Compose.usesRegistry(ctx.config)) {
        usedRegistry = true;
        await Distribution.registryLoginLocal(registryLogin(ctx.config), engine);
        const additionalTags = ctx.config.registry?.additional_tags;
        await Distribution.pushImages(images, additionalTags?.length ? {
          tags: additionalTags,
          env: ctx.env,
          version: ctx.deployVersion,
          branch: ctx.branchName,
        } : undefined, engine);
      } else if (images.length > 0) {
        await Distribution.distributeAll(images, activeNodes(ctx.cluster), engine);
      }
    }
  }

  await runDeployHook(ctx, 'post-build');
  return { images, engine, usedRegistry };
}
