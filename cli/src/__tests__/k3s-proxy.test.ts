import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { parse } from 'yaml';
import type { SSHExecResult, SSHKeyConnection } from '../types';
import type { ProxyConfig } from '../utils/config';

// SSH mock, installed before importing the backend: each test scripts the result of a command by
// its text, and commands are recorded in order.
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

const { K3sProxyBackend } = await import('../services/orchestrator/k3s/k3s-proxy');

const CONNECTION: SSHKeyConnection = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };

beforeEach(() => {
  executedCommands.length = 0;
  sshResponses = () => undefined;
});

describe('K3sProxyBackend.generateHelmChartConfig', () => {
  it('has nothing to configure without ACME email or trusted senders', () => {
    expect(K3sProxyBackend.generateHelmChartConfig({ enabled: true, acme: false } as ProxyConfig)).toBeNull();
  });

  it('configures Let\'s Encrypt with persistence', () => {
    const config = K3sProxyBackend.generateHelmChartConfig({ enabled: true, acme: true, email: 'ops@example.com' } as ProxyConfig);
    expect(config).toContain('persistence:');
    expect(config).toContain('--certificatesresolvers.letsencrypt.acme.email=ops@example.com');
  });

  it('trusts the X-Forwarded-* headers of the configured senders, without ACME too', () => {
    const config = K3sProxyBackend.generateHelmChartConfig({ enabled: true, acme: false, trusted_ips: ['173.245.48.0/20'] } as ProxyConfig);
    expect(config).toContain('--entrypoints.web.forwardedHeaders.trustedIPs=173.245.48.0/20');
    expect(config).toContain('--entrypoints.websecure.forwardedHeaders.trustedIPs=173.245.48.0/20');
    expect(config).not.toContain('persistence:');
  });
});

describe('K3sProxyBackend.ensureRunning', () => {
  const proxy = { enabled: true, acme: true, email: 'ops@example.com' } as ProxyConfig;
  const values = (parse(K3sProxyBackend.generateHelmChartConfig(proxy) as string) as { spec: { valuesContent: string } }).spec.valuesContent;
  const changes = () => executedCommands.filter((cmd) => cmd.includes(' apply ') || cmd.includes('rollout restart'));

  it('leaves Traefik alone when the cluster holds the same configuration', async () => {
    sshResponses = (cmd) => (cmd.includes('get helmchartconfig') ? okResult(`${values}\n`) : undefined);
    await new K3sProxyBackend(CONNECTION).ensureRunning(proxy);
    expect(changes()).toEqual([]);
  });

  it('applies the configuration and restarts Traefik when it differs or is missing', async () => {
    for (const current of [okResult('additionalArguments: []'), { stdout: '', stderr: 'NotFound', exitCode: 1 }]) {
      executedCommands.length = 0;
      sshResponses = (cmd) => (cmd.includes('get helmchartconfig') ? current : undefined);
      await new K3sProxyBackend(CONNECTION).ensureRunning(proxy);
      expect(changes()).toHaveLength(2);
      expect(changes()[1]).toContain('rollout restart deployment/traefik');
    }
  });
});
