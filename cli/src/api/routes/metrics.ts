/**
 * Metrics API Routes
 *
 * Container resource stats and audit log endpoints.
 *
 * GET /api/metrics/stats  - Get real-time container resource usage (CPU, memory, network, block I/O)
 * GET /api/metrics/audit  - Get the deploy audit log for the current stack
 */

import { jsonResponse, errorResponse } from '../server';
import { shellQuote, sshExec } from '../../utils/ssh';
import { sshExecWithFallback } from '../../utils/ssh-fallback';
import { getAccessoriesStackName, getStackName } from '../../utils/config';
import { getApiNodes, getManagerConnection, getAllNodeConnections, onEveryNode, resolveEnvironment, parseIntParam } from './_helpers';
import { DOCKFLOW_AUDIT_DIR } from '../../constants';
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

const STACK_LABEL = 'com.docker.stack.namespace';
const SERVICE_LABEL = 'com.docker.swarm.service.name';

export interface ParsedStatsLine {
  id: string;
  name: string;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
}

/** One `S|id|name|cpu|mem|mem%|net|block` line of the stats command; null for any other line. */
export function parseDockerStatsLine(line: string): ParsedStatsLine | null {
  const parts = line.trim().split('|');
  if (parts[0] !== 'S' || !parts[1] || !parts[2]) return null;
  return {
    id: parts[1],
    name: parts[2],
    cpuPercent: parts[3] || '0.00%',
    memUsage: parts[4] || '0B / 0B',
    memPercent: parts[5] || '0.00%',
    netIO: parts[6] || '0B / 0B',
    blockIO: parts[7] || '0B / 0B',
  };
}

/**
 * Lists the containers of the stacks on a node (`C|id|service|stack` lines) and then their
 * resource usage (`S|...` lines). Fails when Docker does not answer.
 */
export function statsCommand(stacks: string[]): string {
  const lines = stacks.map(
    (stack, i) =>
      `c${i}=$(docker ps --filter ${shellQuote(`label=${STACK_LABEL}=${stack}`)} --format 'C|{{.ID}}|{{.Label "${SERVICE_LABEL}"}}|{{.Label "${STACK_LABEL}"}}') || exit 1`,
  );
  const all = stacks.map((_, i) => `"$c${i}"`).join(' ');
  return [
    ...lines,
    `containers=$(printf '%s\n' ${all} | grep '^C|')`,
    '[ -n "$containers" ] || exit 0',
    `printf '%s\n' "$containers"`,
    `docker stats --no-stream --format 'S|{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}' $(printf '%s\n' "$containers" | cut -d'|' -f2)`,
  ].join('\n');
}

/** Stats entries of one node from the output of `statsCommand`. */
export function parseNodeStats(
  stdout: string,
  node: string,
  stacks: { app: string; accessories: string },
): ContainerStatsEntry[] {
  const owners = new Map<string, { service: string; stack: string }>();
  const stats: ParsedStatsLine[] = [];

  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|');
    if (parts[0] === 'C' && parts[1]) {
      owners.set(parts[1], { service: parts[2] ?? '', stack: parts[3] ?? '' });
      continue;
    }
    const parsed = parseDockerStatsLine(line);
    if (parsed) stats.push(parsed);
  }

  return stats.map(({ id, ...entry }) => {
    const owner = owners.get(id);
    const prefix = owner ? `${owner.stack}_` : '';
    const service = owner?.service.startsWith(prefix) ? owner.service.slice(prefix.length) : owner?.service;
    return {
      ...entry,
      node,
      service: service || undefined,
      role: owner?.stack === stacks.accessories ? 'accessory' : 'app',
    };
  });
}

/**
 * Get container resource stats of the app and accessories stacks, from every node that runs
 * them, via `docker stats --no-stream`.
 */
async function getContainerStats(url: URL): Promise<Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environments configured', 404);

  const app = getStackName(env);
  const accessories = getAccessoriesStackName(env);
  if (!app || !accessories) return errorResponse('Project name not found in config', 500);

  const nodes = getApiNodes(env);
  if (nodes.length === 0) return errorResponse('No server with credentials found', 404);

  const command = statsCommand([app, accessories]);
  const outcomes = await onEveryNode(nodes, async ({ name, connection }) => {
    const result = await sshExec(connection, command);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Failed to get container stats');
    return parseNodeStats(result.stdout, name, { app, accessories });
  });

  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length === outcomes.length) {
    return errorResponse(failed[0].ok ? 'Failed to get container stats' : failed[0].error, 500);
  }

  const containers = outcomes.flatMap((outcome) => (outcome.ok ? outcome.value : []));
  return jsonResponse({
    containers,
    timestamp: new Date().toISOString(),
    ...(failed.length > 0 ? { unreachableNodes: failed.map((outcome) => outcome.node.name) } : {}),
  } satisfies ContainerStatsResponse);
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export function auditFilePath(stackName: string): string {
  return `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
}

/** `timestamp | action | version | performer | message`, as the audit service writes it. */
export function parseAuditLine(line: string): AuditEntry | null {
  const parts = line.split(' | ').map((part) => part.trim());
  if (parts.length < 4 || !parts[0]) return null;
  return {
    timestamp: parts[0],
    action: parts[1],
    version: parts[2],
    performer: parts[3],
    message: parts.slice(4).join(' | ') || undefined,
  };
}

/**
 * Read the deploy audit log from the remote server.
 *
 * The audit file has one line per entry:
 *   timestamp | action | version | performer | message
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

  const lines = parseIntParam(url.searchParams.get('lines'), 100, 1, 10000);
  const auditFile = auditFilePath(conn.stackName);

  try {
    const command = `tail -n ${lines} ${shellQuote(auditFile)} 2>/dev/null || echo ""`;
    // Use fallback across all nodes since audit log is replicated
    const nodeConnections = getAllNodeConnections(env);
    const connections = nodeConnections.length > 0 ? nodeConnections : [conn];
    const result = await sshExecWithFallback(connections, command);

    const output = result.stdout.trim();

    if (!output) {
      return jsonResponse({
        entries: [],
        total: 0,
      } satisfies AuditResponse);
    }

    const entries: AuditEntry[] = output
      .split('\n')
      .map(parseAuditLine)
      .filter((entry): entry is AuditEntry => entry !== null);

    return jsonResponse({
      entries,
      total: entries.length,
    } satisfies AuditResponse);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Failed to read audit log', 500);
  }
}
