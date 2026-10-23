/**
 * The shapes a backup is described with (metadata, list entries, reports, options) and the
 * name check shared by everything that builds a remote path from an id or a service name.
 */

import type { ClusterNode } from '../../types';
import type { BackupDbType } from '../../utils/config';
import type { ArchiveIntegrity } from '../backup-strategies';

export interface BackupBaseEntry {
  id: string;
  service: string;
  dbType: BackupDbType;
  timestamp: string;
  /** What orders the backups (backupEpochMs); absent in metadata written before it, the timestamp orders those */
  epochMs?: number;
  size: string;
  sizeBytes: number;
  compression: 'gzip' | 'none';
  /** The check the backup got when it was taken; absent in metadata written before it existed */
  integrity?: ArchiveIntegrity;
  /** Host of the node where this backup is stored */
  nodeHost: string;
  /** SSH port of the node where this backup is stored */
  nodePort: number;
}

/** One archive of a `type: volume` backup */
export interface BackupVolumeRecord {
  name: string;
  sizeBytes: number;
  mountType: 'volume' | 'bind';
  /** Docker volume name or host path */
  sourcePath: string;
}

export interface BackupMetadata extends BackupBaseEntry {
  durationMs: number;
  stackName: string;
  volumes?: BackupVolumeRecord[];
}

export interface BackupListEntry extends BackupBaseEntry {
  filePath: string;
  /** Name of the server the backup was listed on */
  node: string;
}

export interface BackupListing {
  /** newest first */
  entries: BackupListEntry[];
  /** servers with SSH credentials that did not answer; backups stored there are not listed */
  unreachable: ClusterNode[];
}

export interface PruneReport {
  /** backups removed by retention (data files and metadata) */
  removed: number;
  /** data files left by interrupted backups: no metadata, older than BACKUP_ORPHAN_GRACE_H */
  orphanFiles: number;
  bytesFreed: number;
}

export interface RestoreOptions {
  /** restore a dump whose integrity marker is missing after checking it by other means */
  forceUnverified: boolean;
}

export interface BackupOptions {
  /** the pause before forcing a service update after a restore stopped its server */
  sleep?: (ms: number) => Promise<void>;
}

/** Ids and service names end up in the paths of remote `rm` commands. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
