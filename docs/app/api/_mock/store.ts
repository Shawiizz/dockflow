/**
 * In-memory mock backend for the embedded UI demo on the landing page.
 * Powers the real `cli/ui` Angular build served from /ui-demo — module-scoped
 * state persists for the lifetime of the Next.js server process and resets on restart.
 */
import type {
  ProjectInfo,
  ConnectionInfo,
  ServerStatus,
  ServiceInfo,
  LogEntry,
} from './api-types'

const now = () => new Date().toISOString()

export type MockEnv = 'production' | 'staging'

export const projectInfo: ProjectInfo = {
  projectRoot: '/home/deploy/my-app',
  projectName: 'my-app',
  hasDockflow: true,
  hasConfig: true,
  hasServers: true,
  hasDocker: true,
  hasEnvFile: true,
  environments: ['production', 'staging'],
  serverCount: 4,
  config: {
    project_name: 'my-app',
    health_checks_enabled: true,
  },
}

export const connectionInfo: ConnectionInfo = {
  hasEnvFile: true,
  hasCISecrets: true,
  serversWithCredentials: ['manager', 'worker-1', 'worker-2', 'staging'],
  serversMissingCredentials: [],
  ready: true,
  message: 'All servers configured',
}

interface EnvData {
  servers: ServerStatus[]
  services: ServiceInfo[]
  stackName: string
}

const DATA: Record<MockEnv, EnvData> = {
  production: {
    stackName: 'my-app-production',
    servers: [
      {
        name: 'manager',
        role: 'manager',
        host: '10.0.1.50',
        port: 22,
        user: 'dockflow',
        tags: ['production'],
        status: 'online',
        swarmStatus: 'leader',
        env: {},
      },
      {
        name: 'worker-1',
        role: 'worker',
        host: '10.0.1.51',
        port: 22,
        user: 'dockflow',
        tags: ['production'],
        status: 'online',
        swarmStatus: 'reachable',
        env: {},
      },
      {
        name: 'worker-2',
        role: 'worker',
        host: '10.0.1.52',
        port: 22,
        user: 'dockflow',
        tags: ['production'],
        status: 'online',
        swarmStatus: 'reachable',
        env: {},
      },
    ],
    services: [
      {
        id: 'svc-app',
        name: 'app',
        image: 'ghcr.io/acme/my-app-production:1.4.0',
        replicas: 2,
        replicasRunning: 2,
        state: 'running',
        ports: ['3000:3000'],
        updatedAt: now(),
      },
      {
        id: 'svc-worker',
        name: 'worker',
        image: 'ghcr.io/acme/my-app-production:1.4.0',
        replicas: 1,
        replicasRunning: 1,
        state: 'running',
        ports: [],
        updatedAt: now(),
      },
      {
        id: 'svc-redis',
        name: 'redis',
        image: 'redis:8-alpine',
        replicas: 1,
        replicasRunning: 1,
        state: 'running',
        ports: ['6379:6379'],
        updatedAt: now(),
      },
    ],
  },
  staging: {
    stackName: 'my-app-staging',
    servers: [
      {
        name: 'staging',
        role: 'manager',
        host: '10.0.2.10',
        port: 22,
        user: 'dockflow',
        tags: ['staging'],
        status: 'online',
        swarmStatus: 'leader',
        env: {},
      },
    ],
    services: [
      {
        id: 'svc-app-staging',
        name: 'app',
        image: 'ghcr.io/acme/my-app-staging:1.5.0-rc2',
        replicas: 1,
        replicasRunning: 1,
        state: 'running',
        ports: ['3000:3000'],
        updatedAt: now(),
      },
      {
        id: 'svc-redis-staging',
        name: 'redis',
        image: 'redis:8-alpine',
        replicas: 1,
        replicasRunning: 1,
        state: 'running',
        ports: ['6379:6379'],
        updatedAt: now(),
      },
    ],
  },
}

function resolveEnv(env?: string | null): MockEnv {
  return env === 'staging' ? 'staging' : 'production'
}

export function getServers(env?: string | null): ServerStatus[] {
  return DATA[resolveEnv(env)].servers
}

export function getServices(env?: string | null): ServiceInfo[] {
  return DATA[resolveEnv(env)].services
}

export function getStackName(env?: string | null): string {
  return DATA[resolveEnv(env)].stackName
}

export function findService(name: string, env?: string | null): ServiceInfo | undefined {
  return getServices(env).find((s) => s.name === name)
}

export function findServer(name: string, env?: string | null): ServerStatus | undefined {
  const inEnv = getServers(env).find((s) => s.name === name)
  if (inEnv) return inEnv
  // Some real-app callers (e.g. the server status poller) don't forward `env` —
  // fall back to a name lookup across all environments (server names are unique).
  for (const envKey of Object.keys(DATA) as MockEnv[]) {
    const server = DATA[envKey].servers.find((s) => s.name === name)
    if (server) return server
  }
  return undefined
}

const LOG_TEMPLATES: Record<string, string[]> = {
  app: [
    'GET /health 200 3ms',
    'GET /api/users 200 18ms',
    'POST /api/orders 201 42ms',
    'Connected to database pool (5 idle, 2 active)',
    'Cache hit ratio: 94.2%',
    'GET /api/users/42 200 7ms',
    'Scheduled job "cleanup-sessions" completed in 112ms',
  ],
  worker: [
    'Processing job #4821 (send-email)',
    'Job #4821 completed in 340ms',
    'Picked up job #4822 (generate-report)',
    'Queue depth: 3 pending, 1 active',
    'Job #4822 completed in 1204ms',
  ],
  redis: [
    '1:M * 10 changes in 300 seconds. Saving...',
    '1:M * Background saving started by pid 27',
    '1:M * Background saving terminated with success',
    '1:M * 100 changes in 60 seconds. Saving...',
  ],
}

/** Deterministic-ish rolling log buffer per service, grows over time so auto-refresh shows new lines. */
export function getLogs(serviceName: string, lines: number): LogEntry[] {
  const templates = LOG_TEMPLATES[serviceName] ?? LOG_TEMPLATES['app']
  const count = Math.min(lines, 200)
  const entries: LogEntry[] = []
  const tickSeconds = Math.floor(Date.now() / 4000) // new "line" every ~4s
  for (let i = count - 1; i >= 0; i--) {
    const idx = (tickSeconds - i) % templates.length
    const message = templates[((idx % templates.length) + templates.length) % templates.length]
    const ts = new Date(Date.now() - i * 4000).toISOString()
    entries.push({ timestamp: ts, message, service: serviceName })
  }
  return entries
}
