import { beforeEach, describe, expect, it, mock } from 'bun:test';
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

const { joinWorkers, readiness, requireAllJoined } = await import('../commands/setup/swarm');

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
