import { describe, expect, it } from 'bun:test';
import { parseTagForDeployment, resolveDeployParams } from '../utils/ci';
import type { CIEnvironment } from '../utils/ci';

describe('parseTagForDeployment', () => {
  it('plain semver → production', () => {
    expect(parseTagForDeployment('1.0.0')).toEqual({ env: 'production', version: '1.0.0' });
  });

  it('strips leading v', () => {
    expect(parseTagForDeployment('v2.3.1')).toEqual({ env: 'production', version: '2.3.1' });
  });

  it('strips release/ prefix', () => {
    expect(parseTagForDeployment('release/1.0.0')).toEqual({ env: 'production', version: '1.0.0' });
  });

  it('env suffix → env name', () => {
    expect(parseTagForDeployment('1.0.0-staging')).toEqual({ env: 'staging', version: '1.0.0-staging' });
    expect(parseTagForDeployment('1.0.0-preview')).toEqual({ env: 'preview', version: '1.0.0-preview' });
  });

  it('rc/alpha/beta/dev → production (pre-release, not env)', () => {
    expect(parseTagForDeployment('1.0.0-rc1')).toEqual({ env: 'production', version: '1.0.0-rc1' });
    expect(parseTagForDeployment('1.0.0-alpha')).toEqual({ env: 'production', version: '1.0.0-alpha' });
    expect(parseTagForDeployment('1.0.0-beta2')).toEqual({ env: 'production', version: '1.0.0-beta2' });
    expect(parseTagForDeployment('1.0.0-dev')).toEqual({ env: 'production', version: '1.0.0-dev' });
  });

  it('hotfix/fix/patch/nightly/snapshot → production', () => {
    expect(parseTagForDeployment('1.0.0-hotfix1')).toEqual({ env: 'production', version: '1.0.0-hotfix1' });
    expect(parseTagForDeployment('1.0.0-fix')).toEqual({ env: 'production', version: '1.0.0-fix' });
    expect(parseTagForDeployment('1.0.0-patch3')).toEqual({ env: 'production', version: '1.0.0-patch3' });
    expect(parseTagForDeployment('1.0.0-nightly')).toEqual({ env: 'production', version: '1.0.0-nightly' });
    expect(parseTagForDeployment('1.0.0-snapshot')).toEqual({ env: 'production', version: '1.0.0-snapshot' });
  });

  it('pure numeric suffix → production', () => {
    expect(parseTagForDeployment('1.0.0-1')).toEqual({ env: 'production', version: '1.0.0-1' });
  });

  it('no dash → production', () => {
    expect(parseTagForDeployment('20240101')).toEqual({ env: 'production', version: '20240101' });
  });
});

describe('resolveDeployParams', () => {
  const base: CIEnvironment = {
    provider: 'github',
    isTag: false,
    tag: null,
    branch: 'main',
    commitSha: 'abc12345def67890',
    shortSha: 'abc12345',
  };

  it('tag → uses parseTagForDeployment', () => {
    const ci: CIEnvironment = { ...base, isTag: true, tag: '2.0.0-staging', branch: null };
    expect(resolveDeployParams(ci)).toEqual({ env: 'staging', version: '2.0.0-staging' });
  });

  it('branch → production with branch-sha version', () => {
    const result = resolveDeployParams(base);
    expect(result.env).toBe('production');
    expect(result.version).toBe('main-abc12345');
  });
});
