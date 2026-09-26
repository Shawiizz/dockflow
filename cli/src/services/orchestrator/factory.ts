/**
 * Orchestrator bundle factory (DESIGN-CORE 6.4): one switch on `config.orchestrator`, so every
 * caller of `openOrchestrator` gets a fully wired bundle without ever constructing a backend
 * directly. `createKubernetesOrchestrator` (kubernetes/index.ts) always receives `k3sDistribution`
 * here; a future bring-your-own Kubernetes distribution would only change this one call.
 */

import { ConfigError } from '../../utils/errors';
import { loadConfig, type DockflowConfig } from '../../utils/config';
import { loadSecrets } from '../../utils/secrets';
import { resolveEnvironmentPrefix } from '../../utils/validation';
import type { Orchestrator, OrchestratorTarget } from './interfaces';
import { k3sDistribution } from './kubernetes/k3s/distribution';
import { createKubernetesOrchestrator } from './kubernetes/index';
import { createSwarmOrchestrator } from './swarm/swarm-orchestrator';
import { resolveOrchestratorTarget, type ResolveTargetOptions } from './target';

export function createOrchestrator(target: OrchestratorTarget, config: DockflowConfig): Orchestrator {
  return (config.orchestrator ?? 'swarm') === 'k3s'
    ? createKubernetesOrchestrator(target, config, k3sDistribution)
    : createSwarmOrchestrator(target, config);
}

export interface OpenedOrchestrator {
  config: DockflowConfig;
  orchestrator: Orchestrator;
}

/**
 * Standard entry for commands: loadSecrets + loadConfig (ConfigError when missing),
 * resolveEnvironmentPrefix, resolveOrchestratorTarget, createOrchestrator.
 */
export async function openOrchestrator(env: string, options?: ResolveTargetOptions): Promise<OpenedOrchestrator> {
  loadSecrets();
  const config = loadConfig({ strict: true });
  if (!config) throw new ConfigError('No config.yml found', 'Run `dockflow init` to create a project configuration.');
  const resolvedEnv = resolveEnvironmentPrefix(env);
  const target = await resolveOrchestratorTarget(resolvedEnv, config, options);
  const orchestrator = createOrchestrator(target, config);
  return { config, orchestrator };
}
