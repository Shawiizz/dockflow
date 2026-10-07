import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

const executedCommands: string[] = [];
let stackDeployed = true;
let volumes: string[] = [];

const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', exitCode: 0 });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (_conn: unknown, cmd: string): Promise<SSHExecResult> => {
    executedCommands.push(cmd);
    if (cmd.startsWith('docker stack ls')) return ok(stackDeployed ? 'demo-production-accessories\n' : '');
    if (cmd.startsWith('docker stack services')) return ok('demo-production-accessories_redis\t1/1\n');
    if (cmd.startsWith('docker volume ls')) return ok(volumes.join('\n'));
    if (cmd.startsWith('docker stack ps')) return ok('0');
    return ok();
  },
}));

const realConfig = await import('../utils/config');
mock.module('../utils/config', () => ({
  ...realConfig,
  getAccessoriesStackName: (env: string) => `demo-${env}-accessories`,
}));

const { removeAccessories } = await import('../commands/accessories/remove');
const { ErrorCode } = await import('../utils/errors');

const connection = { host: 'manager', port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection;
const remove = (options: { volumes?: boolean }) =>
  removeAccessories(connection, 'production', 'demo-production', { ...options, yes: true });

beforeEach(() => {
  executedCommands.length = 0;
  stackDeployed = true;
  volumes = [];
});

describe('removeAccessories', () => {
  it('clears the accessories hash of the app stack, so the next deploy brings them back', async () => {
    await remove({});
    expect(executedCommands).toContain('docker stack rm demo-production-accessories');
    expect(executedCommands).toContain("rm -rf '/var/lib/dockflow/accessories/demo-production'");
  });

  it('with --volumes, finishes a removal whose stack is gone but whose volumes remain', async () => {
    stackDeployed = false;
    volumes = ['demo-production-accessories_redis-data'];
    await remove({ volumes: true });
    expect(executedCommands.some((cmd) => cmd.startsWith('docker stack rm'))).toBe(false);
    expect(executedCommands).toContain("docker volume rm 'demo-production-accessories_redis-data'");
  });

  it('refuses when neither the stack nor its volumes exist', async () => {
    stackDeployed = false;
    await expect(remove({ volumes: true })).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
  });

  it('refuses a stack already gone without --volumes', async () => {
    stackDeployed = false;
    volumes = ['demo-production-accessories_redis-data'];
    await expect(remove({})).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
  });
});
