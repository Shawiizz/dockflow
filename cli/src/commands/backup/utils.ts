/**
 * Shared utilities for backup commands
 */

import { loadConfig, getStackName, getAccessoriesStackName, type BackupAccessoryConfig } from '../../utils/config';
import { BackupError, ErrorCode } from '../../utils/errors';
import type { SSHKeyConnection } from '../../types';
import { createBackup, type Backup, type BackupListEntry } from '../../services/backup';
import { getAllNodeConnections } from '../../utils/servers';

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

  throw new BackupError(
    `No backup configuration found for service '${service}'`,
    {
      code: ErrorCode.BACKUP_CONFIG_MISSING,
      suggestion: `Add backup config in .dockflow/config.yml:\n  backup:\n    services:        # for main stack services\n      ${service}:\n        type: volume\n    accessories:     # for accessory services\n      ${service}:\n        type: postgres  # postgres, mysql, mongodb, redis, raw, or volume`,
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

// ─── Shared data-fetching helpers (used by both CLI commands and API routes) ──

/** Backup entries grouped by service within a single stack */
export interface StackGroupedEntries {
  backupService: Backup;
  byService: Record<string, BackupListEntry[]>;
}

/**
 * List backups across all configured stacks, sorted newest-first.
 */
export async function listFromAllStacks(
  connection: SSHKeyConnection,
  env: string
): Promise<BackupListEntry[]> {
  const stacks = getAllBackupStacks(env);
  const entries: BackupListEntry[] = [];

  const allConnections = getAllNodeConnections(env);

  for (const { stackName } of stacks) {
    const backupService = createBackup(connection, stackName, allConnections);
    const result = await backupService.list();
    if (result.success) entries.push(...result.data);
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return entries;
}

/**
 * List backups across all configured stacks, grouped by stack and service.
 * Returns one entry per stack, each containing a BackupService and its entries grouped by service name.
 */
export async function listGroupedFromAllStacks(
  connection: SSHKeyConnection,
  env: string
): Promise<StackGroupedEntries[]> {
  const stacks = getAllBackupStacks(env);
  const result: StackGroupedEntries[] = [];
  const allConnections = getAllNodeConnections(env);

  for (const { stackName } of stacks) {
    const backupService = createBackup(connection, stackName, allConnections);
    const listResult = await backupService.list();
    if (!listResult.success) continue;

    const byService: Record<string, BackupListEntry[]> = {};
    for (const entry of listResult.data) {
      (byService[entry.service] ??= []).push(entry);
    }
    result.push({ backupService, byService });
  }

  return result;
}
