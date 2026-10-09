import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import type { Client } from 'ssh2';
import { channelResult, NO_EXIT_STATUS, openChannelOnClient, openUnbufferedChannelOnClient } from '../utils/ssh';

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

function client(): { channel: EventEmitter & { stderr: EventEmitter }; client: Pick<Client, 'exec'> } {
  const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  return {
    channel,
    client: { exec: ((_command: string, callback: (error: Error | undefined, stream: unknown) => void) => callback(undefined, channel)) as Client['exec'] },
  };
}

describe('openChannelOnClient', () => {
  it('keeps the error text a stream delivers right after the exit status', async () => {
    const { channel, client: fake } = client();
    const handle = await openChannelOnClient(fake, 'docker stack deploy');
    channel.emit('exit', 1);
    process.nextTick(() => channel.stderr.emit('data', Buffer.from('network not found')));

    expect(await handle.done).toEqual({ stdout: '', stderr: 'network not found', exitCode: 1 });
  });
});

describe('openUnbufferedChannelOnClient', () => {

  it('settles on the exit status and keeps nothing of the output', async () => {
    const { channel, client: fake } = client();
    const handle = await openUnbufferedChannelOnClient(fake, 'cat file');
    channel.emit('data', Buffer.from('payload'));
    channel.emit('exit', 0);
    expect(await handle.done).toEqual({ exitCode: 0 });
    expect(Object.keys(await handle.done)).toEqual(['exitCode']);
  });

  it('reads a signal and a missing status as channelResult does', async () => {
    const killed = client();
    const handleKilled = await openUnbufferedChannelOnClient(killed.client, 'x');
    killed.channel.emit('exit', null, 'SIGKILL');
    expect(await handleKilled.done).toEqual({ exitCode: 137 });

    const lost = client();
    const handleLost = await openUnbufferedChannelOnClient(lost.client, 'x');
    lost.channel.emit('close');
    expect(await handleLost.done).toEqual({ exitCode: NO_EXIT_STATUS });
  });

  it('the first of exit and close wins', async () => {
    const { channel, client: fake } = client();
    const handle = await openUnbufferedChannelOnClient(fake, 'x');
    channel.emit('exit', 3);
    channel.emit('close');
    expect(await handle.done).toEqual({ exitCode: 3 });
  });

  it('an exec that cannot open its channel rejects', async () => {
    const failing = { exec: ((_command: string, callback: (error: Error | undefined) => void) => callback(new Error('channel open failure'))) as Client['exec'] };
    await expect(openUnbufferedChannelOnClient(failing, 'x')).rejects.toThrow('channel open failure');
  });
});
