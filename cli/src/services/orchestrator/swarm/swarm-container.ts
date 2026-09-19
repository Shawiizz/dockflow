/**
 * Swarm ContainerBackend (design-06 3.1-3.3, 3.9): finds the container of a task or service on any
 * node, then runs `docker exec`, `docker logs`, `docker cp` and `docker stats` on the node holding
 * it. Every remote argument is quoted on its own; the backend never prints (log warnings go to the
 * sink).
 */

import { PassThrough, type Readable } from 'stream';
import type { SSHKeyConnection } from '../../../types';
import { LogLineBuffer, splitServiceLogsContext } from '../../../utils/docker-logs';
import { CLIError, ConnectionError, ErrorCode, UnsupportedOperationError } from '../../../utils/errors';
import { shellQuote } from '../../../utils/ssh';
import type {
  ClusterNodeRef,
  ContainerBackend,
  ContainerStats,
  ExecRequest,
  ExecResult,
  InstanceTarget,
  LogLine,
  LogSink,
  LogsOptions,
  OrchestratorTarget,
  StackNaming,
  StackRef,
} from '../interfaces';
import { dockerSinceValue, type LocalOffset, parseSince, splitTimestamp } from '../kubernetes/status/logs';
import { swarmNaming } from './swarm-naming';
import {
  dockerStatsCommand,
  endOf,
  firstLine,
  type LocatedContainer,
  listSwarmInstances,
  locateServiceContainer,
  locateTaskContainer,
  onText,
  parseDockerStatsLine,
  readSwarmServices,
  runSwarmQuery,
  type SwarmChannel,
  type SwarmSsh,
  swarmNodes,
  swarmNodeToServer,
  swarmSsh,
  swarmTransportError,
} from './swarm-utils';

/** `ContainerPathError` reasons (design-06 3.3) */
export type CopyFailureReason = 'not-found' | 'no-tar' | 'not-a-directory' | 'other';

/** Builds the error a failed copy reports, so the bundle can hand in the shared `ContainerPathError`. */
export type CopyErrorFactory = (message: string, reason: CopyFailureReason) => Error;

/** Default copy error, carrying the same `reason` as `ContainerPathError`. */
export class SwarmCopyError extends CLIError {
  constructor(
    message: string,
    readonly reason: CopyFailureReason,
  ) {
    super(message, reason === 'not-found' ? ErrorCode.CONTAINER_NOT_FOUND : ErrorCode.COMMAND_FAILED);
    this.name = 'SwarmCopyError';
  }
}

export interface SwarmContainerBackendOptions {
  /** default: the real SSH transport */
  ssh?: SwarmSsh;
  naming?: StackNaming;
  /** minutes east of UTC for `--since` dates without a zone; default: the CLI machine's zone */
  localOffset?: LocalOffset;
  /** default: SwarmCopyError */
  pathError?: CopyErrorFactory;
}

const RERUN_SUGGESTION = 'Run the command again; Dockflow picks another ready manager.';

const COPY_NOT_FOUND = /Could not find the file|No such container:path/i;

function localZone(at: Date): number {
  return -at.getTimezoneOffset();
}

/** R-21: a Swarm task runs one container, so there is nothing to choose. */
function refuseContainerFlag(container: string | undefined, command: string): void {
  if (container === undefined) return;
  throw new UnsupportedOperationError(
    `dockflow ${command} --container is not supported with orchestrator: swarm: a Swarm task runs one container`,
  );
}

function commandName(ref: StackRef, command: 'exec' | 'logs'): string {
  return ref.role === 'accessory' ? `accessories ${command}` : command;
}

function lostConnection(node: ClusterNodeRef, operation: string): ConnectionError {
  return new ConnectionError(`Lost the connection to ${node.name} while ${operation}`, RERUN_SUGGESTION);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface DockerExecOptions {
  tty?: boolean;
  /** forward stdin (`-i`); implied by `tty` */
  stdin?: boolean;
  workdir?: string;
  user?: string;
  env?: Record<string, string>;
}

/** `docker exec [-it|-i] [-w <dir>] [-u <user>] [-e KEY=VALUE]... <id> <argv...>`, every element quoted. */
export function dockerExecCommand(containerId: string, argv: readonly string[], options: DockerExecOptions = {}): string {
  const parts = ['docker exec'];
  if (options.tty) parts.push('-it');
  else if (options.stdin) parts.push('-i');
  if (options.workdir !== undefined) parts.push('-w', shellQuote(options.workdir));
  if (options.user !== undefined) parts.push('-u', shellQuote(options.user));
  for (const [key, value] of Object.entries(options.env ?? {})) parts.push('-e', shellQuote(`${key}=${value}`));
  parts.push(shellQuote(containerId), ...argv.map(shellQuote));
  return parts.join(' ');
}

/** `web.2.x2x4q` out of docker's `shop-production_web.2.x2x4q` */
function taskOfContext(task: string, scope: string): string {
  const prefix = `${scope}_`;
  return task.startsWith(prefix) ? task.slice(prefix.length) : task;
}

export class SwarmContainerBackend implements ContainerBackend {
  private readonly ssh: SwarmSsh;
  private readonly naming: StackNaming;
  private readonly localOffset: LocalOffset;
  private readonly pathError: CopyErrorFactory;
  /** control plane first, then every other node with credentials */
  private readonly nodes: ClusterNodeRef[];

  constructor(
    private readonly target: OrchestratorTarget,
    options: SwarmContainerBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
    this.naming = options.naming ?? swarmNaming;
    this.localOffset = options.localOffset ?? localZone;
    this.pathError = options.pathError ?? ((message, reason) => new SwarmCopyError(message, reason));
    this.nodes = swarmNodes(target);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** The task's container when an instance was chosen, else any running container of the service. */
  private async locate(ref: StackRef, target: InstanceTarget): Promise<LocatedContainer> {
    const env = this.target.env;
    if (target.instance !== undefined) {
      const found = await locateTaskContainer(this.ssh, this.nodes, target.instance);
      if (found) return found;
      throw new CLIError(
        `Instance ${target.instance} of service ${target.service} has no container on any reachable node`,
        ErrorCode.CONTAINER_NOT_FOUND,
        `List the instances with \`dockflow ps ${env} --all\`.`,
      );
    }
    const found = await locateServiceContainer(this.ssh, this.nodes, this.naming.serviceNativeName(ref, target.service));
    if (found) return found;
    throw new CLIError(
      `Service ${target.service} has no running container`,
      ErrorCode.CONTAINER_NOT_FOUND,
      `Check its instances with \`dockflow ps ${env}\`.`,
    );
  }

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------

  async exec(ref: StackRef, target: InstanceTarget, request: ExecRequest): Promise<number> {
    refuseContainerFlag(target.container, commandName(ref, 'exec'));
    const found = await this.locate(ref, target);
    // a PTY needs the process terminal; streams handed in (the API) are always driven without one
    const tty = request.tty && request.io === undefined;
    const command = dockerExecCommand(found.containerId, request.argv, {
      tty,
      stdin: request.stdin,
      workdir: request.workdir,
      user: request.user,
      env: request.env,
    });
    if (tty) return this.ssh.interactive(found.node, command);
    return this.pipeExec(found.node, command, request, target.service);
  }

  private async pipeExec(node: ClusterNodeRef, command: string, request: ExecRequest, service: string): Promise<number> {
    const io = request.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
    let channel: SwarmChannel;
    try {
      channel = await this.ssh.channel(node, command);
    } catch (error) {
      throw swarmTransportError(node, this.target.env, error);
    }
    channel.stdout.pipe(io.stdout, { end: false });
    channel.stderr.pipe(io.stderr, { end: false });
    const output = Promise.all([endOf(channel.stdout), endOf(channel.stderr)]);
    if (request.stdin) io.stdin.pipe(channel.stdin);
    else channel.stdin.end();
    try {
      const { exitCode } = await channel.done;
      await output;
      return exitCode;
    } catch {
      throw lostConnection(node, `running a command in ${service}`);
    } finally {
      if (request.stdin) {
        io.stdin.unpipe(channel.stdin);
        // an unpiped process stdin still holds the event loop open
        if (request.io === undefined) process.stdin.pause();
      }
    }
  }

  async capture(ref: StackRef, target: InstanceTarget, argv: string[]): Promise<ExecResult> {
    refuseContainerFlag(target.container, commandName(ref, 'exec'));
    const found = await this.locate(ref, target);
    try {
      const result = await this.ssh.exec(found.node, dockerExecCommand(found.containerId, argv));
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      throw swarmTransportError(found.node, this.target.env, error);
    }
  }

  async shell(ref: StackRef, target: InstanceTarget, shell: 'auto' | '/bin/sh' | '/bin/bash'): Promise<number> {
    refuseContainerFlag(target.container, commandName(ref, 'exec'));
    const found = await this.locate(ref, target);
    const path = shell === 'auto' ? await this.detectShell(found) : shell;
    return this.ssh.interactive(found.node, `docker exec -it ${shellQuote(found.containerId)} ${shellQuote(path)}`);
  }

  private async detectShell(found: LocatedContainer): Promise<'/bin/sh' | '/bin/bash'> {
    const probe = await this.ssh.exec(
      found.node,
      `docker exec ${shellQuote(found.containerId)} which bash 2>/dev/null || echo not_found`,
    );
    return probe.stdout.trim() === 'not_found' ? '/bin/sh' : '/bin/bash';
  }

  async interactiveCommand(
    ref: StackRef,
    target: InstanceTarget,
    shell: '/bin/sh' | '/bin/bash',
  ): Promise<{ connection: SSHKeyConnection; command: string }> {
    refuseContainerFlag(target.container, commandName(ref, 'exec'));
    const found = await this.locate(ref, target);
    return {
      connection: found.node.connection,
      command: `docker exec -it ${shellQuote(found.containerId)} ${shellQuote(shell)}`,
    };
  }

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  /** `[-f] --tail <n|all> [--timestamps] [--since <docker form>]`; a bad `--since` throws before any SSH. */
  private logFlags(options: LogsOptions): string {
    const parts: string[] = [];
    if (options.follow) parts.push('-f');
    parts.push('--tail', String(options.tail));
    if (options.timestamps) parts.push('--timestamps');
    if (options.since !== undefined) {
      parts.push('--since', shellQuote(dockerSinceValue(parseSince(options.since, this.localOffset))));
    }
    return parts.join(' ');
  }

  async streamLogs(ref: StackRef, service: string | null, options: LogsOptions, sink: LogSink): Promise<void> {
    refuseContainerFlag(options.container, commandName(ref, 'logs'));
    const flags = this.logFlags(options);
    const operation = options.follow ? 'following logs' : 'reading logs';
    const scope = this.naming.scope(ref);
    const env = this.target.env;

    if (options.instance !== undefined) {
      const instance = options.instance;
      const found = await locateTaskContainer(this.ssh, this.nodes, instance);
      if (!found) {
        throw new CLIError(
          `Instance ${instance} has no container on any reachable node`,
          ErrorCode.CONTAINER_NOT_FOUND,
          `List the instances with \`dockflow ps ${env} --all\`.`,
        );
      }
      const owner = service ?? scope;
      await this.pumpLogs(found.node, `docker logs ${flags} ${shellQuote(found.containerId)} 2>&1`, operation, (line) =>
        sink.line(this.containerLogLine(line, owner, instance, options.timestamps)),
      );
      return;
    }

    if (options.includeTerminated) {
      const controlPlane = this.target.controlPlane;
      const services =
        service !== null
          ? [service]
          : (await readSwarmServices(this.ssh, controlPlane, env, scope, ref.role)).map((s) => s.name);
      if (services.length === 0) {
        throw new CLIError(
          `${capitalize(this.naming.describe(ref))} has no services`,
          ErrorCode.STACK_NOT_FOUND,
          `Check what is deployed with \`dockflow status ${env}\`.`,
        );
      }
      await Promise.all(
        services.map((svc) =>
          this.pumpLogs(
            controlPlane,
            `docker service logs ${flags} ${shellQuote(this.naming.serviceNativeName(ref, svc))} 2>&1`,
            operation,
            (line) => sink.line(this.serviceLogLine(line, svc, scope, options.timestamps)),
          ),
        ),
      );
      return;
    }

    const tasks = await listSwarmInstances(this.ssh, this.target.controlPlane, env, scope, {
      service: service ?? undefined,
      nodeToServer: swarmNodeToServer(this.target),
    });
    if (tasks.length === 0) {
      const subject = service !== null ? `Service ${service}` : capitalize(this.naming.describe(ref));
      throw new CLIError(
        `${subject} has no running instance`,
        ErrorCode.CONTAINER_NOT_FOUND,
        `Add \`--all-tasks\` to include terminated instances, or run \`dockflow ps ${env}\`.`,
      );
    }
    await Promise.all(
      tasks.map(async (task) => {
        const found = await locateTaskContainer(this.ssh, this.nodes, task.id);
        if (!found) {
          // never skipped silently: a missing container means partial logs (a node down or without credentials)
          sink.warn(
            `Logs incomplete: container for task ${task.id.slice(0, 12)} (node ${task.node ?? 'unknown'}) not found on any reachable node`,
          );
          return;
        }
        await this.pumpLogs(found.node, `docker logs ${flags} ${shellQuote(found.containerId)} 2>&1`, operation, (line) =>
          sink.line(this.containerLogLine(line, task.service, task.label, options.timestamps)),
        );
      }),
    );
  }

  /** `docker logs` line: with `--timestamps` the leading RFC3339Nano token becomes `timestamp`. */
  private containerLogLine(line: string, service: string, instance: string, timestamps: boolean): LogLine {
    if (!timestamps) return { service, instance, timestamp: null, text: line };
    return { service, instance, ...splitTimestamp(line) };
  }

  /**
   * `docker service logs` line. Docker writes `<timestamp> <task>@<node>    | <text>`; the context
   * is also accepted in front of the timestamp. Without `--timestamps` the line is kept verbatim.
   */
  private serviceLogLine(line: string, service: string, scope: string, timestamps: boolean): LogLine {
    if (!timestamps) return { service, instance: service, timestamp: null, text: line };
    const leading = splitServiceLogsContext(line);
    if (leading) {
      return { service, instance: taskOfContext(leading.task, scope), ...splitTimestamp(leading.text) };
    }
    const stamped = splitTimestamp(line);
    const context = splitServiceLogsContext(stamped.text);
    if (context) {
      return { service, instance: taskOfContext(context.task, scope), timestamp: stamped.timestamp, text: context.text };
    }
    return { service, instance: service, ...stamped };
  }

  /** Streams one remote command line by line (empty lines dropped); a lost channel rejects. */
  private async pumpLogs(node: ClusterNodeRef, command: string, operation: string, emit: (line: string) => void): Promise<void> {
    let channel: SwarmChannel;
    try {
      channel = await this.ssh.channel(node, command);
    } catch (error) {
      throw swarmTransportError(node, this.target.env, error);
    }
    channel.stdin.end();
    const stdout = new LogLineBuffer();
    const stderr = new LogLineBuffer();
    const deliver = (lines: string[]): void => {
      for (const line of lines) if (line.length > 0) emit(line);
    };
    onText(channel.stdout, (text) => deliver(stdout.push(text)));
    onText(channel.stderr, (text) => deliver(stderr.push(text)));
    try {
      await channel.done;
      await Promise.all([endOf(channel.stdout), endOf(channel.stderr)]);
    } catch {
      throw lostConnection(node, operation);
    } finally {
      deliver(stdout.flush());
      deliver(stderr.flush());
    }
  }

  // -------------------------------------------------------------------------
  // cp
  // -------------------------------------------------------------------------

  private copyFailure(stderr: string, exitCode: number, subject: string, path: string, service: string): Error {
    if (COPY_NOT_FOUND.test(stderr)) return this.pathError(`Path ${path} does not exist in ${service}`, 'not-found');
    if (/not a directory/i.test(stderr)) return this.pathError(`Path ${path} in ${service} is not a directory`, 'not-a-directory');
    return this.pathError(`${subject} failed: ${firstLine(stderr) || `exit ${exitCode}`}`, 'other');
  }

  /**
   * `docker cp <id>:<path> -` on the container's node. The exit status is only known after the
   * archive, so the stream ends only once it is 0; otherwise it errors with the copy error.
   */
  async copyOut(ref: StackRef, target: InstanceTarget, path: string): Promise<Readable> {
    refuseContainerFlag(target.container, 'cp');
    const found = await this.locate(ref, target);
    let channel: SwarmChannel;
    try {
      channel = await this.ssh.channel(found.node, `docker cp ${shellQuote(`${found.containerId}:${path}`)} -`);
    } catch (error) {
      throw swarmTransportError(found.node, this.target.env, error);
    }
    channel.stdin.end();
    let stderr = '';
    onText(channel.stderr, (text) => {
      stderr += text;
    });
    const archive = new PassThrough();
    channel.stdout.pipe(archive, { end: false });
    let settled = false;
    // a reader that stops early (the destination probe reads one header) releases the channel
    archive.once('close', () => {
      if (!settled) channel.close();
    });
    Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]).then(
      ([{ exitCode }]) => {
        settled = true;
        if (exitCode === 0) archive.end();
        else archive.destroy(this.copyFailure(stderr, exitCode, `Copying ${path} out of ${target.service}`, path, target.service));
      },
      () => {
        settled = true;
        archive.destroy(lostConnection(found.node, `copying ${path} out of ${target.service}`));
      },
    );
    return archive;
  }

  /** `docker cp - <id>:<destDir>` with the tar stream on stdin. */
  async copyIn(ref: StackRef, target: InstanceTarget, destDir: string, tar: Readable): Promise<void> {
    refuseContainerFlag(target.container, 'cp');
    const found = await this.locate(ref, target);
    let channel: SwarmChannel;
    try {
      channel = await this.ssh.channel(found.node, `docker cp - ${shellQuote(`${found.containerId}:${destDir}`)}`);
    } catch (error) {
      throw swarmTransportError(found.node, this.target.env, error);
    }
    let stderr = '';
    onText(channel.stderr, (text) => {
      stderr += text;
    });
    channel.stdout.resume();
    const localFailure = new Promise<never>((_, reject) => {
      tar.once('error', (error) => {
        channel.close();
        reject(error);
      });
    });
    localFailure.catch(() => {});
    tar.pipe(channel.stdin);
    const remote = Promise.all([channel.done, endOf(channel.stdout), endOf(channel.stderr)]).then(
      ([{ exitCode }]) => exitCode,
      () => {
        throw lostConnection(found.node, `copying into ${destDir} of ${target.service}`);
      },
    );
    const exitCode = await Promise.race([remote, localFailure]);
    if (exitCode !== 0) {
      throw this.copyFailure(stderr, exitCode, `Copying into ${destDir} of ${target.service}`, destDir, target.service);
    }
  }

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  /**
   * `docker stats` on every node for the containers of the ref's stack only, so the other role
   * never appears. Nodes that fail are left out; only when every node fails is it an error.
   */
  async stats(ref: StackRef): Promise<ContainerStats[]> {
    const scope = this.naming.scope(ref);
    const command = dockerStatsCommand(scope);
    const results = await Promise.allSettled(
      this.nodes.map(async (node) => {
        const stdout = await runSwarmQuery(this.ssh, node, this.target.env, command, 'docker stats');
        const rows: ContainerStats[] = [];
        for (const line of (stdout ?? '').split('\n')) {
          if (!line.trim()) continue;
          const row = parseDockerStatsLine(line.trim(), { scope, role: ref.role, node: node.name });
          if (row) rows.push(row);
        }
        return rows;
      }),
    );
    const rows: ContainerStats[] = [];
    let firstFailure: unknown = null;
    for (const result of results) {
      if (result.status === 'fulfilled') rows.push(...result.value);
      else firstFailure ??= result.reason;
    }
    if (firstFailure !== null && results.every((result) => result.status === 'rejected')) throw firstFailure;
    return rows;
  }
}
