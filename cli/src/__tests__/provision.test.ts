import { describe, expect, it } from 'bun:test';
import { buildPortainerVhost, parseHtpasswdHash } from '../commands/setup/provision';

describe('buildPortainerVhost', () => {
  it('proxies the domain to the local portainer port', () => {
    const vhost = buildPortainerVhost('portainer.example.com', 9100);
    expect(vhost).toContain('listen 80;');
    expect(vhost).toContain('server_name portainer.example.com;');
    expect(vhost).toContain('proxy_pass http://127.0.0.1:9100;');
    expect(vhost).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
  });
});

describe('parseHtpasswdHash', () => {
  it('extracts the bcrypt hash from htpasswd output', () => {
    const out = 'admin:$2y$05$abcdefghijklmnopqrstuv\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$abcdefghijklmnopqrstuv');
  });

  it('tolerates leading noise lines (docker pull output)', () => {
    const out = 'Unable to find image locally\nadmin:$2y$05$hash\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$hash');
  });

  it('skips noise lines that contain colons', () => {
    const out = 'Status: Downloaded newer image\nadmin:$2y$05$hash\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$hash');
  });

  it('returns null for non-credential output', () => {
    expect(parseHtpasswdHash('')).toBeNull();
    expect(parseHtpasswdHash('some error')).toBeNull();
    expect(parseHtpasswdHash('warning: something:else\n')).toBeNull();
  });
});
