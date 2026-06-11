import { describe, expect, it } from 'bun:test';
import { parseDockerignore } from '../utils/dockerignore';

describe('parseDockerignore', () => {
  it('empty content includes everything except always-excluded', () => {
    const shouldInclude = parseDockerignore('');
    expect(shouldInclude('src/index.ts')).toBe(true);
    expect(shouldInclude('Dockerfile')).toBe(true);
  });

  it('.env.dockflow is always excluded, even with empty .dockerignore', () => {
    const shouldInclude = parseDockerignore('');
    expect(shouldInclude('.env.dockflow')).toBe(false);
    expect(shouldInclude('sub/dir/.env.dockflow')).toBe(false);
  });

  it('excludes plain directory patterns recursively', () => {
    const shouldInclude = parseDockerignore('node_modules\n');
    expect(shouldInclude('node_modules/lodash/index.js')).toBe(false);
    expect(shouldInclude('src/app.ts')).toBe(true);
  });

  it('supports glob patterns', () => {
    const shouldInclude = parseDockerignore('*.log\n');
    expect(shouldInclude('debug.log')).toBe(false);
    expect(shouldInclude('logs/app.log')).toBe(false);
    expect(shouldInclude('app.ts')).toBe(true);
  });

  it('supports negation patterns', () => {
    const shouldInclude = parseDockerignore('*.md\n!README.md\n');
    expect(shouldInclude('CHANGELOG.md')).toBe(false);
    expect(shouldInclude('README.md')).toBe(true);
  });

  it('ignores comment lines', () => {
    const shouldInclude = parseDockerignore('# comment\nbuild\n');
    expect(shouldInclude('build/out.js')).toBe(false);
    expect(shouldInclude('# comment')).toBe(true);
  });

  it('normalizes Windows backslash paths', () => {
    const shouldInclude = parseDockerignore('dist\n');
    expect(shouldInclude('dist\\bundle.js')).toBe(false);
  });
});
