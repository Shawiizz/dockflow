/** The data the Swarm services take and return. */

import type { ParsedCompose } from '../compose';
import type { ProxyConfig } from '../../utils/config';

// ---------------------------------------------------------------------------
// Stack-level types
// ---------------------------------------------------------------------------

export interface StackInfo {
  name: string;
  services: number;
}

export interface ServiceInfo {
  name: string;
  image: string;
  replicas: string;
  ports: string;
}

export interface ConvergenceResult {
  converged: boolean;
  rolledBack: boolean;
  timedOut: boolean;
  errorDetail?: string;
}

export interface StackMetadata {
  version: string;
  env: string;
  branch: string;
  timestamp: string;
  project_name: string;
}

export interface InternalHealthResult {
  healthy: boolean;
  rolledBack: boolean;
  failedService?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Deploy inputs
// ---------------------------------------------------------------------------

export interface StackDeployInput {
  stackName: string;
  env: string;
  compose: ParsedCompose;
  /** When enabled, the deploy injects the Traefik routing. */
  proxy?: ProxyConfig;
  /**
   * When set, only these service names are deployed. Other services in the compose
   * are left untouched (no prune). Used by the --only flag.
   */
  servicesFilter?: string[];
}

export interface AccessoryDeployInput {
  stackName: string;
  env: string;
  compose: ParsedCompose;
  /** Path of the accessories compose file in the project. */
  accessoryPath: string;
  /** Skip change detection and deploy even if the content hasn't changed. */
  force?: boolean;
  proxy?: ProxyConfig;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** Where a log line comes from: `web.2` among the service's running instances. */
export interface LogSource {
  instance: string;
  instances: number;
}

export interface LogsOptions {
  follow: boolean;
  tail?: number | 'all';
  /** as typed by the user; validated by parseSince before any SSH */
  since?: string;
  timestamps?: boolean;
  /** Stream a specific task only (Swarm task ID). */
  taskId?: string;
  /** Include logs from terminated/historical task replicas. */
  allTasks?: boolean;
}
