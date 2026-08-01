/**
 * Subset of cli/src/api/types.ts needed by the mock backend.
 * Docs is a standalone package (no workspace link to cli), so these are
 * hand-synced — keep in sync with the real types if their shape changes.
 */

export type ServerRole = 'manager' | 'worker'
export type ServerConnectionStatus = 'unknown' | 'checking' | 'online' | 'offline' | 'error'
export type SwarmStatus = 'leader' | 'reachable' | 'unreachable' | 'not-swarm'

export interface ServerStatus {
  name: string
  role: ServerRole
  host: string
  port: number
  user: string
  tags: string[]
  status: ServerConnectionStatus
  swarmStatus?: SwarmStatus
  error?: string
  message?: string
  env: Record<string, string>
}

export interface ServersResponse {
  servers: ServerStatus[]
  environments: string[]
  total: number
  message?: string
}

export interface ProjectConfigSummary {
  project_name: string
  registry?: string
  remote_build?: boolean
  health_checks_enabled?: boolean
}

export interface ProjectInfo {
  projectRoot: string
  projectName: string
  hasDockflow: boolean
  hasConfig: boolean
  hasServers: boolean
  hasDocker: boolean
  hasEnvFile: boolean
  environments: string[]
  serverCount: number
  config: ProjectConfigSummary | null
}

export interface ConnectionInfo {
  hasEnvFile: boolean
  hasCISecrets: boolean
  serversWithCredentials: string[]
  serversMissingCredentials: string[]
  ready: boolean
  message: string
}

export type ServiceState = 'running' | 'paused' | 'stopped' | 'starting' | 'error' | 'unknown'

export interface ServiceInfo {
  id: string
  name: string
  image: string
  replicas: number
  replicasRunning: number
  state: ServiceState
  ports: string[]
  updatedAt?: string
  error?: string
}

export interface ServicesListResponse {
  services: ServiceInfo[]
  stackName: string
  total: number
  message?: string
}

export interface ServiceActionResponse {
  success: boolean
  message: string
  output?: string
}

export interface LogEntry {
  timestamp: string
  message: string
  service?: string
}

export interface LogsResponse {
  logs: LogEntry[]
  service: string
  lines: number
}
