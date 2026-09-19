/**
 * Swarm BackupBackend (design-06 4.4): dumps and restores through `docker exec` in the service's
 * container, volume archives and restores through a throwaway alpine container. Files are
 * written on the node running the container. Verification, metadata and the restore refusals
 * belong to `services/backup.ts`, which is the same for both orchestrators.
 */

import { posix } from 'path';
import { BackupError, ErrorCode } from '../../../utils/errors';
import { shortHash } from '../../../utils/hash';
import { printDebug } from '../../../utils/output';
import { shellQuote, sshExec, sshExecChannel, sshExecChannelUnbuffered } from '../../../utils/ssh';
import {
  buildCapturePipeline,
  buildDiscardScript,
  buildExtractScript,
  buildSwapScript,
  parseContainerMounts,
  previousDirName,
  RESTORE_MOUNT_DIR,
} from '../../backup-strategies';
import type {
  BackupBackend,
  BackupFile,
  BackupVolume,
  ClusterNodeRef,
  InstanceTarget,
  OrchestratorTarget,
  StackNaming,
  StackRef,
} from '../interfaces';
import { findContainerForTask, findSwarmContainer } from './swarm-utils';

export interface SwarmBackupOptions {
  /** the pause before forcing a service update after a restore stopped its server */
  sleep?: (ms: number) => Promise<void>;
}

/** image of the throwaway containers reading and writing volumes (today's choice, kept) */
const VOLUME_IMAGE = 'alpine';
const RESTART_PAUSE_MS = 3000;
const STDERR_LINES = 5;

interface Located {
  containerId: string;
  node: ClusterNodeRef;
}

interface VolumePlan {
  volume: BackupVolume;
  file: BackupFile;
  node: ClusterNodeRef;
  /** `-v <source>:/dockflow/v0` */
  mount: string;
}

function sameNode(a: ClusterNodeRef, b: ClusterNodeRef): boolean {
  return a.connection.host === b.connection.host && a.connection.port === b.connection.port;
}

function headLines(text: string, count: number = STDERR_LINES): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, count)
    .join('; ');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SwarmBackupBackend implements BackupBackend {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly target: OrchestratorTarget,
    private readonly naming: StackNaming,
    options: SwarmBackupOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ─── Nodes and containers ───────────────────────────────────────────────

  private nodes(): ClusterNodeRef[] {
    const seen = new Set<string>();
    return [this.target.controlPlane, ...this.target.managers, ...this.target.workers].filter((node) => {
      const key = `${node.connection.host}:${node.connection.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private nodeNamed(name: string | null): ClusterNodeRef | null {
    return name === null ? null : (this.nodes().find((node) => node.name === name) ?? null);
  }

  /** the running container of the service (or of the chosen task), raced over every node */
  private async locate(ref: StackRef, target: InstanceTarget): Promise<Located> {
    const nodes = this.nodes();
    const connections = nodes.map((node) => node.connection);
    const found = target.instance
      ? await findContainerForTask(target.instance, connections)
      : await findSwarmContainer(
          this.naming.scope(ref),
          this.naming.serviceNativeName(ref, target.service),
          this.target.controlPlane.connection,
          connections,
        );
    if (!found) {
      throw new BackupError(`No running container found for service ${target.service}`, {
        code: ErrorCode.CONTAINER_NOT_FOUND,
      });
    }
    const node =
      nodes.find((candidate) => candidate.connection.host === found.connection.host && candidate.connection.port === found.connection.port) ??
      this.target.controlPlane;
    return { containerId: found.containerId, node };
  }

  private async removeFiles(files: BackupFile[]): Promise<void> {
    for (const file of files) {
      try {
        await sshExec(file.node.connection, `rm -f -- ${shellQuote(file.remotePath)}`);
      } catch (error) {
        printDebug(`Could not remove ${file.remotePath} on ${file.node.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Streams a backup file into `command` on `node`: one pipeline when the file is there, else a
   * relay through the CLI with backpressure (the container moved since the backup was taken).
   */
  private async streamInto(
    file: BackupFile,
    gunzip: boolean,
    node: ClusterNodeRef,
    command: string,
  ): Promise<{ exitCode: number; stderr: string }> {
    const path = shellQuote(file.remotePath);
    if (sameNode(file.node, node)) {
      const result = await sshExec(node.connection, gunzip ? `gunzip -c ${path} | ${command}` : `${command} < ${path}`);
      return { exitCode: result.exitCode, stderr: result.stderr };
    }

    const source = await sshExecChannelUnbuffered(file.node.connection, `${gunzip ? 'gunzip -c' : 'cat'} ${path}`);
    const sink = await sshExecChannel(node.connection, command);
    let sourceStderr = '';
    source.stream.stderr.on('data', (chunk: Buffer) => {
      sourceStderr += chunk.toString();
    });
    source.stream.on('error', (error: Error) => printDebug(`Backup relay source: ${error.message}`));
    sink.stream.on('error', (error: Error) => printDebug(`Backup relay target: ${error.message}`));

    // Whichever side settles first decides: a reader that failed first truncated the stream; a
    // restore that finished first stopped reading (a refusal), so the reader is closed.
    const settled: { first: 'source' | 'sink' | null } = { first: null };
    const sourceOutcome = source.done.then(
      (result) => {
        settled.first ??= 'source';
        return result.exitCode;
      },
      (error: unknown) => {
        settled.first ??= 'source';
        printDebug(`Backup relay source: ${error instanceof Error ? error.message : String(error)}`);
        return -1;
      },
    );
    const sinkOutcome = sink.done.then((result) => {
      settled.first ??= 'sink';
      if (!source.stream.readableEnded) {
        source.stream.unpipe(sink.stream);
        source.stream.destroy();
      }
      return result;
    });
    source.stream.pipe(sink.stream);

    const [sourceExit, result] = await Promise.all([sourceOutcome, sinkOutcome]);
    if (settled.first === 'source' && sourceExit !== 0) {
      throw new BackupError(
        `Cannot read backup file ${file.remotePath} on ${file.node.name}: ${headLines(sourceStderr) || `exit code ${sourceExit}`}`,
        { code: ErrorCode.RESTORE_FAILED },
      );
    }
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  // ─── BackupBackend ──────────────────────────────────────────────────────

  async dump(ref: StackRef, target: InstanceTarget, script: string, remotePath: string, options: { gzip: boolean }): Promise<BackupFile> {
    const { containerId, node } = await this.locate(ref, target);
    // the container's own shell reads the credentials from its environment: none on the host argv
    const producer = `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(script)}`;
    const result = await sshExec(node.connection, buildCapturePipeline(producer, remotePath, options.gzip));
    if (result.exitCode !== 0) {
      await this.removeFiles([{ node, remotePath }]);
      throw new BackupError(`Backup of ${target.service} failed (exit ${result.exitCode}): ${headLines(result.stderr)}`);
    }
    return { node, remotePath };
  }

  async restore(
    ref: StackRef,
    target: InstanceTarget,
    script: string,
    file: BackupFile,
    options: { gunzip: boolean },
  ): Promise<{ exitCode: number; stderr: string }> {
    const { containerId, node } = await this.locate(ref, target);
    // the outcome is returned untouched: services/backup.ts reads the refusal marker and exit code
    return this.streamInto(file, options.gunzip, node, `docker exec -i ${shellQuote(containerId)} sh -c ${shellQuote(script)}`);
  }

  async volumes(ref: StackRef, service: string, options: { includeBindMounts: boolean; exclude: string[] }): Promise<BackupVolume[]> {
    const { containerId, node } = await this.locate(ref, { service });
    const result = await sshExec(node.connection, `docker inspect --format '{{json .Mounts}}' ${shellQuote(containerId)}`);
    if (result.exitCode !== 0) {
      throw new BackupError(`Cannot read the mounts of ${service} on ${node.name}: ${headLines(result.stderr)}`);
    }
    let mounts: ReturnType<typeof parseContainerMounts>;
    try {
      mounts = parseContainerMounts(result.stdout, this.naming.scope(ref), options.exclude, options.includeBindMounts);
    } catch (error) {
      throw new BackupError(`Cannot read the mounts of ${service} on ${node.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return mounts.map((mount) => ({
      name: mount.name,
      kind: mount.mountType,
      source: mount.source,
      mountPath: mount.destination,
      node: node.name,
    }));
  }

  async archiveVolumes(
    ref: StackRef,
    service: string,
    volumes: BackupVolume[],
    pathPrefix: string,
    options: { gzip: boolean },
  ): Promise<BackupFile[]> {
    const files: BackupFile[] = [];
    let container: Located | null = null;
    try {
      for (const volume of volumes) {
        const node = this.nodeNamed(volume.node) ?? (container ??= await this.locate(ref, { service })).node;
        const remotePath = `${pathPrefix}.${volume.name}.tar${options.gzip ? '.gz' : ''}`;
        const producer =
          volume.kind === 'volume'
            ? `docker run --rm -v ${shellQuote(volume.source)}:/backup-source:ro ${VOLUME_IMAGE} tar cf - -C /backup-source .`
            : `tar cf - -C ${shellQuote(volume.source)} .`;
        files.push({ node, remotePath });
        const result = await sshExec(node.connection, buildCapturePipeline(producer, remotePath, options.gzip));
        if (result.exitCode !== 0) {
          throw new BackupError(
            `Backup failed for ${volume.kind} ${volume.source}: ${headLines(result.stderr) || `exit code ${result.exitCode}`}`,
          );
        }
      }
      return files;
    } catch (error) {
      await this.removeFiles(files);
      throw error;
    }
  }

  /** the Docker volume an archive goes back into; never a new, empty one created by `docker run -v` */
  private async resolveVolume(ref: StackRef, service: string, volume: BackupVolume, node: ClusterNodeRef): Promise<string> {
    const result = await sshExec(node.connection, `docker volume ls --format '{{.Name}}'`);
    const existing = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()));
    const candidates = [volume.source, `${this.naming.scope(ref)}_${volume.name}`, volume.name];
    const match = candidates.find((candidate) => candidate !== '' && existing.has(candidate));
    if (match === undefined) {
      throw new BackupError(`Backup volume ${volume.name} has no matching volume in service ${service}; nothing was restored`, {
        code: ErrorCode.RESTORE_FAILED,
      });
    }
    return match;
  }

  /** stable per backup (hash of `<dir>/<id>`), so a retry cleans what an interrupted run left */
  private restoreId(archives: { file: BackupFile }[]): string {
    const path = archives[0].file.remotePath;
    const id = posix.basename(path).split('.')[0];
    return shortHash(`${posix.dirname(path)}/${id}`, 8);
  }

  /**
   * Extract every archive beside the current contents, and swap only once all of them succeeded:
   * a bad archive or a full disk leaves every volume as it was. The service keeps running, as it
   * always did on Swarm.
   */
  async restoreVolumes(ref: StackRef, service: string, archives: { volume: BackupVolume; file: BackupFile }[]): Promise<void> {
    if (archives.length === 0) return;
    const id8 = this.restoreId(archives);

    // every mapping is resolved before anything is written
    const plans: VolumePlan[] = [];
    for (const { volume, file } of archives) {
      const node = this.nodeNamed(volume.node) ?? file.node;
      const source = volume.kind === 'bind' ? volume.source : await this.resolveVolume(ref, service, volume, node);
      plans.push({ volume, file, node, mount: `-v ${shellQuote(source)}:${RESTORE_MOUNT_DIR}` });
    }

    const extracted: VolumePlan[] = [];
    try {
      for (const plan of plans) {
        extracted.push(plan);
        const command = `docker run --rm -i ${plan.mount} ${VOLUME_IMAGE} sh -c ${shellQuote(buildExtractScript(RESTORE_MOUNT_DIR, id8))}`;
        const result = await this.streamInto(plan.file, plan.file.remotePath.endsWith('.gz'), plan.node, command);
        if (result.exitCode !== 0) throw this.extractionError(service, plan, result);
      }
    } catch (error) {
      await this.discard(extracted, id8);
      throw error;
    }

    for (const plan of plans) {
      const command = `docker run --rm ${plan.mount} ${VOLUME_IMAGE} sh -c ${shellQuote(buildSwapScript(RESTORE_MOUNT_DIR, id8))}`;
      const result = await sshExec(plan.node.connection, command);
      if (result.exitCode !== 0) {
        throw new BackupError(
          `Restore of ${service} failed while swapping volume ${plan.volume.name}: ${headLines(result.stderr) || `exit code ${result.exitCode}`}; the previous contents are in ${plan.volume.name}/${previousDirName(id8)}`,
          {
            code: ErrorCode.RESTORE_FAILED,
            suggestion: `Retry the restore, or move the files back from that directory with \`dockflow ssh ${this.target.env}\`.`,
          },
        );
      }
    }
  }

  private extractionError(service: string, plan: VolumePlan, result: { exitCode: number; stderr: string }): BackupError {
    if (/No space left on device/i.test(result.stderr)) {
      return new BackupError(
        `Restore of ${service} needs room for a second copy of volume ${plan.volume.name} on ${plan.node.name}; nothing was changed`,
        {
          code: ErrorCode.RESTORE_FAILED,
          suggestion: `Free disk space on ${plan.node.name} and run the restore again; the current contents were kept.`,
        },
      );
    }
    return new BackupError(
      `Restore of ${service} failed while reading the archive of volume ${plan.volume.name}: ${headLines(result.stderr) || `exit code ${result.exitCode}`}; nothing was changed`,
      { code: ErrorCode.RESTORE_FAILED },
    );
  }

  /** removes the extraction directories a failed first phase left beside the data */
  private async discard(plans: VolumePlan[], id8: string): Promise<void> {
    for (const plan of plans) {
      const command = `docker run --rm ${plan.mount} ${VOLUME_IMAGE} sh -c ${shellQuote(buildDiscardScript(RESTORE_MOUNT_DIR, id8))}`;
      try {
        const result = await sshExec(plan.node.connection, command);
        if (result.exitCode !== 0) printDebug(`Could not clean the restore directory of ${plan.volume.name}: ${headLines(result.stderr)}`);
      } catch (error) {
        printDebug(`Could not clean the restore directory of ${plan.volume.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * The restore stopped the server (redis SHUTDOWN NOSAVE). The restart policy usually brings the
   * task back; forcing an update covers a disabled or exhausted policy. Failures stay non-fatal.
   */
  async restartAfterRestore(ref: StackRef, service: string): Promise<void> {
    await this.sleep(RESTART_PAUSE_MS);
    const name = this.naming.serviceNativeName(ref, service);
    try {
      const result = await sshExec(this.target.controlPlane.connection, `docker service update --force ${shellQuote(name)}`);
      if (result.exitCode !== 0) printDebug(`Service update after restore failed (non-fatal): ${headLines(result.stderr)}`);
    } catch (error) {
      printDebug(`Service update after restore failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
