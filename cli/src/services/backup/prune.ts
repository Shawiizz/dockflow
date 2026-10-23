/**
 * Pruning backups: retention by count, and the sweep of data files that interrupted backups
 * left without metadata.
 */

import type { ClusterNode } from '../../types';
import { ok, err, type Result } from '../../types';
import { BackupError } from '../../utils/errors';
import { raw, sh, sshExec, type RawShell } from '../../utils/ssh';
import { formatBytes, printDebug, printInfo } from '../../utils/output';
import { BACKUP_ORPHAN_GRACE_H, DOCKFLOW_BACKUPS_DIR } from '../../constants';
import { buildBackupDir, selectBackupsToPrune } from '../backup-strategies';
import { nodeOf, nodesFor } from './listing';
import { SAFE_NAME, type BackupListEntry, type BackupListing, type PruneReport } from './types';

/**
 * Keep the `retentionCount` newest backups, and remove data files left without metadata by
 * interrupted backups once they are older than BACKUP_ORPHAN_GRACE_H (a backup being written
 * has no metadata yet). Files are removed on the node they were listed on.
 * `prefetched` entries spare the listing.
 */
export async function pruneBackups(
  allNodes: ClusterNode[],
  stackName: string,
  list: (service: string | undefined, options: { node?: string }) => Promise<Result<BackupListing, Error>>,
  service: string | undefined,
  retentionCount: number,
  options: { node?: string; prefetched?: BackupListEntry[] } = {},
): Promise<Result<PruneReport, Error>> {
  try {
    const nodes = nodesFor(allNodes, options.node);
    let entries = options.prefetched;
    if (!entries) {
      const listed = await list(service, { node: options.node });
      if (!listed.success) return err(listed.error);
      entries = listed.data.entries;
    }

    const toRemove = selectBackupsToPrune(entries, retentionCount);
    const byNode = new Map<string, { node: ClusterNode; patterns: RawShell[] }>();
    let bytesFreed = 0;
    for (const entry of toRemove) {
      if (!SAFE_NAME.test(entry.id) || !SAFE_NAME.test(entry.service)) {
        throw new BackupError(`Backup ${JSON.stringify(entry.id)} of ${JSON.stringify(entry.service)} has an unusable name; nothing was pruned`);
      }
      const node = nodeOf(allNodes, entry);
      const key = `${node.connection.host}:${node.connection.port}`;
      const group = byNode.get(key) ?? { node, patterns: [] };
      // `<id>.` then a glob: the data files, the metadata and any rc file of that backup only
      group.patterns.push(raw(sh`${`${buildBackupDir(stackName, entry.service)}/${entry.id}.`}*`));
      byNode.set(key, group);
      bytesFreed += entry.sizeBytes;
    }
    for (const { node, patterns } of byNode.values()) {
      const result = await sshExec(node.connection, sh`rm -f -- ${patterns}`);
      if (result.exitCode !== 0) {
        throw new BackupError(`Cannot remove backups on ${node.name}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      }
    }

    const orphans = await pruneOrphans(stackName, service, nodes);
    bytesFreed += orphans.bytes;
    if (orphans.files > 0) {
      printInfo(`Removed ${orphans.files} orphaned backup file(s) (${formatBytes(orphans.bytes)}) left by interrupted backups`);
    }
    return ok({ removed: toRemove.length, orphanFiles: orphans.files, bytesFreed });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

async function pruneOrphans(stackName: string, service: string | undefined, nodes: ClusterNode[]): Promise<{ files: number; bytes: number }> {
  const base = service ? buildBackupDir(stackName, service) : `${DOCKFLOW_BACKUPS_DIR}/${stackName}`;
  // backup ids start with the date, so only files named after one are candidates
  const command =
    sh`find ${base} -type f -name '[0-9]*' ! -name '*.meta.json' -mmin +${BACKUP_ORPHAN_GRACE_H * 60} 2>/dev/null | ` +
    `while IFS= read -r f; do b=\${f##*/}; [ -e "\${f%/*}/\${b%%.*}.meta.json" ] && continue; ` +
    `s=$(stat -c %s "$f" 2>/dev/null || echo 0); rm -f -- "$f" && printf '%s\\t%s\\n' "$s" "$f"; done`;

  let files = 0;
  let bytes = 0;
  for (const node of nodes) {
    let stdout: string;
    try {
      stdout = (await sshExec(node.connection, command)).stdout;
    } catch (e) {
      printDebug(`Orphaned backup files on ${node.name} were not checked: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const line of stdout.split(/\r?\n/)) {
      const [size, path] = line.split('\t');
      if (!path) continue;
      files++;
      bytes += Number.parseInt(size, 10) || 0;
      printDebug(`Removed orphaned backup file ${path} on ${node.name}`);
    }
  }
  return { files, bytes };
}
