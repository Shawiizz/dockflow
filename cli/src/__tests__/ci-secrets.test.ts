import { afterEach, describe, expect, it } from 'bun:test';
import {
  serverNameToEnvKey,
  getCISecret,
  getServerPrivateKey,
  mergeEnvVars,
} from '../utils/servers/ci-secrets';
import { generateConnectionString } from '../utils/connection-parser';
import type { ServersConfig } from '../types';

const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';

// Track every env var the tests set so cleanup is exhaustive.
const touched: string[] = [];
function setEnv(key: string, value: string): void {
  process.env[key] = value;
  touched.push(key);
}

afterEach(() => {
  for (const key of touched) delete process.env[key];
  touched.length = 0;
});

describe('serverNameToEnvKey', () => {
  it('uppercases server names', () => {
    expect(serverNameToEnvKey('main_server')).toBe('MAIN_SERVER');
    expect(serverNameToEnvKey('web1')).toBe('WEB1');
  });
});

describe('getCISecret', () => {
  it('server-specific secret takes priority over global', () => {
    setEnv('STAGING_MAIN_TOKEN', 'server-level');
    setEnv('STAGING_TOKEN', 'env-level');
    expect(getCISecret('staging', 'main', 'TOKEN')).toBe('server-level');
  });

  it('falls back to global secret when server-specific missing', () => {
    setEnv('STAGING_TOKEN', 'env-level');
    expect(getCISecret('staging', 'main', 'TOKEN')).toBe('env-level');
  });

  it('empty server-specific value falls back to global', () => {
    setEnv('STAGING_MAIN_TOKEN', '');
    setEnv('STAGING_TOKEN', 'env-level');
    expect(getCISecret('staging', 'main', 'TOKEN')).toBe('env-level');
  });

  it('no serverName skips server-specific lookup', () => {
    setEnv('STAGING_TOKEN', 'env-level');
    expect(getCISecret('staging', null, 'TOKEN')).toBe('env-level');
  });

  it('returns undefined when nothing is set', () => {
    expect(getCISecret('staging', 'main', 'NOPE_XYZ')).toBeUndefined();
  });
});

describe('getServerPrivateKey', () => {
  it('extracts key from CONNECTION string', () => {
    setEnv('PROD_WEB_CONNECTION', generateConnectionString({
      host: 'h', port: 22, user: 'u', privateKey: FAKE_KEY,
    }));
    expect(getServerPrivateKey('prod', 'web')).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
  });

  it('falls back to SSH_PRIVATE_KEY secret', () => {
    setEnv('PROD_WEB_SSH_PRIVATE_KEY', FAKE_KEY);
    expect(getServerPrivateKey('prod', 'web')).toBe(FAKE_KEY);
  });

  it('invalid CONNECTION string falls back to SSH_PRIVATE_KEY', () => {
    setEnv('PROD_WEB_CONNECTION', 'not-valid-base64-json');
    setEnv('PROD_WEB_SSH_PRIVATE_KEY', FAKE_KEY);
    expect(getServerPrivateKey('prod', 'web')).toBe(FAKE_KEY);
  });
});

describe('mergeEnvVars', () => {
  const emptyConfig = {} as ServersConfig;

  it('priority: all < tag < server.env < CI global < CI server-specific', () => {
    const config = {
      env: {
        all: { SHARED: 'from-all', ONLY_ALL: 'all' },
        production: { SHARED: 'from-tag' },
      },
    } as unknown as ServersConfig;

    const result = mergeEnvVars(config, 'production', 'main', { SHARED: 'from-server' });
    expect(result.SHARED).toBe('from-server');
    expect(result.ONLY_ALL).toBe('all');
  });

  it('CI env vars override config values', () => {
    setEnv('PRODUCTION_SHARED', 'from-ci');
    const config = { env: { all: { SHARED: 'from-all' } } } as unknown as ServersConfig;
    const result = mergeEnvVars(config, 'production', 'main', undefined);
    expect(result.SHARED).toBe('from-ci');
  });

  it('CI server-specific var is picked up without the server prefix in the name', () => {
    setEnv('PRODUCTION_MAIN_DB_URL', 'postgres://x');
    const result = mergeEnvVars(emptyConfig, 'production', 'main', undefined);
    expect(result.DB_URL).toBe('postgres://x');
  });

  it('connection-related vars are never merged into app env', () => {
    setEnv('PRODUCTION_CONNECTION', 'xxx');
    setEnv('PRODUCTION_HOST', 'xxx');
    setEnv('PRODUCTION_SSH_PRIVATE_KEY', 'xxx');
    setEnv('PRODUCTION_MAIN_PASSWORD', 'xxx');
    const result = mergeEnvVars(emptyConfig, 'production', 'main', undefined);
    expect(result.CONNECTION).toBeUndefined();
    expect(result.HOST).toBeUndefined();
    expect(result.SSH_PRIVATE_KEY).toBeUndefined();
    expect(result.PASSWORD).toBeUndefined();
  });

  it('vars from a different environment are ignored', () => {
    setEnv('STAGING_FOO', 'staging-only');
    const result = mergeEnvVars(emptyConfig, 'production', 'main', undefined);
    expect(result.FOO).toBeUndefined();
  });
});
