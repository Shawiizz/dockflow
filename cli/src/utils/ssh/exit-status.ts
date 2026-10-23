/**
 * How the end of an exec channel reads: the exit code of a command, the shell-style code of one a
 * signal killed, and ssh(1)'s 255 when the session closed without a status.
 */

/** Linux numbers of the signals RFC 4254 lets a server report */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGFPE: 8, SIGKILL: 9,
  SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
};

/** What ssh(1) returns when the session ends without the command's exit status */
export const NO_EXIT_STATUS = 255;

/**
 * The result of a closed exec channel, from what ssh2 passes its 'exit' and 'close' events:
 * a number when the command exited; null and the signal's name when a signal killed it, which
 * reads as a shell reports it (128 + the signal's number); nothing when the channel closed
 * without an exit status, which reads as ssh(1) reports it. Only an exit status of 0 is a
 * success, and stderr says why there was none.
 */
export function channelResult(
  stdout: string,
  stderr: string,
  code?: number | null,
  signal?: string,
): { stdout: string; stderr: string; exitCode: number } {
  if (typeof code === 'number') return { stdout, stderr, exitCode: code };

  const killed = code === null && signal !== undefined;
  const reason = killed
    ? `the remote command was killed by ${signal}`
    : 'the session closed before the remote command reported its exit status';
  return {
    stdout,
    stderr: stderr && !stderr.endsWith('\n') ? `${stderr}\n${reason}` : `${stderr}${reason}`,
    exitCode: killed ? 128 + (SIGNAL_NUMBERS[signal as string] ?? 0) : NO_EXIT_STATUS,
  };
}
