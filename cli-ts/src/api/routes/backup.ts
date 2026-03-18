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
import { getManagerConnection, resolveEnvironment } from './_helpers';
import { createBackupService, type BackupService, type BackupBaseEntry } from '../../services/backup-service';
import type { SSHKeyConnection } from '../../types';
import type { BackupEntry, BackupListResponse, BackupActionResponse, BackupPruneResponse } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────

interface BackupContext {
  env: string;
  conn: SSHKeyConnection;
  stackName: string;
  backupService: BackupService;
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

  return { env, conn, stackName, backupService: createBackupService(conn, stackName) };
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

/** Load backup config for a service — checks both services and accessories */
function getBackupConfig(service: string): { backupConfig: BackupAccessoryConfig; compression: 'gzip' | 'none'; source: 'services' | 'accessories' } | Response {
  const config = loadConfig({ silent: true });

  const fromServices = config?.backup?.services?.[service];
  if (fromServices) {
    return { backupConfig: fromServices, compression: config?.backup?.compression ?? 'gzip', source: 'services' };
  }

  const fromAccessories = config?.backup?.accessories?.[service];
  if (fromAccessories) {
    return { backupConfig: fromAccessories, compression: config?.backup?.compression ?? 'gzip', source: 'accessories' };
  }

  return errorResponse(`No backup configuration for service '${service}'`, 400);
}

/** Get all configured backup stack names for an environment */
function getAllBackupStackNames(env: string): string[] {
  const config = loadConfig({ silent: true });
  const stacks: string[] = [];

  if (config?.backup?.services && Object.keys(config.backup.services).length > 0) {
    const name = getStackName(env);
    if (name) stacks.push(name);
  }

  if (config?.backup?.accessories && Object.keys(config.backup.accessories).length > 0) {
    const name = getAccessoriesStackName(env);
    if (name) stacks.push(name);
  }

  return stacks;
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
    return createBackup(url);
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
    // List from all configured stacks
    const stackNames = getAllBackupStackNames(base.env);
    for (const stackName of stackNames) {
      const backupService = createBackupService(base.conn, stackName);
      const result = await backupService.list();
      if (result.success) allEntries.push(...result.data);
    }
    allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
async function createBackup(url: URL): Promise<Response> {
  const base = resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service');
  if (!service) return errorResponse('Service name required', 400);

  const ctx = resolveBackupContextForService(base.env, base.conn, service);
  if (ctx instanceof Response) return ctx;

  const cfg = getBackupConfig(service);
  if (cfg instanceof Response) return cfg;

  const result = await ctx.backupService.backup(service, cfg.backupConfig, cfg.compression);

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

  const cfg = getBackupConfig(service);
  if (cfg instanceof Response) return cfg;

  // Resolve backup
  const resolveResult = await ctx.backupService.resolveBackup(service, backupId ?? undefined);
  if (!resolveResult.success) {
    return errorResponse(resolveResult.error.message, 404);
  }

  const result = await ctx.backupService.restore(service, resolveResult.data.id, cfg.backupConfig, resolveResult.data.compression);

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
    // Prune across all configured stacks, grouped per service
    const stackNames = getAllBackupStackNames(base.env);
    for (const stackName of stackNames) {
      const backupService = createBackupService(base.conn, stackName);
      const listResult = await backupService.list();
      if (!listResult.success) continue;

      // Group entries by service and prune each independently
      const byService: Record<string, typeof listResult.data> = {};
      for (const entry of listResult.data) {
        (byService[entry.service] ??= []).push(entry);
      }

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
