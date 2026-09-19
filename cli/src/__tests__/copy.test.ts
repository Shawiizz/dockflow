// design-06 3.3 and 10.1 (`copy.test.ts`): `dockflow cp` argument parsing, the docker cp rules of both
// directions including the `SRC/.` contents form, the destination probe and ContainerPathError.

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import {
  type ContainerEndpoint,
  ContainerPathError,
  containerTarArgs,
  NO_TAR_SUGGESTION,
  noTarError,
  parseCopyArguments,
  parseCopyEndpoint,
  planCopyIn,
  planCopyOut,
  probeContainerPath,
  remoteSourcePath,
} from '../services/orchestrator/copy';
import { CLIError, ErrorCode, ValidationError } from '../utils/errors';

function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a throw');
}

function container(path: string, contents = false): ContainerEndpoint {
  return { kind: 'container', service: 'web', path, contents };
}

describe('parseCopyEndpoint', () => {
  it('reads <service>:<absolute path> as a container endpoint', () => {
    expect(parseCopyEndpoint('web:/app', 'linux')).toEqual({ kind: 'container', service: 'web', path: '/app', contents: false });
    expect(parseCopyEndpoint('web_1:/x', 'linux')).toEqual({ kind: 'container', service: 'web_1', path: '/x', contents: false });
    expect(parseCopyEndpoint('db.primary:/var/lib/data', 'darwin')).toMatchObject({ kind: 'container', service: 'db.primary' });
  });

  it('reads <release>/<workload>:<path> into service and workload', () => {
    expect(parseCopyEndpoint('search/search-api:/data', 'linux')).toEqual({
      kind: 'container',
      service: 'search',
      workload: 'search-api',
      path: '/data',
      contents: false,
    });
  });

  it('keeps relative, absolute and drive paths local', () => {
    expect(parseCopyEndpoint('./local', 'linux')).toEqual({ kind: 'local', path: './local', contents: false });
    expect(parseCopyEndpoint('/abs/local', 'linux')).toEqual({ kind: 'local', path: '/abs/local', contents: false });
    expect(parseCopyEndpoint('C:\\data', 'win32')).toEqual({ kind: 'local', path: 'C:\\data', contents: false });
    expect(parseCopyEndpoint('C:/data', 'win32')).toEqual({ kind: 'local', path: 'C:/data', contents: false });
  });

  it('reads a one-letter prefix as a service everywhere but Windows', () => {
    expect(parseCopyEndpoint('c:/data', 'linux')).toEqual({ kind: 'container', service: 'c', path: '/data', contents: false });
  });

  it('refuses a relative container path', () => {
    const error = thrown(() => parseCopyEndpoint('web:relative', 'linux'));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Container paths must be absolute: web:relative');
  });

  it('strips a trailing /. and sets contents', () => {
    expect(parseCopyEndpoint('web:/app/logs/.', 'linux')).toEqual({ kind: 'container', service: 'web', path: '/app/logs', contents: true });
    expect(parseCopyEndpoint('web:/.', 'linux')).toEqual({ kind: 'container', service: 'web', path: '/', contents: true });
    expect(parseCopyEndpoint('./conf/.', 'linux')).toEqual({ kind: 'local', path: './conf', contents: true });
    expect(parseCopyEndpoint('C:\\conf\\.', 'win32')).toEqual({ kind: 'local', path: 'C:\\conf', contents: true });
    expect(parseCopyEndpoint('./conf\\.', 'linux')).toEqual({ kind: 'local', path: './conf\\.', contents: false });
  });
});

describe('parseCopyArguments', () => {
  it('needs exactly one container side', () => {
    for (const [src, dest] of [
      ['web:/a', 'db:/b'],
      ['./a', './b'],
    ]) {
      const error = thrown(() => parseCopyArguments(src, dest, 'linux'));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.message).toBe(`Exactly one of ${src} and ${dest} must be <service>:<path>`);
      expect((error as CLIError).suggestion).toBe('For example: `dockflow cp production web:/app/logs ./logs`.');
    }
  });

  it('gives the direction', () => {
    expect(parseCopyArguments('web:/app/logs', './logs', 'linux')).toMatchObject({ direction: 'out', source: { service: 'web' }, destination: { path: './logs' } });
    expect(parseCopyArguments('./conf', 'web:/etc/app', 'linux')).toMatchObject({ direction: 'in', source: { path: './conf' }, destination: { path: '/etc/app' } });
    expect(parseCopyArguments('search/search-api:/data', './data', 'linux')).toMatchObject({ source: { service: 'search', workload: 'search-api' } });
  });

  it('refuses a destination ending with /. (m10)', () => {
    const remote = thrown(() => parseCopyArguments('./conf', 'web:/etc/app/.', 'linux')) as CLIError;
    expect(remote).toBeInstanceOf(ValidationError);
    expect(remote.message).toBe('A destination must not end with /.');
    expect(remote.suggestion).toBe('Use `web:/etc/app` for the directory itself.');
    const local = thrown(() => parseCopyArguments('web:/app/logs', './out/.', 'linux')) as CLIError;
    expect(local.suggestion).toBe('Use `./out` for the directory itself.');
  });
});

describe('container tar arguments', () => {
  it('archives the last component from its parent, or the entries for /. and the root', () => {
    expect(containerTarArgs('/app/logs')).toEqual(['-C', '/app', 'logs']);
    expect(containerTarArgs('/app/logs/')).toEqual(['-C', '/app', 'logs']);
    expect(containerTarArgs('/file.txt')).toEqual(['-C', '/', 'file.txt']);
    expect(containerTarArgs('/app/logs/.')).toEqual(['-C', '/app/logs', '.']);
    expect(containerTarArgs('/.')).toEqual(['-C', '/', '.']);
    expect(containerTarArgs('/')).toEqual(['-C', '/', '.']);
  });

  it('appends /. to the path copyOut receives for the contents form', () => {
    expect(remoteSourcePath({ path: '/app/logs', contents: false })).toBe('/app/logs');
    expect(remoteSourcePath({ path: '/app/logs', contents: true })).toBe('/app/logs/.');
    expect(remoteSourcePath({ path: '/', contents: true })).toBe('/.');
  });
});

describe('planCopyOut (container -> local)', () => {
  const out = join('work', 'out');

  it('extracts into an existing directory', () => {
    expect(planCopyOut(container('/app/logs'), { path: out, exists: true, isDirectory: true })).toEqual({
      remotePath: '/app/logs',
      extractDir: out,
      renameTopEntry: null,
      tarArgs: ['-C', '/app', 'logs'],
    });
  });

  it('copies a file or a directory to a new name next to it', () => {
    const plan = planCopyOut(container('/app/report.txt'), { path: join('work', 'copy.txt'), exists: false, isDirectory: false, parentExists: true });
    expect(plan).toEqual({ remotePath: '/app/report.txt', extractDir: 'work', renameTopEntry: 'copy.txt', tarArgs: ['-C', '/app', 'report.txt'] });
    expect(planCopyOut(container('/app/logs'), { path: join('work', 'logs-copy'), exists: false, isDirectory: false })).toMatchObject({
      extractDir: 'work',
      renameTopEntry: 'logs-copy',
    });
  });

  it('overwrites an existing file through the same rename (a directory source is refused by extractTar)', () => {
    expect(planCopyOut(container('/app/app.yml'), { path: join('work', 'app.yml'), exists: true, isDirectory: false })).toMatchObject({
      extractDir: 'work',
      renameTopEntry: 'app.yml',
    });
  });

  it('refuses a missing local parent', () => {
    const error = thrown(() => planCopyOut(container('/app/logs'), { path: join('nope', 'logs'), exists: false, isDirectory: false, parentExists: false }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Parent directory nope does not exist');
  });

  it('copies the entries of a directory into an existing directory for SRC/.', () => {
    expect(planCopyOut(container('/app/logs', true), { path: out, exists: true, isDirectory: true })).toEqual({
      remotePath: '/app/logs/.',
      extractDir: out,
      renameTopEntry: null,
      tarArgs: ['-C', '/app/logs', '.'],
    });
    const missing = thrown(() => planCopyOut(container('/app/logs', true), { path: out, exists: false, isDirectory: false, parentExists: true }));
    expect(missing.message).toBe(`${out} must be an existing directory to receive the contents of /app/logs`);
    const file = thrown(() => planCopyOut(container('/app/logs', true), { path: out, exists: true, isDirectory: false }));
    expect(file.message).toBe(`Cannot copy a directory onto the file ${out}`);
  });
});

describe('planCopyIn (local -> container)', () => {
  const conf = join('src', 'conf');

  it('puts a directory or a file into an existing directory under its own name', () => {
    expect(planCopyIn({ path: conf, isDirectory: true, contents: false }, { service: 'web', path: '/etc/app', type: 'directory' })).toEqual({
      destDir: '/etc/app',
      entryName: 'conf',
    });
  });

  it('copies to a new name next to a missing destination', () => {
    expect(
      planCopyIn({ path: join('src', 'app.yml'), isDirectory: false, contents: false }, { service: 'web', path: '/etc/app/new.yml', type: 'missing', parentExists: true }),
    ).toEqual({ destDir: '/etc/app', entryName: 'new.yml' });
    expect(planCopyIn({ path: conf, isDirectory: true, contents: false }, { service: 'web', path: '/etc/conf2', type: 'missing' })).toEqual({
      destDir: '/etc',
      entryName: 'conf2',
    });
  });

  it('overwrites a file with a file and refuses a directory onto a file', () => {
    expect(
      planCopyIn({ path: join('src', 'app.yml'), isDirectory: false, contents: false }, { service: 'web', path: '/etc/app/app.yml', type: 'file' }),
    ).toEqual({ destDir: '/etc/app', entryName: 'app.yml' });
    const error = thrown(() => planCopyIn({ path: conf, isDirectory: true, contents: false }, { service: 'web', path: '/etc/app/app.yml', type: 'file' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Cannot copy a directory onto the file /etc/app/app.yml');
  });

  it('refuses a destination whose parent does not exist in the container', () => {
    const error = thrown(() => planCopyIn({ path: conf, isDirectory: true, contents: false }, { service: 'web', path: '/nope/conf', type: 'missing', parentExists: false }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Parent directory /nope does not exist in web');
  });

  it('copies the entries of a local directory for SRC/., into an existing directory only', () => {
    expect(planCopyIn({ path: conf, isDirectory: true, contents: true }, { service: 'web', path: '/etc/app', type: 'directory' })).toEqual({
      destDir: '/etc/app',
      entryName: null,
    });
    const notDirectory = thrown(() => planCopyIn({ path: join('src', 'app.yml'), isDirectory: false, contents: true }, { service: 'web', path: '/etc/app', type: 'directory' }));
    expect(notDirectory.message).toBe(`${join('src', 'app.yml')}/. ends with /. but is not a directory`);
    const missing = thrown(() => planCopyIn({ path: conf, isDirectory: true, contents: true }, { service: 'web', path: '/etc/app', type: 'missing' }));
    expect(missing.message).toBe(`/etc/app must be an existing directory in web to receive the contents of ${conf}`);
  });
});

describe('ContainerPathError', () => {
  it('is a CLIError carrying its reason', () => {
    const missing = new ContainerPathError('Path /app/logs does not exist in web', 'not-found');
    expect(missing).toBeInstanceOf(CLIError);
    expect(missing.reason).toBe('not-found');
    expect(missing.code).toBe(ErrorCode.CONTAINER_NOT_FOUND);
    expect(new ContainerPathError('Copying failed', 'other').code).toBe(ErrorCode.COMMAND_FAILED);
    expect(new ContainerPathError('Path /x in web is not a directory', 'not-a-directory').reason).toBe('not-a-directory');
  });

  it('R-19: an image without tar', () => {
    const error = noTarError('web');
    expect(error.reason).toBe('no-tar');
    expect(error.message).toBe('Copying files requires tar in the container image of web');
    expect(error.suggestion).toBe(NO_TAR_SUGGESTION);
    expect(NO_TAR_SUGGESTION).toBe('Add tar to the image, or copy through a volume.');
  });
});

// ---------------------------------------------------------------------------
// Destination probe
// ---------------------------------------------------------------------------

async function archiveOf(first: { name: string; type: 'file' | 'directory' }, restBytes = 0): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => pack.on('end', () => resolve()));
  pack.entry({ name: first.name, type: first.type, size: first.type === 'file' ? 3 : 0 }, first.type === 'file' ? 'abc' : '');
  if (restBytes > 0) pack.entry({ name: `${first.name}/big`, type: 'file', size: restBytes }, Buffer.alloc(restBytes, 1));
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

function failing(error: Error): Readable {
  return new Readable({
    read() {
      this.destroy(error);
    },
  });
}

describe('probeContainerPath', () => {
  it('reads the type of the first header and destroys the stream', async () => {
    const streams: Readable[] = [];
    const open = async (path: string): Promise<Readable> => {
      const stream = Readable.from([await archiveOf({ name: path === '/etc/app' ? 'app' : 'app.yml', type: path === '/etc/app' ? 'directory' : 'file' }, 64 * 1024)]);
      streams.push(stream);
      return stream;
    };
    expect(await probeContainerPath(open, 'web', '/etc/app')).toEqual({ service: 'web', path: '/etc/app', type: 'directory' });
    expect(await probeContainerPath(open, 'web', '/etc/app.yml')).toEqual({ service: 'web', path: '/etc/app.yml', type: 'file' });
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it('probes the parent of a missing path', async () => {
    const opened: string[] = [];
    const open = async (path: string): Promise<Readable> => {
      opened.push(path);
      if (path === '/etc/app/new.yml') return failing(new ContainerPathError('Path /etc/app/new.yml does not exist in web', 'not-found'));
      return Readable.from([await archiveOf({ name: 'app', type: 'directory' })]);
    };
    expect(await probeContainerPath(open, 'web', '/etc/app/new.yml')).toEqual({
      service: 'web',
      path: '/etc/app/new.yml',
      type: 'missing',
      parentExists: true,
    });
    expect(opened).toEqual(['/etc/app/new.yml', '/etc/app']);
  });

  it('reports a missing parent, whether the backend rejects or the stream errors', async () => {
    const open = async (path: string): Promise<Readable> => {
      if (path === '/nope') throw new ContainerPathError('Path /nope does not exist in web', 'not-found');
      return failing(new ContainerPathError(`Path ${path} does not exist in web`, 'not-found'));
    };
    expect(await probeContainerPath(open, 'web', '/nope/conf')).toEqual({ service: 'web', path: '/nope/conf', type: 'missing', parentExists: false });
  });

  it('lets any other failure through (R-19 included)', async () => {
    const open = async (): Promise<Readable> => failing(noTarError('web'));
    await expect(probeContainerPath(open, 'web', '/etc/app')).rejects.toMatchObject({ reason: 'no-tar' });
  });
});
