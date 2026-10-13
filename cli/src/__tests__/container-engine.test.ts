import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

const commands: string[] = [];
let reply: SSHExecResult = { stdout: '', stderr: '', exitCode: 0 };

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (_conn: unknown, command: string) => {
    commands.push(command);
    return reply;
  },
}));

const { detectContainerEngine } = await import('../commands/deploy-phases');

const manager = { host: 'manager', port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection;

beforeEach(() => {
  commands.length = 0;
  reply = { stdout: '', stderr: '', exitCode: 0 };
});

describe('detectContainerEngine', () => {
  it('uses the configured engine without asking the manager', async () => {
    expect(await detectContainerEngine(manager, 'docker')).toBe('docker');
    expect(await detectContainerEngine(manager, 'podman')).toBe('podman');
    expect(commands).toEqual([]);
  });

  it('picks podman when the manager has it', async () => {
    reply = { stdout: '/usr/bin/podman\n', stderr: '', exitCode: 0 };
    expect(await detectContainerEngine(manager)).toBe('podman');
    expect(commands).toEqual(['which podman 2>/dev/null']);
  });

  it('falls back to docker when the manager has no podman', async () => {
    reply = { stdout: '', stderr: '', exitCode: 1 };
    expect(await detectContainerEngine(manager)).toBe('docker');
  });
});
