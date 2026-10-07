import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

// ---------------------------------------------------------------------------
// SSH mock — must be installed before importing the firewall helper. Each
// test scripts the result of a command by its text; commands are recorded.
// ---------------------------------------------------------------------------

type Responder = (cmd: string) => SSHExecResult | undefined;

const executedCommands: string[] = [];
let sshResponses: Responder = () => undefined;

const okResult = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', exitCode: 0 });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (_conn: unknown, cmd: string): Promise<SSHExecResult> => {
    executedCommands.push(cmd);
    return sshResponses(cmd) ?? okResult();
  },
}));

const { openPortCommands, openPorts } = await import('../commands/setup/firewall');

const CONNECTION: SSHKeyConnection = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };
const PORTS = [
  { port: 2377, protocol: 'tcp', description: 'Cluster management' },
  { port: 4789, protocol: 'udp', description: 'Overlay network' },
];

beforeEach(() => {
  executedCommands.length = 0;
  sshResponses = () => undefined;
});

describe('openPortCommands', () => {
  it('opens each port with ufw, then reloads it', () => {
    expect(openPortCommands('ufw', PORTS)).toEqual(['sudo -n ufw allow 2377/tcp', 'sudo -n ufw allow 4789/udp', 'sudo -n ufw reload']);
  });

  it('adds permanent firewalld ports, then reloads', () => {
    expect(openPortCommands('firewalld', PORTS)).toEqual([
      'sudo -n firewall-cmd --permanent --add-port=2377/tcp',
      'sudo -n firewall-cmd --permanent --add-port=4789/udp',
      'sudo -n firewall-cmd --reload',
    ]);
  });

  it('inserts an iptables rule only when it is not there yet', () => {
    expect(openPortCommands('iptables', PORTS)[0]).toBe(
      'sudo -n iptables -C INPUT -p tcp --dport 2377 -j ACCEPT 2>/dev/null || sudo -n iptables -I INPUT -p tcp --dport 2377 -j ACCEPT',
    );
  });
});

describe('openPorts', () => {
  it('opens the ports with the firewall the host has', async () => {
    sshResponses = (cmd) => (cmd.endsWith('command -v ufw') ? okResult('/usr/sbin/ufw\n') : undefined);
    expect(await openPorts(CONNECTION, 'manager', PORTS)).toBe(true);
    expect(executedCommands.slice(1)).toEqual(['sudo -n ufw allow 2377/tcp', 'sudo -n ufw allow 4789/udp', 'sudo -n ufw reload']);
  });

  it('reports a command sudo refused instead of claiming the ports are open', async () => {
    sshResponses = (cmd) => {
      if (cmd.endsWith('command -v ufw')) return okResult('/usr/sbin/ufw\n');
      if (cmd.startsWith('sudo -n')) return { stdout: '', stderr: 'sudo: a password is required\n', exitCode: 1 };
      return undefined;
    };
    expect(await openPorts(CONNECTION, 'manager', PORTS)).toBe(false);
    expect(executedCommands.filter((cmd) => cmd.startsWith('sudo -n'))).toEqual(['sudo -n ufw allow 2377/tcp']);
  });
});
