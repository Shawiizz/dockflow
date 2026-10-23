/** Routes to list, create, restore and prune backups; `env`, `service` and `id` come from the query string. */

import { jsonResponse, errorResponse } from '../server';
import { printDebug } from '../../utils/output';
import { loadConfig, getStackName, getAccessoriesStackName, type BackupAccessoryConfig } from '../../utils/config';
import { getManagerConnection, resolveEnvironment } from './_helpers';
import { createBackup, type Backup, type BackupBaseEntry } from '../../services/backup';
import { requireBackupConfig, listFromAllStacks, listGroupedFromAllStacks, getBackupNodes, scaleToOneHint, type BackupSource } from '../../commands/backup/utils';
import { createEnvLock, LockHeldError } from '../../services/lock';
import type { ClusterNode, SSHKeyConnection } from '../../types';
import type { BackupEntry, BackupListResponse, BackupActionResponse, BackupPruneResponse } from '../types';

interface BackupContext {
  env: string;
  conn: SSHKeyConnection;
  stackName: string;
  backupService: Backup;
  backupConfig: BackupAccessoryConfig;
  compression: 'gzip' | 'none';
  source: BackupSource;
}

/** The environment and its manager connection, or the error Response to answer with. */
async function resolveEnvAndConnection(url: URL): Promise<{ env: string; conn: SSHKeyConnection } | Response> {
  const env = resolveEnvironment(url.searchParams.get('env'));
  if (!env) return errorResponse('No environment available', 400);

  const conn = await getManagerConnection(env);
  if (!conn) return errorResponse('Cannot connect to manager', 500);

  return { env, conn };
}

/** Backup context of a service, on the app or the accessories stack depending on where its backup is configured; an error Response when it has none. */
function resolveBackupContextForService(env: string, conn: SSHKeyConnection, service: string): BackupContext | Response {
  const cfg = getBackupConfig(service);
  if (cfg instanceof Response) return cfg;

  const stackName = cfg.source === 'services' ? getStackName(env) : getAccessoriesStackName(env);
  if (!stackName) return errorResponse('No project configured', 400);

  return {
    env, conn, stackName,
    backupService: createBackup(conn, stackName, getBackupNodes(env)),
    backupConfig: cfg.backupConfig,
    compression: cfg.compression,
    source: cfg.source,
  };
}

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

/** `requireBackupConfig`, answering 400 instead of throwing. */
function getBackupConfig(service: string): { backupConfig: BackupAccessoryConfig; compression: 'gzip' | 'none'; source: BackupSource } | Response {
  try {
    return requireBackupConfig(service);
  } catch {
    return errorResponse(`No backup configuration for service '${service}'`, 400);
  }
}

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

async function listBackups(url: URL): Promise<Response> {
  const base = await resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service') || undefined;

  let allEntries: BackupBaseEntry[] = [];
  let unreachable: ClusterNode[] = [];

  if (service) {
    const ctx = resolveBackupContextForService(base.env, base.conn, service);
    if (ctx instanceof Response) return ctx;
    const result = await ctx.backupService.list(service);
    if (!result.success) return errorResponse(result.error.message, 500);
    allEntries = result.data.entries;
    unreachable = result.data.unreachable;
  } else {
    try {
      ({ entries: allEntries, unreachable } = await listFromAllStacks(base.conn, base.env));
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : String(e), 500);
    }
  }

  const response: BackupListResponse = {
    backups: allEntries.map(toBackupEntry),
    total: allEntries.length,
    ...(unreachable.length > 0 && { unreachableNodes: unreachable.map(node => node.name) }),
  };

  return jsonResponse(response);
}

async function handleCreateBackup(url: URL): Promise<Response> {
  const base = await resolveEnvAndConnection(url);
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

async function restoreBackup(url: URL): Promise<Response> {
  const base = await resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service');
  const backupId = url.searchParams.get('id');

  if (!service) return errorResponse('Service name required', 400);

  const ctx = resolveBackupContextForService(base.env, base.conn, service);
  if (ctx instanceof Response) return ctx;

  const resolveResult = await ctx.backupService.resolveBackup(service, backupId ?? undefined);
  if (!resolveResult.success) {
    return errorResponse(resolveResult.error.message, 404);
  }

  const replicated = await ctx.backupService.replicaRefusal(service, scaleToOneHint(ctx.env, service, ctx.source));
  if (replicated) return errorResponse(`${replicated.message}. ${replicated.suggestion ?? ''}`.trim(), 409);

  // A deploy or another restore rewriting the same stack at the same time would corrupt both
  const stackName = getStackName(base.env);
  if (!stackName) return errorResponse('No project configured', 400);
  const lock = await createEnvLock(base.env, stackName, loadConfig({ silent: true })?.lock?.stale_threshold_minutes);
  const acquired = await lock.acquire({ message: `Restore ${service} from backup ${resolveResult.data.id}` });
  if (!acquired.success) {
    return errorResponse(acquired.error.message, acquired.error instanceof LockHeldError ? 409 : 500);
  }

  let result;
  try {
    result = await ctx.backupService.restore(service, resolveResult.data, ctx.backupConfig, resolveResult.data.compression);
  } finally {
    const released = await lock.release();
    if (!released.success) printDebug(`Could not release the lock of ${stackName}: ${released.error.message}`);
  }

  if (!result.success) {
    return errorResponse(result.error.message, 500);
  }

  const response: BackupActionResponse = {
    success: true,
    message: `Restored ${service} from backup ${resolveResult.data.id}`,
  };

  return jsonResponse(response);
}

async function pruneBackups(url: URL): Promise<Response> {
  const base = await resolveEnvAndConnection(url);
  if (base instanceof Response) return base;

  const service = url.searchParams.get('service') || undefined;

  const config = loadConfig({ silent: true });
  const retentionCount = config?.backup?.retention_count ?? 10;

  let totalPruned = 0;
  let bytesFreed = 0;
  let unreachable: ClusterNode[] = [];
  const failures: string[] = [];

  if (service) {
    const ctx = resolveBackupContextForService(base.env, base.conn, service);
    if (ctx instanceof Response) return ctx;
    const result = await ctx.backupService.prune(service, retentionCount);
    if (!result.success) return errorResponse(result.error.message, 500);
    totalPruned = result.data.removed;
    bytesFreed = result.data.bytesFreed;
  } else {
    let grouped;
    try {
      grouped = await listGroupedFromAllStacks(base.conn, base.env);
    } catch (e) {
      return errorResponse(e instanceof Error ? e.message : String(e), 500);
    }
    unreachable = grouped.unreachable;
    for (const { backupService, byService } of grouped.stacks) {
      for (const [svc, entries] of Object.entries(byService)) {
        if (entries.length <= retentionCount) continue;
        const result = await backupService.prune(svc, retentionCount, { prefetched: entries });
        if (result.success) {
          totalPruned += result.data.removed;
          bytesFreed += result.data.bytesFreed;
        } else {
          failures.push(`${svc}: ${result.error.message}`);
        }
      }
    }
  }

  if (failures.length > 0) {
    return errorResponse(`Pruned ${totalPruned} backup(s), but pruning failed for ${failures.join('; ')}`, 500);
  }

  const response: BackupPruneResponse = {
    success: true,
    pruned: totalPruned,
    message: service
      ? `Pruned ${totalPruned} backup(s) for ${service}`
      : `Pruned ${totalPruned} backup(s)`,
    ...(bytesFreed > 0 && { bytesFreed }),
    ...(unreachable.length > 0 && { unreachableNodes: unreachable.map(node => node.name) }),
  };

  return jsonResponse(response);
}
