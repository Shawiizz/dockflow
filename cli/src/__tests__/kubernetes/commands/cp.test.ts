// `dockflow cp` (design-06 10.4 `commands/cp.test.ts`): both directions call the right backend
// method with the planned paths, and the destination probe classifies directory/file/missing.
// Real local temp files are used for the local side (no `mock.module`, as the Kubernetes suite
// never uses it); the container side is a `FakeOrchestrator`.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, type Readable } from 'stream';
import tar from 'tar-stream';
import { runCp } from '../../../commands/app/cp';
import { __setOrchestratorOpenerForTests } from '../../../commands/shared/day2';
import { ContainerPathError, NO_TAR_SUGGESTION, noTarError, probeContainerPath } from '../../../services/orchestrator/copy';
import type { ServiceInfo } from '../../../services/orchestrator/interfaces';
import type { DockflowConfig } from '../../../utils/config';
import * as output from '../../../utils/output';
import { FakeOrchestrator } from '../fakes/fake-orchestrator';

function baseConfig(): DockflowConfig {
  return { project_name: 'shop' };
}

function service(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    name: 'web',
    nativeName: 'web',
    kind: 'service',
    role: 'app',
    mode: 'replicated',
    image: 'shop/web:1.0',
    replicas: { running: 1, desired: 1 },
    ports: [],
    state: 'running',
    ...overrides,
  };
}

function open(orchestrator: FakeOrchestrator): void {
  __setOrchestratorOpenerForTests(async () => ({ config: baseConfig(), orchestrator }));
}

// A backend's copyOut always hands back a plain Node byte stream (an SSH channel's stdout, or a
// PassThrough wrapping one), never the tar-stream Pack object itself; `firstEntryType` relies on
// Node stream methods (`unpipe`) a Pack does not implement, so tests pipe through a real PassThrough.
function toByteStream(pack: tar.Pack): Readable {
  const bytes = new PassThrough();
  pack.pipe(bytes);
  return bytes;
}

function tarOfFile(name: string, content: string): Readable {
  const pack = tar.pack();
  pack.entry({ name }, content);
  pack.finalize();
  return toByteStream(pack);
}

function tarOfDirectory(): Readable {
  const pack = tar.pack();
  pack.entry({ name: '.', type: 'directory' });
  pack.finalize();
  return toByteStream(pack);
}

/** drains an archive fully, the way a real backend's `copyIn` does before resolving */
async function drainCopyIn(archive: Readable): Promise<void> {
  for await (const _chunk of archive) {
    // read to completion so the local file read behind it finishes before the test tears down
  }
}

let tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dockflow-cp-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  __setOrchestratorOpenerForTests(null);
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('cp out (container -> local)', () => {
  it('extracts the archive into an existing local directory', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', () => tarOfFile('app.log', 'hello world'));
    open(orchestrator);

    const destDir = makeTmpDir();
    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    try {
      await runCp('production', 'web:/app/logs/app.log', destDir, {});
    } finally {
      success.mockRestore();
    }

    const calls = orchestrator.callsTo('containers.copyOut');
    expect(calls.length).toBe(1);
    expect(calls[0][2]).toBe('/app/logs/app.log');
    expect(readFileSync(join(destDir, 'app.log'), 'utf8')).toBe('hello world');
  });

  it('renames the top entry when the local destination names a new file', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', () => tarOfFile('app.log', 'renamed'));
    open(orchestrator);

    const destDir = makeTmpDir();
    const destFile = join(destDir, 'copy.log');
    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    try {
      await runCp('production', 'web:/app/logs/app.log', destFile, {});
    } finally {
      success.mockRestore();
    }

    expect(readFileSync(destFile, 'utf8')).toBe('renamed');
  });
});

describe('cp in (local -> container)', () => {
  it('probes the missing destination and copies into its parent directory', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', (_ref, _target, path) => {
      if (path === '/app/config.json') throw new ContainerPathError('Path /app/config.json does not exist in web', 'not-found');
      if (path === '/app') return tarOfDirectory();
      throw new Error(`unexpected probe path ${String(path)}`);
    });
    orchestrator.program('containers.copyIn', (_ref, _target, _destDir, archive) => drainCopyIn(archive));
    open(orchestrator);

    const localDir = makeTmpDir();
    const localFile = join(localDir, 'config.json');
    await Bun.write(localFile, '{"ok":true}');

    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    try {
      await runCp('production', localFile, 'web:/app/config.json', {});
    } finally {
      success.mockRestore();
    }

    const copyInCalls = orchestrator.callsTo('containers.copyIn');
    expect(copyInCalls.length).toBe(1);
    expect(copyInCalls[0][2]).toBe('/app');
  });

  it('targets the accessories role with --accessories', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service({ role: 'accessory' })]);
    orchestrator.program('containers.copyOut', () => tarOfDirectory());
    orchestrator.program('containers.copyIn', (_ref, _target, _destDir, archive) => drainCopyIn(archive));
    open(orchestrator);

    const localDir = makeTmpDir();
    const localFile = join(localDir, 'dump.sql');
    await Bun.write(localFile, 'SELECT 1;');

    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    try {
      await runCp('production', localFile, 'web:/backups', { accessories: true });
    } finally {
      success.mockRestore();
    }

    const getServicesCalls = orchestrator.callsTo('stack.getServices');
    expect(getServicesCalls[0][0]).toMatchObject({ role: 'accessory' });
  });
});

describe('SRC/. copies the directory\'s contents, not the directory (design-06 3.3)', () => {
  it('extracts entries directly into the local destination, skipping the top-entry rename', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', (_ref, _target, path) => {
      expect(path).toBe('/app/data/.');
      const pack = tar.pack();
      pack.entry({ name: 'sub/app.log' }, 'inner');
      pack.finalize();
      return toByteStream(pack);
    });
    open(orchestrator);

    const destDir = makeTmpDir();
    const success = spyOn(output, 'printSuccess').mockImplementation(() => {});
    try {
      await runCp('production', 'web:/app/data/.', destDir, {});
    } finally {
      success.mockRestore();
    }

    const calls = orchestrator.callsTo('containers.copyOut');
    expect(calls[0][2]).toBe('/app/data/.');
    expect(readFileSync(join(destDir, 'sub', 'app.log'), 'utf8')).toBe('inner');
  });

  it('refuses a destination ending with /.', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    open(orchestrator);

    await expect(runCp('production', 'web:/app/data', './out/.', {})).rejects.toThrow('A destination must not end with /.');
  });

  it('refuses a non-directory local source ending with /.', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    open(orchestrator);

    const localDir = makeTmpDir();
    const localFile = join(localDir, 'dump.sql');
    await Bun.write(localFile, 'SELECT 1;');

    await expect(runCp('production', `${localFile}/.`, 'web:/app/backup', {})).rejects.toThrow('ends with /. but is not a directory');
  });
});

describe('cp in an image without tar (R-19)', () => {
  it('propagates the ContainerPathError the backend raises when tar is missing', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', noTarError('web'));
    open(orchestrator);

    const destDir = makeTmpDir();
    let caught: unknown;
    try {
      await runCp('production', 'web:/app/logs/app.log', destDir, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ContainerPathError);
    expect((caught as ContainerPathError).reason).toBe('no-tar');
    expect((caught as ContainerPathError).message).toBe('Copying files requires tar in the container image of web');
    expect((caught as ContainerPathError).suggestion).toBe(NO_TAR_SUGGESTION);
  });

  it('propagates the same error on the local -> container direction (the destination probe uses copyOut too)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    orchestrator.program('stack.getServices', [service()]);
    orchestrator.program('containers.copyOut', noTarError('web'));
    open(orchestrator);

    const localDir = makeTmpDir();
    const localFile = join(localDir, 'dump.sql');
    await Bun.write(localFile, 'SELECT 1;');

    await expect(runCp('production', localFile, 'web:/app/dump.sql', {})).rejects.toBeInstanceOf(ContainerPathError);
  });
});

describe('probeContainerPath', () => {
  it('reports directory, file and missing (with parentExists)', async () => {
    const open2 = async (path: string): Promise<Readable> => {
      if (path === '/app') return tarOfDirectory();
      if (path === '/app/config.json') return tarOfFile('config.json', '{}');
      if (path === '/app/missing.txt') throw new ContainerPathError('not found', 'not-found');
      throw new Error(`unexpected path ${path}`);
    };

    await expect(probeContainerPath(open2, 'web', '/app')).resolves.toMatchObject({ type: 'directory' });
    await expect(probeContainerPath(open2, 'web', '/app/config.json')).resolves.toMatchObject({ type: 'file' });
    await expect(probeContainerPath(open2, 'web', '/app/missing.txt')).resolves.toMatchObject({ type: 'missing', parentExists: true });
  });
});
