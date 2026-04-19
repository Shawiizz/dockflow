/**
 * Backup API Routes
 *
 * GET  /api/backup/list?env=&service=         - List backups
 * POST /api/backup/create?env=&service=       - Create a backup
 * POST /api/backup/restore?env=&service=&id=  - Restore from a backup
 * POST /api/backup/prune?env=&service=        - Prune old backups (service optional)
 */

import { jsonResponse, errorResponse } from '../server';
import { loadConfig, getStackName, getAccessoriesStackName, type BackupAccessoryConfig } from '../../utils/config';
import { getManagerConnection, resolveEnvironment, getAllNodeConnections } from './_helpers';
import { createBackup, type Backup, type BackupBaseEntry } from '../../services/backup';
import { requireBackupConfig, listFromAllStacks, listGroupedFromAllStacks, type BackupSource } from '../../commands/backup/utils';
import type { SSHKeyConnection } from '../../types';
import type { BackupEntry, BackupListResponse, BackupActionResponse, BackupPruneResponse } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface BackupContext {
  env: string;
  conn: SSHKeyConnection;
  stackName: string;
  backupService: Backup;
  backupConfig: BackupAccessoryConfig;
  compression: 'gzip' | 'none';
}

/** Resolve env and connection — returns an error Response on failure */
function resolveEnvAndConnection(url: URL): { env: string; conn: SSHKeyConnection } | Response {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environment available', 400);

  const conn = getManagerConnection(env);
  if (!conn) return errorResponse('Cannot connect to manager', 500);

  return { env, conn };
}

/** Resolve backup context for a specific service (auto-detects stack) */
function resolveBackupContextForService(env: string, conn: SSHKeyConnection, service: string): BackupContext | Response {
  const cfg = getBackupConfig(service);
  if (cfg instanceof Response) return cfg;

  const stackName = cfg.source === 'services' ? getStackName(env) : getAccessoriesStackName(env);
  if (!stackName) return errorResponse('No project configured', 400);

  return {
    env, conn, stackName,
    backupService: createBackup(conn, stackName, getAllNodeConnections(env)),
    backupConfig: cfg.backupConfig,
    compression: cfg.compression,
  };
}

/** Map a service entry to the API response shape */
function toBackupEntry(e: BackupBaseEntry): BackupEntry {
  return {
    id: e.id,
    service: e.service,
    dbType: e.dbType,
    timestamp: e.timestamp,
    size: e.size,
    sizeBytes: e.sizeBytes,
  };
}

/** Load backup config for a service — wraps shared util with Response error handling */
function getBackupConfig(service: string): { backupConfig: BackupAccessoryConfig; compression: 'gzip' | 'none'; source: BackupSource } | Response {
  try {
    return requireBackupConfig(service);
  } catch {
    return errorResponse(`No backup configuration for service '${service}'`, 400);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────

/**
 * Handle /api/backup/* routes
 */
export async function handleBackupRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/backup/list' && method === 'GET') {
    return listBackups(url);
  }

  if (pathname === '/api/backup/create' && method === 'POST') {
    return handleCreateBackup(url);
  }

  if (pathname === '/api/backup/restore' && method === 'POST') {
    return restoreBackup(url);
  }

  if (pathname === '/api/backup/prune' && method === 'POST') {
    return pruneBackups(url);
  }

  return errorResponse('Endpoint not found', 404);
}

/**
 * GET /api/backup/list?env=&service=
 */
async function listBackups(url: URL): Promise<Response> {
  const base = resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service') || undefined;

  let allEntries: BackupBaseEntry[] = [];

  if (service) {
    const ctx = resolveBackupContextForService(base.env, base.conn, service);
    if (ctx instanceof Response) return ctx;
    const result = await ctx.backupService.list(service);
    if (!result.success) return errorResponse(result.error.message, 500);
    allEntries = result.data;
  } else {
    allEntries = await listFromAllStacks(base.conn, base.env);
  }

  const response: BackupListResponse = {
    backups: allEntries.map(toBackupEntry),
    total: allEntries.length,
  };

  return jsonResponse(response);
}

/**
 * POST /api/backup/create?env=&service=
 */
async function handleCreateBackup(url: URL): Promise<Response> {
  const base = resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service');
  if (!service) return errorResponse('Service name required', 400);

  const ctx = resolveBackupContextForService(base.env, base.conn, service);
  if (ctx instanceof Response) return ctx;

  const result = await ctx.backupService.backup(service, ctx.backupConfig, ctx.compression);

  if (!result.success) {
    return errorResponse(result.error.message, 500);
  }

  const response: BackupActionResponse = {
    success: true,
    message: `Backup ${result.data.id} created`,
    backup: toBackupEntry(result.data),
  };

  return jsonResponse(response);
}

/**
 * POST /api/backup/restore?env=&service=&id=
 */
async function restoreBackup(url: URL): Promise<Response> {
  const base = resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service');
  const backupId = url.searchParams.get('id');

  if (!service) return errorResponse('Service name required', 400);

  const ctx = resolveBackupContextForService(base.env, base.conn, service);
  if (ctx instanceof Response) return ctx;

  // Resolve backup
  const resolveResult = await ctx.backupService.resolveBackup(service, backupId ?? undefined);
  if (!resolveResult.success) {
    return errorResponse(resolveResult.error.message, 404);
  }

  const result = await ctx.backupService.restore(service, resolveResult.data.id, ctx.backupConfig, resolveResult.data.compression);

  if (!result.success) {
    return errorResponse(result.error.message, 500);
  }

  const response: BackupActionResponse = {
    success: true,
    message: `Restored ${service} from backup ${resolveResult.data.id}`,
  };

  return jsonResponse(response);
}

/**
 * POST /api/backup/prune?env=&service=
 */
async function pruneBackups(url: URL): Promise<Response> {
  const base = resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service') || undefined;

  const config = loadConfig({ silent: true });
  const retentionCount = config?.backup?.retention_count ?? 10;

  let totalPruned = 0;

  if (service) {
    const ctx = resolveBackupContextForService(base.env, base.conn, service);
    if (ctx instanceof Response) return ctx;
    const result = await ctx.backupService.prune(service, retentionCount);
    if (!result.success) return errorResponse(result.error.message, 500);
    totalPruned = result.data;
  } else {
    const stackData = await listGroupedFromAllStacks(base.conn, base.env);
    for (const { backupService, byService } of stackData) {
      for (const [svc, entries] of Object.entries(byService)) {
        if (entries.length <= retentionCount) continue;
        const result = await backupService.prune(svc, retentionCount, entries);
        if (result.success) totalPruned += result.data;
      }
    }
  }

  const response: BackupPruneResponse = {
    success: true,
    pruned: totalPruned,
    message: service
      ? `Pruned ${totalPruned} backup(s) for ${service}`
      : `Pruned ${totalPruned} backup(s)`,
  };

  return jsonResponse(response);
}
