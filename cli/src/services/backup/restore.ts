/**
 * Restoring a database backup into its running container, and the refusals that come before
 * it: a backup of another type, a service running several replicas, redis with appendonly.
 */

import type { ClusterNode, SSHKeyConnection } from '../../types';
import type { BackupAccessoryConfig, BackupDbType } from '../../utils/config';
import { ok, err, type Result } from '../../types';
import { BackupError, ErrorCode } from '../../utils/errors';
import { shellQuote, sshExec } from '../../utils/ssh';
import { printDebug } from '../../utils/output';
import { findSwarmContainer, qualifyServiceName } from '../swarm/docker';
import type { SwarmStack } from '../swarm/stack';
import {
  DB_TYPES,
  buildBackupDir,
  buildDataFilePath,
  buildRestoreScript,
  parseRestoreRefusal,
  recordedIntegrity,
  stripRefusalMarker,
} from '../backup-strategies';
import { restoreVolumes } from './restore-volumes';
import { streamInto } from './restore-stream';
import { verifyBeforeRestore } from './verify';
import type { BackupListEntry, RestoreOptions } from './types';

const RESTART_PAUSE_MS = 3000;

/**
 * A backup of another type than the one configured would be fed to the wrong tool: a mysql dump to
 * psql, a volume archive to a database.
 */
export function restoreTypeMismatch(
  entry: { id: string; dbType: BackupDbType },
  service: string,
  config: BackupAccessoryConfig,
): BackupError | null {
  if (entry.dbType === config.type) return null;
  return new BackupError(
    `Backup ${entry.id} is a ${entry.dbType} backup, but ${service} is configured with type ${config.type}`,
    {
      code: ErrorCode.RESTORE_FAILED,
      suggestion: `Restore it with a backup configuration of type ${entry.dbType}, or pick a backup of type ${config.type} with \`--from <id>\`.`,
    },
  );
}

/**
 * The error to refuse a restore with when the service runs several replicas: the restore writes
 * into one of them only, and the others would keep, or replicate over, the old data. Null when
 * it runs one, or when the manager does not say.
 */
export async function replicaRefusal(
  connection: SSHKeyConnection,
  stackName: string,
  nodeCount: number,
  service: string,
  scaleHint: string,
): Promise<BackupError | null> {
  const result = await sshExec(
    connection,
    `docker service inspect ${shellQuote(qualifyServiceName(stackName, service))} ` +
      `--format '{{if .Spec.Mode.Global}}global{{else if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}'`,
  );
  const mode = result.exitCode === 0 ? result.stdout.trim() : '';
  const replicas = mode === 'global' ? (nodeCount > 1 ? nodeCount : 1) : Number(mode);
  if (!Number.isInteger(replicas) || replicas <= 1) return null;
  const runs = mode === 'global' ? `runs on each of the ${replicas} servers` : `runs ${replicas} replicas`;
  return new BackupError(`${service} ${runs}; a restore writes into one of them only`, {
    code: ErrorCode.RESTORE_FAILED,
    suggestion: scaleHint,
  });
}

/** What a restore needs from the Backup instance that runs it */
export interface RestoreContext {
  stackName: string;
  swarm: SwarmStack;
  sleep: (ms: number) => Promise<void>;
  findContainer: (service: string) => ReturnType<typeof findSwarmContainer>;
}

/**
 * Restore the backup `entry`, which is stored on `node`: volumes through the volume flow, a
 * database by streaming the verified dump into the container.
 */
export async function restoreEntry(
  context: RestoreContext,
  service: string,
  entry: BackupListEntry,
  node: ClusterNode,
  config: BackupAccessoryConfig,
  compression?: 'gzip' | 'none',
  options: RestoreOptions = { forceUnverified: false },
): Promise<Result<void, Error>> {
  const dbType = config.type;

  const mismatch = restoreTypeMismatch(entry, service, config);
  if (mismatch) return err(mismatch);
  const nodeConn = node.connection;
  const backupId = entry.id;
  const backupDir = buildBackupDir(context.stackName, service);

  // Determine compression from argument or metadata
  const backupCompression = compression ?? entry.compression;

  // Volume restore uses a different flow (docker run instead of docker exec)
  if (dbType === 'volume') {
    return restoreVolumes(context.stackName, service, backupId, backupCompression, node);
  }

  const found = await context.findContainer(service);
  if (!found) {
    return err(new BackupError(`No running container found for service ${service}`, { code: ErrorCode.CONTAINER_NOT_FOUND }));
  }
  const { containerId, connection: containerConn } = found;

  const dataFile = buildDataFilePath(backupDir, backupId, dbType, backupCompression);

  // Refuse to stream an empty/corrupt backup into the database — for
  // postgres/mysql an empty stream would be a silent no-op "success",
  // and file-overwriting restores (redis) would destroy the live data.
  const verdict = await verifyBeforeRestore(nodeConn, dataFile, backupCompression, recordedIntegrity(dbType, backupCompression, entry.integrity), backupId, options);
  if (verdict) return err(verdict);

  let restoreScript: string;
  try {
    restoreScript = buildRestoreScript(config);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // The container may have moved to another node since the backup was taken
  const dockerExec = `docker exec -i ${shellQuote(containerId)} sh -c ${shellQuote(restoreScript)}`;
  let result: { exitCode: number; stderr: string };
  try {
    result = await streamInto(node, dataFile, backupCompression === 'gzip', containerConn, dockerExec);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  if (parseRestoreRefusal(result.stderr) === 'redis-appendonly') {
    return err(new BackupError(
      `Redis in service ${service} has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed`,
      {
        code: ErrorCode.RESTORE_FAILED,
        suggestion: 'Back up and restore this service with `type: volume`.',
      },
    ));
  }

  // For strategies that kill the container as part of restore (e.g. Redis SHUTDOWN NOSAVE),
  // a non-zero exit from docker exec is expected — the process died mid-exec.
  // Only treat it as an error if there's actual stderr output.
  const restoreKillsContainer = DB_TYPES[dbType].requiresServiceRestart;
  const detail = stripRefusalMarker(result.stderr).trim();
  if (result.exitCode !== 0 && (!restoreKillsContainer || detail)) {
    return err(new Error(`Restore failed: ${detail || `exit code ${result.exitCode}`}`));
  }

  // If the restore killed the container (e.g. Redis SHUTDOWN NOSAVE):
  // Swarm's restart_policy brings it back automatically in most cases.
  // We also force a service update as a safety net for setups where the restart
  // policy is disabled or exhausted — non-fatal if it fails.
  if (restoreKillsContainer) {
    await context.sleep(RESTART_PAUSE_MS);
    try {
      await context.swarm.restart(context.stackName, service);
    } catch (e) {
      printDebug(`Service update after restore failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return ok(undefined);
}
