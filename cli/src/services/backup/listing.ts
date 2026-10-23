/**
 * Finding backups across the nodes: which nodes a command addresses, listing the metadata they
 * hold, and resolving an id, a prefix or "latest" to one listed backup.
 */

import type { ClusterNode } from '../../types';
import { ok, err, type Result } from '../../types';
import { BackupError, ErrorCode, ValidationError } from '../../utils/errors';
import { printDebug } from '../../utils/output';
import { shellQuote, sshExec } from '../../utils/ssh';
import { DOCKFLOW_BACKUPS_DIR } from '../../constants';
import { buildBackupDir, buildDataFilePath, findBackupMatch, newestBackupFirst } from '../backup-strategies';
import { parseMetadata } from './metadata';
import type { BackupListEntry, BackupListing } from './types';

/** Every node, or the one `--node` names */
export function nodesFor(nodes: ClusterNode[], name: string | undefined): ClusterNode[] {
  if (name === undefined) return nodes;
  const node = nodes.find(candidate => candidate.name === name);
  if (!node) {
    throw new ValidationError(
      `Server ${name} is not a server of this environment with SSH credentials`,
      `Pass one of: ${nodes.map(candidate => candidate.name).join(', ')}.`,
    );
  }
  return [node];
}

/** The node holding a backup: the one it was listed on, else the host its metadata recorded */
export function nodeOf(nodes: ClusterNode[], entry: { node?: string; nodeHost: string; nodePort: number; id: string }): ClusterNode {
  const node = nodes.find(candidate => candidate.name === entry.node)
    ?? nodes.find(candidate => candidate.connection.host === entry.nodeHost && candidate.connection.port === entry.nodePort);
  if (!node) {
    throw new BackupError(
      `Backup ${entry.id} is stored on ${entry.nodeHost}:${entry.nodePort}, which is not a server of this environment with SSH credentials`,
      { code: ErrorCode.BACKUP_NOT_FOUND },
    );
  }
  return node;
}

/** The backups of a service on the nodes that answer, which a new backup must sort after */
export async function storedBackups(
  list: () => Promise<Result<BackupListing, Error>>,
  service: string,
): Promise<BackupListEntry[]> {
  try {
    const listed = await list();
    return listed.success ? listed.data.entries : [];
  } catch (e) {
    printDebug(`Stored backups of ${service} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Backups newest first, from every node in parallel; a node that does not answer is reported in `unreachable`. */
export async function listBackups(
  allNodes: ClusterNode[],
  stackName: string,
  service?: string,
  options: { node?: string } = {},
): Promise<Result<BackupListing, Error>> {
  let nodes: ClusterNode[];
  try {
    nodes = nodesFor(allNodes, options.node);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  const SEP = '---DOCKFLOW_META_SEP---';
  const baseDir = service
    ? buildBackupDir(stackName, service)
    : `${DOCKFLOW_BACKUPS_DIR}/${stackName}`;
  const findCmd = `find ${shellQuote(baseDir)} -name '*.meta.json' 2>/dev/null | sort -r | while IFS= read -r f; do echo '${SEP}'; cat "$f"; done`;

  const answers = await Promise.all(nodes.map(async (node) => {
    try {
      return { node, stdout: (await sshExec(node.connection, findCmd)).stdout };
    } catch (e) {
      printDebug(`Backups on ${node.name} could not be listed: ${e instanceof Error ? e.message : String(e)}`);
      return { node, stdout: null };
    }
  }));

  const entries: BackupListEntry[] = [];
  const unreachable: ClusterNode[] = [];
  const seenIds = new Set<string>();

  for (const { node, stdout } of answers) {
    if (stdout === null) {
      unreachable.push(node);
      continue;
    }
    for (const chunk of stdout.split(SEP)) {
      if (!chunk.trim()) continue;
      const meta = parseMetadata(chunk.trim());
      if (!meta) continue;

      // a replicated backup id can appear on several nodes
      if (seenIds.has(meta.id)) continue;
      seenIds.add(meta.id);

      const dir = buildBackupDir(stackName, meta.service);
      const volumeName = meta.dbType === 'volume' && meta.volumes?.length
        ? meta.volumes[0].name
        : undefined;

      entries.push({
        id: meta.id,
        service: meta.service,
        dbType: meta.dbType,
        timestamp: meta.timestamp,
        epochMs: typeof meta.epochMs === 'number' ? meta.epochMs : undefined,
        size: meta.size,
        sizeBytes: meta.sizeBytes,
        compression: meta.compression,
        integrity: meta.integrity,
        filePath: buildDataFilePath(dir, meta.id, meta.dbType, meta.compression, volumeName),
        nodeHost: meta.nodeHost,
        nodePort: meta.nodePort,
        node: node.name,
      });
    }
  }

  entries.sort(newestBackupFirst);

  return ok({ entries, unreachable });
}

/** The listed entry of a backup id; one that is not listed names the nodes that did not answer */
export function listedEntry(listed: Result<BackupListing, Error>, backupId: string): BackupListEntry {
  if (!listed.success) throw listed.error;
  const entry = listed.data.entries.find(candidate => candidate.id === backupId);
  if (entry) return entry;
  const names = listed.data.unreachable.map(node => node.name).join(', ');
  throw new BackupError(`Backup ${backupId} not found`, {
    code: ErrorCode.BACKUP_NOT_FOUND,
    suggestion: names ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined,
  });
}

/**
 * Resolve a backup by ID prefix or "latest" (undefined) in a listing. The newest backup cannot
 * be known while a node that may hold a newer one did not answer, so "latest" is refused then.
 */
export function resolveFromListing(
  listResult: Result<BackupListing, Error>,
  service: string,
  idOrLatest?: string
): Result<BackupListEntry, Error> {
  if (!listResult.success) return err(listResult.error);

  const { entries, unreachable } = listResult.data;
  const names = unreachable.map(node => node.name).join(', ');
  const latest = !idOrLatest || idOrLatest === 'latest';

  if (latest && unreachable.length > 0) {
    return err(new BackupError(`The newest backup of ${service} cannot be determined: ${names} did not answer`, {
      code: ErrorCode.BACKUP_NOT_FOUND,
      suggestion: `Name the backup explicitly with \`--from <id>\`, or bring ${names} back and retry.`,
    }));
  }

  const match = findBackupMatch(entries, latest ? undefined : idOrLatest);
  if (match) return ok(match);

  return err(new BackupError(
    entries.length === 0
      ? `No backups found for service ${service}`
      : `No backup matching "${idOrLatest}" found for service ${service}`,
    {
      code: ErrorCode.BACKUP_NOT_FOUND,
      suggestion: unreachable.length > 0 ? `Bring ${names} back and retry; backups stored there are not listed.` : undefined,
    },
  ));
}
