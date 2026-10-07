import { describe, expect, it } from 'bun:test';
import { isIpOrCidr, ProxyConfigSchema } from '../schemas/config.schema';

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
});
