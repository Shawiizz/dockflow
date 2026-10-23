/**
 * SSH utilities using the ssh2 library.
 * Supports key-based and password-based authentication.
 * No temporary key files needed — keys are passed directly in memory.
 *
 * Connection pooling: a module-level pool reuses SSH connections per host.
 * Multiple exec() calls multiplex over a single TCP connection via SSH channels.
 * Interactive sessions (sshShell, executeInteractiveSSH) bypass the pool.
 */

export { presentedHostKey, connectionFailure } from './connect';
export { closeAllConnections } from './pool';
export { NO_EXIT_STATUS, channelResult } from './exit-status';
export { sshExec, sshExecStream } from './exec';
export {
  sshExecChannel,
  openChannelOnClient,
  sshExecChannelUnbuffered,
  openUnbufferedChannelOnClient,
  type SSHChannelHandle,
  type SSHUnbufferedChannelHandle,
} from './channels';
export { sshShell, executeInteractiveSSH, executePtySSH } from './interactive';
export { escapeSingleQuotes, shellQuote } from './quoting';
