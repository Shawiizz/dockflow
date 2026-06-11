import { describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { getBuildTargets, getOverridesForTarget } from '../services/build';
import type { BuildTarget } from '../services/build';

const BASE = resolve('/project/.dockflow/docker');

describe('getBuildTargets', () => {
  it('string build → context dir with default Dockerfile', () => {
    const targets = getBuildTargets('services:\n  app:\n    image: app:1\n    build: ../..\n', BASE);
    expect(targets).toHaveLength(1);
    expect(targets[0].dockerfile).toBe('Dockerfile');
    expect(targets[0].context).toBe(resolve(BASE, '../..'));
    // string form: Dockerfile is resolved relative to the context
    expect(targets[0].dockerfileAbsPath).toBe(resolve(BASE, '../..', 'Dockerfile'));
    expect(targets[0].tag).toBe('app:1');
  });

  it('object build → dockerfile resolved relative to basePath', () => {
    const yaml = `
services:
  app:
    image: app:1
    build:
      context: ../..
      dockerfile: docker/Dockerfile.prod
`;
    const targets = getBuildTargets(yaml, BASE);
    expect(targets[0].dockerfile).toBe('docker/Dockerfile.prod');
    expect(targets[0].context).toBe(resolve(BASE, '../..'));
    expect(targets[0].dockerfileAbsPath).toBe(resolve(BASE, 'docker/Dockerfile.prod'));
  });

  it('services without build section are skipped', () => {
    const yaml = 'services:\n  db:\n    image: postgres\n  app:\n    image: a\n    build: .\n';
    const targets = getBuildTargets(yaml, BASE);
    expect(targets.map(t => t.tag)).toEqual(['a']);
  });

  it('missing image falls back to name:latest', () => {
    const targets = getBuildTargets('services:\n  app:\n    build: .\n', BASE);
    expect(targets[0].tag).toBe('app:latest');
  });

  it('servicesFilter restricts targets', () => {
    const yaml = 'services:\n  a:\n    build: .\n  b:\n    build: .\n';
    const targets = getBuildTargets(yaml, BASE, 'b');
    expect(targets.map(t => t.tag)).toEqual(['b:latest']);
  });

  it('build args object format', () => {
    const yaml = `
services:
  app:
    build:
      context: .
      args:
        NODE_ENV: production
        PORT: 3000
`;
    const targets = getBuildTargets(yaml, BASE);
    expect(targets[0].args).toEqual({ NODE_ENV: 'production', PORT: '3000' });
  });

  it('build args array format KEY=value', () => {
    const yaml = `
services:
  app:
    build:
      context: .
      args:
        - NODE_ENV=production
        - "URL=http://x?a=b"
`;
    const targets = getBuildTargets(yaml, BASE);
    expect(targets[0].args).toEqual({ NODE_ENV: 'production', URL: 'http://x?a=b' });
  });

  it('empty compose yields no targets', () => {
    expect(getBuildTargets('services: {}\n', BASE)).toEqual([]);
  });
});

describe('getOverridesForTarget', () => {
  const projectRoot = resolve('/project');

  function makeTarget(overrides: Partial<BuildTarget> = {}): BuildTarget {
    return {
      dockerfile: 'Dockerfile',
      dockerfileAbsPath: resolve(projectRoot, 'app/Dockerfile'),
      context: resolve(projectRoot, 'app'),
      tag: 'app:1',
      ...overrides,
    };
  }

  it('re-keys rendered files inside the context relative to it', () => {
    const rendered = new Map([
      ['app/config.json', '{"env":"prod"}'],
      ['other/file.txt', 'outside'],
    ]);
    const overrides = getOverridesForTarget(rendered, makeTarget(), projectRoot);
    expect(overrides.get('config.json')).toBe('{"env":"prod"}');
    expect(overrides.has('other/file.txt')).toBe(false);
  });

  it('includes the rendered Dockerfile when it lives outside the context', () => {
    const target = makeTarget({
      dockerfile: 'docker/Dockerfile',
      dockerfileAbsPath: resolve(projectRoot, '.dockflow/docker/Dockerfile'),
    });
    const rendered = new Map([['.dockflow/docker/Dockerfile', 'FROM node']]);
    const overrides = getOverridesForTarget(rendered, target, projectRoot);
    expect(overrides.get('docker/Dockerfile')).toBe('FROM node');
  });

  it('Dockerfile inside the context is not duplicated', () => {
    const rendered = new Map([['app/Dockerfile', 'FROM node']]);
    const overrides = getOverridesForTarget(rendered, makeTarget(), projectRoot);
    // picked up via the context scan only, keyed relative to the context
    expect(overrides.get('Dockerfile')).toBe('FROM node');
    expect(overrides.size).toBe(1);
  });

  it('empty rendered map yields empty overrides', () => {
    expect(getOverridesForTarget(new Map(), makeTarget(), projectRoot).size).toBe(0);
  });
});
