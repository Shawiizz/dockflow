/**
 * Shared API types
 *
 * Single source of truth for all types exchanged between
 * the Bun API server (backend) and the Angular WebUI (frontend).
 *
 * Backend: import from '../api/types'
 * Frontend: import from '@shared/api-types'  (via tsconfig paths)
 */

// ─── Health ──────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version: string;
  timestamp: string;
}

// ─── Servers ─────────────────────────────────────────────────────────────────

export type ServerRole = 'manager' | 'worker';
export type ServerConnectionStatus = 'unknown' | 'checking' | 'online' | 'offline' | 'error';
export type SwarmStatus = 'leader' | 'reachable' | 'unreachable' | 'not-swarm';

export interface ServerStatus {
  name: string;
  role: ServerRole;
  host: string;
  port: number;
  user: string;
  tags: string[];
  status: ServerConnectionStatus;
  swarmStatus?: SwarmStatus;
  error?: string;
  message?: string;
  env: Record<string, string>;
}

export interface ServersResponse {
  servers: ServerStatus[];
  environments: string[];
  total: number;
  message?: string;
}

export interface EnvironmentsResponse {
  environments: string[];
  total: number;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectConfigSummary {
  project_name: string;
  registry?: string;
  remote_build?: boolean;
  health_checks_enabled?: boolean;
}

export interface ProjectInfo {
  projectRoot: string;
  projectName: string;
  hasDockflow: boolean;
  hasConfig: boolean;
  hasServers: boolean;
  hasDocker: boolean;
  hasEnvFile: boolean;
  environments: string[];
  serverCount: number;
  config: ProjectConfigSummary | null;
}

export interface ConnectionInfo {
  hasEnvFile: boolean;
  hasCISecrets: boolean;
  serversWithCredentials: string[];
  serversMissingCredentials: string[];
  ready: boolean;
  message: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ConfigResponse {
  exists: boolean;
  config: Record<string, unknown> | null;
  message?: string;
}

export interface ServersConfigResponse {
  exists: boolean;
  servers: Record<string, unknown> | null;
  message?: string;
}

export interface ConfigUpdateResponse {
  success: boolean;
  config?: Record<string, unknown>;
  errors?: Array<{ path: string; message: string }>;
}

export interface ServersConfigUpdateResponse {
  success: boolean;
  servers?: Record<string, unknown>;
  errors?: Array<{ path: string; message: string }>;
}

export interface RawConfigResponse {
  fileName: string;
  content: string;
}

// ─── Services ────────────────────────────────────────────────────────────────

export type ServiceState = 'running' | 'paused' | 'stopped' | 'error' | 'unknown';

export interface ServiceInfo {
  id: string;
  name: string;
  image: string;
  replicas: number;
  replicasRunning: number;
  state: ServiceState;
  ports: string[];
  updatedAt?: string;
  error?: string;
}

export interface ServicesListResponse {
  services: ServiceInfo[];
  stackName: string;
  total: number;
  message?: string;
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  message: string;
  service?: string;
}

export interface LogsResponse {
  logs: LogEntry[];
  service: string;
  lines: number;
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

export type DeployStatus = 'pending' | 'running' | 'success' | 'failed';
export type DeployTarget = 'app' | 'accessories' | 'all';

export interface DeployHistoryEntry {
  id: string;
  environment: string;
  target: DeployTarget;
  version: string;
  status: DeployStatus;
  startedAt: string;
  finishedAt?: string;
  duration?: number;
  error?: string;
  user?: string;
}

export interface DeployHistoryResponse {
  deployments: DeployHistoryEntry[];
  total: number;
}

export interface DeployRequest {
  environment: string;
  target: DeployTarget;
  version?: string;
  skipBuild?: boolean;
  skipHealthCheck?: boolean;
}

export interface DeployResponse {
  success: boolean;
  deploymentId: string;
  message: string;
  error?: string;
}

// ─── Accessories ─────────────────────────────────────────────────────────────

export interface AccessoryInfo {
  name: string;
  image?: string;
  volumes?: string[];
  ports?: string[];
  env?: Record<string, string>;
}

export interface AccessoriesResponse {
  accessories: AccessoryInfo[];
  total: number;
  message?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}
