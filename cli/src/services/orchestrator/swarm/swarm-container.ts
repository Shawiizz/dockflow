/**
 * Swarm container backend.
 *
 * Implements ContainerBackend for Docker Swarm: locates the container for a
 * given service across all Swarm nodes, then runs `docker exec`/`docker cp`
 * on the right node.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { sshExec, sshExecStream, executeInteractiveSSH, shellEscape } from '../../../utils/ssh';
import { printWarning } from '../../../utils/output';
import type {
  ContainerBackend,
  ExecOptions,
  ExecResult,
  LogsOptions,
} from '../interfaces';
import { findSwarmContainer, findContainerForTask, listSwarmTasks } from './swarm-utils';

export class SwarmContainerBackend implements ContainerBackend {
  constructor(
    private readonly conn: SSHKeyConnection,
    private readonly allConnections: SSHKeyConnection[],
  ) {}

  private findContainer(stackName: string, serviceName: string) {
    return findSwarmContainer(stackName, serviceName, this.conn, this.allConnections);
  }

  private buildExecCommand(
    containerId: string,
    command: string | string[],
    options: ExecOptions = {},
  ): string {
    const parts = ['docker exec'];

    if (options.interactive) parts.push('-it');
    if (options.workdir) parts.push(`-w ${options.workdir}`);
    if (options.user) parts.push(`-u ${options.user}`);

    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        parts.push(`-e ${key}="${value}"`);
      }
    }

    parts.push(containerId);

    if (Array.isArray(command)) {
      parts.push(...command);
    } else {
      parts.push(command);
    }

    return parts.join(' ');
  }

  async exec(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options: ExecOptions = {},
  ): Promise<Result<ExecResult, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    try {
      const cmd = this.buildExecCommand(found.containerId, command, options);
      const result = await sshExec(found.connection, cmd);
      return ok({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async execStream(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options: ExecOptions = {},
    callbacks?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void },
  ): Promise<Result<number, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    try {
      const cmd = this.buildExecCommand(found.containerId, command, { ...options, interactive: false });
      const result = await sshExecStream(found.connection, cmd, callbacks);
      return ok(result.exitCode);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async shell(
    stackName: string,
    serviceName: string,
    shell: string = '/bin/sh',
  ): Promise<Result<void, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    try {
      await executeInteractiveSSH(found.connection, `docker exec -it ${found.containerId} ${shell}`);
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async bash(stackName: string, serviceName: string): Promise<Result<void, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    const check = await sshExec(found.connection, `docker exec ${found.containerId} which bash 2>/dev/null || echo "not_found"`);
    const shellPath = check.stdout.trim() === 'not_found' ? '/bin/sh' : '/bin/bash';

    try {
      await executeInteractiveSSH(found.connection, `docker exec -it ${found.containerId} ${shellPath}`);
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async copyTo(
    stackName: string,
    serviceName: string,
    localPath: string,
    containerPath: string,
  ): Promise<Result<void, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    const result = await sshExec(found.connection, `docker cp '${shellEscape(localPath)}' ${found.containerId}:'${shellEscape(containerPath)}'`);
    if (result.exitCode !== 0) return err(new Error(`Failed to copy file: ${result.stderr}`));
    return ok(undefined);
  }

  async copyFrom(
    stackName: string,
    serviceName: string,
    containerPath: string,
    localPath: string,
  ): Promise<Result<void, Error>> {
    const found = await this.findContainer(stackName, serviceName);
    if (!found) return err(new Error(`No running container found for service ${serviceName}`));

    const result = await sshExec(found.connection, `docker cp ${found.containerId}:'${shellEscape(containerPath)}' '${shellEscape(localPath)}'`);
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
      const fullName = serviceName.includes('_') ? serviceName : `${stackName}_${serviceName}`;
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
    if (options.since) parts.push(`--since ${options.since}`);
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
