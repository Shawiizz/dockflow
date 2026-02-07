/**
 * Metrics API Routes
 *
 * Container resource stats and audit log endpoints.
 *
 * GET /api/metrics/stats  - Get real-time container resource usage (CPU, memory, network, block I/O)
 * GET /api/metrics/audit  - Get the deploy audit log for the current stack
 */

import { jsonResponse, errorResponse } from '../server';
import { sshExec } from '../../utils/ssh';
import { getManagerConnection, resolveEnvironment } from './_helpers';
import type {
  ContainerStatsEntry,
  ContainerStatsResponse,
  AuditEntry,
  AuditResponse,
} from '../types';

// ─── Route handler ──────────────────────────────────────────────────────────

/**
 * Handle /api/metrics/* routes
 */
export async function handleMetricsRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/metrics/stats
  if (pathname === '/api/metrics/stats' && method === 'GET') {
    return getContainerStats(url);
  }

  // GET /api/metrics/audit
  if (pathname === '/api/metrics/audit' && method === 'GET') {
    return getAuditLog(url);
  }

  return errorResponse('Endpoint not found', 404);
}

// ─── Container stats ────────────────────────────────────────────────────────

/**
 * Get container resource stats via `docker stats --no-stream`.
 *
 * Uses pipe-delimited format for reliable parsing:
 *   Name|CPU%|MemUsage|Mem%|NetIO|BlockIO
 *
 * When a stackName is available, results are filtered to containers
 * belonging to that stack.
 */
async function getContainerStats(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  try {
    // docker stats outputs one row per container, --no-stream takes a snapshot
    let command = "docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}'";

    // Filter by stack name if available
    if (conn.stackName) {
      command += ` | grep '^${conn.stackName}'`;
      // grep may exit 1 if no matches, so ensure we get output either way
      command = `${command} || true`;
    }

    const result = await sshExec(conn, command);

    if (result.exitCode !== 0) {
      return errorResponse(result.stderr.trim() || 'Failed to get container stats', 500);
    }

    const containers: ContainerStatsEntry[] = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split('|');
        return {
          name: parts[0] || '',
          cpuPercent: parts[1] || '0.00%',
          memUsage: parts[2] || '0B / 0B',
          memPercent: parts[3] || '0.00%',
          netIO: parts[4] || '0B / 0B',
          blockIO: parts[5] || '0B / 0B',
        };
      })
      .filter((entry) => entry.name !== '');

    return jsonResponse({
      containers,
      timestamp: new Date().toISOString(),
    } satisfies ContainerStatsResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to get container stats', 500);
  }
}

// ─── Audit log ──────────────────────────────────────────────────────────────

const AUDIT_DIR = '/var/lib/dockflow/audit';

/**
 * Read the deploy audit log from the remote server.
 *
 * The audit file uses a pipe-delimited format:
 *   timestamp|action|version|performer|message
 *
 * Supports query parameters:
 * - env:   environment to query (defaults to first available)
 * - lines: max number of entries to return (default 100)
 */
async function getAuditLog(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('No manager server with credentials found', 404);

  const lines = parseInt(url.searchParams.get('lines') || '100', 10);
  const auditFile = `${AUDIT_DIR}/${conn.stackName}.log`;

  try {
    const command = `tail -n ${lines} ${auditFile} 2>/dev/null || echo ""`;
    const result = await sshExec(conn, command);

    const output = result.stdout.trim();

    if (!output) {
      return jsonResponse({
        entries: [],
        total: 0,
      } satisfies AuditResponse);
    }

    const entries: AuditEntry[] = output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split('|');
        return {
          timestamp: parts[0] || '',
          action: parts[1] || '',
          version: parts[2] || '',
          performer: parts[3] || '',
          message: parts.slice(4).join('|') || undefined,
        };
      })
      .filter((entry) => entry.timestamp !== '');

    return jsonResponse({
      entries,
      total: entries.length,
    } satisfies AuditResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to read audit log', 500);
  }
}
