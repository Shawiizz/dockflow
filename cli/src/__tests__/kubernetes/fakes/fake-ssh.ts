// FakeSsh (design-07 3.2): the SSH transport under runtime/*. Only runtime/*.test.ts and the target
// resolution tests use it; backend tests stop at the executor fakes.

import { PassThrough, Writable } from 'stream';
import type { SshChannel, SshStreamHandlers, SshTransport } from '../../../services/orchestrator/kubernetes/deps';
import type { ClusterNodeRef } from '../../../services/orchestrator/interfaces';

/** `interactive` is the PTY path (executeInteractiveSSH); design-07 lists the other three */
export type SshPath = 'exec' | 'channel' | 'stream' | 'interactive';

export interface SshCall {
  /** ClusterNodeRef.name */
  node: string;
  /** full remote command string */
  command: string;
  path: SshPath;
  /** bytes written before end() (channel path; empty elsewhere) */
  stdin: Uint8Array;
  /** 1-based; >1 only on retried exec calls */
  attempt: number;
  /** channel path: the caller ended stdin */
  ended: boolean;
  /** the caller closed the channel or aborted the call before it finished (guard expiry) */
  closed: boolean;
}

export interface FakeSshResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** delivered in this order on the channel and stream paths; replaces stdout/stderr */
  chunks?: { stream: 'stdout' | 'stderr'; data: string }[];
}

export interface FakeSshRule {
  node?: string;
  command: RegExp | ((command: string) => boolean);
  path?: SshPath;
  respond: FakeSshResponse | ((call: SshCall) => FakeSshResponse);
  /** simulate a transport error (ECONNRESET) */
  transportError?: 'first-attempt' | 'always';
  /** never resolve until the caller's guard fires */
  hang?: boolean;
}

/** exit status the fake reports for a channel the caller closed before it answered */
export const CLOSED_EXIT = -1;

function transportError(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

function chunksOf(response: FakeSshResponse): { stream: 'stdout' | 'stderr'; data: string }[] {
  if (response.chunks) return response.chunks;
  const chunks: { stream: 'stdout' | 'stderr'; data: string }[] = [];
  if (response.stdout) chunks.push({ stream: 'stdout', data: response.stdout });
  if (response.stderr) chunks.push({ stream: 'stderr', data: response.stderr });
  return chunks;
}

function joined(response: FakeSshResponse, stream: 'stdout' | 'stderr'): string {
  return chunksOf(response)
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.data)
    .join('');
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export class FakeSsh {
  readonly calls: SshCall[] = [];
  /** commands no rule matched; assertAllRulesUsed() fails when any exist */
  readonly unexpected: string[] = [];
  private readonly used = new Set<FakeSshRule>();
  private done = false;

  constructor(private readonly rules: FakeSshRule[]) {}

  /** assertAllRulesUsed() was called; assertExecutorInvariants fails a fake that never was (design-07 3.9) */
  get asserted(): boolean {
    return this.done;
  }

  /** implements the SSH transport interface runtime/* receive through injection */
  transport(): SshTransport {
    return {
      exec: (node, command, options) => this.exec(node, command, options?.signal),
      channel: async (node, command) => this.channel(node, command),
      stream: (node, command, handlers, options) => this.stream(node, command, handlers, options?.signal),
      interactive: async (node, command) => {
        const { rule, call } = this.record(node, command, 'interactive', 1);
        if (rule.transportError) throw transportError();
        if (rule.hang) return new Promise<number>(() => {});
        return this.response(rule, call).exitCode;
      },
    };
  }

  assertAllRulesUsed(): void {
    this.done = true;
    const problems: string[] = [];
    this.rules.forEach((rule, index) => {
      if (!this.used.has(rule)) problems.push(`rule ${index} (${String(rule.command)}) was never used`);
    });
    for (const command of this.unexpected) problems.push(`unexpected SSH call: ${command}`);
    if (problems.length > 0) throw new Error(`FakeSsh:\n${problems.join('\n')}`);
  }

  /** the name every other fake gives its completeness check (design-07 3.0 rule 4) */
  assertDone(): void {
    this.assertAllRulesUsed();
  }

  private match(node: ClusterNodeRef, command: string, path: SshPath): FakeSshRule {
    const rule = this.rules.find(
      (candidate) =>
        (candidate.node === undefined || candidate.node === node.name) &&
        (candidate.path === undefined || candidate.path === path) &&
        (typeof candidate.command === 'function' ? candidate.command(command) : candidate.command.test(command)),
    );
    if (!rule) {
      this.unexpected.push(`[${path} on ${node.name}] ${command}`);
      throw new Error(`Unexpected SSH call on ${node.name} (${path}): ${command}`);
    }
    this.used.add(rule);
    return rule;
  }

  private record(node: ClusterNodeRef, command: string, path: SshPath, attempt: number): { rule: FakeSshRule; call: SshCall } {
    const call: SshCall = { node: node.name, command, path, stdin: new Uint8Array(), attempt, ended: false, closed: false };
    this.calls.push(call);
    return { rule: this.match(node, command, path), call };
  }

  private response(rule: FakeSshRule, call: SshCall): FakeSshResponse {
    return typeof rule.respond === 'function' ? rule.respond(call) : rule.respond;
  }

  private async exec(node: ClusterNodeRef, command: string, signal?: AbortSignal) {
    let { rule, call } = this.record(node, command, 'exec', 1);
    if (rule.transportError) {
      // the transport's one retry
      ({ rule, call } = this.record(node, command, 'exec', 2));
      if (rule.transportError === 'always') throw transportError();
    }
    if (rule.hang) {
      await whenAborted(signal);
      call.closed = true;
      throw new Error('channel closed');
    }
    await nextTurn();
    const response = this.response(rule, call);
    return { exitCode: response.exitCode, stdout: joined(response, 'stdout'), stderr: joined(response, 'stderr') };
  }

  private channel(node: ClusterNodeRef, command: string): SshChannel {
    const { rule, call } = this.record(node, command, 'channel', 1);
    if (rule.transportError) throw transportError();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received: Buffer[] = [];
    let settle: (value: { exitCode: number }) => void = () => {};
    const done = new Promise<{ exitCode: number }>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      stdout.end();
      stderr.end();
      // the exit status arrives after the output, as on a real channel
      void nextTurn().then(() => settle({ exitCode }));
    };
    const answer = async (): Promise<void> => {
      await nextTurn();
      if (finished) return;
      const response = this.response(rule, call);
      for (const chunk of chunksOf(response)) (chunk.stream === 'stdout' ? stdout : stderr).write(chunk.data);
      finish(response.exitCode);
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received.push(Buffer.from(chunk));
        call.stdin = new Uint8Array(Buffer.concat(received));
        callback();
      },
      final(callback) {
        call.ended = true;
        callback();
        if (!rule.hang) void answer();
      },
    });
    return {
      stdin,
      stdout,
      stderr,
      done,
      close: () => {
        if (finished) return;
        call.closed = true;
        finish(CLOSED_EXIT);
      },
    };
  }

  private async stream(node: ClusterNodeRef, command: string, handlers: SshStreamHandlers, signal?: AbortSignal): Promise<number> {
    const { rule, call } = this.record(node, command, 'stream', 1);
    if (rule.transportError) throw transportError();
    if (rule.hang) {
      await whenAborted(signal);
      call.closed = true;
      return CLOSED_EXIT;
    }
    const response = this.response(rule, call);
    for (const chunk of chunksOf(response)) {
      await nextTurn();
      if (signal?.aborted) {
        call.closed = true;
        return CLOSED_EXIT;
      }
      handlers[chunk.stream](Buffer.from(chunk.data, 'utf8'));
    }
    await nextTurn();
    return response.exitCode;
  }
}
