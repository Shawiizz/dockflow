import { describe, expect, it } from 'bun:test';
import { isLoopbackHostname, isSameOriginRequest } from '../api/origin';
import { isValidDockerName } from '../api/routes/_helpers';

const request = (headers: Record<string, string>) => new Request('http://localhost/api/x', { headers });

describe('isLoopbackHostname', () => {
  it('accepts loopback hostnames', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isLoopbackHostname('evil.com')).toBe(false);
    expect(isLoopbackHostname('localhost.attacker.com')).toBe(false);
    expect(isLoopbackHostname('0.0.0.0')).toBe(false);
    expect(isLoopbackHostname('192.168.1.10')).toBe(false);
  });
});

describe('isSameOriginRequest', () => {
  it('allows same-origin browser requests', () => {
    expect(isSameOriginRequest(request({ host: 'localhost:4200', origin: 'http://localhost:4200' }))).toBe(true);
    expect(isSameOriginRequest(request({ host: '127.0.0.1:4200', origin: 'http://127.0.0.1:4200' }))).toBe(true);
  });

  it('allows non-browser clients that send no Origin', () => {
    expect(isSameOriginRequest(request({ host: 'localhost:4200' }))).toBe(true);
  });

  it('rejects cross-origin requests (CSRF / WebSocket hijack)', () => {
    expect(isSameOriginRequest(request({ host: 'localhost:4200', origin: 'https://evil.com' }))).toBe(false);
    expect(isSameOriginRequest(request({ host: 'localhost:4200', origin: 'http://evil.localhost.attacker.com' }))).toBe(false);
  });

  it('rejects non-loopback Host (DNS rebinding)', () => {
    expect(isSameOriginRequest(request({ host: 'attacker.com', origin: 'http://localhost:4200' }))).toBe(false);
  });

  it('rejects a malformed Origin', () => {
    expect(isSameOriginRequest(request({ host: 'localhost:4200', origin: 'not a url' }))).toBe(false);
  });
});

describe('isValidDockerName', () => {
  it('accepts valid docker resource names', () => {
    expect(isValidDockerName('myapp_web')).toBe(true);
    expect(isValidDockerName('web-1.2')).toBe(true);
    expect(isValidDockerName('a')).toBe(true);
  });

  it('rejects names with shell metacharacters', () => {
    expect(isValidDockerName('web; rm -rf /')).toBe(false);
    expect(isValidDockerName('a b')).toBe(false);
    expect(isValidDockerName('$(whoami)')).toBe(false);
    expect(isValidDockerName('a`b`')).toBe(false);
    expect(isValidDockerName('a&&b')).toBe(false);
  });

  it('rejects empty, over-long, and non-alphanumeric-leading names', () => {
    expect(isValidDockerName('')).toBe(false);
    expect(isValidDockerName('-start')).toBe(false);
    expect(isValidDockerName('.start')).toBe(false);
    expect(isValidDockerName('a'.repeat(257))).toBe(false);
  });
});
