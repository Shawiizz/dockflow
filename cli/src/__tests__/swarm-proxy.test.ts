import { describe, expect, it } from 'bun:test';
import { SwarmProxyBackend } from '../services/orchestrator/swarm/swarm-proxy';
import type { ProxyConfig } from '../utils/config';

const base = { enabled: true, acme: true, email: 'ops@example.com' } as ProxyConfig;

describe('SwarmProxyBackend.configHash', () => {
  it('is stable for the same configuration', () => {
    expect(SwarmProxyBackend.configHash({ ...base })).toBe(SwarmProxyBackend.configHash({ ...base }));
  });

  it('changes when the generated stack would change', () => {
    const hash = SwarmProxyBackend.configHash(base);

    expect(SwarmProxyBackend.configHash({ ...base, email: 'other@example.com' })).not.toBe(hash);
    expect(SwarmProxyBackend.configHash({ ...base, acme: false })).not.toBe(hash);
    expect(SwarmProxyBackend.configHash({ ...base, dashboard: { enabled: true, domain: 'tr.example.com' } } as ProxyConfig)).not.toBe(hash);
  });
});

describe('SwarmProxyBackend.generateCompose', () => {
  it('labels the service with the hash it was deployed from, dashboard or not', () => {
    const hash = SwarmProxyBackend.configHash(base);
    const dashboard = { ...base, dashboard: { enabled: true, domain: 'tr.example.com' } } as ProxyConfig;

    expect(SwarmProxyBackend.generateCompose(base, hash)).toContain(`"dockflow.config-hash=${hash}"`);
    expect(SwarmProxyBackend.generateCompose(dashboard, 'abc')).toContain('"dockflow.config-hash=abc"');
    expect(SwarmProxyBackend.generateCompose(base)).not.toContain('dockflow.config-hash');
  });
});
