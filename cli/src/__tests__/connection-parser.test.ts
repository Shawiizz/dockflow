import { describe, expect, it } from 'bun:test';
import {
  parseConnectionString,
  generateConnectionString,
  ConnectionParseErrorCode,
} from '../utils/connection-parser';
import { DEFAULT_SSH_PORT } from '../constants';

const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----';

function encode(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

describe('parseConnectionString', () => {
  it('parses a valid connection with all fields', () => {
    const result = parseConnectionString(encode({
      host: '10.0.0.1',
      port: 2222,
      user: 'deploy',
      privateKey: FAKE_KEY,
      password: 'sudo-pass',
    }));
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.host).toBe('10.0.0.1');
    expect(result.data.port).toBe(2222);
    expect(result.data.user).toBe('deploy');
    expect(result.data.password).toBe('sudo-pass');
    expect(result.data.privateKey.endsWith('\n')).toBe(true); // normalized
  });

  it('defaults port to 22 when missing', () => {
    const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: FAKE_KEY }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.port).toBe(DEFAULT_SSH_PORT);
  });

  it('accepts string port', () => {
    const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: FAKE_KEY, port: '2200' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.port).toBe(2200);
  });

  it('rejects out-of-range or non-numeric port', () => {
    for (const port of [0, 65536, 'abc']) {
      const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: FAKE_KEY, port }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe(ConnectionParseErrorCode.INVALID_PORT);
    }
  });

  it('rejects missing host / user / privateKey', () => {
    for (const data of [
      { user: 'u', privateKey: FAKE_KEY },
      { host: 'h', privateKey: FAKE_KEY },
      { host: 'h', user: 'u' },
      { host: '', user: 'u', privateKey: FAKE_KEY },
    ]) {
      const result = parseConnectionString(encode(data));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe(ConnectionParseErrorCode.MISSING_REQUIRED_FIELD);
    }
  });

  it('rejects garbage input as invalid JSON', () => {
    const result = parseConnectionString('zzzz');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ConnectionParseErrorCode.INVALID_JSON);
  });

  it('rejects a privateKey without PEM markers', () => {
    const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: 'not-a-key' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ConnectionParseErrorCode.INVALID_PRIVATE_KEY);
  });

  it('normalizes escaped newlines in the private key', () => {
    const escaped = '-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----';
    const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: escaped }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.privateKey).toContain('\n');
      expect(result.data.privateKey).not.toContain('\\n');
    }
  });

  it('empty password is omitted', () => {
    const result = parseConnectionString(encode({ host: 'h', user: 'u', privateKey: FAKE_KEY, password: '' }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.password).toBeUndefined();
  });
});

describe('generateConnectionString', () => {
  it('round-trips through parseConnectionString', () => {
    const conn = { host: 'srv', port: 2222, user: 'root', privateKey: FAKE_KEY + '\n', password: 'pw' };
    const result = parseConnectionString(generateConnectionString(conn));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.host).toBe('srv');
      expect(result.data.port).toBe(2222);
      expect(result.data.user).toBe('root');
      expect(result.data.password).toBe('pw');
    }
  });
});
