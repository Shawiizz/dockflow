/**
 * Backup API Routes (design-06 8.2, 3.20, 4)
 *
 * GET  /api/backup/list?env=&service=         - List backups (every configured service when omitted)
 * POST /api/backup/create?env=&service=       - Create a backup
 * POST /api/backup/restore?env=&service=&id=  - Restore from a backup (`id` is required)
 * POST /api/backup/prune?env=&service=        - Prune old backups (service optional)
 */

import { resolveService, type Day2Context } from '../../commands/shared/day2';
import { configuredSources, nounForSource, requireBackupConfig, requireBackupSource, type BackupSource } from '../../commands/backup/utils';
import { createBackup, type Backup, type BackupBaseEntry, type BackupListEntry } from '../../services/backup';
import type { StackRef } from '../../services/orchestrator/interfaces';
import { DeployError, ErrorCode } from '../../utils/errors';
import { errorResponse, jsonResponse, withOrchestrator, type ApiContext } from './_helpers';
import type { BackupActionResponse, BackupEntry, BackupListResponse, BackupPruneResponse } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function refFor(ctx: ApiContext, source: BackupSource): StackRef {
  return source === 'services' ? ctx.appRef : ctx.accessoryRef;
}

/** `resolveService` (shared with the CLI, R-14 included) needs a full `Day2Context`; the API context
 * carries the same identity fields and has no use for `invalidate`/`lock`'s own memo or laziness. */
function asDay2Context(ctx: ApiContext): Day2Context {
  return {
    ...ctx,
    invalidate: () => {},
    lock: () => ctx.orchestrator.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes),
  };
}

function groupByService(entries: readonly BackupListEntry[]): Map<string, BackupListEntry[]> {
  const grouped = new Map<string, BackupListEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.service) ?? [];
    list.push(entry);
    grouped.set(entry.service, list);
  }
  return grouped;
}

function toBackupEntry(entry: BackupBaseEntry): BackupEntry {
  return {
    id: entry.id,
    service: entry.service,
    dbType: entry.dbType,
    timestamp: entry.timestamp,
    size: entry.size,
    sizeBytes: entry.sizeBytes,
  };
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
  const service = url.searchParams.get('service') || undefined;

  return withOrchestrator(
    url,
    async (ctx) => {
      const sources = service ? [requireBackupSource(service).source] : configuredSources();

      const entries: BackupListEntry[] = [];
      const unreachableNodes = new Set<string>();
      for (const source of sources) {
        const result = await createBackup(ctx.orchestrator, refFor(ctx, source)).list(service);
        if (!result.success) throw result.error;
        entries.push(...result.data.entries);
        for (const node of result.data.unreachable) unreachableNodes.add(node.name);
      }
      entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

      return jsonResponse({
        backups: entries.map(toBackupEntry),
        total: entries.length,
        unreachableNodes: [...unreachableNodes],
      } satisfies BackupListResponse);
    },
    { failover: false },
  );
}

/**
 * POST /api/backup/create?env=&service=
 */
async function handleCreateBackup(url: URL): Promise<Response> {
  const service = url.searchParams.get('service');
  if (!service) return errorResponse('Service name required', 400);

  return withOrchestrator(url, async (ctx) => {
    // ctx.env, not the raw query param: withOrchestrator already resolved the default environment.
    const { backupConfig, compression, source } = requireBackupConfig(service, ctx.env, 'dockflow backup create');
    const ref = refFor(ctx, source);
    const { service: svc } = await resolveService(asDay2Context(ctx), ref, service, { allowHelm: false, noun: nounForSource(source) });

    const result = await createBackup(ctx.orchestrator, ref).backup(svc.name, backupConfig, compression);
    if (!result.success) throw result.error;

    return jsonResponse({
      success: true,
      message: `Backup ${result.data.id} created`,
      backup: toBackupEntry(result.data),
    } satisfies BackupActionResponse);
  });
}

/**
 * POST /api/backup/restore?env=&service=&id=
 *
 * `id` is required: the route never resolves `latest` itself (K64b) — the UI lists backups first
 * and lets the operator pick one. `forceUnverified` is always `false`: restoring an unverifiable
 * backup is a CLI-only escape hatch.
 */
async function restoreBackup(url: URL): Promise<Response> {
  const service = url.searchParams.get('service');
  const backupId = url.searchParams.get('id');

  if (!service) return errorResponse('Service name required', 400);
  if (!backupId) return errorResponse('Backup id required', 400);

  return withOrchestrator(url, async (ctx) => {
    const { backupConfig, source } = requireBackupConfig(service, ctx.env, 'dockflow backup restore');
    const ref = refFor(ctx, source);
    const { service: svc } = await resolveService(asDay2Context(ctx), ref, service, { allowHelm: false, noun: nounForSource(source) });

    const lock = ctx.orchestrator.lock(ctx.stackName, ctx.config.lock?.stale_threshold_minutes);
    const acquired = await lock.acquire({ message: `Restore ${svc.name} via WebUI` });
    if (!acquired.success) {
      throw new DeployError(acquired.error.message, ErrorCode.DEPLOY_LOCKED);
    }
    try {
      // assertSingleReplica (R-23) and the archive verification run inside Backup.restore itself.
      const result = await createBackup(ctx.orchestrator, ref).restore(svc.name, backupId, backupConfig, undefined, { forceUnverified: false });
      if (!result.success) throw result.error;

      return jsonResponse({
        success: true,
        message: `Restored ${svc.name} from backup ${backupId}`,
      } satisfies BackupActionResponse);
    } finally {
      await lock.release();
    }
  });
}

/**
 * POST /api/backup/prune?env=&service=
 */
async function pruneBackups(url: URL): Promise<Response> {
  const service = url.searchParams.get('service') || undefined;

  return withOrchestrator(
    url,
    async (ctx) => {
      const retentionCount = ctx.config.backup?.retention_count ?? 10;
      const sources = service ? [requireBackupSource(service).source] : configuredSources();

      let totalPruned = 0;
      for (const source of sources) {
        const ref = refFor(ctx, source);
        const backupService: Backup = createBackup(ctx.orchestrator, ref);
        const listed = await backupService.list(service);
        if (!listed.success) throw listed.error;

        for (const [svcName, svcEntries] of groupByService(listed.data.entries)) {
          if (svcEntries.length <= retentionCount) continue;
          const result = await backupService.prune(svcName, retentionCount, { prefetched: svcEntries });
          if (result.success) totalPruned += result.data.removed;
        }
      }

      return jsonResponse({
        success: true,
        pruned: totalPruned,
        message: service ? `Pruned ${totalPruned} backup(s) for ${service}` : `Pruned ${totalPruned} backup(s)`,
      } satisfies BackupPruneResponse);
    },
    { failover: false },
  );
}
