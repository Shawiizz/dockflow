/**
 * The containers of a stack's services: located across all nodes, then reached with
 * `docker exec`, `docker cp` and `docker logs` on the node that runs them.
 */

import { PassThrough, type Readable } from 'stream';
import type { SSHKeyConnection } from '../../types';
import { sshExec, sshExecStream, sshExecChannelUnbuffered, executeInteractiveSSH, shellQuote, type SSHUnbufferedChannelHandle } from '../../utils/ssh';
import { CLIError, ConnectionError, ErrorCode } from '../../utils/errors';
import type { ExecRequest } from '../../utils/exec-plan';
import { printWarning } from '../../utils/output';
import type { LogSource, LogsOptions } from './types';
import { ContainerPathError } from './copy';
import { LogLineBuffer } from '../../utils/docker-logs';
import { findSwarmContainer, findContainerForTask, listSwarmTasks, qualifyServiceName } from './docker';
import { dockerSinceValue, LOCAL_OFFSET, parseSince } from '../../utils/log-options';

/** `docker exec [-it|-i] [-w <dir>] [-u <user>] [-e KEY=VALUE]... <id> <argv...>`, every element quoted. */
export function dockerExecCommand(
  containerId: string,
  argv: readonly string[],
  options: Partial<Pick<ExecRequest, 'tty' | 'stdin' | 'workdir' | 'user' | 'env'>> = {},
): string {
  const parts = ['docker exec'];
  if (options.tty) parts.push('-it');
  else if (options.stdin) parts.push('-i');
  if (options.workdir !== undefined) parts.push('-w', shellQuote(options.workdir));
  if (options.user !== undefined) parts.push('-u', shellQuote(options.user));
  for (const [key, value] of Object.entries(options.env ?? {})) parts.push('-e', shellQuote(`${key}=${value}`));
  parts.push(shellQuote(containerId), ...argv.map(shellQuote));
  return parts.join(' ');
}

const COPY_NOT_FOUND = /Could not find the file|No such container:path/i;
const COPY_NOT_A_DIRECTORY = /not a directory|must be a directory/i;

/** The error `docker cp` reported on stderr, said in terms of the container path. */
function copyFailure(stderr: string, exitCode: number, subject: string, path: string, service: string): ContainerPathError {
  if (COPY_NOT_FOUND.test(stderr)) return new ContainerPathError(`Path ${path} does not exist in ${service}`, 'not-found');
  if (COPY_NOT_A_DIRECTORY.test(stderr)) return new ContainerPathError(`Path ${path} in ${service} is not a directory`, 'not-a-directory');
  const detail = stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? `exit ${exitCode}`;
  return new ContainerPathError(`${subject} failed: ${detail}`, 'other');
}

/** What `stream` has emitted so far, as text. */
function collectText(stream: Readable): () => string {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
  return () => Buffer.concat(chunks).toString('utf8');
}

function streamEnded(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded || stream.destroyed) return resolve();
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', () => resolve());
  });
}

interface LocatedContainer {
  containerId: string;
  connection: SSHKeyConnection;
}

/** A service's tasks that are meant to run now; a job's tasks are meant to complete, and their logs are what it printed. */
export function tasksToFollow<T extends { desiredState: string }>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => task.desiredState === 'Running' || task.desiredState === 'Complete');
}

export class SwarmContainers {
  constructor(
    private readonly conn: SSHKeyConnection,
    private readonly allConnections: SSHKeyConnection[],
  ) {}

  /** One command talks to one container: the probe and the copy must not land on two replicas. */
  private readonly located = new Map<string, Promise<LocatedContainer>>();

  /** The chosen task's container, else a running container of the service, on whichever node runs it. */
  private locate(stackName: string, serviceName: string, taskId?: string): Promise<LocatedContainer> {
    const key = `${stackName}\0${serviceName}\0${taskId ?? ''}`;
    let located = this.located.get(key);
    if (!located) {
      located = this.findContainer(stackName, serviceName, taskId);
      this.located.set(key, located);
      located.catch(() => this.located.delete(key));
    }
    return located;
  }

  private async findContainer(stackName: string, serviceName: string, taskId?: string): Promise<LocatedContainer> {
    const found = taskId
      ? await findContainerForTask(taskId, [this.conn, ...this.allConnections])
      : await findSwarmContainer(stackName, serviceName, this.conn, this.allConnections);
    if (found) return found;
    throw new CLIError(
      taskId ? `Task ${taskId} of ${serviceName} has no container on any reachable node` : `Service ${serviceName} has no running container`,
      ErrorCode.CONTAINER_NOT_FOUND,
      'Check its tasks with `dockflow ps <env>`.',
    );
  }

  async run(stackName: string, serviceName: string, request: ExecRequest, taskId?: string): Promise<number> {
    const found = await this.locate(stackName, serviceName, taskId);
    const command = dockerExecCommand(found.containerId, request.argv, request);
    if (request.tty) return executeInteractiveSSH(found.connection, command);

    let channel: SSHUnbufferedChannelHandle;
    try {
      channel = await sshExecChannelUnbuffered(found.connection, command);
    } catch (error) {
      throw new ConnectionError(`Could not reach the node running ${serviceName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { stream } = channel;
    stream.pipe(process.stdout, { end: false });
    stream.stderr.pipe(process.stderr, { end: false });
    if (request.stdin) process.stdin.pipe(stream);
    else stream.end();
    try {
      const { exitCode } = await channel.done;
      return exitCode;
    } finally {
      if (request.stdin) {
        process.stdin.unpipe(stream);
        // an unpiped stdin still holds the event loop open
        process.stdin.pause();
      }
    }
  }

  async shell(stackName: string, serviceName: string, shell: 'auto' | '/bin/sh' | '/bin/bash', taskId?: string): Promise<number> {
    const found = await this.locate(stackName, serviceName, taskId);
    const id = shellQuote(found.containerId);
    let path = shell;
    if (path === 'auto') {
      const probe = await sshExec(found.connection, `docker exec ${id} which bash 2>/dev/null || echo not_found`);
      path = probe.stdout.trim() === 'not_found' ? '/bin/sh' : '/bin/bash';
    }
    return executeInteractiveSSH(found.connection, `docker exec -it ${id} ${shellQuote(path)}`);
  }

  /**
   * `docker cp <id>:<path> -` on the container's node. The exit status is only known after the
   * archive, so the stream ends only once it is 0; otherwise it errors with the copy error.
   */
  async copyOut(stackName: string, serviceName: string, path: string, taskId?: string): Promise<Readable> {
    const found = await this.locate(stackName, serviceName, taskId);
    const channel = await this.openCopyChannel(found.connection, `docker cp ${shellQuote(`${found.containerId}:${path}`)} -`);
    const { stream } = channel;
    stream.end();
    const stderr = collectText(stream.stderr);
    const archive = new PassThrough();
    stream.pipe(archive, { end: false });
    let finished = false;
    // a reader that stops early (the destination probe reads one header) releases the channel
    archive.once('close', () => {
      if (!finished) stream.close();
    });
    Promise.all([channel.done, streamEnded(stream), streamEnded(stream.stderr)]).then(
      ([{ exitCode }]) => {
        finished = true;
        if (exitCode === 0) archive.end();
        else archive.destroy(copyFailure(stderr(), exitCode, `Copying ${path} out of ${serviceName}`, path, serviceName));
      },
      () => {
        finished = true;
        archive.destroy(new ConnectionError(`Lost the connection to ${found.connection.host} while copying ${path} out of ${serviceName}`));
      },
    );
    return archive;
  }

  /** `docker cp - <id>:<destDir>` with the tar stream on stdin. */
  async copyIn(stackName: string, serviceName: string, destDir: string, archive: Readable, taskId?: string): Promise<void> {
    // listening before the first await: the archive may fail while the container is being located
    let closeChannel = () => {};
    const localFailure = new Promise<never>((_, reject) => {
      archive.once('error', (error) => {
        closeChannel();
        reject(error);
      });
    });
    localFailure.catch(() => {});

    const found = await Promise.race([this.locate(stackName, serviceName, taskId), localFailure]);
    const channel = await Promise.race([
      this.openCopyChannel(found.connection, `docker cp - ${shellQuote(`${found.containerId}:${destDir}`)}`),
      localFailure,
    ]);
    const { stream } = channel;
    closeChannel = () => stream.close();
    const stderr = collectText(stream.stderr);
    stream.resume();
    archive.pipe(stream);
    const remote = Promise.all([channel.done, streamEnded(stream), streamEnded(stream.stderr)]).then(
      ([{ exitCode }]) => exitCode,
      () => {
        throw new ConnectionError(`Lost the connection to ${found.connection.host} while copying into ${destDir} of ${serviceName}`);
      },
    );
    const exitCode = await Promise.race([remote, localFailure]);
    if (exitCode !== 0) throw copyFailure(stderr(), exitCode, `Copying into ${destDir} of ${serviceName}`, destDir, serviceName);
  }

  private async openCopyChannel(connection: SSHKeyConnection, command: string): Promise<SSHUnbufferedChannelHandle> {
    try {
      return await sshExecChannelUnbuffered(connection, command);
    } catch (error) {
      throw new ConnectionError(`Could not reach ${connection.host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onLine: (line: string, source: LogSource) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const allConns = [this.conn, ...this.allConnections];
    const single: LogSource = { instance: serviceName, instances: 1 };

    if (options.taskId) {
      const found = await findContainerForTask(options.taskId, allConns);
      if (!found) {
        onError(new Error(`Task ${options.taskId} not found on any node`));
        return;
      }
      await this.runLogStream(found.connection, 'docker logs', found.containerId, options, (line) => onLine(line, single), onError);
      return;
    }

    if (options.allTasks) {
      // docker service logs names each line's task itself
      await this.runLogStream(this.conn, 'docker service logs', qualifyServiceName(stackName, serviceName), options, (line) => onLine(line, single), onError);
      return;
    }

    const running = tasksToFollow(await listSwarmTasks(stackName, serviceName, this.conn));
    if (running.length === 0) {
      onError(new Error(
        `No running tasks for service ${serviceName}. ` +
        `Use --all-tasks to see logs from terminated replicas.`
      ));
      return;
    }

    await Promise.all(running.map(async (task) => {
      const found = await findContainerForTask(task.id, allConns);
      if (!found) {
        // never skip silently: a missing container means partial logs, typically an
        // unreachable node or a connection list missing workers
        printWarning(
          `Logs incomplete: container for task ${task.id.slice(0, 12)} (node ${task.node}) not found on any reachable node`,
        );
        return;
      }
      const source: LogSource = { instance: `${serviceName}.${task.slot}`, instances: running.length };
      await this.runLogStream(found.connection, 'docker logs', found.containerId, options, (line) => onLine(line, source), onError);
    }));
  }

  private async runLogStream(
    connection: SSHKeyConnection,
    baseCommand: string,
    target: string,
    options: LogsOptions,
    onLine: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const parts = [baseCommand];
    if (options.follow) parts.push('-f');
    parts.push(`--tail ${options.tail ?? 100}`);
    if (options.timestamps) parts.push('--timestamps');
    if (options.since !== undefined) parts.push(`--since ${shellQuote(dockerSinceValue(parseSince(options.since, LOCAL_OFFSET)))}`);
    parts.push(shellQuote(target), '2>&1');

    // whole lines only: a chunk can end in the middle of one
    const stdout = new LogLineBuffer();
    const stderr = new LogLineBuffer();
    const emit = (lines: string[]) => {
      for (const line of lines) if (line.length > 0) onLine(line);
    };

    try {
      await sshExecStream(connection, parts.join(' '), {
        onStdout: (chunk) => emit(stdout.push(chunk)),
        onStderr: (chunk) => emit(stderr.push(chunk)),
      });
      emit(stdout.flush());
      emit(stderr.flush());
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
