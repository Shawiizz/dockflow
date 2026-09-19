// Seams of one Kubernetes bundle (PD-1): the clock every wait goes through, the SSH transport the
// runtime executors sit on, and the dependencies and memo the backends of one bundle share.

import type { Readable, Writable } from 'stream';
import type { Redactor } from '../../../utils/redact';
import type { ClusterNodeRef } from '../interfaces';
import type { K8sDistribution } from './distribution';
import type { HelmExecutor } from './runtime/helm';
import type { KubeExecutor } from './runtime/kubectl';
import type { NodeShell } from './runtime/node-shell';

/**
 * Injected wherever a wait happens; no backend reads `Date.now()` or sleeps directly, so every
 * deadline is testable in fake time.
 */
export interface Clock {
  now(): Date;
  /**
   * Resolves once `ms` have elapsed, or as soon as `signal` aborts (it never rejects). Local
   * guards pass a signal so a finished call does not leave a timer keeping the process alive.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    }),
};

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * An exec channel whose three streams the caller drives. Nothing buffers the output: the caller
 * reads (or resumes) both stdout and stderr, or the remote command stalls once the window fills.
 */
export interface SshChannel {
  /** remote stdin; the caller ends it to send EOF */
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /**
   * remote exit status, possibly before the last output chunk was read; rejects when the connection
   * is lost before the command reported one. After close() it resolves, with NO_EXIT_CODE when no
   * status came.
   */
  done: Promise<{ exitCode: number }>;
  /** closes the channel on both sides (local guard expiry, caller cancellation) */
  close(): void;
}

export interface SshStreamHandlers {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
}

/**
 * What `runtime/*` receive (and the `probe` option of target resolution). Rejections are transport
 * failures only; a remote command exiting non-zero resolves normally.
 */
export interface SshTransport {
  /** one command with collected output; one transport retry is allowed, so read-only calls only */
  exec(node: ClusterNodeRef, command: string, options?: { signal?: AbortSignal }): Promise<SshExecResult>;
  /** non-retrying exec channel */
  channel(node: ClusterNodeRef, command: string): Promise<SshChannel>;
  /** non-retrying exec whose output is delivered chunk by chunk; resolves with the exit code */
  stream(
    node: ClusterNodeRef,
    command: string,
    handlers: SshStreamHandlers,
    options?: { signal?: AbortSignal },
  ): Promise<number>;
  /** PTY session on a dedicated connection; resolves with the remote exit code */
  interactive(node: ClusterNodeRef, command: string): Promise<number>;
}

/** One NodeShell per node: image import, backup relays and host commands off the control plane. */
export type NodeShellFactory = (node: ClusterNodeRef) => NodeShell;

export interface KubernetesBundleDeps {
  /** bound to target.controlPlane; shared by every backend of the bundle */
  kubectl: KubeExecutor;
  helm: HelmExecutor;
  nodeShell: NodeShellFactory;
  clock: Clock;
  redactor: Redactor;
  distribution: K8sDistribution;
}

/**
 * Per-bundle memo shared by several backends. Memos private to one backend (renders, receipts,
 * replaced releases, reserved host ports) live in that backend.
 */
export interface SharedMemo {
  /** key: canonical JSON of the preflight needs */
  preflight: Map<string, Promise<void>>;
  /** key: namespace; one ensureNamespace per namespace and bundle */
  namespaces: Map<string, Promise<void>>;
  crds: Promise<{ routes: boolean }> | null;
}

export function createSharedMemo(): SharedMemo {
  return { preflight: new Map(), namespaces: new Map(), crds: null };
}

/** Runs `fn` once per key; a rejected run is forgotten so the next caller tries again. */
export function memoize<T>(memo: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  const known = memo.get(key);
  if (known) return known;
  const running = fn();
  memo.set(key, running);
  running.catch(() => {
    if (memo.get(key) === running) memo.delete(key);
  });
  return running;
}
