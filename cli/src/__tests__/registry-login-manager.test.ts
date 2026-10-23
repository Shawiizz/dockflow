import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

const calls: { command: string; stdin: string }[] = [];
let reply: SSHExecResult = { stdout: '', stderr: '', exitCode: 0 };

const realSsh = await import('../utils/ssh');
const sshSpies = [
  spyOn(realSsh, 'sshExecChannel').mockImplementation((async (_conn: unknown, command: string) => {
    const call = { command, stdin: '' };
    calls.push(call);
    return { stream: { end: (data: string) => { call.stdin = data; } }, done: Promise.resolve(reply) };
  }) as never),
];
afterAll(() => {
  for (const spy of sshSpies) spy.mockRestore();
});

const { registryLogin } = await import('../services/distribution');
const { DeployError } = await import('../utils/errors');

const manager = { host: 'manager', port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection;

beforeEach(() => {
  calls.length = 0;
  reply = { stdout: '', stderr: '', exitCode: 0 };
});

describe('registryLogin on the manager', () => {
  it('passes the password on stdin, never in the command', async () => {
    await registryLogin(manager, { url: 'registry.example.com', username: 'deploy', password: "s3'cret" });
    expect(calls).toEqual([
      { command: "docker login 'registry.example.com' -u 'deploy' --password-stdin", stdin: "s3'cret\n" },
    ]);
  });

  it('skips the login without a username, which --password-stdin requires', async () => {
    await registryLogin(manager, { url: 'localhost:5000', password: 'placeholder' });
    expect(calls).toEqual([]);
  });

  it('a refused login names the registry and keeps the password out of the message', async () => {
    reply = { stdout: '', stderr: 'Error response from daemon: unauthorized\n', exitCode: 1 };
    const failure = await registryLogin(manager, { url: 'registry.example.com', username: 'deploy', password: 's3cret' }).catch((e) => e);
    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.message).toBe('Registry login to registry.example.com failed on the manager: Error response from daemon: unauthorized');
  });
});
