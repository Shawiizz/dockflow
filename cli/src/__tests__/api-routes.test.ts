import type { ServiceInfo } from '../api/types';
import { err, ok, type SSHKeyConnection } from '../types';
import { CLIError, ErrorCode } from '../utils/errors';
import type { Lock, LockData } from '../services/lock';
import { afterAll, describe, expect, it, test } from 'bun:test';
import { hasPosixShell, LocalShell } from './helpers/local-shell';
import { parseNodeStats, statsCommand } from '../api/routes/metrics';
import type { EnvNode } from '../utils/servers';
import { resolveApiService, withTimeout } from '../api/routes/_helpers';
import { formatDiskUsage, parseDockerSize, pruneCommand, pruneNodes, sumDockerSizes, unknownPruneTargets } from '../api/routes/resources';
import { execServiceCandidates, locateExecContainer } from '../api/routes/ssh';
import { connectivityStatus } from '../api/routes/servers';
import { buildArgs, deployArgs } from '../api/routes/operations';
import { readServiceLogs, resolvePartialStates, serviceListCommand, serviceLogsCommand, withDeployLock } from '../api/routes/services';
import { ApiProject } from './helpers/api-project';

const project = new ApiProject();
afterAll(() => project.dispose());

describe('the stack name of an API connection', () => {
  // staging has one manager: its connection needs no probe over SSH
  it('is <project>-<env>, the name the deploy gives the stack', async () => {
    const names = await project.run<Record<string, string | null | undefined>>(`
      const { getApiStacks, getManagerConnection } = await api('api/routes/_helpers');
      console.log(JSON.stringify({
        production: getApiStacks('production')?.app,
        staging: (await getManagerConnection('staging'))?.stackName,
      }));
    `);
    expect(names).toEqual({ production: 'shop-production', staging: 'shop-staging' });
  });

  it('names the lock and audit files of the deploy', async () => {
    const files = await project.run<{ lock: string; audit: string }>(`
      const { getManagerConnection } = await api('api/routes/_helpers');
      const { auditFilePath } = await api('api/routes/metrics');
      const { Lock } = await api('services/lock');
      const conn = await getManagerConnection('staging');
      const commands: string[] = [];
      const shell = { run: async (command: string) => { commands.push(command); return { stdout: 'NO_LOCK', stderr: '', exitCode: 0 }; } };
      await new Lock(shell, conn.stackName).status();
      console.log(JSON.stringify({ lock: commands[0], audit: auditFilePath(conn.stackName) }));
    `);
    expect(files.lock).toContain('/shop-staging.lock');
    expect(files.audit).toEndWith('/shop-staging.log');
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

describe('exec target lookup', () => {
  const stacks = ['shop-production', 'shop-production-accessories'];
  const conn = (host: string): SSHKeyConnection => ({ host, port: 22, user: 'deploy', privateKey: 'key' });
  const manager = conn('10.0.0.1');
  const nodes = [manager, conn('10.0.0.3')];

  it('reads a bare name as a compose name of the app stack, then of the accessories', () => {
    expect(execServiceCandidates('web', stacks)).toEqual(['shop-production_web', 'shop-production-accessories_web']);
  });

  it('keeps a compose name that contains an underscore', () => {
    expect(execServiceCandidates('my_worker', stacks)).toEqual(['shop-production_my_worker', 'shop-production-accessories_my_worker']);
  });

  it('keeps a native name as it is', () => {
    expect(execServiceCandidates('shop-production_web', stacks)).toEqual(['shop-production_web']);
    expect(execServiceCandidates('shop-production-accessories_db', stacks)).toEqual(['shop-production-accessories_db']);
  });

  it('returns the container with the node that runs it', async () => {
    const worker = nodes[1];
    const asked: string[] = [];
    const found = await locateExecContainer('web', stacks, manager, nodes, async (_stack, service, _conn, all) => {
      asked.push(service);
      expect(all).toEqual(nodes);
      return { containerId: 'abc123', connection: worker };
    });
    expect(found).toEqual({ containerId: 'abc123', connection: worker });
    expect(asked).toEqual(['shop-production_web']);
  });

  it('tries the accessories stack when the app stack has no such service', async () => {
    const found = await locateExecContainer('db', stacks, manager, nodes, async (_stack, service) =>
      service === 'shop-production-accessories_db' ? { containerId: 'def456', connection: manager } : null,
    );
    expect(found?.containerId).toBe('def456');
  });

  it('is null when no node runs the service', async () => {
    expect(await locateExecContainer('web', stacks, manager, nodes, async () => null)).toBeNull();
  });
});

describe('prune targets', () => {
  it('accepts the four docker resources', () => {
    expect(unknownPruneTargets(['containers', 'images', 'volumes', 'networks'])).toEqual([]);
  });

  it('names every unknown target', () => {
    expect(unknownPruneTargets(['images', 'cache', 'rm -rf /', 3])).toEqual(['cache', 'rm -rf /', '3']);
  });

  it('prunes all unused images only when asked to', () => {
    expect<string>(pruneCommand('images', false)).toBe('docker image prune -f');
    expect<string>(pruneCommand('images', true)).toBe('docker image prune -f -a');
  });
});

describe('statsCommand', () => {
  const stacks = ['shop-production', 'shop-production-accessories'];

  it('quotes the stack names as values, and leaves the shell syntax of the command live', () => {
    const command = statsCommand(["a'; rm -rf /; '", 'b']);
    expect(command).toContain(`--filter 'label=com.docker.stack.namespace=a'\\''; rm -rf /; '\\'''`);
    expect(command).toContain(`printf '%s\n' "$c0" "$c1" | grep '^C|'`);
  });

  const fakeDocker = (body: string) => `docker() {\n${body}\n}\n`;

  const workingDocker = fakeDocker(`
    case "$1" in
      ps)
        case "$*" in
          *namespace=shop-production-accessories*) echo 'C|bbb222|shop-production-accessories_db|shop-production-accessories' ;;
          *namespace=shop-production*) echo 'C|aaa111|shop-production_web|shop-production' ;;
        esac ;;
      stats)
        shift 4
        for id in "$@"; do echo "S|$id|name-$id|1.00%|1MiB / 2MiB|50.00%|1kB / 1kB|0B / 0B"; done ;;
    esac`);

  test.if(hasPosixShell)('lists the containers of both stacks, then reads the stats of exactly those', async () => {
    const shell = new LocalShell();
    const result = await shell.run(workingDocker + statsCommand(stacks));
    expect(result.exitCode).toBe(0);
    const entries = parseNodeStats(result.stdout, 'w1', { app: stacks[0], accessories: stacks[1] });
    expect(entries.map((entry) => [entry.name, entry.service, entry.role])).toEqual([
      ['name-aaa111', 'web', 'app'],
      ['name-bbb222', 'db', 'accessory'],
    ]);
  });

  test.if(hasPosixShell)('prints nothing and succeeds on a node that runs none of the stacks', async () => {
    const result = await new LocalShell().run(fakeDocker('return 0') + statsCommand(stacks));
    expect(result).toMatchObject({ stdout: '', exitCode: 0 });
  });

  test.if(hasPosixShell)('fails with the Docker error when the daemon does not answer', async () => {
    const result = await new LocalShell().run(fakeDocker('echo "Cannot connect to the Docker daemon" >&2; return 1') + statsCommand(stacks));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Cannot connect');
  });
});

describe('docker sizes', () => {
  it('reads the decimal units docker prints', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('12.3kB')).toBe(12_300);
    expect(parseDockerSize('1.234GB')).toBe(1_234_000_000);
    expect(parseDockerSize('nothing')).toBeNull();
  });

  it('sums sizes across nodes in docker notation', () => {
    expect(sumDockerSizes(['1.5GB', '500MB'])).toBe('2GB');
    expect(sumDockerSizes(['300kB', '400kB'])).toBe('700kB');
    expect(sumDockerSizes(['0B', '0B'])).toBe('0B');
    expect(sumDockerSizes(['999B', '2B'])).toBe('1.001kB');
  });

  it('has no sum when a size is unreadable or there is none', () => {
    expect(sumDockerSizes(['1GB', 'n/a'])).toBeNull();
    expect(sumDockerSizes([])).toBeNull();
  });
});

describe('pruneNodes', () => {
  const node = (name: string, role: 'manager' | 'worker'): EnvNode => ({
    name,
    role,
    connection: { host: `${name}.example`, port: 22, user: 'deploy', privateKey: 'key' },
  });
  const nodes = [node('m1', 'manager'), node('w1', 'worker')];
  const reply = (stdout: string, exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });

  it('prunes every node and sums the space freed', async () => {
    const seen: string[] = [];
    const results = await pruneNodes(nodes, ['images'], true, async (conn, command) => {
      seen.push(`${conn.host}: ${command}`);
      return reply(conn.host.startsWith('m1') ? 'Total reclaimed space: 1.5GB' : 'Total reclaimed space: 500MB');
    });
    expect(seen.sort()).toEqual(['m1.example: docker image prune -f -a', 'w1.example: docker image prune -f -a']);
    expect(results).toEqual([
      {
        target: 'images',
        success: true,
        reclaimed: '2GB',
        nodes: [
          { node: 'm1', success: true, reclaimed: '1.5GB' },
          { node: 'w1', success: true, reclaimed: '500MB' },
        ],
      },
    ]);
  });

  it('names the nodes that failed and still counts what the others freed', async () => {
    const results = await pruneNodes(nodes, ['containers', 'networks'], false, async (conn, command) =>
      conn.host.startsWith('w1') && command.includes('container') ? reply('', 1, 'permission denied') : reply('Total reclaimed space: 10MB'),
    );
    expect(results[0]).toMatchObject({ target: 'containers', success: false, reclaimed: '10MB', error: 'w1: permission denied' });
    expect(results[1]).toMatchObject({ target: 'networks', success: true });
  });

  it('reports a node that cannot be reached', async () => {
    const results = await pruneNodes(nodes, ['containers'], false, async (conn) => {
      if (conn.host.startsWith('w1')) throw new Error('connection timed out');
      return reply('');
    });
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('w1: connection timed out');
    expect(results[0].nodes?.[0]).toEqual({ node: 'm1', success: true, reclaimed: '0B' });
  });
});

describe('formatDiskUsage', () => {
  it('is the plain output for a single node', () => {
    expect(formatDiskUsage([{ node: 'm1', role: 'manager', raw: 'TYPE  TOTAL' }])).toBe('TYPE  TOTAL');
  });

  it('has a block per node, with the unreachable ones named', () => {
    expect(
      formatDiskUsage([
        { node: 'm1', role: 'manager', raw: 'TYPE  TOTAL' },
        { node: 'w1', role: 'worker', error: 'timed out' },
      ]),
    ).toBe('m1 (manager):\nTYPE  TOTAL\n\nw1 (worker):\nunreachable: timed out');
  });
});

describe('resolveApiService', () => {
  const stacks = { app: 'shop-production', accessories: 'shop-production-accessories' };
  const existing = (...names: string[]) => async (name: string) => names.includes(name);

  it('takes a native name as it is, without asking the cluster', async () => {
    const exists = async () => {
      throw new Error('must not be called');
    };
    expect(await resolveApiService('shop-production_web', stacks, exists)).toEqual({ name: 'shop-production_web', service: 'web', role: 'app' });
    expect(await resolveApiService('shop-production-accessories_db', stacks, exists)).toEqual({
      name: 'shop-production-accessories_db',
      service: 'db',
      role: 'accessory',
    });
  });

  it('finds a compose name in the app stack, then in the accessories', async () => {
    expect(await resolveApiService('web', stacks, existing('shop-production_web'))).toEqual({ name: 'shop-production_web', service: 'web', role: 'app' });
    expect(await resolveApiService('db', stacks, existing('shop-production-accessories_db'))).toEqual({
      name: 'shop-production-accessories_db',
      service: 'db',
      role: 'accessory',
    });
  });

  it('is null for a service that exists in neither stack', async () => {
    expect(await resolveApiService('ghost', stacks, existing())).toBeNull();
  });
});

describe('withDeployLock', () => {
  const data = {} as LockData;
  const fakeLock = (acquire: () => ReturnType<Lock['acquire']>) => {
    const calls: string[] = [];
    return {
      calls,
      lock: {
        acquire: async () => {
          calls.push('acquire');
          return acquire();
        },
        release: async () => {
          calls.push('release');
          return ok(undefined);
        },
      },
    };
  };
  const done = async () => new Response('done');

  it('runs the operation under the lock and releases it', async () => {
    const { calls, lock } = fakeLock(async () => ok(data));
    const response = await withDeployLock(lock, 'x', async () => {
      calls.push('run');
      return done();
    });
    expect(await response.text()).toBe('done');
    expect(calls).toEqual(['acquire', 'run', 'release']);
  });

  it('answers 409 and does not run while a deploy holds the lock', async () => {
    const { calls, lock } = fakeLock(async () => err(new CLIError('Already locked by ci@runner (2 min ago)', ErrorCode.DEPLOY_LOCKED)));
    const response = await withDeployLock(lock, 'x', done);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, message: 'Already locked by ci@runner (2 min ago)' });
    expect(calls).toEqual(['acquire']);
  });

  it('answers 500 when the lock cannot be read at all', async () => {
    const { lock } = fakeLock(async () => err(new CLIError('connection refused', ErrorCode.CONNECTION_FAILED)));
    expect((await withDeployLock(lock, 'x', done)).status).toBe(500);
  });

  it('releases the lock when the operation throws', async () => {
    const { calls, lock } = fakeLock(async () => ok(data));
    await expect(
      withDeployLock(lock, 'x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['acquire', 'release']);
  });
});

describe('readServiceLogs', () => {
  const conn = { host: 'm1', port: 22, user: 'deploy', privateKey: 'key', stackName: 'shop-production' };
  const task = (slot: number) => `shop-production_web.${slot}.k2j3h4g5f6d7s8a9q1w2e3r4t`;
  const replyWith = (stdout: string, exitCode = 0) => async () => ({ stdout, stderr: '', exitCode });

  it('asks for timestamps and merges the containers stderr', () => {
    expect<string>(serviceLogsCommand('shop-production_web', 50)).toBe(
      "docker service logs --tail 50 --timestamps --no-trunc 'shop-production_web' 2>&1",
    );
  });

  it('returns the lines of every task, oldest first, without the task context', async () => {
    const output = [
      `${task(1)}@m1    | 2026-01-15T10:00:02Z second`,
      `${task(2)}@w1    | 2026-01-15T10:00:01Z first`,
    ].join('\n');
    const read = await readServiceLogs(conn, 'shop-production', 'shop-production_web', 'web', 100, replyWith(output));
    expect(read).toEqual({
      logs: [
        { timestamp: '2026-01-15T10:00:01Z', message: 'first', service: 'web.2' },
        { timestamp: '2026-01-15T10:00:02Z', message: 'second', service: 'web.1' },
      ],
    });
  });

  it('answers 404 for a service that does not exist, instead of parsing docker error as a log line', async () => {
    const read = await readServiceLogs(conn, 'shop-production', 'shop-production_ghost', 'ghost', 100, replyWith('Error response from daemon: no such service: shop-production_ghost', 1));
    expect(read).toEqual({ error: 'Service ghost not found', status: 404 });
  });

  it('answers 500 with the docker message for any other failure', async () => {
    const read = await readServiceLogs(conn, 'shop-production', 'shop-production_web', 'web', 100, replyWith('Cannot connect to the Docker daemon', 1));
    expect(read).toEqual({ error: 'Cannot connect to the Docker daemon', status: 500 });
  });
});

describe('resolvePartialStates', () => {
  type Tracked = { name: string; state: ServiceInfo['state'] };
  const conn = { host: 'm1', port: 22, user: 'deploy', privateKey: 'key', stackName: 'shop-production' };
  const tasks = (byService: Record<string, string>) => async (_conn: unknown, command: string) => {
    const service = Object.keys(byService).find((name) => command.includes(`'${name}'`));
    return { stdout: byService[service ?? ''] ?? '', stderr: '', exitCode: 0 };
  };

  it('tells a crash-looping 0/N service from one that is still starting', async () => {
    const services: Tracked[] = [
      { name: 'shop-production-accessories_db', state: 'starting' },
      { name: 'shop-production-accessories_cache', state: 'starting' },
    ];
    await resolvePartialStates(
      conn,
      services,
      tasks({
        'shop-production-accessories_db': 'Failed 3 seconds ago\nPreparing 1 second ago',
        'shop-production-accessories_cache': 'Starting 2 seconds ago',
      }),
    );
    expect(services.map((service) => service.state)).toEqual(['error', 'starting']);
  });

  it('leaves the states that are already settled alone', async () => {
    const services: Tracked[] = [{ name: 'a', state: 'running' }, { name: 'b', state: 'stopped' }];
    await resolvePartialStates(conn, services, async () => {
      throw new Error('must not be called');
    });
    expect(services.map((service) => service.state)).toEqual(['running', 'stopped']);
  });
});
