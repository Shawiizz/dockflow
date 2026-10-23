/**
 * Backup — backup and restore of accessory databases and Docker volumes. Dumps and restores run
 * with `docker exec` in the service container; volumes are archived by a temporary Alpine container.
 *
 * Backups are stored on the node where the service runs, not necessarily the manager: nodeHost and
 * nodePort in the metadata let restore, prune and list connect to the right node.
 *
 * The class is the public entry point; the work of each operation lives in the sibling modules.
 */

import type { ClusterNode, SSHKeyConnection } from '../../types';
import type { BackupAccessoryConfig } from '../../utils/config';
import { err, type Result } from '../../types';
import { BackupError, ErrorCode } from '../../utils/errors';
import { findSwarmContainer } from '../swarm/docker';
import { SwarmStack } from '../swarm/stack';
import { backupDatabase, backupVolumes } from './capture';
import { listBackups, listedEntry, nodeOf, resolveFromListing, storedBackups } from './listing';
import { pruneBackups } from './prune';
import { replicaRefusal, restoreEntry } from './restore';
import type {
  BackupListEntry,
  BackupListing,
  BackupMetadata,
  BackupOptions,
  PruneReport,
  RestoreOptions,
} from './types';

export class Backup {
  private readonly swarm: SwarmStack;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The manager first, then every other server with SSH credentials */
  private readonly nodes: ClusterNode[];

  constructor(
    /** Manager connection — used for Swarm operations (service restart) */
    private readonly connection: SSHKeyConnection,
    private readonly stackName: string,
    /** Every server with SSH credentials — used to find containers and the backups on any node */
    nodes: ClusterNode[] = [],
    options: BackupOptions = {}
  ) {
    this.swarm = new SwarmStack(connection);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const same = (a: SSHKeyConnection, b: SSHKeyConnection) => a.host === b.host && a.port === b.port;
    const manager = nodes.find(node => same(node.connection, connection)) ?? { name: connection.host, connection };
    this.nodes = [manager, ...nodes.filter(node => !same(node.connection, connection))];
  }

  private findContainer(service: string) {
    return findSwarmContainer(this.stackName, service, this.connection, this.nodes.map(node => node.connection));
  }

  /** Backs up an accessory service; the file is written on the node where its container runs. */
  async backup(
    service: string,
    config: BackupAccessoryConfig,
    compression: 'gzip' | 'none' = 'gzip'
  ): Promise<Result<BackupMetadata, Error>> {
    const found = await this.findContainer(service);
    if (!found) {
      return err(new BackupError(`No running container found for service ${service}`, { code: ErrorCode.CONTAINER_NOT_FOUND }));
    }
    const { containerId, connection: nodeConn } = found;
    const stored = () => storedBackups(() => this.list(service), service);

    // a volume backup runs a container (docker run), not docker exec in the service
    if (config.type === 'volume') {
      return backupVolumes(this.stackName, service, containerId, nodeConn, config, compression, stored);
    }
    return backupDatabase(this.stackName, service, containerId, nodeConn, config, compression, stored);
  }

  /** Backups newest first, from every node in parallel; a node that does not answer is reported in `unreachable`. */
  async list(service?: string, options: { node?: string } = {}): Promise<Result<BackupListing, Error>> {
    return listBackups(this.nodes, this.stackName, service, options);
  }

  /**
   * The error to refuse a restore with when the service runs several replicas: the restore writes
   * into one of them only, and the others would keep, or replicate over, the old data. Null when
   * it runs one, or when the manager does not say.
   */
  async replicaRefusal(service: string, scaleHint: string): Promise<BackupError | null> {
    return replicaRefusal(this.connection, this.stackName, this.nodes.length, service, scaleHint);
  }

  /**
   * Restores on the node holding the backup. `backup` is an id to look up on every node, or the
   * entry resolveBackup already found, which spares a second round of listings (and the wait for
   * a node that does not answer).
   */
  async restore(
    service: string,
    backup: string | BackupListEntry,
    config: BackupAccessoryConfig,
    compression?: 'gzip' | 'none',
    options: RestoreOptions = { forceUnverified: false },
  ): Promise<Result<void, Error>> {
    let entry: BackupListEntry;
    let node: ClusterNode;
    try {
      entry = typeof backup === 'string' ? listedEntry(await this.list(service), backup) : backup;
      node = nodeOf(this.nodes, entry);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
    return restoreEntry(
      {
        stackName: this.stackName,
        swarm: this.swarm,
        sleep: this.sleep,
        findContainer: (name) => this.findContainer(name),
      },
      service,
      entry,
      node,
      config,
      compression,
      options,
    );
  }

  /**
   * Keep the `retentionCount` newest backups, and remove data files left without metadata by
   * interrupted backups once they are older than BACKUP_ORPHAN_GRACE_H (a backup being written
   * has no metadata yet). Files are removed on the node they were listed on.
   * `prefetched` entries spare the listing.
   */
  async prune(
    service: string | undefined,
    retentionCount: number,
    options: { node?: string; prefetched?: BackupListEntry[] } = {},
  ): Promise<Result<PruneReport, Error>> {
    return pruneBackups(
      this.nodes,
      this.stackName,
      (name, listOptions) => this.list(name, listOptions),
      service,
      retentionCount,
      options,
    );
  }

  /**
   * Resolve a backup by ID prefix or "latest" (undefined). The newest backup cannot be known
   * while a node that may hold a newer one did not answer, so "latest" is refused then.
   */
  async resolveBackup(
    service: string,
    idOrLatest?: string
  ): Promise<Result<BackupListEntry, Error>> {
    return resolveFromListing(await this.list(service), service, idOrLatest);
  }
}

export function createBackup(
  connection: SSHKeyConnection,
  stackName: string,
  nodes: ClusterNode[] = []
): Backup {
  return new Backup(connection, stackName, nodes);
}
