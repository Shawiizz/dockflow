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

// ─── Service Actions ────────────────────────────────────────────────────────

export interface ServiceActionResponse {
  success: boolean;
  message: string;
  output?: string;
}

// ─── Accessories Status ─────────────────────────────────────────────────────

export interface AccessoryStatusInfo extends AccessoryInfo {
  status?: 'running' | 'stopped' | 'unknown';
  replicas?: string;
  replicasRunning?: number;
  replicasDesired?: number;
}

export interface AccessoriesStatusResponse {
  accessories: AccessoryStatusInfo[];
  total: number;
  message?: string;
}

export interface AccessoryActionResponse {
  success: boolean;
  message: string;
  output?: string;
}

// ─── Operations (Deploy/Build) ──────────────────────────────────────────────

export interface DeployOperationRequest {
  environment: string;
  version?: string;
  skipBuild?: boolean;
  force?: boolean;
  accessories?: boolean;
  all?: boolean;
  skipAccessories?: boolean;
  services?: string;
  dryRun?: boolean;
}

export interface BuildOperationRequest {
  environment: string;
  services?: string;
  push?: boolean;
}

export interface OperationStatusResponse {
  running: boolean;
  type?: 'deploy' | 'build';
  environment?: string;
  startedAt?: string;
}

// ─── Prune ──────────────────────────────────────────────────────────────────

export interface PruneRequest {
  targets: ('containers' | 'images' | 'volumes' | 'networks')[];
  all?: boolean;
}

export interface PruneResult {
  target: string;
  success: boolean;
  reclaimed?: string;
  error?: string;
}

export interface PruneResponse {
  results: PruneResult[];
}

export interface DiskUsageResponse {
  raw: string;
}

// ─── Locks ──────────────────────────────────────────────────────────────────

export interface LockInfo {
  locked: boolean;
  performer?: string;
  startedAt?: string;
  version?: string;
  message?: string;
  stack?: string;
  isStale?: boolean;
  durationMinutes?: number;
}

export interface LockActionResponse {
  success: boolean;
  message: string;
}

// ─── Monitoring ─────────────────────────────────────────────────────────────

export interface ContainerStatsEntry {
  name: string;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
}

export interface ContainerStatsResponse {
  containers: ContainerStatsEntry[];
  timestamp: string;
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  version: string;
  performer: string;
  message?: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export interface ComposeDeployPlacement {
  constraints?: string[];
}

export interface ComposeDeployUpdateConfig {
  parallelism?: number;
  delay?: string;
  order?: string;
  failure_action?: string;
  monitor?: string;
  max_failure_ratio?: number;
}

export interface ComposeDeployRollbackConfig {
  parallelism?: number;
  delay?: string;
  order?: string;
  monitor?: string;
}

export interface ComposeDeployRestartPolicy {
  condition?: string;
  delay?: string;
  max_attempts?: number;
}

export interface ComposeDeployResources {
  limits?: { cpus?: string; memory?: string };
  reservations?: { cpus?: string; memory?: string };
}

export interface ComposeDeploy {
  replicas?: number;
  placement?: ComposeDeployPlacement;
  update_config?: ComposeDeployUpdateConfig;
  rollback_config?: ComposeDeployRollbackConfig;
  restart_policy?: ComposeDeployRestartPolicy;
  resources?: ComposeDeployResources;
}

export interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string } | string;
  ports?: string[];
  environment?: Record<string, string> | string[];
  deploy?: ComposeDeploy;
  volumes?: string[];
  networks?: string[];
  [key: string]: unknown;
}

export interface ComposeFile {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
}

export interface ComposeResponse {
  exists: boolean;
  compose: ComposeFile | null;
  message?: string;
}

export interface ComposeUpdateResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// ─── Topology ────────────────────────────────────────────────────────────────

export interface TopologyService {
  name: string;
  image?: string;
  replicas?: number;
  ports?: string[];
}

export interface TopologyServer {
  name: string;
  role: string;
  host?: string;
  tags: string[];
}

export interface TopologyConnection {
  serviceName: string;
  serverName: string;
  constraintType: 'hostname' | 'role';
  constraintValue: string;
  implicit: boolean;
}

export interface TopologyResponse {
  services: TopologyService[];
  servers: TopologyServer[];
  connections: TopologyConnection[];
}

export interface TopologyUpdateRequest {
  connections: Array<{
    serviceName: string;
    serverName: string;
    constraintType: 'hostname' | 'role';
    constraintValue: string;
  }>;
}

export interface TopologyUpdateResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}
