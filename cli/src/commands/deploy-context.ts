/**
 * DeployContext — shared state passed between deploy phases.
 */

import type { DockflowConfig } from '../utils/config';
import type { SSHKeyConnection } from '../types';
import type { RenderedFiles } from '../services/compose';
import type { StackBackend, ProxyBackend } from '../services/orchestrator/interfaces';
import type { Release } from '../services/release';
import type { Lock } from '../services/lock';
import type { Audit } from '../services/audit';
import type { Metrics } from '../services/metrics';

export interface DeployOptions {
  services?: string;
  skipBuild?: boolean;
  force?: boolean;
  debug?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  noFailover?: boolean;
  dryRun?: boolean;
  branch?: string;
}

export interface DeployContext {
  env: string;
  config: DockflowConfig;
  stackName: string;
  branchName: string;
  deployVersion: string;
  projectRoot: string;

  managerConn: SSHKeyConnection;
  workerConns: Array<{ connection: SSHKeyConnection; name: string }>;
  otherManagerConns: SSHKeyConnection[];

  deployApp: boolean;
  forceAccessories: boolean;
  skipAccessories: boolean;
  options: Partial<DeployOptions>;

  rendered: RenderedFiles;
  composeContent: string;
  composeDirPath: string;

  orchestrator: StackBackend;
  proxyBackend?: ProxyBackend;
  releases: Release;
  lock: Lock;
  audit: Audit;
  metrics: Metrics;
}
