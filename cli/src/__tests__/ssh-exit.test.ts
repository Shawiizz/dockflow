import { describe, expect, it } from 'bun:test';
import { channelResult, NO_EXIT_STATUS } from '../utils/ssh';

// What ssh2 passes the 'close' and 'exit' events of an exec channel: (code) when the command
// exited, (null, 'SIGKILL', ...) when a signal killed it, nothing when no exit status came.
describe('channelResult', () => {
  it('keeps the exit status of a command that exited, 0 included', () => {
    expect(channelResult('out', 'err', 0)).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
    expect(channelResult('', 'denied', 1)).toEqual({ stdout: '', stderr: 'denied', exitCode: 1 });
  });

  it('fails a command a signal killed, as a shell reports it, and says so', () => {
    expect(channelResult('partial', '', null, 'SIGKILL')).toEqual({
      stdout: 'partial',
      stderr: 'the remote command was killed by SIGKILL',
      exitCode: 137,
    });
    expect(channelResult('', 'Terminated', null, 'SIGTERM')).toEqual({
      stdout: '',
      stderr: 'Terminated\nthe remote command was killed by SIGTERM',
      exitCode: 143,
    });
    // a signal without a known number still fails
    expect(channelResult('', '', null, 'SIGPWR').exitCode).toBe(128);
  });

  it('fails a channel that closed without an exit status, as ssh(1) does', () => {
    for (const code of [undefined, null]) {
      expect(channelResult('', 'line\n', code)).toEqual({
        stdout: '',
        stderr: 'line\nthe session closed before the remote command reported its exit status',
        exitCode: NO_EXIT_STATUS,
      });
    }
    expect(NO_EXIT_STATUS).toBe(255);
  });
});
