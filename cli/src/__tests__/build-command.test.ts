import { describe, expect, it, spyOn } from 'bun:test';
import { runBuild } from '../commands/build';
import * as Build from '../services/build';
import * as Compose from '../services/compose';
import * as Distribution from '../services/distribution';
import * as Plugin from '../services/plugin';
import * as config_ from '../utils/config';
import * as output from '../utils/output';
import * as secrets from '../utils/secrets';
import * as servers from '../utils/servers';
import * as validation from '../utils/validation';

describe('runBuild', () => {
  it('has nothing to build for a project that deploys files only', async () => {
    // a flat project whose config file exists, independent of the repository's own files
    const layout = spyOn(config_, 'getLayout').mockReturnValue({ type: 'flat', configPath: import.meta.path, root: '.' } as never);
    const load = spyOn(config_, 'loadConfig').mockReturnValue({ project_name: 'docs', no_services: true } as never);
    const info = spyOn(output, 'printInfo').mockImplementation(() => {});
    const targets = spyOn(Build, 'getBuildTargets');
    try {
      await runBuild('production', {});

      expect(info).toHaveBeenCalledWith('This project deploys files only (no_services): there is nothing to build.');
      expect(targets).not.toHaveBeenCalled();
    } finally {
      layout.mockRestore();
      load.mockRestore();
      info.mockRestore();
      targets.mockRestore();
    }
  });
});

describe('runBuild: the container engine', () => {
  async function build(containerEngine: 'docker' | 'podman' | undefined) {
    const calls = { targets: [] as Build.BuildTarget[], loginEngine: 'unset' as unknown, pushEngine: 'unset' as unknown };
    const config = {
      project_name: 'shop',
      container_engine: containerEngine,
      registry: { enabled: true, url: 'registry.example.com', username: 'ci' },
    };
    const spies = [
      spyOn(config_, 'getLayout').mockReturnValue({ type: 'flat', configPath: import.meta.path, root: '.' } as never),
      spyOn(config_, 'loadConfig').mockReturnValue(config as never),
      spyOn(secrets, 'loadSecrets').mockImplementation(() => {}),
      spyOn(validation, 'resolveEnvironmentPrefix').mockImplementation((env: string) => env),
      spyOn(servers, 'getManagersForEnvironment').mockReturnValue([]),
      spyOn(Compose, 'renderAndResolveCompose').mockReturnValue({ rendered: new Map(), composeContent: '', composeDirPath: '.', projectRoot: '.', renderContext: {} } as never),
      spyOn(Plugin, 'loadConfigWithPlugins').mockResolvedValue({ config } as never),
      spyOn(Compose, 'usesRegistry').mockReturnValue(true),
      spyOn(Compose, 'registryPassword').mockReturnValue('secret'),
      spyOn(Build, 'getBuildTargets').mockReturnValue([{ tag: 'shop-web:build' } as never]),
      spyOn(Build, 'getOverridesForTarget').mockReturnValue(undefined as never),
      spyOn(Build, 'buildAll').mockImplementation(async (targets) => {
        calls.targets = targets;
        return { images: ['shop-web:build'], durationMs: 1 };
      }),
      spyOn(Distribution, 'registryLoginLocal').mockImplementation(async (_login, engine) => {
        calls.loginEngine = engine;
      }),
      spyOn(Distribution, 'pushImages').mockImplementation(async (_images, _tags, engine) => {
        calls.pushEngine = engine;
      }),
      spyOn(output, 'printInfo').mockImplementation(() => {}),
      spyOn(output, 'printWarning').mockImplementation(() => {}),
      spyOn(output, 'printIntro').mockImplementation(() => {}),
      spyOn(output, 'printDim').mockImplementation(() => {}),
      spyOn(output, 'printBlank').mockImplementation(() => {}),
      spyOn(output, 'printSuccess').mockImplementation(() => {}),
    ];
    try {
      await runBuild('production', { push: true, skipHooks: true, branch: 'main' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return calls;
  }

  it('builds and pushes with the configured engine', async () => {
    const calls = await build('podman');

    expect(calls.targets[0].engine).toBe('podman');
    expect(calls.loginEngine).toBe('podman');
    expect(calls.pushEngine).toBe('podman');
  });

  it('leaves docker to the builders when none is configured: the command never connects to a server to detect one', async () => {
    const calls = await build(undefined);

    expect(calls.targets[0].engine).toBeUndefined();
    expect(calls.loginEngine).toBeUndefined();
    expect(calls.pushEngine).toBeUndefined();
  });
});
