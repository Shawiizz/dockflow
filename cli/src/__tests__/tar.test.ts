import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { ValidationError } from '../utils/errors';
import { createTar, buildExcludeFilter, extractedMode, extractTar, packPathToTar } from '../utils/tar';

/** Extract a tar buffer back into a Map<name, content> for assertions. */
function extractEntries(buf: Buffer): Promise<Map<string, { content: string; mode: number }>> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    const out = new Map<string, { content: string; mode: number }>();
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        out.set(header.name, { content: Buffer.concat(chunks).toString(), mode: header.mode! });
        next();
      });
      stream.resume();
    });
    extract.on('finish', () => resolve(out));
    extract.on('error', reject);
    extract.end(buf);
  });
}

describe('createTar', () => {
  it('packs string and Buffer entries with default mode 0644', async () => {
    const buf = await createTar([
      { path: 'a.txt', content: 'hello' },
      { path: 'dir/b.bin', content: Buffer.from([1, 2, 3]) },
    ]);
    const entries = await extractEntries(buf);
    expect(entries.get('a.txt')!.content).toBe('hello');
    expect(entries.get('a.txt')!.mode).toBe(0o644);
    expect(entries.has('dir/b.bin')).toBe(true);
  });

  it('normalizes Windows backslashes in entry paths', async () => {
    const buf = await createTar([{ path: 'dir\\sub\\file.txt', content: 'x' }]);
    const entries = await extractEntries(buf);
    expect(entries.has('dir/sub/file.txt')).toBe(true);
  });

  it('honors a custom mode', async () => {
    const buf = await createTar([{ path: 'run.sh', content: '#!/bin/sh', mode: 0o755 }]);
    const entries = await extractEntries(buf);
    expect(entries.get('run.sh')!.mode).toBe(0o755);
  });

  it('empty entry list produces a valid empty archive', async () => {
    const buf = await createTar([]);
    const entries = await extractEntries(buf);
    expect(entries.size).toBe(0);
  });
});

describe('buildExcludeFilter', () => {
  it('exact path match', () => {
    const isExcluded = buildExcludeFilter(['secrets.txt']);
    expect(isExcluded('secrets.txt')).toBe(true);
    expect(isExcluded('other.txt')).toBe(false);
  });

  it('directory prefix match requires a path separator', () => {
    const isExcluded = buildExcludeFilter(['node_modules']);
    expect(isExcluded('node_modules/x.js')).toBe(true);
    expect(isExcluded('node_modules')).toBe(true);
    expect(isExcluded('node_modules_backup/x.js')).toBe(false); // no false prefix match
  });

  it('glob patterns', () => {
    const isExcluded = buildExcludeFilter(['*.log']);
    expect(isExcluded('app.log')).toBe(true);
    expect(isExcluded('app.ts')).toBe(false);
  });

  it('globstar patterns', () => {
    const isExcluded = buildExcludeFilter(['**/*.tmp']);
    expect(isExcluded('a/b/c.tmp')).toBe(true);
    expect(isExcluded('a/b/c.txt')).toBe(false);
  });

  it('empty patterns excludes nothing', () => {
    const isExcluded = buildExcludeFilter([]);
    expect(isExcluded('anything')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dockflow cp: extractTar and packPathToTar (design-06 3.3, m11)
// ---------------------------------------------------------------------------

interface ArchiveEntry {
  name: string;
  type?: tar.Headers['type'];
  content?: string;
  linkname?: string;
  mode?: number;
}

/** builds an archive entry by entry, exactly as written (hostile names included) */
async function archive(entries: readonly ArchiveEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    pack.on('end', () => resolve());
    pack.on('error', reject);
  });
  for (const entry of entries) {
    const content = entry.content ?? '';
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: entry.name,
          type: entry.type ?? 'file',
          mode: entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644),
          linkname: entry.linkname,
          size: Buffer.byteLength(content),
        },
        content,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** name, type, linkname and content of every entry of a tar stream */
async function listEntries(stream: Readable): Promise<{ name: string; type: string; linkname: string | null; content: string }[]> {
  const extract = tar.extract();
  stream.on('error', (error) => extract.destroy(error));
  stream.pipe(extract);
  const out: { name: string; type: string; linkname: string | null; content: string }[] = [];
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(chunk as Buffer);
    out.push({
      name: entry.header.name,
      type: entry.header.type ?? 'file',
      linkname: entry.header.linkname ?? null,
      content: Buffer.concat(chunks).toString('utf8'),
    });
  }
  return out;
}

function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'dockflow-symlink-probe-'));
  try {
    symlinkSync('target', join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Windows without the symlink privilege cannot create links: extraction skips them with a warning */
const SYMLINKS = canCreateSymlinks();

const temporary: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockflow-tar-${label}-`));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function extractInto(entries: readonly ArchiveEntry[], options: Parameters<typeof extractTar>[2] = {}) {
  const root = tempDir('extract');
  const dest = join(root, 'dest');
  mkdirSync(dest);
  const warnings: string[] = [];
  const run = extractTar(Readable.from([await archive(entries)]), dest, { onWarning: (message) => warnings.push(message), ...options });
  return { root, dest, warnings, run };
}

describe('extractTar', () => {
  it('writes directories and files and counts files and bytes', async () => {
    const { dest, run } = await extractInto([
      { name: 'app', type: 'directory' },
      { name: 'app/a.txt', content: 'hello' },
      { name: 'app/sub/b.txt', content: 'wor' },
    ]);
    expect(await run).toEqual({ files: 2, bytes: 8 });
    expect(readFileSync(join(dest, 'app', 'a.txt'), 'utf8')).toBe('hello');
    expect(readFileSync(join(dest, 'app', 'sub', 'b.txt'), 'utf8')).toBe('wor');
  });

  it('renames the top entry of every path', async () => {
    const { dest, run } = await extractInto(
      [
        { name: 'logs', type: 'directory' },
        { name: 'logs/today.log', content: 'line' },
      ],
      { renameTopEntry: 'copy' },
    );
    await run;
    expect(readFileSync(join(dest, 'copy', 'today.log'), 'utf8')).toBe('line');
    expect(existsSync(join(dest, 'logs'))).toBe(false);
  });

  it('skips the root entry of a contents archive (tar -C dir .)', async () => {
    const { dest, run } = await extractInto([
      { name: './', type: 'directory' },
      { name: './a.txt', content: 'x' },
    ]);
    expect(await run).toEqual({ files: 1, bytes: 1 });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('x');
  });

  for (const name of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', 'a\\..\\..\\x', 'c:relative']) {
    it(`refuses the entry name ${JSON.stringify(name)} before writing anything`, async () => {
      const { root, dest, run } = await extractInto([
        { name: 'first.txt', content: 'kept' },
        { name, content: 'owned' },
      ]);
      const error = await run.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toBe(`Refusing to extract ${name}: it points outside ${dest}`);
      expect(existsSync(join(root, 'x'))).toBe(false);
      expect(existsSync(join(dest, 'first.txt'))).toBe(true);
    });
  }

  it('refuses a symlink whose target leaves the destination, relative or absolute', async () => {
    for (const linkname of ['../../etc', '/etc', 'sub/../../outside']) {
      const { run } = await extractInto([{ name: 'a', type: 'symlink', linkname }]);
      await expect(run).rejects.toThrow('Refusing to extract a: it points outside');
    }
  });

  it('accepts a symlink inside the destination, or skips it with one warning where links cannot be created', async () => {
    const { dest, warnings, run } = await extractInto([
      { name: 'sub', type: 'directory' },
      { name: 'sub/file', content: 'x' },
      { name: 'link', type: 'symlink', linkname: 'sub' },
    ]);
    expect(await run).toEqual({ files: 1, bytes: 1 });
    if (SYMLINKS) {
      expect(lstatSync(join(dest, 'link')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dest, 'link'))).toBe('sub');
      expect(warnings).toEqual([]);
    } else {
      expect(existsSync(join(dest, 'link'))).toBe(false);
      expect(warnings).toEqual(['Skipped 1 symbolic link(s): this system does not allow creating them']);
    }
  });

  it('refuses to write through a symlink of the archive even when it points inside (a -> subdir, then a/b)', async () => {
    const { dest, run } = await extractInto([
      { name: 'subdir', type: 'directory' },
      { name: 'a', type: 'symlink', linkname: 'subdir' },
      { name: 'a/b', content: 'x' },
    ]);
    await expect(run).rejects.toThrow('Refusing to extract a/b: a is a symbolic link');
    expect(existsSync(join(dest, 'subdir', 'b'))).toBe(false);
  });

  it('refuses an archive that creates a directory, replaces it with a symlink, then writes into it', async () => {
    const { dest, run } = await extractInto([
      { name: 'a', type: 'directory' },
      { name: 'a', type: 'symlink', linkname: 'elsewhere' },
      { name: 'a/b', content: 'x' },
    ]);
    await expect(run).rejects.toThrow(ValidationError);
    expect(existsSync(join(dest, 'a', 'b'))).toBe(false);
  });

  it('never follows a link already present in the destination', async () => {
    const { root, dest, run } = await extractInto([{ name: 'outside-link/x', content: 'x' }]);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    if (SYMLINKS) {
      symlinkSync(outside, join(dest, 'outside-link'), 'dir');
      await expect(run).rejects.toThrow('Refusing to extract outside-link/x: outside-link is a symbolic link');
      expect(existsSync(join(outside, 'x'))).toBe(false);
    } else {
      // without links on this system the parent is created as a real directory inside the destination
      await run;
      expect(lstatSync(join(dest, 'outside-link')).isDirectory()).toBe(true);
      expect(existsSync(join(outside, 'x'))).toBe(false);
    }
  });

  it('accepts a hard link to a file extracted earlier and refuses one to anything else', async () => {
    const good = await extractInto([
      { name: 'f', content: 'abc' },
      { name: 'g', type: 'link', linkname: 'f' },
    ]);
    expect(await good.run).toEqual({ files: 2, bytes: 3 });
    expect(readFileSync(join(good.dest, 'g'), 'utf8')).toBe('abc');

    const later = await extractInto([
      { name: 'l', type: 'link', linkname: 'later' },
      { name: 'later', content: 'x' },
    ]);
    await expect(later.run).rejects.toThrow('Refusing to extract l: its target later is not a file extracted earlier from this archive');

    const outside = await extractInto([{ name: 'l', type: 'link', linkname: '../outside' }]);
    await expect(outside.run).rejects.toThrow(`Refusing to extract l: it points outside ${outside.dest}`);
  });

  it('keeps permission bits only: setuid, setgid and sticky are dropped', async () => {
    expect(extractedMode(0o4755, 0o644)).toBe(0o755);
    expect(extractedMode(0o2775, 0o644)).toBe(0o775);
    expect(extractedMode(0o1777, 0o644)).toBe(0o777);
    expect(extractedMode(undefined, 0o644)).toBe(0o644);
    const { dest, run } = await extractInto([{ name: 'tool', content: '#!/bin/sh', mode: 0o4755 }]);
    await run;
    if (process.platform !== 'win32') expect(statSync(join(dest, 'tool')).mode & 0o7777).toBe(0o755);
    else expect(existsSync(join(dest, 'tool'))).toBe(true);
  });

  it('skips devices and FIFOs with one warning', async () => {
    const { dest, warnings, run } = await extractInto([
      { name: 'pipe', type: 'fifo' },
      { name: 'tty', type: 'character-device' },
      { name: 'f', content: 'x' },
    ]);
    expect(await run).toEqual({ files: 1, bytes: 1 });
    expect(warnings).toEqual(['Skipped 2 device or FIFO entries of the archive']);
    expect(existsSync(join(dest, 'pipe'))).toBe(false);
  });

  it('refuses a directory onto an existing file and overwrites an existing file with a file', async () => {
    const dirOntoFile = await extractInto(
      [
        { name: 'logs', type: 'directory' },
        { name: 'logs/a', content: 'x' },
      ],
      { renameTopEntry: 'target' },
    );
    writeFileSync(join(dirOntoFile.dest, 'target'), 'old');
    await expect(dirOntoFile.run).rejects.toThrow(`Cannot copy a directory onto the file ${join(dirOntoFile.dest, 'target')}`);
    expect(readFileSync(join(dirOntoFile.dest, 'target'), 'utf8')).toBe('old');

    const fileOverFile = await extractInto([{ name: 'app.log', content: 'new' }], { renameTopEntry: 'target' });
    writeFileSync(join(fileOverFile.dest, 'target'), 'old');
    await fileOverFile.run;
    expect(readFileSync(join(fileOverFile.dest, 'target'), 'utf8')).toBe('new');
  });

  it('creates a missing destination directory', async () => {
    const root = tempDir('missing');
    const dest = join(root, 'new', 'dir');
    await extractTar(Readable.from([await archive([{ name: 'a', content: 'x' }])]), dest);
    expect(readFileSync(join(dest, 'a'), 'utf8')).toBe('x');
  });

  it('rejects with the error of its source stream', async () => {
    const dest = tempDir('error');
    const failure = new Error('remote tar failed');
    const source = new Readable({
      read() {
        this.destroy(failure);
      },
    });
    await expect(extractTar(source, dest)).rejects.toBe(failure);
  });
});

describe('packPathToTar', () => {
  it('packs one file under the requested name, round trip through extractTar', async () => {
    const src = tempDir('pack-file');
    writeFileSync(join(src, 'report.txt'), 'quarterly numbers');
    const dest = tempDir('pack-file-out');
    const result = await extractTar(packPathToTar(join(src, 'report.txt'), 'copy.txt'), dest);
    expect(result).toEqual({ files: 1, bytes: 17 });
    expect(readFileSync(join(dest, 'copy.txt'), 'utf8')).toBe('quarterly numbers');
  });

  it('packs a nested directory, round trip through extractTar', async () => {
    const src = tempDir('pack-dir');
    mkdirSync(join(src, 'conf', 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(src, 'conf', 'app.yml'), 'port: 80');
    writeFileSync(join(src, 'conf', 'nested', 'deeper', 'x.txt'), 'x');
    const entries = await listEntries(packPathToTar(join(src, 'conf'), 'conf'));
    expect(entries.map((e) => [e.name.replace(/\/$/, ''), e.type])).toEqual([
      ['conf', 'directory'],
      ['conf/app.yml', 'file'],
      ['conf/nested', 'directory'],
      ['conf/nested/deeper', 'directory'],
      ['conf/nested/deeper/x.txt', 'file'],
    ]);
    const dest = tempDir('pack-dir-out');
    await extractTar(packPathToTar(join(src, 'conf'), 'renamed'), dest);
    expect(readFileSync(join(dest, 'renamed', 'app.yml'), 'utf8')).toBe('port: 80');
    expect(readFileSync(join(dest, 'renamed', 'nested', 'deeper', 'x.txt'), 'utf8')).toBe('x');
  });

  it('packs the entries of a directory at the archive root for the SRC/. form', async () => {
    const src = tempDir('pack-contents');
    writeFileSync(join(src, 'a.txt'), 'a');
    mkdirSync(join(src, 'd'));
    writeFileSync(join(src, 'd', 'b.txt'), 'b');
    const entries = await listEntries(packPathToTar(src, null));
    expect(entries.map((e) => e.name.replace(/\/$/, ''))).toEqual(['a.txt', 'd', 'd/b.txt']);
    await expect(listEntries(packPathToTar(join(src, 'a.txt'), null))).rejects.toThrow('is not a directory');
  });

  it('keeps symbolic links as links', async () => {
    const src = tempDir('pack-link');
    mkdirSync(join(src, 'tree'));
    writeFileSync(join(src, 'tree', 'target.txt'), 't');
    if (SYMLINKS) symlinkSync('target.txt', join(src, 'tree', 'link'));
    const entries = await listEntries(packPathToTar(join(src, 'tree'), 'tree'));
    const link = entries.find((e) => e.name === 'tree/link');
    if (SYMLINKS) {
      expect(link).toMatchObject({ type: 'symlink', linkname: 'target.txt', content: '' });
      const dest = tempDir('pack-link-out');
      await extractTar(packPathToTar(join(src, 'tree'), 'tree'), dest);
      expect(readlinkSync(join(dest, 'tree', 'link'))).toBe('target.txt');
    } else {
      expect(link).toBeUndefined();
      expect(entries.find((e) => e.name === 'tree/target.txt')).toMatchObject({ type: 'file', content: 't' });
    }
  });

  it('fails the stream when the local path does not exist', async () => {
    const src = tempDir('pack-missing');
    await expect(listEntries(packPathToTar(join(src, 'missing'), 'x'))).rejects.toThrow();
  });
});
