/**
 * Feeding a backup file into a restore command: one pipeline when the file sits on the node
 * that runs the command, else a relay through this machine with backpressure.
 */

import type { ClusterNode, SSHKeyConnection } from '../../types';
import { BackupError, ErrorCode } from '../../utils/errors';
import { shellQuote, sshExec, sshExecChannelUnbuffered } from '../../utils/ssh';
import { printDebug } from '../../utils/output';

const STDERR_CAP = 64 * 1024;

/** What a stream wrote so far, up to a cap: the head of stderr is what names the problem. */
function collectText(stream: NodeJS.ReadableStream): () => string {
  let text = '';
  stream.on('data', (chunk: Buffer | string) => {
    if (text.length < STDERR_CAP) text += chunk.toString();
  });
  return () => text;
}

/** Resolves when the stream has ended, or after a moment if it never says so. */
function streamEnded(stream: NodeJS.ReadableStream & { readableEnded?: boolean }): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 500);
    stream.once('end', done);
    stream.once('close', done);
  });
}

/**
 * Streams a backup file into `command` on `sink`: one pipeline when the file is on that node,
 * else a relay through this machine with backpressure.
 */
export async function streamInto(
  source: ClusterNode,
  file: string,
  gunzip: boolean,
  sink: SSHKeyConnection,
  command: string,
): Promise<{ exitCode: number; stderr: string }> {
  const path = shellQuote(file);
  const reader = gunzip ? `gunzip -c ${path}` : `cat ${path}`;
  if (source.connection.host === sink.host && source.connection.port === sink.port) {
    const result = await sshExec(sink, `${reader} | ${command}`);
    return { exitCode: result.exitCode, stderr: result.stderr };
  }

  const from = await sshExecChannelUnbuffered(source.connection, reader);
  let to: Awaited<ReturnType<typeof sshExecChannelUnbuffered>>;
  try {
    to = await sshExecChannelUnbuffered(sink, command);
  } catch (e) {
    from.stream.destroy();
    throw e;
  }
  const fromStderr = collectText(from.stream.stderr);
  const toStderr = collectText(to.stream.stderr);
  to.stream.on('data', () => {});
  from.stream.on('error', (e: Error) => printDebug(`Backup relay source: ${e.message}`));
  to.stream.on('error', (e: Error) => printDebug(`Backup relay target: ${e.message}`));

  // Whichever side settles first decides: a reader that failed first truncated the stream; a
  // restore that finished first stopped reading, so the reader is closed.
  const settled: { first: 'source' | 'sink' | null } = { first: null };
  const fromOutcome = from.done.then(({ exitCode }) => {
    settled.first ??= 'source';
    return exitCode;
  });
  const toOutcome = to.done.then(({ exitCode }) => {
    settled.first ??= 'sink';
    if (!from.stream.readableEnded) {
      from.stream.unpipe(to.stream);
      from.stream.destroy();
    }
    return exitCode;
  });
  from.stream.pipe(to.stream);

  const [fromExit, toExit] = await Promise.all([fromOutcome, toOutcome]);
  // the exit status can arrive before the last of stderr
  await streamEnded(to.stream.stderr);
  if (settled.first === 'source' && fromExit !== 0) {
    await streamEnded(from.stream.stderr);
    throw new BackupError(
      `Cannot read backup file ${file} on ${source.name}: ${fromStderr().trim().split(/\r?\n/)[0] || `exit code ${fromExit}`}`,
      { code: ErrorCode.RESTORE_FAILED },
    );
  }
  return { exitCode: toExit, stderr: toStderr() };
}
