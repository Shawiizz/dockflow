/**
 * Upload plan types and the pure path helpers shared by uploadFiles and rollbackUploads, so the
 * backup paths written during an upload always match the ones read on rollback.
 */

import { dirname } from 'path';
import type { UploadItem } from '../../utils/config';
import type { SSHKeyConnection } from '../../types';

export interface HostUploadState {
  name: string;
  conn: SSHKeyConnection;
  backedUp: string[];                                       // individual files backed up
  created: string[];                                        // individual files created (no prior backup)
  backedUpDirs: Array<{ dest: string; backup: string }>;   // dirs backed up as tar.gz
  createdDirs: string[];                                    // dirs created from scratch
}

export interface UploadRollbackPlan {
  hosts: HostUploadState[];
  backupBaseDir: string;
}

/** Final destination for a single-file upload: trailing-slash dests get the source basename. */
export function resolveFileDestPath(dest: string, srcBasename: string): string {
  return dest.endsWith('/') ? `${dest.replace(/\/$/, '')}/${srcBasename}` : dest;
}

/**
 * The directory the deploy user must own for an upload to succeed: files are written with
 * `cat > path`, which needs write access on the containing directory, not on the file. A directory
 * upload owns its destination outright; a file upload owns the directory holding it.
 */
export function uploadOwnedDir(dest: string, isDirUpload: boolean): string {
  const clean = dest.replace(/\/$/, '');
  return isDirUpload || dest.endsWith('/') ? clean : dirname(clean);
}

export function fileBackupPath(backupBaseDir: string, destPath: string): string {
  return `${backupBaseDir}/${destPath.replace(/^\//, '')}`;
}

export function dirBackupPath(backupBaseDir: string, destBase: string): string {
  return `${backupBaseDir}/${destBase.replace(/^\//, '')}.tar.gz`;
}

/**
 * The uploads that apply to a partial deploy (--only): those without a service always do, the
 * others when one of their services is targeted.
 */
export function filterUploads(uploads: UploadItem[] | undefined, only?: string): UploadItem[] {
  if (!uploads || uploads.length === 0) return [];
  if (!only) return uploads;
  const serviceFilter = new Set(only.split(',').map((s: string) => s.trim()));
  return uploads.filter(u => {
    if (!u.service) return true;
    const services = Array.isArray(u.service) ? u.service : [u.service];
    return services.some(s => serviceFilter.has(s));
  });
}

/** How an upload is named in the output: its plugin label, or its source path. */
export function uploadName(upload: UploadItem): string {
  return upload.label ?? upload.src;
}
