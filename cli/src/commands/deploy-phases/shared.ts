/**
 * Helpers shared by the deploy phases and the run: the cluster's node lists, and the Traefik
 * bring-up that the app and accessories phases both need.
 */

import type { ClusterConnection, ClusterNode } from '../../types';
import type { DeployContext } from '../deploy-context';

/** Every node of the deploy, the manager in use first: Swarm schedules tasks on managers too. */
export function activeNodes(cluster: ClusterConnection): ClusterNode[] {
  return [cluster.manager, ...cluster.otherManagers, ...cluster.workers];
}

/** Every node but the manager in use. */
export function otherNodes(cluster: ClusterConnection): ClusterNode[] {
  return [...cluster.otherManagers, ...cluster.workers];
}

/** Bring Traefik up to date once per deploy, for whichever phase needs it first. */
export function ensureProxy(ctx: DeployContext): Promise<void> {
  if (!ctx.swarmProxy) return Promise.resolve();
  ctx.proxyReady ??= ctx.swarmProxy.ensureRunning(ctx.config.proxy!);
  return ctx.proxyReady;
}
