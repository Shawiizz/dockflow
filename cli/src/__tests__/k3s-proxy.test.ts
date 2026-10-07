import { describe, expect, it } from 'bun:test';
import { K3sProxyBackend } from '../services/orchestrator/k3s/k3s-proxy';
import type { ProxyConfig } from '../utils/config';

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
