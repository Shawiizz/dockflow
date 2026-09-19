// Scripts and streams on any cluster node, for the work that is not kubectl on the control plane:
// image import and listings on every node, backup relays, host commands (DESIGN-CORE 8.4, K04).
// Nothing is retried, reads included, so a flaky read surfaces as one failure its caller handles.

import type { Readable } from 'stream';
import { printDebug } from '../../../../utils/output';
import type { Redactor } from '../../../../utils/redact';
import type { ClusterNodeRef } from '../../interfaces';
import { type Clock, type NodeShellFactory, type SshChannel, type SshTransport, systemClock } from '../deps';
import { KubeError, NO_EXIT_CODE } from './errors';
import { driveChannel, guarded, type KubectlResult, overTransport, sshTransport } from './kubectl';

export interface NodeShell {
  readonly node: ClusterNodeRef;
  /** runs a POSIX sh script; a non-zero exit is returned, not thrown; stderr is redacted */
  run(script: string, options: { stdin?: Readable | Uint8Array | string; guardS: number | null }): Promise<KubectlResult>;
  /** raw channel streaming both directions; the caller owns the lifecycle */
  channel(script: string): Promise<SshChannel>;
}

export interface NodeShellOptions {
  /** the bundle Redactor */
  redactor: Redactor;
  /** default: the SSH transport of runtime/kubectl.ts */
  transport?: SshTransport;
  /** default: systemClock */
  clock?: Clock;
}

/** sudo refusing a command: the deploy user lacks the rule setup writes (design-03 12.2) */
export function isSudoRefusal(stderr: string): boolean {
  return /a password is required|is not allowed to run sudo|a terminal is required/.test(stderr);
}

class SshNodeShell implements NodeShell {
  private readonly redactor: Redactor;
  private readonly transport: SshTransport;
  private readonly clock: Clock;

  constructor(
    readonly node: ClusterNodeRef,
    options: NodeShellOptions,
  ) {
    this.redactor = options.redactor;
    this.transport = options.transport ?? sshTransport;
    this.clock = options.clock ?? systemClock;
  }

  async run(script: string, options: { stdin?: Readable | Uint8Array | string; guardS: number | null }): Promise<KubectlResult> {
    const out = await guarded(
      this.clock,
      options.guardS,
      async (signal) =>
        overTransport(this.node, this.redactor, 'a node command', async () =>
          driveChannel(await this.transport.channel(this.node, script), { stdin: options.stdin, signal }),
        ),
      () =>
        new KubeError(
          'Timeout',
          `A command on ${this.node.name} did not finish within ${options.guardS}s`,
          this.node.name,
          NO_EXIT_CODE,
          '',
        ),
    );
    // the local stdin stream failed; the channel was closed, so the exit status means nothing
    if (out.failure !== null) throw out.failure.error;
    printDebug(`node command on ${this.node.name}: exit ${out.exitCode}`);
    return {
      exitCode: out.exitCode,
      stdout: out.stdout.toString('utf8'),
      stderr: this.redactor.redact(out.stderr.toString('utf8')),
    };
  }

  async channel(script: string): Promise<SshChannel> {
    const channel = await overTransport(this.node, this.redactor, 'a node channel', () =>
      this.transport.channel(this.node, script),
    );
    const done = overTransport(this.node, this.redactor, 'a node channel', () => channel.done);
    done.then(
      ({ exitCode }) => printDebug(`node channel on ${this.node.name}: exit ${exitCode}`),
      () => {},
    );
    return { stdin: channel.stdin, stdout: channel.stdout, stderr: channel.stderr, done, close: () => channel.close() };
  }
}

export function nodeShell(node: ClusterNodeRef, options: NodeShellOptions): NodeShell {
  return new SshNodeShell(node, options);
}

/** the `nodeShell` dependency of a bundle: one NodeShell per node, all sharing the options */
export function nodeShellFactory(options: NodeShellOptions): NodeShellFactory {
  return (node) => nodeShell(node, options);
}
