/**
 * Public API of the backup service: the Backup class and its factory, the types that describe
 * a backup, and the restore type check. The work of each operation lives in the sibling modules.
 */

export * from './backup';
export type {
  BackupBaseEntry,
  BackupListEntry,
  BackupListing,
  BackupMetadata,
  BackupOptions,
  BackupVolumeRecord,
  PruneReport,
  RestoreOptions,
} from './types';
export { restoreTypeMismatch } from './restore';
