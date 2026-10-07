import { describe, expect, it } from 'bun:test';
import { FirewallConfigSchema, isIpOrCidr, ProxyConfigSchema } from '../schemas/config.schema';
import { findUnknownConfigKeys } from '../schemas/validation';

describe('isIpOrCidr', () => {
  it('accepts addresses and CIDR ranges of both families', () => {
    for (const value of ['173.245.48.0/20', '10.0.0.1', '0.0.0.0/0', '2400:cb00::/32', '::1', '2001:db8::1/128']) {
      expect({ value, ok: isIpOrCidr(value) }).toEqual({ value, ok: true });
    }
  });

  it('refuses host names, out-of-range octets or prefixes, and stray slashes', () => {
    for (const value of ['cdn.example.com', '256.1.1.1', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/8/9', '1::2::3', '']) {
      expect({ value, ok: isIpOrCidr(value) }).toEqual({ value, ok: false });
    }
  });
});

describe('ProxyConfigSchema', () => {
  it('takes trusted_ips as a list of addresses or ranges', () => {
    const parsed = ProxyConfigSchema.safeParse({ enabled: true, acme: false, trusted_ips: ['173.245.48.0/20', '2400:cb00::/32'] });
    expect(parsed.success).toBe(true);
    expect(ProxyConfigSchema.safeParse({ enabled: true, acme: false, trusted_ips: ['cdn.example.com'] }).success).toBe(false);
  });

  it('takes routes with a domain per environment, an optional path and port', () => {
    const route = { service: 'panel', domains: { production: 'panel.example.com' } };
    const routes = (...list: unknown[]) => ProxyConfigSchema.safeParse({ enabled: true, acme: false, routes: list }).success;

    expect(routes(route, { ...route, path: '/ws', port: 3001 })).toBe(true);
    expect(routes({ ...route, domains: { production: 'https://panel.example.com' } })).toBe(false);
    expect(routes({ ...route, domains: { production: 'panel.example.com`) || Host(`x' } })).toBe(false);
    expect(routes({ ...route, path: 'ws' })).toBe(false);
    expect(routes({ ...route, path: '/a$b' })).toBe(false);
    expect(routes({ ...route, port: 70000 })).toBe(false);
    expect(routes({ domains: route.domains })).toBe(false);
  });

  it('reports the unknown keys of a route', () => {
    const config = { project_name: 'demo', proxy: { routes: [{ service: 'panel', domains: {}, prot: 3000 }] } };
    expect(findUnknownConfigKeys(config)).toEqual([{ path: 'proxy.routes[0].prot', suggestion: 'port' }]);
  });
});

describe('FirewallConfigSchema', () => {
  const ports = (...list: unknown[]) => FirewallConfigSchema.safeParse({ public_ports: list });

  it('takes a port, a range, a protocol, and the addresses a port answers', () => {
    expect(ports(1883, '51820/udp', '8000-8010/tcp', { port: 443, from: ['173.245.48.0/20', '2400:cb00::/32'] }).success).toBe(true);
  });

  it('refuses a port outside 1-65535, an unknown protocol, a bad address', () => {
    for (const entry of [0, 70000, '443/sctp', '10-5', 'https', { port: 443, from: ['cdn.example.com'] }, { port: 443, from: [] }]) {
      expect({ entry, ok: ports(entry).success }).toEqual({ entry, ok: false });
    }
  });

  it('refuses a misspelled key, which would otherwise open the port to everyone', () => {
    expect(ports({ port: 443, form: ['173.245.48.0/20'] }).success).toBe(false);
  });
});
