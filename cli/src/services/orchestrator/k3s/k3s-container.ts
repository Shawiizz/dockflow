/**
 * k3s container backend.
 *
 * Implements ContainerBackend via `kubectl exec` / `kubectl cp` / `kubectl logs`.
 * Pods are resolved via the `app=<serviceName>` label written by the K8sManifest module.
 */

import type { SSHKeyConnection } from '../../../types';
import { ok, err, type Result } from '../../../types/result';
import { sshExec, sshExecStream, executeInteractiveSSH, shellEscape } from '../../../utils/ssh';
import { K3S_DOCKFLOW_KUBECONFIG, K3S_NAMESPACE_PREFIX } from '../../../constants';
import type {
  ContainerBackend,
  ExecOptions,
  ExecResult,
  LogsOptions,
} from '../interfaces';

export class K3sContainerBackend implements ContainerBackend {
  private readonly kube = `kubectl --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`;

  constructor(private readonly conn: SSHKeyConnection) {}

  private ns(stackName: string): string {
    return `${K3S_NAMESPACE_PREFIX}-${stackName}`;
  }

  private async findPod(stackName: string, serviceName: string): Promise<string | null> {
    const ns = this.ns(stackName);
    const result = await sshExec(
      this.conn,
      `${this.kube} get pods -n ${ns} -l app=${shellEscape(serviceName)} --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null`,
    );

    const pod = result.stdout.trim().replace(/^'|'$/g, '');
    return pod || null;
  }

  async exec(
    stackName: string,
    serviceName: string,
    command: string | string[],
    options: ExecOptions = {},
  ): Promise<Result<ExecResult, Error>> {
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);
    const cmd = this.buildExecCommand(ns, pod, command, options);

    try {
      const result = await sshExec(this.conn, cmd);
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
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);
    const cmd = this.buildExecCommand(ns, pod, command, { ...options, interactive: false });

    try {
      const result = await sshExecStream(this.conn, cmd, callbacks);
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
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);

    try {
      await executeInteractiveSSH(this.conn, `${this.kube} exec -it -n ${ns} ${pod} -- ${shell}`);
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async bash(stackName: string, serviceName: string): Promise<Result<void, Error>> {
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);

    const check = await sshExec(this.conn, `${this.kube} exec -n ${ns} ${pod} -- which bash 2>/dev/null || echo "not_found"`);
    const shellPath = check.stdout.trim() === 'not_found' ? '/bin/sh' : '/bin/bash';

    try {
      await executeInteractiveSSH(this.conn, `${this.kube} exec -it -n ${ns} ${pod} -- ${shellPath}`);
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
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);
    const result = await sshExec(
      this.conn,
      `${this.kube} cp '${shellEscape(localPath)}' ${ns}/${pod}:'${shellEscape(containerPath)}'`,
    );

    if (result.exitCode !== 0) return err(new Error(`Failed to copy file: ${result.stderr}`));
    return ok(undefined);
  }

  async copyFrom(
    stackName: string,
    serviceName: string,
    containerPath: string,
    localPath: string,
  ): Promise<Result<void, Error>> {
    const pod = await this.findPod(stackName, serviceName);
    if (!pod) return err(new Error(`No running pod found for service ${serviceName}`));

    const ns = this.ns(stackName);
    const result = await sshExec(
      this.conn,
      `${this.kube} cp ${ns}/${pod}:'${shellEscape(containerPath)}' '${shellEscape(localPath)}'`,
    );

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
    const ns = this.ns(stackName);
    const flags = [
      options.follow ? '-f' : '',
      options.tail != null ? `--tail=${options.tail}` : '',
      options.since ? `--since=${options.since}` : '',
      options.timestamps ? '--timestamps' : '',
    ]
      .filter(Boolean)
      .join(' ');

    try {
      await sshExecStream(
        this.conn,
        `${this.kube} logs -n ${ns} -l app=${serviceName} ${flags}`,
        {
          onStdout: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onData(line);
            }
          },
          onStderr: (data) => {
            for (const line of data.split('\n')) {
              if (line.length > 0) onError(new Error(line));
            }
          },
        },
      );
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private buildExecCommand(
    ns: string,
    pod: string,
    command: string | string[],
    options: ExecOptions = {},
  ): string {
    const parts = [this.kube, 'exec'];

    if (options.interactive) parts.push('-it');
    parts.push('-n', ns, pod, '--');

    if (options.workdir || options.user || options.env) {
      const envParts: string[] = [];
      if (options.env) {
        for (const [key, value] of Object.entries(options.env)) {
          envParts.push(`${key}='${shellEscape(value)}'`);
        }
      }

      const cmdStr = Array.isArray(command) ? command.join(' ') : command;
      let wrapped = '';

      if (options.env) wrapped += envParts.join(' ') + ' ';
      if (options.workdir) wrapped += `cd '${shellEscape(options.workdir)}' && `;
      wrapped += cmdStr;

      if (options.user) {
        parts.push('su', '-', options.user, '-c', `'${shellEscape(wrapped)}'`);
      } else {
        parts.push('sh', '-c', `'${shellEscape(wrapped)}'`);
      }
    } else {
      if (Array.isArray(command)) {
        parts.push(...command);
      } else {
        parts.push(command);
      }
    }

    return parts.join(' ');
  }
}
