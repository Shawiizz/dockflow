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

export const projectInfo: ProjectInfo = {
  projectRoot: '/home/deploy/my-app',
  projectName: 'my-app',
  hasDockflow: true,
  hasConfig: true,
  hasServers: true,
  hasDocker: true,
  hasEnvFile: true,
  environments: ['production', 'staging'],
  serverCount: 3,
  config: {
    project_name: 'my-app',
    health_checks_enabled: true,
  },
}

export const connectionInfo: ConnectionInfo = {
  hasEnvFile: true,
  hasCISecrets: true,
  serversWithCredentials: ['manager', 'worker-1', 'worker-2'],
  serversMissingCredentials: [],
  ready: true,
  message: 'All servers configured',
}

export const servers: ServerStatus[] = [
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
]

export const services: ServiceInfo[] = [
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
]

export const stackName = 'my-app-production'

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

export function findService(name: string): ServiceInfo | undefined {
  return services.find((s) => s.name === name)
}

export function findServer(name: string): ServerStatus | undefined {
  return servers.find((s) => s.name === name)
}
