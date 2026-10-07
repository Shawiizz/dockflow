/**
 * Swarm container backend.
 *
 * Implements ContainerBackend for Docker Swarm: locates the container for a
 * given service across all Swarm nodes, then runs `docker exec`/`docker cp`
 * on the right node.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { sshExec, sshExecStream, sshExecChannelUnbuffered, executeInteractiveSSH, shellQuote, type SSHUnbufferedChannelHandle } from '../../../utils/ssh';
import { CLIError, ConnectionError, ErrorCode } from '../../../utils/errors';
import type { ExecRequest } from '../../../utils/exec-plan';
import { printWarning } from '../../../utils/output';
import type { ContainerBackend, LogsOptions } from '../interfaces';
import { findSwarmContainer, findContainerForTask, listSwarmTasks, qualifyServiceName } from './swarm-utils';
import { dockerSinceValue, LOCAL_OFFSET, parseSince } from '../../../utils/log-options';

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

export class SwarmContainerBackend implements ContainerBackend {
  constructor(
    private readonly conn: SSHKeyConnection,
    private readonly allConnections: SSHKeyConnection[],
  ) {}

  /** The chosen task's container, else a running container of the service, on whichever node runs it. */
  private async locate(stackName: string, serviceName: string, taskId?: string): Promise<{ containerId: string; connection: SSHKeyConnection }> {
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

  async copyTo(
    stackName: string,
    serviceName: string,
    localPath: string,
    containerPath: string,
  ): Promise<Result<void, Error>> {
    const found = await this.locate(stackName, serviceName);
    const result = await sshExec(found.connection, `docker cp ${shellQuote(localPath)} ${found.containerId}:${shellQuote(containerPath)}`);
    if (result.exitCode !== 0) return err(new Error(`Failed to copy file: ${result.stderr}`));
    return ok(undefined);
  }

  async copyFrom(
    stackName: string,
    serviceName: string,
    containerPath: string,
    localPath: string,
  ): Promise<Result<void, Error>> {
    const found = await this.locate(stackName, serviceName);
    const result = await sshExec(found.connection, `docker cp ${found.containerId}:${shellQuote(containerPath)} ${shellQuote(localPath)}`);
    if (result.exitCode !== 0) return err(new Error(`Failed to copy file: ${result.stderr}`));
    return ok(undefined);
  }

  async streamLogs(
    stackName: string,
    serviceName: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const allConns = [this.conn, ...this.allConnections];

    if (options.taskId) {
      const found = await findContainerForTask(options.taskId, allConns);
      if (!found) {
        onError(new Error(`Task ${options.taskId} not found on any node`));
        return;
      }
      await this.runLogStream(found.connection, 'docker logs', found.containerId, options, onData, onError);
      return;
    }

    if (options.allTasks) {
      const fullName = qualifyServiceName(stackName, serviceName);
      await this.runLogStream(this.conn, 'docker service logs', fullName, options, onData, onError);
      return;
    }

    const tasks = await listSwarmTasks(stackName, serviceName, this.conn);
    const running = tasks.filter(t => t.desiredState === 'Running');
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
        // Never skip silently: a missing container means partial logs —
        // typically an unreachable node or a connection list missing workers.
        printWarning(
          `Logs incomplete: container for task ${task.id.slice(0, 12)} (node ${task.node}) not found on any reachable node`,
        );
        return;
      }
      await this.runLogStream(found.connection, 'docker logs', found.containerId, options, onData, onError);
    }));
  }

  private async runLogStream(
    connection: SSHKeyConnection,
    baseCommand: string,
    target: string,
    options: LogsOptions,
    onData: (line: string) => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    const parts = [baseCommand];
    if (options.follow) parts.push('-f');
    parts.push(`--tail ${options.tail ?? 100}`);
    if (options.timestamps) parts.push('--timestamps');
    if (options.since !== undefined) parts.push(`--since ${shellQuote(dockerSinceValue(parseSince(options.since, LOCAL_OFFSET)))}`);
    parts.push(target, '2>&1');

    const emit = (data: string) => {
      for (const line of data.split('\n')) {
        if (line.length > 0) onData(line);
      }
    };

    try {
      await sshExecStream(connection, parts.join(' '), { onStdout: emit, onStderr: emit });
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
