/**
 * Shared helpers for the `dockflow backup` command group (design-06 3.20): local config lookup
 * (before any SSH) and the role a service's backup configuration belongs to. The engine itself
 * (`services/backup.ts`, over `Orchestrator.backups`) does everything that touches a node.
 */

import type { StackRef } from '../../services/orchestrator/interfaces';
import { type BackupAccessoryConfig, loadConfig } from '../../utils/config';
import { BackupError, ErrorCode, UnsupportedOperationError } from '../../utils/errors';
import type { Day2Context } from '../shared/day2';

export type BackupSource = 'services' | 'accessories';

export interface ResolvedBackupConfig {
  backupConfig: BackupAccessoryConfig;
  compression: 'gzip' | 'none';
  source: BackupSource;
}

const TRAEFIK_NAMES: ReadonlySet<string> = new Set(['traefik', 'dockflow-traefik']);

function lookup(service: string): ResolvedBackupConfig | null {
  const config = loadConfig();
  const compression = config?.backup?.compression ?? 'gzip';
  const fromServices = config?.backup?.services?.[service];
  if (fromServices) return { backupConfig: fromServices, compression, source: 'services' };
  const fromAccessories = config?.backup?.accessories?.[service];
  if (fromAccessories) return { backupConfig: fromAccessories, compression, source: 'accessories' };
  return null;
}

function missingConfigError(service: string): BackupError {
  const available = getBackupServiceNames();
  return new BackupError(`No backup configuration found for service '${service}'`, {
    code: ErrorCode.BACKUP_CONFIG_MISSING,
    suggestion:
      available.length > 0
        ? `Available services: ${available.join(', ')}.`
        : 'Add backup config in `.dockflow/config.yml` under `backup.services` or `backup.accessories`.',
  });
}

/** R-24: Traefik's ACME storage is not a compose service and has no dump/restore path in v1. */
function traefikRefusal(operation: string, env: string): UnsupportedOperationError {
  return new UnsupportedOperationError(
    `${operation} is not supported: Traefik is not a stack service`,
    `Back up Traefik's \`acme.json\` with the procedure in the proxy documentation (\`dockflow ssh ${env}\`, then \`kubectl exec\`).`,
  );
}

/**
 * Loads and validates a service's backup config from config.yml (local, before SSH). Used by
 * `create`/`restore`, where an unconfigured `traefik`/`dockflow-traefik` on k3s is R-24 instead of
 * the ordinary missing-configuration refusal.
 */
export function requireBackupConfig(service: string, env: string, operation: string): ResolvedBackupConfig {
  const found = lookup(service);
  if (found) return found;
  if ((loadConfig()?.orchestrator ?? 'swarm') === 'k3s' && TRAEFIK_NAMES.has(service)) {
    throw traefikRefusal(operation, env);
  }
  throw missingConfigError(service);
}

/** Same lookup for `list`/`prune`, which are not in R-24's trigger set (design-06 3.20). */
export function requireBackupSource(service: string): ResolvedBackupConfig {
  const found = lookup(service);
  if (found) return found;
  throw missingConfigError(service);
}

/** Names configured under `backup.services` and `backup.accessories`, for "missing argument" suggestions. */
export function getBackupServiceNames(): string[] {
  const config = loadConfig();
  const names: string[] = [];
  if (config?.backup?.services) names.push(...Object.keys(config.backup.services));
  if (config?.backup?.accessories) names.push(...Object.keys(config.backup.accessories));
  return names;
}

/** The `StackRef` a backup source resolves to; app and accessory share one namespace on k3s (D7). */
export function refForSource(ctx: Day2Context, source: BackupSource): StackRef {
  return source === 'services' ? ctx.appRef : ctx.accessoryRef;
}

export function nounForSource(source: BackupSource): 'service' | 'accessory' {
  return source === 'services' ? 'service' : 'accessory';
}

/** Every role with at least one backup configured, for `list`/`prune` without a service name. */
export function configuredSources(): BackupSource[] {
  const config = loadConfig();
  const sources: BackupSource[] = [];
  if (config?.backup?.services && Object.keys(config.backup.services).length > 0) sources.push('services');
  if (config?.backup?.accessories && Object.keys(config.backup.accessories).length > 0) sources.push('accessories');
  return sources;
}
