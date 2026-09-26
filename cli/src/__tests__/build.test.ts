import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { assertBuildSupported } from '../commands/build';
import { BUILD_KEYS_READ, buildEnv, getBuildTargets, getOverridesForTarget, ignoredKeysOf } from '../services/build';
import type { BuildTarget } from '../services/build';
import { capabilityRefusal } from '../services/orchestrator/capabilities';
import { ErrorCode, UnsupportedOperationError } from '../utils/errors';
import * as output from '../utils/output';

const BASE = resolve('/project/.dockflow/docker');

// every warning the builder prints goes through these spies, so no test writes to stderr
let warnings: string[] = [];
let hints: string[] = [];

beforeEach(() => {
  warnings = [];
  hints = [];
  spyOn(output, 'printWarning').mockImplementation((message: string) => {
    warnings.push(message);
  });
  spyOn(output, 'printDim').mockImplementation((message: string) => {
    hints.push(message);
  });
});

afterEach(() => {
  mock.restore();
});

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

describe('build.key-ignored (design-01 IMG-09)', () => {
  const HINT_TARGET = '  Remove `build.target`, or build and push the image yourself and reference it with `image:`.';

  // getBuildTargets takes no orchestrator: it is the one entry of `dockflow build` and of the
  // deploy build on Swarm and k3s alike, so the warning cannot differ between them
  for (const orchestrator of ['swarm', 'k3s'] as const) {
    it(`warns once per ignored key with its compose path (${orchestrator})`, () => {
      assertBuildSupported({ orchestrator, options: {} });
      const targets = getBuildTargets('services:\n  web:\n    image: web:1\n    build:\n      context: .\n      target: prod\n', BASE);

      expect(targets.map((t) => t.tag)).toEqual(['web:1']);
      expect(warnings).toEqual([
        'docker-compose.yml services.web.build.target: build.target is ignored: the Dockflow builder only reads context, dockerfile and args',
      ]);
      expect(hints).toEqual([HINT_TARGET]);
    });
  }

  it('lists every ignored key in file order and never the keys the builder reads', () => {
    const yaml = `
services:
  web:
    image: web:1
    build:
      context: .
      dockerfile: Dockerfile.prod
      args: { A: "1" }
      platforms: [linux/arm64]
      cache_from: [web:cache]
      x-note: kept for tooling
`;
    getBuildTargets(yaml, BASE);

    expect(warnings.map((w) => w.split(':')[0])).toEqual([
      'docker-compose.yml services.web.build.platforms',
      'docker-compose.yml services.web.build.cache_from',
    ]);
    expect(hints).toHaveLength(2);
    expect(BUILD_KEYS_READ).toEqual(['context', 'dockerfile', 'args']);
  });

  it('warns only for the services selected with --only, and never for a string build', () => {
    const yaml = 'services:\n  a:\n    build:\n      context: .\n      target: x\n  b:\n    build: .\n  c:\n    build:\n      context: .\n      ssh: [default]\n';

    getBuildTargets(yaml, BASE, 'b,c');

    expect(warnings).toEqual([
      'docker-compose.yml services.c.build.ssh: build.ssh is ignored: the Dockflow builder only reads context, dockerfile and args',
    ]);
  });

  it('ignoredKeysOf reads mappings only', () => {
    expect(ignoredKeysOf('web', '.')).toEqual([]);
    expect(ignoredKeysOf('web', ['.'])).toEqual([]);
    expect(ignoredKeysOf('web', { context: '.', no_cache: true })).toEqual([{ service: 'web', key: 'no_cache' }]);
  });
});

describe('buildEnv', () => {
  it('leaves out the default provenance attestation of an image shipped to the nodes, whose id must follow its content', () => {
    expect(buildEnv({ noDefaultAttestations: true }, { PATH: '/bin' })).toEqual({ PATH: '/bin', BUILDX_NO_DEFAULT_ATTESTATIONS: '1' });
  });

  it('keeps the environment as it is for a registry push', () => {
    const env = { PATH: '/bin' };
    expect(buildEnv({ noDefaultAttestations: false }, env)).toBe(env);
    expect(buildEnv({}, env)).toBe(env);
  });
});

describe('remote build refusal (U-CMD-REFUSE-02)', () => {
  it('refuses options.remote_build on k3s with the remoteBuild capability refusal', () => {
    const refusal = capabilityRefusal('remoteBuild', 'options.remote_build');
    let caught: unknown = null;
    try {
      assertBuildSupported({ orchestrator: 'k3s', options: { remote_build: true } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnsupportedOperationError);
    const error = caught as UnsupportedOperationError;
    expect(error.code).toBe(ErrorCode.UNSUPPORTED_OPERATION);
    expect(error.message).toBe(refusal.message);
    expect(error.message).toBe(
      'options.remote_build is not supported with orchestrator: k3s: k3s nodes run containerd only and ship no image builder',
    );
    expect(error.suggestion).toBe(refusal.suggestion);
  });

  it('accepts remote builds on Swarm (the default orchestrator) and local builds everywhere', () => {
    expect(() => assertBuildSupported({ options: { remote_build: true } })).not.toThrow();
    expect(() => assertBuildSupported({ orchestrator: 'swarm', options: { remote_build: true } })).not.toThrow();
    expect(() => assertBuildSupported({ orchestrator: 'k3s', options: { remote_build: false } })).not.toThrow();
    expect(() => assertBuildSupported({ orchestrator: 'k3s' })).not.toThrow();
  });

  it('runs the check right after the config is read, before any render, hook or build', () => {
    const source = readFileSync(resolve(import.meta.dir, '../commands/build.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function runBuild'));
    const check = body.indexOf('assertBuildSupported(config)');

    expect(check).toBeGreaterThan(body.indexOf('loadConfig()'));
    for (const later of ['Compose.renderAndResolveCompose(', 'Hook.runHook(', 'Build.buildAll(']) {
      expect(check).toBeLessThan(body.indexOf(later));
    }
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

  it('re-keys rendered files when the context is the project root', () => {
    // `context: ../..` from .dockflow/docker resolves to the project root, so the paths
    // are already relative to the context and nothing has to be stripped.
    const target = makeTarget({
      context: projectRoot,
      dockerfile: 'Dockerfile.app',
      dockerfileAbsPath: resolve(projectRoot, '.dockflow/docker/Dockerfile.app'),
    });
    const rendered = new Map([
      ['src/environments/environment.ts', 'export const environment = {};'],
      ['.dockflow/docker/Dockerfile.app', 'FROM node'],
    ]);

    const overrides = getOverridesForTarget(rendered, target, projectRoot);

    expect(overrides.get('src/environments/environment.ts')).toBe('export const environment = {};');
  });

  it('still keys the Dockerfile under the name passed to -f at the project root', () => {
    const target = makeTarget({
      context: projectRoot,
      dockerfile: 'Dockerfile.app',
      dockerfileAbsPath: resolve(projectRoot, '.dockflow/docker/Dockerfile.app'),
    });
    const rendered = new Map([['.dockflow/docker/Dockerfile.app', 'FROM node']]);

    const overrides = getOverridesForTarget(rendered, target, projectRoot);

    expect(overrides.get('Dockerfile.app')).toBe('FROM node');
  });

  it('empty rendered map yields empty overrides', () => {
    expect(getOverridesForTarget(new Map(), makeTarget(), projectRoot).size).toBe(0);
  });
});
