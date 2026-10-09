import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

const executed: { host: string; cmd: string }[] = [];
let stackDeployed = true;
let volumesByHost: Record<string, string[]> = {};

const ok = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', exitCode: 0 });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (conn: SSHKeyConnection, cmd: string): Promise<SSHExecResult> => {
    executed.push({ host: conn.host, cmd });
    if (cmd.startsWith('docker stack ls')) return ok(stackDeployed ? 'demo-production-accessories\n' : '');
    if (cmd.startsWith('docker stack services')) return ok('demo-production-accessories_redis\t1/1\n');
    if (cmd.startsWith('docker volume ls')) return ok((volumesByHost[conn.host] ?? []).join('\n'));
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

const node = (name: string) => ({ name, connection: { host: name, port: 22, user: 'deploy', privateKey: '' } as SSHKeyConnection });
const nodes = [node('manager'), node('worker-1')];
const remove = (options: { volumes?: boolean }) => removeAccessories(nodes, 'production', 'demo-production', { ...options, yes: true });
const ran = (host: string, cmd: string) => executed.some((e) => e.host === host && e.cmd === cmd);

beforeEach(() => {
  executed.length = 0;
  stackDeployed = true;
  volumesByHost = {};
});

describe('removeAccessories', () => {
  it('clears the accessories hash of the app stack, so the next deploy brings them back', async () => {
    await remove({});
    expect(ran('manager', 'docker stack rm demo-production-accessories')).toBe(true);
    expect(ran('manager', "rm -rf '/var/lib/dockflow/accessories/demo-production'")).toBe(true);
  });

  it('with --volumes, deletes each volume on the node that holds it', async () => {
    volumesByHost = { manager: ['demo-production-accessories_cache'], 'worker-1': ['demo-production-accessories_redis-data'] };
    await remove({ volumes: true });
    expect(ran('manager', "docker volume rm 'demo-production-accessories_cache'")).toBe(true);
    expect(ran('worker-1', "docker volume rm 'demo-production-accessories_redis-data'")).toBe(true);
  });

  it('with --volumes, finishes a removal whose stack is gone but whose volumes remain on a worker', async () => {
    stackDeployed = false;
    volumesByHost = { 'worker-1': ['demo-production-accessories_redis-data'] };
    await remove({ volumes: true });
    expect(executed.some((e) => e.cmd.startsWith('docker stack rm'))).toBe(false);
    expect(ran('worker-1', "docker volume rm 'demo-production-accessories_redis-data'")).toBe(true);
  });

  it('refuses when neither the stack nor its volumes exist', async () => {
    stackDeployed = false;
    await expect(remove({ volumes: true })).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
  });

  it('refuses a stack already gone without --volumes', async () => {
    stackDeployed = false;
    volumesByHost = { manager: ['demo-production-accessories_redis-data'] };
    await expect(remove({})).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
  });
});
