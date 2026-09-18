/**
 * What each orchestrator supports, and the one refusal text per missing capability.
 */

import { UnsupportedOperationError } from '../../utils/errors';
import type { CapabilityName, Orchestrator, OrchestratorCapabilities, OrchestratorKind } from './interfaces';

const CAPABILITIES: Record<OrchestratorKind, OrchestratorCapabilities> = {
  swarm: {
    revert: 'native',
    execAsUser: true,
    remoteBuild: true,
    helm: false,
    volumes: false,
    networkPrune: true,
    clusterState: false,
    artifactFormat: 'swarm-compose/1',
  },
  k3s: {
    revert: 'backend',
    execAsUser: false,
    remoteBuild: false,
    helm: true,
    volumes: true,
    networkPrune: false,
    clusterState: true,
    artifactFormat: 'k8s-manifests/1',
  },
};

export interface CapabilityRefusal {
  message: string;
  suggestion?: string;
}

/**
 * The capability alone decides the text: each one is missing on exactly one orchestrator. Placeholders
 * such as `<env>` in suggestions are printed as written, because the refusal happens before the
 * command knows them all.
 */
export function capabilityRefusal(capability: CapabilityName, operation: string): CapabilityRefusal {
  switch (capability) {
    case 'execAsUser':
      return {
        message: `${operation} is not supported with orchestrator: k3s: the Kubernetes exec API runs commands as the container user`,
        suggestion:
          "Set `user:` in docker-compose.yml, or run: `dockflow exec <env> <service> -- su -s /bin/sh <user> -c '<command>'`.",
      };
    case 'remoteBuild':
      return {
        message: `${operation} is not supported with orchestrator: k3s: k3s nodes run containerd only and ship no image builder`,
        suggestion: 'Build locally (remove `options.remote_build`) or push to a registry.',
      };
    case 'helm':
      return {
        message: `${operation} requires orchestrator: k3s`,
        suggestion: 'Helm releases are only supported on Kubernetes.',
      };
    case 'volumes':
      return {
        message: `${operation} is not supported with orchestrator: swarm`,
        suggestion: 'List Swarm volumes on a node with `dockflow ssh <env>`, then `docker volume ls`.',
      };
    case 'networkPrune':
      return {
        message: `${operation} is not supported with orchestrator: k3s: the pod network is managed by the cluster`,
      };
  }
}

/** A copy: callers may keep or spread it without touching the table. */
export function capabilitiesFor(kind: OrchestratorKind): OrchestratorCapabilities {
  return { ...CAPABILITIES[kind] };
}

function refuse(capability: CapabilityName, operation: string): never {
  const { message, suggestion } = capabilityRefusal(capability, operation);
  throw new UnsupportedOperationError(message, suggestion);
}

/** Throws UnsupportedOperationError when the capability is missing (bundle already built). */
export function requireCapability(orchestrator: Orchestrator, capability: CapabilityName, operation: string): void {
  if (!orchestrator.capabilities[capability]) refuse(capability, operation);
}

/**
 * The same table, addressed by kind instead of by bundle. `requireCapability` cannot honour "before
 * any SSH work" on its own: obtaining a bundle resolves the target, which probes every manager over
 * SSH when an environment has several. Commands call `requireCapabilityFor(config.orchestrator ??
 * 'swarm', ...)` right after `loadConfig`, before `openOrchestrator`.
 */
export function requireCapabilityFor(kind: OrchestratorKind, capability: CapabilityName, operation: string): void {
  if (!CAPABILITIES[kind][capability]) refuse(capability, operation);
}
