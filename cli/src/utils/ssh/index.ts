/**
 * SSH over ssh2, with keys passed in memory (no key files). Commands share a pooled connection
 * per host; interactive sessions (sshShell, executeInteractiveSSH, executePtySSH) bypass the pool.
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
export { escapeSingleQuotes, shellQuote, sh, raw, RawShell, type ShellValue } from './quoting';
