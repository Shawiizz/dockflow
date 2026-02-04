/**
 * Deploy API Routes
 *
 * GET /api/deploy/history - Get deployment history from audit log
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, getProjectRoot } from '../../utils/config';
import { getAvailableEnvironments } from '../../utils/servers';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { DeployHistoryEntry, DeployHistoryResponse } from '../types';

/**
 * Handle /api/deploy/* routes
 */
export async function handleDeployRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // GET /api/deploy/history
  if (pathname === '/api/deploy/history' && method === 'GET') {
    return getDeployHistory(url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * Read deploy history from the audit log file
 *
 * Dockflow writes audit logs to .dockflow/audit.log as JSON-per-line.
 * If the file doesn't exist we return an empty list.
 */
async function getDeployHistory(url: URL): Promise<Response> {
  const envFilter = url.searchParams.get('env');
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const projectRoot = getProjectRoot();

  // Try multiple common audit log locations
  const auditPaths = [
    join(projectRoot, '.dockflow', 'audit.log'),
    join(projectRoot, '.dockflow', 'deploy.log'),
    join(projectRoot, '.dockflow', 'history.json'),
  ];

  let entries: DeployHistoryEntry[] = [];

  for (const auditPath of auditPaths) {
    if (existsSync(auditPath)) {
      try {
        const content = readFileSync(auditPath, 'utf-8');

        if (auditPath.endsWith('.json')) {
          // JSON array format
          const parsed = JSON.parse(content);
          entries = Array.isArray(parsed) ? parsed : [];
        } else {
          // JSON-per-line format
          entries = content
            .trim()
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean) as DeployHistoryEntry[];
        }
        break;
      } catch {
        // Continue to next path
      }
    }
  }

  // If we couldn't find any audit log, return empty with message
  if (entries.length === 0) {
    // Generate a synthetic history from what we can determine
    const config = loadConfig({ silent: true });
    const environments = getAvailableEnvironments();

    return jsonResponse({
      deployments: [],
      total: 0,
      message: 'No deployment history found. Deploy your project to start recording history.',
    } satisfies DeployHistoryResponse & { message?: string });
  }

  // Filter by environment if specified
  if (envFilter) {
    entries = entries.filter((e) => e.environment === envFilter);
  }

  // Sort by most recent first
  entries.sort((a, b) => {
    const dateA = new Date(a.startedAt || 0).getTime();
    const dateB = new Date(b.startedAt || 0).getTime();
    return dateB - dateA;
  });

  // Limit results
  entries = entries.slice(0, limit);

  return jsonResponse({
    deployments: entries,
    total: entries.length,
  } satisfies DeployHistoryResponse);
}
