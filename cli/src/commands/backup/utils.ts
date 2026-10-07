/**
 * Shared utilities for backup commands
 */

import { loadConfig, getStackName, getAccessoriesStackName, type BackupAccessoryConfig } from '../../utils/config';
import { BackupError, ErrorCode } from '../../utils/errors';
import type { ClusterNode, SSHKeyConnection } from '../../types';
import { createBackup, type Backup, type BackupListEntry } from '../../services/backup';
import { newestBackupFirst } from '../../services/backup-strategies';
import { getFullConnectionInfo, resolveServersForEnvironment } from '../../utils/servers';
import { printWarning } from '../../utils/output';

export type BackupSource = 'services' | 'accessories';

/**
 * Load and validate backup configuration for a specific service.
 * Searches both `backup.services` (main stack) and `backup.accessories`.
 * Returns the config, compression setting, and which source it came from.
 */
export function requireBackupConfig(service: string): {
  backupConfig: BackupAccessoryConfig;
  compression: 'gzip' | 'none';
  source: BackupSource;
} {
  const config = loadConfig();

  const fromServices = config?.backup?.services?.[service];
  if (fromServices) {
    return { backupConfig: fromServices, compression: config?.backup?.compression ?? 'gzip', source: 'services' };
  }

  const fromAccessories = config?.backup?.accessories?.[service];
  if (fromAccessories) {
    return { backupConfig: fromAccessories, compression: config?.backup?.compression ?? 'gzip', source: 'accessories' };
  }

  const configured = getBackupServiceNames();
  const known = configured.length > 0 ? `Services with a backup configuration: ${configured.join(', ')}.\n` : '';
  throw new BackupError(
    `No backup configuration found for service '${service}'`,
    {
      code: ErrorCode.BACKUP_CONFIG_MISSING,
      suggestion: `${known}Add backup config in .dockflow/config.yml:\n  backup:\n    services:        # for main stack services\n      ${service}:\n        type: volume\n    accessories:     # for accessory services\n      ${service}:\n        type: postgres  # postgres, mysql, mongodb, redis, raw, or volume`,
    }
  );
}

/**
 * Resolve the stack name based on where the backup config was found.
 * - 'services' → main stack name ({project}-{env})
 * - 'accessories' → accessories stack name ({project}-{env}-accessories)
 */
export function resolveBackupStack(env: string, source: BackupSource): string {
  const stackName = source === 'services'
    ? getStackName(env)
    : getAccessoriesStackName(env);

  if (!stackName) {
    throw new BackupError('No project configured', {
      code: ErrorCode.BACKUP_FAILED,
      suggestion: 'Ensure project_name is set in .dockflow/config.yml',
    });
  }

  return stackName;
}

/**
 * Get all configured backup stack names for an environment.
 * Returns entries for both services and accessories stacks if configured.
 */
export function getAllBackupStacks(env: string): { stackName: string; source: BackupSource }[] {
  const config = loadConfig();
  const stacks: { stackName: string; source: BackupSource }[] = [];

  if (config?.backup?.services && Object.keys(config.backup.services).length > 0) {
    const stackName = getStackName(env);
    if (stackName) stacks.push({ stackName, source: 'services' });
  }

  if (config?.backup?.accessories && Object.keys(config.backup.accessories).length > 0) {
    const stackName = getAccessoriesStackName(env);
    if (stackName) stacks.push({ stackName, source: 'accessories' });
  }

  return stacks;
}

/**
 * Get all configured backup service names (from both services and accessories).
 */
export function getBackupServiceNames(): string[] {
  const config = loadConfig();
  const names: string[] = [];
  if (config?.backup?.services) names.push(...Object.keys(config.backup.services));
  if (config?.backup?.accessories) names.push(...Object.keys(config.backup.accessories));
  return names;
}

/**
 * Every server of the environment with SSH credentials, managers first: the nodes a backup can
 * be stored on.
 */
export function getBackupNodes(env: string): ClusterNode[] {
  const servers = resolveServersForEnvironment(env);
  const sorted = [
    ...servers.filter(server => server.role === 'manager'),
    ...servers.filter(server => server.role === 'worker'),
  ];
  return sorted.flatMap((server) => {
    const connection = getFullConnectionInfo(env, server.name);
    return connection ? [{ name: server.name, connection }] : [];
  });
}

/** Say which servers did not answer, and what that leaves out. */
export function warnUnreachableNodes(unreachable: ClusterNode[], consequence: string): void {
  if (unreachable.length === 0) return;
  printWarning(`${unreachable.length} server(s) did not answer (${unreachable.map(node => node.name).join(', ')}); ${consequence}`);
}

function addUnreachable(into: Map<string, ClusterNode>, nodes: ClusterNode[]): void {
  for (const node of nodes) into.set(`${node.connection.host}:${node.connection.port}`, node);
}

// ─── Shared data-fetching helpers (used by both CLI commands and API routes) ──

/** Backup entries grouped by service within a single stack */
export interface StackGroupedEntries {
  backupService: Backup;
  byService: Record<string, BackupListEntry[]>;
}

/**
 * List backups across all configured stacks, sorted newest-first, with the servers that did not
 * answer. `node` narrows the search to one server.
 */
export async function listFromAllStacks(
  connection: SSHKeyConnection,
  env: string,
  node?: string,
): Promise<{ entries: BackupListEntry[]; unreachable: ClusterNode[] }> {
  const entries: BackupListEntry[] = [];
  const unreachable = new Map<string, ClusterNode>();
  const nodes = getBackupNodes(env);

  for (const { stackName } of getAllBackupStacks(env)) {
    const result = await createBackup(connection, stackName, nodes).list(undefined, { node });
    if (!result.success) throw result.error;
    entries.push(...result.data.entries);
    addUnreachable(unreachable, result.data.unreachable);
  }

  entries.sort(newestBackupFirst);
  return { entries, unreachable: [...unreachable.values()] };
}

/**
 * List backups across all configured stacks, grouped by stack and service.
 * Returns one entry per stack, each containing a Backup and its entries grouped by service name.
 */
export async function listGroupedFromAllStacks(
  connection: SSHKeyConnection,
  env: string,
  node?: string,
): Promise<{ stacks: StackGroupedEntries[]; unreachable: ClusterNode[] }> {
  const stacks: StackGroupedEntries[] = [];
  const unreachable = new Map<string, ClusterNode>();
  const nodes = getBackupNodes(env);

  for (const { stackName } of getAllBackupStacks(env)) {
    const backupService = createBackup(connection, stackName, nodes);
    const listResult = await backupService.list(undefined, { node });
    if (!listResult.success) throw listResult.error;

    const byService: Record<string, BackupListEntry[]> = {};
    for (const entry of listResult.data.entries) {
      (byService[entry.service] ??= []).push(entry);
    }
    stacks.push({ backupService, byService });
    addUnreachable(unreachable, listResult.data.unreachable);
  }

  return { stacks, unreachable: [...unreachable.values()] };
}
