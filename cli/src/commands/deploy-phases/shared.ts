/**
 * Helpers shared by several deploy phases: the nodes that receive images and uploads, and the
 * Traefik bring-up that the app and accessories phases both need.
 */

import type { ClusterConnection, ClusterNode } from '../../types';
import type { DeployContext } from '../deploy-context';

/** Nodes that receive images and uploads: Swarm schedules tasks on managers too. */
export function activeNodes(cluster: ClusterConnection): ClusterNode[] {
  return [cluster.manager, ...cluster.otherManagers, ...cluster.workers];
}

/** Bring Traefik up to date once per deploy, for whichever phase needs it first. */
export function ensureProxy(ctx: DeployContext): Promise<void> {
  if (!ctx.swarmProxy) return Promise.resolve();
  ctx.proxyReady ??= ctx.swarmProxy.ensureRunning(ctx.config.proxy!);
  return ctx.proxyReady;
}
