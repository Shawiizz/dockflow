/**
 * DeployContext — shared state passed between deploy phases.
 */

import type { DockflowConfig } from '../utils/config';
import type { SSHKeyConnection } from '../types';
import type { RenderedFiles } from '../services/compose-service';
import type { OrchestratorService } from '../services/orchestrator/interface';
import type { HealthBackend } from '../services/orchestrator/health-interface';
import type { ReleaseService } from '../services/release-service';
import type { LockService } from '../services/lock-service';
import type { AuditService } from '../services/audit-service';
import type { MetricsService } from '../services/metrics-service';

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

  orchestrator: OrchestratorService;
  healthBackend: HealthBackend;
  releases: ReleaseService;
  lock: LockService;
  audit: AuditService;
  metrics: MetricsService;
}
