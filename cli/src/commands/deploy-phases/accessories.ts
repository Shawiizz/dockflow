/**
 * Accessories phase: the accessories compose as it is deployed, its digest for the release, and
 * the deploy of the accessories stack.
 */

import { getLayout } from '../../utils/config';
import * as Compose from '../../services/compose';
import type { ParsedCompose } from '../../services/compose';
import { ConvergenceError } from '../../services/swarm/convergence';
import type { DeployContext } from '../deploy-context';
import { convergenceError } from './app';
import { ensureProxy } from './shared';
import { posixRelative } from '../../utils/fs';

/** The key of accessories.yml among the rendered files */
export function accessoriesKey(): string {
  const layout = getLayout();
  return layout.accessoriesPath
    ? posixRelative(layout.root, layout.accessoriesPath)
    : '.dockflow/docker/accessories.yml';
}

/** The accessories compose as it is deployed, null when there is none to deploy. */
function accessoriesToDeploy(ctx: DeployContext): { compose: ParsedCompose; routed: boolean } | null {
  const accessoriesContent = ctx.rendered.get(accessoriesKey());
  if (!accessoriesContent) return null;

  const compose = Compose.loadFromString(accessoriesContent, 'accessories.yml');
  // a file left with comments only declares no accessory
  if (!Compose.hasServices(compose)) return null;
  Compose.injectAccessoriesDefaults(compose);
  // accessories answer only through proxy.routes, and their stack joins Traefik's network
  const proxy = ctx.config.proxy;
  const routed = !!proxy && Compose.injectTraefikLabels(compose, proxy, ctx.stackName, ctx.env, { defaultRoute: false });
  return { compose, routed };
}

/** The digest of the accessories a release leaves running: this deploy's, else the ones already on the server. */
export async function releaseAccessoriesDigest(ctx: DeployContext): Promise<string | undefined> {
  const deployed = ctx.skipAccessories ? null : accessoriesToDeploy(ctx);
  if (deployed) return Compose.accessoriesDigest(Compose.serialize(deployed.compose));
  return (await ctx.swarm.accessoriesDigest(ctx.stackName).catch(() => null)) ?? undefined;
}

export async function deployAccessories(ctx: DeployContext): Promise<void> {
  if (ctx.skipAccessories) return;

  const accessories = accessoriesToDeploy(ctx);
  if (!accessories) return;
  const { compose: accessoriesCompose, routed } = accessories;
  if (routed) await ensureProxy(ctx);

  const result = await ctx.swarm.deployAccessory({
    stackName: ctx.stackName,
    env: ctx.env,
    compose: accessoriesCompose,
    force: ctx.forceAccessories,
    proxy: ctx.config.proxy,
  });

  if (!result.success) {
    const error = result.error;
    if (!(error instanceof ConvergenceError)) throw error;
    throw convergenceError({ rolledBack: error.outcome === 'rolled-back', timedOut: error.outcome === 'timeout', errorDetail: error.message }, ctx.env, 'accessories');
  }
}
