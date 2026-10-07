import { afterAll, describe, expect, it } from 'bun:test';
import { withTimeout } from '../api/routes/_helpers';
import { connectivityStatus } from '../api/routes/servers';
import { buildArgs, deployArgs } from '../api/routes/operations';
import { serviceListCommand } from '../api/routes/services';
import { ApiProject } from './helpers/api-project';

const project = new ApiProject();
afterAll(() => project.dispose());

describe('the stack name of an API connection', () => {
  it('is <project>-<env>, the name the deploy gives the stack', async () => {
    const names = await project.run<Record<string, string | null>>(`
      const { getManagerConnection } = await api('api/routes/_helpers');
      console.log(JSON.stringify({
        production: getManagerConnection('production')?.stackName,
        staging: getManagerConnection('staging')?.stackName,
      }));
    `);
    expect(names).toEqual({ production: 'shop-production', staging: 'shop-staging' });
  });

  it('names the lock and audit files of the deploy', async () => {
    const files = await project.run<{ lock: string; audit: string }>(`
      const { getManagerConnection } = await api('api/routes/_helpers');
      const { auditFilePath } = await api('api/routes/metrics');
      const { Lock } = await api('services/lock');
      const conn = getManagerConnection('production');
      const commands: string[] = [];
      const shell = { run: async (command: string) => { commands.push(command); return { stdout: 'NO_LOCK', stderr: '', exitCode: 0 }; } };
      await new Lock(shell, conn.stackName).status();
      console.log(JSON.stringify({ lock: commands[0], audit: auditFilePath(conn.stackName) }));
    `);
    expect(files.lock).toContain('/shop-production.lock');
    expect(files.audit).toEndWith('/shop-production.log');
  });
});

describe('serviceListCommand', () => {
  it('selects the services of exactly one stack by its namespace label', () => {
    const command = serviceListCommand('shop-production');
    expect(command).toContain(`--filter 'label=com.docker.stack.namespace=shop-production'`);
    expect(command).not.toContain('name=');
  });

  it('quotes the stack name', () => {
    expect(serviceListCommand('a b; c')).toContain("'label=com.docker.stack.namespace=a b; c'");
  });
});

describe('operation arguments', () => {
  it('passes the service list of a deploy as --only, the only option the CLI defines', () => {
    expect(deployArgs({ environment: 'production', services: 'web,api', skipBuild: true })).toEqual([
      'deploy',
      'production',
      '--skip-build',
      '--only',
      'web,api',
    ]);
  });

  it('passes the service list of a build as --only', () => {
    expect(buildArgs({ environment: 'staging', services: 'web', push: true })).toEqual(['build', 'staging', '--only', 'web', '--push']);
  });

  it('adds no option that was not asked for', () => {
    expect(deployArgs({ environment: 'production' })).toEqual(['deploy', 'production']);
    expect(buildArgs({ environment: 'production' })).toEqual(['build', 'production']);
  });
});

describe('connectivityStatus', () => {
  it('is offline when the server does not answer over SSH', () => {
    expect(connectivityStatus(false)).toBe('offline');
    expect(connectivityStatus(false, 'leader')).toBe('offline');
  });

  it('is offline when Docker does not answer on a manager', () => {
    expect(connectivityStatus(true, 'unreachable')).toBe('offline');
  });

  it('is online for a worker and for every answering manager state', () => {
    expect(connectivityStatus(true)).toBe('online');
    expect(connectivityStatus(true, 'leader')).toBe('online');
    expect(connectivityStatus(true, 'reachable')).toBe('online');
    expect(connectivityStatus(true, 'unready')).toBe('online');
  });
});

describe('withTimeout', () => {
  it('returns the value of a promise that settles in time', async () => {
    expect(await withTimeout(Promise.resolve(7), 1000, 'late')).toBe(7);
  });

  it('passes the rejection of the promise through', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'late')).rejects.toThrow('boom');
  });

  it('rejects with the message when the promise takes too long', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'did not answer')).rejects.toThrow('did not answer');
  });
});
