import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as output from '../utils/output';
import type { ResolvedServer, SSHExecResult, SSHKeyConnection } from '../types';
import { CLIError, ErrorCode } from '../utils/errors';

type Responder = (host: string, command: string) => Partial<SSHExecResult> | undefined;

let scripted = false;
let respond: Responder = () => undefined;
const executed: { host: string; command: string }[] = [];

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (...args: Parameters<typeof realSsh.sshExec>) => {
    if (!scripted) return realSsh.sshExec(...args);
    const [conn, command] = args;
    executed.push({ host: conn.host, command });
    return { stdout: '', stderr: '', exitCode: 0, ...respond(conn.host, command) };
  },
}));

const { initializeSwarm, joinWorkers, readiness, requireAllJoined, swarmAddress, swarmJoinCommand } = await import('../commands/setup/swarm');

const worker = (name: string): ResolvedServer => ({ name, host: `${name}.example.com`, port: 22, user: 'deploy' }) as ResolvedServer;
const connect = (w: ResolvedServer): SSHKeyConnection | null =>
  w.name === 'keyless' ? null : { host: w.host, port: w.port, user: w.user, privateKey: 'test-key' };

beforeEach(() => {
  scripted = true;
  respond = () => undefined;
  executed.length = 0;
});

describe('joinWorkers', () => {
  it('reports no failure when every worker joins, or already belongs to the cluster', async () => {
    respond = (host, command) => (command.startsWith('docker info') ? { stdout: host === 'old.example.com' ? 'active\n' : 'inactive\n' } : undefined);
    const failures = await joinWorkers([worker('old'), worker('new')], connect, '10.0.0.1', 'SWMTKN-1-abc');
    expect(failures).toEqual([]);
    expect(executed.filter((call) => call.command.startsWith('docker swarm join')).map((call) => call.host)).toEqual(['new.example.com']);
  });

  it('collects the worker without a key and the one whose join fails, and goes on to the others', async () => {
    respond = (host, command) => {
      if (command.startsWith('docker info')) return { stdout: 'inactive\n' };
      if (command.startsWith('docker swarm join') && host === 'broken.example.com') return { exitCode: 1, stderr: 'rpc error: connection refused' };
      return undefined;
    };
    const failures = await joinWorkers([worker('keyless'), worker('broken'), worker('fine')], connect, '10.0.0.1', 'SWMTKN-1-abc');
    expect(failures).toEqual([
      { name: 'keyless', reason: 'no SSH key' },
      { name: 'broken', reason: 'could not join the cluster' },
    ]);
    expect(executed.filter((call) => call.command.startsWith('docker swarm join')).map((call) => call.host)).toEqual(['broken.example.com', 'fine.example.com']);
  });
});

describe('private_host', () => {
  const manager = (extra: Partial<ResolvedServer> = {}): ResolvedServer =>
    ({ name: 'manager-1', role: 'manager', host: '203.0.113.10', port: 22, user: 'deploy', ...extra }) as ResolvedServer;
  const connection: SSHKeyConnection = { host: '203.0.113.10', port: 22, user: 'deploy', privateKey: 'test-key' };
  const warnings: string[] = [];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnings.length = 0;
    warn = spyOn(output, 'printWarning').mockImplementation((message: string) => void warnings.push(message));
  });
  afterEach(() => warn.mockRestore());

  const swarmCommands = () => executed.map((call) => call.command).filter((command) => command.startsWith('docker swarm'));

  it('is the address Swarm uses, and the host when there is none', () => {
    expect(swarmAddress(manager())).toBe('203.0.113.10');
    expect(swarmAddress(manager({ privateHost: '10.0.0.5' }))).toBe('10.0.0.5');
  });

  it('initialises the Swarm on the private address while SSH keeps using the host', async () => {
    respond = (_host, command) => (command.startsWith('docker info') ? { stdout: 'inactive\n' } : undefined);

    const init = await initializeSwarm(connection, manager({ privateHost: '10.0.0.5' }));

    expect(swarmCommands()).toContain("docker swarm init --advertise-addr '10.0.0.5' 2>&1");
    expect(init?.internalIp).toBe('10.0.0.5');
    expect(executed.every((call) => call.host === '203.0.113.10')).toBe(true);
  });

  it('initialises on the host when no private address is set', async () => {
    respond = (_host, command) => (command.startsWith('docker info') ? { stdout: 'inactive\n' } : undefined);
    const init = await initializeSwarm(connection, manager());
    expect(swarmCommands()).toContain("docker swarm init --advertise-addr '203.0.113.10' 2>&1");
    expect(init?.internalIp).toBe('203.0.113.10');
  });

  it('builds the join of a worker with the manager address, and its own advertised address', () => {
    expect(swarmJoinCommand('SWMTKN-1-abc', '10.0.0.5')).toBe("docker swarm join --token 'SWMTKN-1-abc' '10.0.0.5:2377'");
    expect(swarmJoinCommand('SWMTKN-1-abc', '10.0.0.5', '10.0.0.6')).toBe(
      "docker swarm join --token 'SWMTKN-1-abc' --advertise-addr '10.0.0.6' '10.0.0.5:2377'",
    );
    expect(swarmJoinCommand('t', 'fd00::5')).toBe("docker swarm join --token 't' '[fd00::5]:2377'");
  });

  it('joins a worker through the manager private address, advertising its own', async () => {
    respond = (_host, command) => (command.startsWith('docker info') ? { stdout: 'inactive\n' } : undefined);

    const failures = await joinWorkers([{ ...worker('w1'), privateHost: '10.0.0.6' }, worker('w2')], connect, '10.0.0.5', 'SWMTKN-1-abc');

    expect(failures).toEqual([]);
    expect(swarmCommands().filter((command) => command.startsWith('docker swarm join'))).toEqual([
      "docker swarm join --token 'SWMTKN-1-abc' --advertise-addr '10.0.0.6' '10.0.0.5:2377'",
      "docker swarm join --token 'SWMTKN-1-abc' '10.0.0.5:2377'",
    ]);
  });

  it('warns, and changes nothing, when a node already in the cluster advertises another address', async () => {
    respond = (_host, command) => {
      if (command === "docker info --format '{{.Swarm.LocalNodeState}}'") return { stdout: 'active\n' };
      if (command === "docker info --format '{{.Swarm.NodeAddr}}'") return { stdout: '203.0.113.20\n' };
      return undefined;
    };

    await joinWorkers([{ ...worker('w1'), privateHost: '10.0.0.6' }], connect, '10.0.0.5', 'SWMTKN-1-abc');

    expect(swarmCommands()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('w1 advertises 203.0.113.20 in the Swarm, not its private_host 10.0.0.6');
    expect(warnings[0]).toContain('docker swarm leave --force');
  });

  it('says nothing when the node already advertises its private address, or has none', async () => {
    respond = (_host, command) => {
      if (command === "docker info --format '{{.Swarm.LocalNodeState}}'") return { stdout: 'active\n' };
      if (command === "docker info --format '{{.Swarm.NodeAddr}}'") return { stdout: '10.0.0.6\n' };
      return undefined;
    };
    await joinWorkers([{ ...worker('w1'), privateHost: '10.0.0.6' }, worker('w2')], connect, '10.0.0.5', 'SWMTKN-1-abc');
    expect(warnings).toEqual([]);
    expect(executed.filter((call) => call.command.includes('NodeAddr'))).toHaveLength(1);
  });

  it('warns about a manager whose Swarm already exists on another address', async () => {
    respond = (_host, command) => {
      if (command === "docker info --format '{{.Swarm.LocalNodeState}}'") return { stdout: 'active\n' };
      if (command === "docker info --format '{{.Swarm.NodeAddr}}'") return { stdout: '203.0.113.10\n' };
      if (command.startsWith('docker swarm join-token')) return { stdout: 'SWMTKN-1-abc\n' };
      return undefined;
    };
    await initializeSwarm(connection, manager({ privateHost: '10.0.0.5' }));
    expect(warnings[0]).toContain('manager-1 advertises 203.0.113.10 in the Swarm, not its private_host 10.0.0.5');
    expect(swarmCommands().some((command) => command.startsWith('docker swarm init'))).toBe(false);
  });
});

describe('requireAllJoined', () => {
  it('lets a complete cluster through', () => {
    expect(() => requireAllJoined('production', [])).not.toThrow();
  });

  it('fails, naming the workers, instead of letting the command say the cluster is ready', () => {
    let error: unknown;
    try {
      requireAllJoined('production', [
        { name: 'w1', reason: 'no SSH key' },
        { name: 'w2', reason: 'could not join the cluster' },
      ]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CLIError);
    expect(error).toMatchObject({ message: 'Swarm setup of production failed on w1, w2', code: ErrorCode.COMMAND_FAILED });
    expect((error as CLIError).suggestion).toContain('run setup again');
  });
});

describe('readiness', () => {
  it('counts the Ready nodes and names the others', () => {
    expect(readiness('manager-1|Ready\nworker-1|Down\nworker-2|Ready\n')).toEqual({ ready: 2, notReady: ['worker-1 (Down)'] });
    expect(readiness('')).toEqual({ ready: 0, notReady: [] });
  });
});
