import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { registryLoginLocal } from '../services/distribution';
import { DeployError, ErrorCode } from '../utils/errors';

interface SpawnCall {
  argv: string[];
  stdin: string;
}

function fakeSpawn(exitCode: number, stderr = '') {
  const calls: SpawnCall[] = [];
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], options: { stdin: ReadableStream }) => {
    const call: SpawnCall = { argv, stdin: '' };
    calls.push(call);
    const read = new Response(options.stdin).text().then((text) => {
      call.stdin = text;
    });
    return {
      stdout: new Response('').body,
      stderr: new Response(stderr).body,
      exited: read.then(() => exitCode),
    };
  }) as unknown as typeof Bun.spawn);
  return { calls, spy };
}

describe('registryLoginLocal', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('logs in on this machine with the username, the password only on stdin', async () => {
    const { calls, spy } = fakeSpawn(0);
    restore = () => spy.mockRestore();
    await registryLoginLocal({ url: 'registry.example.com', username: 'deploy', password: 's3cret' });
    expect(calls.map((call) => call.argv)).toEqual([['docker', 'login', 'registry.example.com', '-u', 'deploy', '--password-stdin']]);
    expect(calls[0]?.stdin).toBe('s3cret');
  });

  it('uses the configured engine', async () => {
    const { calls, spy } = fakeSpawn(0);
    restore = () => spy.mockRestore();
    await registryLoginLocal({ url: 'registry.example.com', username: 'deploy', password: 's3cret' }, 'podman');
    expect(calls[0]?.argv[0]).toBe('podman');
  });

  it('pushes anonymously without a username, which login --password-stdin requires', async () => {
    const { calls, spy } = fakeSpawn(0);
    restore = () => spy.mockRestore();
    await registryLoginLocal({ url: 'localhost:5000', password: 'placeholder' });
    expect(calls).toEqual([]);
  });

  it('a refused login fails the deploy with the engine message and no password', async () => {
    const { spy } = fakeSpawn(1, 'Error response from daemon: Get "https://registry.example.com/v2/": unauthorized\n');
    restore = () => spy.mockRestore();
    const failure = await registryLoginLocal({ url: 'registry.example.com', username: 'deploy', password: 's3cret' }).catch((error) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(failure.message).toBe('Registry login to registry.example.com failed: Error response from daemon: Get "https://registry.example.com/v2/": unauthorized');
    expect(failure.message).not.toContain('s3cret');
  });
});
