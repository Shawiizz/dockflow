/**
 * DeployContext — shared state passed between deploy phases (design-03 3.1).
 */

import type { DockflowConfig } from '../utils/config';
import type { RenderedFiles } from '../services/compose';
import type { ClusterNodeRef, Orchestrator, OrchestratorTarget } from '../services/orchestrator/interfaces';
import type { Audit } from '../services/audit';
import type { Metrics } from '../services/metrics';

export interface DeployOptions {
  only?: string;
  skipBuild?: boolean;
  force?: boolean;
  debug?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  /** false with --no-failover: Commander names a negated option after the positive form */
  failover?: boolean;
  dryRun?: boolean;
  branch?: string;
  /** deploy --adopt <name>: take over a Helm release installed outside Dockflow */
  adopt?: string[];
  /** deploy --rebind-volumes: accept a claim-shape change that repoints a service at another claim */
  rebindVolumes?: boolean;
}

export interface DeployContext {
  env: string;
  config: DockflowConfig;
  stackName: string;
  branchName: string;
  deployVersion: string;
  projectRoot: string;

  /** replaces cluster: ClusterConnection */
  target: OrchestratorTarget;
  /** replaces orchestrator: StackBackend, proxyBackend, releases, lock */
  orchestrator: Orchestrator;

  deployApp: boolean;
  forceAccessories: boolean;
  skipAccessories: boolean;
  options: Partial<DeployOptions>;

  rendered: RenderedFiles;
  composeContent: string;
  composeDirPath: string;

  /** on target.controlPlane.connection (file-based, unchanged) */
  audit: Audit;
  metrics: Metrics;

  /** set by deployApp when the backend reverted; exported to on-failure hooks */
  revertedTo: string | null;
  /** true once the app role's objects were sent to the API server, whatever the outcome (K08) */
  applyStarted: boolean;
  /**
   * true when a revert (backend or Swarm-native) CONFIRMED that the app role runs what `previous`
   * describes again; the only case in which a record whose apply started may be rewound (3.3)
   */
  appSettled: boolean;
  /** bundle used by the failure path when the control plane was lost (19.3); null otherwise */
  cleanupOrchestrator: Orchestrator | null;
  /** read once before the render (3.3 step 0) and passed to both roles (section 4, core K28) */
  traefikOnCluster: boolean;
}

/** Every node that can run pods, receives uploads and imported images (managers first, servers.yml order). */
export function activeNodes(target: OrchestratorTarget): ClusterNodeRef[] {
  return [...target.managers, ...target.workers];
}
