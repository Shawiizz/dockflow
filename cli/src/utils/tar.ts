/**
 * Tar archive utilities.
 * Uses tar-stream + zlib for pure-JS archive creation — no binary dependency.
 */

import tar from 'tar-stream';
import { createGzip } from 'zlib';
import { createReadStream, promises as fsp, readFileSync, type Stats } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { Readable } from 'stream';
import { ValidationError } from './errors';
import { walkDir } from './fs';
import { printWarning } from './output';

export interface TarEntry {
  /** Relative path within the archive (forward slashes) */
  path: string;
  /** File content */
  content: Buffer | string;
  /** File mode (default 0o644) */
  mode?: number;
}

/**
 * Create a tar archive buffer from a list of entries.
 */
export function createTar(entries: TarEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];

    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);

    for (const entry of entries) {
      const content = typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf-8')
        : entry.content;

      pack.entry({
        name: entry.path.replace(/\\/g, '/'),
        mode: entry.mode ?? 0o644,
        size: content.length,
      }, content);
    }

    pack.finalize();
  });
}

/** Build a reusable exclude predicate from patterns (globs or plain path prefixes). */
export function buildExcludeFilter(patterns: string[]): (rel: string) => boolean {
  const globs = patterns.map(p => /[*?[]/.test(p) ? new Bun.Glob(p) : null);
  return (rel: string) => patterns.some((pattern, i) => {
    const glob = globs[i];
    return glob ? glob.match(rel) : rel === pattern || rel.startsWith(pattern + '/');
  });
}

/** Called after each file is added; `bytesProcessed` is the cumulative uncompressed size so far. */
export type PackProgressCallback = (bytesProcessed: number) => void;

/**
 * Stream a tar archive of a directory into a Node.js Readable.
 * Exclude patterns can be globs (containing *, ?, [) or plain path prefixes.
 */
export function packDirToTarGz(
  srcDir: string,
  excludePatterns: string[] = [],
  onProgress?: PackProgressCallback,
  compress = true,
): NodeJS.ReadableStream {
  const pack = tar.pack();
  const gz = compress ? createGzip() : null;
  const isExcluded = buildExcludeFilter(excludePatterns);

  (async () => {
    let bytesProcessed = 0;
    for (const file of walkDir(srcDir)) {
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      if (isExcluded(rel)) continue;
      const content = readFileSync(file);
      await new Promise<void>((res, rej) =>
        pack.entry({ name: rel, mode: 0o644, size: content.length }, content, err => err ? rej(err) : res()),
      );
      bytesProcessed += content.length;
      onProgress?.(bytesProcessed);
    }
    pack.finalize();
  })().catch(err => pack.destroy(err instanceof Error ? err : new Error(String(err))));

  if (gz) {
    pack.pipe(gz);
    return gz;
  }
  return pack;
}

// ---------------------------------------------------------------------------
// dockflow cp: pack a local path, extract a container archive (design-06 3.3)
// ---------------------------------------------------------------------------

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function addEntry(pack: tar.Pack, header: tar.Headers): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    pack.entry(header, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function addFile(pack: tar.Pack, header: tar.Headers, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const sink = pack.entry(header, (error) => (error ? reject(error) : resolvePromise()));
    createReadStream(path).on('error', reject).pipe(sink);
  });
}

async function packEntry(pack: tar.Pack, path: string, name: string, stat: Stats): Promise<void> {
  // modes kept, ownership dropped: the container side extracts as its own user
  const common = { name, mode: stat.mode & 0o7777, mtime: stat.mtime };
  if (stat.isSymbolicLink()) {
    const linkname = (await fsp.readlink(path)).replace(/\\/g, '/');
    await addEntry(pack, { ...common, type: 'symlink', linkname });
  } else if (stat.isDirectory()) {
    await addEntry(pack, { ...common, type: 'directory' });
    await packChildren(pack, path, name);
  } else if (stat.isFile()) {
    await addFile(pack, { ...common, type: 'file', size: stat.size }, path);
  }
}

async function packChildren(pack: tar.Pack, dir: string, prefix: string): Promise<void> {
  const names = (await fsp.readdir(dir)).sort();
  for (const child of names) {
    const path = join(dir, child);
    await packEntry(pack, path, prefix === '' ? child : `${prefix}/${child}`, await fsp.lstat(path));
  }
}

/**
 * Tar stream of a local file or directory under `entryName` (regular files, directories and
 * symlinks kept as links; devices and sockets left out). `entryName` null packs the entries of a
 * directory at the archive root (the `SRC/.` form).
 */
export function packPathToTar(localPath: string, entryName: string | null): Readable {
  const pack = tar.pack();
  (async () => {
    const stat = await fsp.lstat(localPath);
    if (entryName === null) {
      if (!stat.isDirectory()) throw new ValidationError(`${localPath} is not a directory`);
      await packChildren(pack, localPath, '');
    } else {
      await packEntry(pack, localPath, entryName, stat);
    }
    pack.finalize();
  })().catch((error) => pack.destroy(errorOf(error)));
  return pack;
}

export interface ExtractTarOptions {
  /** new name of the archive's top entry (the first path component of every entry) */
  renameTopEntry?: string | null;
  /** skipped entries are reported here once per archive; default printWarning */
  onWarning?: (message: string) => void;
}

export interface ExtractTarResult {
  /** regular files and hard links written */
  files: number;
  bytes: number;
}

/** Mode an extracted entry gets: permission bits only, so setuid, setgid and sticky are dropped. */
export function extractedMode(mode: number | null | undefined, fallback: number): number {
  return (mode ?? fallback) & 0o777;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function drain(entry: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of entry) {
    // an entry must be read to its end before the next one arrives
  }
}

const SPECIAL_TYPES = new Set(['character-device', 'block-device', 'fifo']);

/** the platform refuses to create symbolic links (Windows without the privilege) */
function isSymlinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'ENOSYS' || code === 'EACCES';
}

class Extraction {
  files = 0;
  bytes = 0;
  skippedSpecial = 0;
  skippedLinks = 0;
  /** archive paths of symbolic link entries: nothing is ever extracted through them */
  private readonly links = new Set<string>();
  /** archive path -> real path of every regular file written, the only valid hard link targets */
  private readonly written = new Map<string, string>();
  private readonly directoryModes: { path: string; mode: number }[] = [];

  constructor(
    private readonly root: string,
    private readonly destDir: string,
    private readonly rename: string | null,
  ) {}

  private refuse(name: string, reason: string): ValidationError {
    return new ValidationError(`Refusing to extract ${name}: ${reason}`);
  }

  private outside(name: string): ValidationError {
    return this.refuse(name, `it points outside ${this.destDir}`);
  }

  /** path components after the rename; null for the archive root (`./`) */
  segments(name: string): string[] | null {
    if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) throw this.outside(name);
    const parts = name.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
    if (parts.includes('..')) throw this.outside(name);
    if (process.platform === 'win32' && parts.some((part) => part.includes(':'))) throw this.outside(name);
    if (parts.length === 0) return null;
    if (this.rename) parts[0] = this.rename;
    return parts;
  }

  private display(parts: readonly string[]): string {
    return join(this.destDir, ...parts);
  }

  /** the entry's parent as a real directory inside the root, created when missing, never through a link */
  private async parent(name: string, parts: readonly string[]): Promise<string> {
    const parents = parts.slice(0, -1);
    for (let i = 1; i <= parents.length; i++) {
      const prefix = parents.slice(0, i).join('/');
      if (this.links.has(prefix)) throw this.refuse(name, `${prefix} is a symbolic link`);
    }
    let current = this.root;
    for (const part of parents) {
      const next = join(current, part);
      let stat = await lstatOrNull(next);
      if (stat === null) {
        await fsp.mkdir(next);
        stat = await fsp.lstat(next);
      }
      if (stat.isSymbolicLink()) throw this.refuse(name, `${relative(this.root, next)} is a symbolic link`);
      if (!stat.isDirectory()) throw this.refuse(name, `${relative(this.root, next)} is not a directory`);
      current = next;
    }
    const real = await fsp.realpath(current);
    if (!isInside(this.root, real)) throw this.outside(name);
    return real;
  }

  /** removes a file or link in the way of a new non-directory entry; a directory is kept and refused */
  private async clear(target: string, parts: readonly string[], name: string): Promise<void> {
    const stat = await lstatOrNull(target);
    if (stat === null) return;
    if (stat.isDirectory()) throw this.refuse(name, `${this.display(parts)} is a directory`);
    await fsp.unlink(target);
  }

  async entry(header: tar.Headers, content: AsyncIterable<Buffer>): Promise<void> {
    const name = header.name;
    const parts = this.segments(name);
    const type = header.type ?? 'file';
    if (parts === null) {
      await drain(content);
      return;
    }
    if (SPECIAL_TYPES.has(type)) {
      this.skippedSpecial += 1;
      await drain(content);
      return;
    }
    const key = parts.join('/');
    const parent = await this.parent(name, parts);
    const target = join(parent, parts[parts.length - 1]);
    switch (type) {
      case 'directory':
        await this.directory(target, parts, header);
        break;
      case 'file':
      case 'contiguous-file':
        await this.clear(target, parts, name);
        await this.file(target, key, header, content);
        return;
      case 'symlink':
        await this.symlink(target, key, parts, name, header.linkname ?? '');
        break;
      case 'link':
        await this.hardLink(target, key, parts, name, header.linkname ?? '');
        break;
      default:
        this.skippedSpecial += 1;
    }
    await drain(content);
  }

  private async directory(target: string, parts: readonly string[], header: tar.Headers): Promise<void> {
    const stat = await lstatOrNull(target);
    if (stat === null) await fsp.mkdir(target);
    else if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ValidationError(`Cannot copy a directory onto the file ${this.display(parts)}`);
    }
    this.links.delete(parts.join('/'));
    // applied once every entry is written: a read-only directory would refuse its own children
    this.directoryModes.push({ path: target, mode: extractedMode(header.mode, 0o755) });
  }

  private async file(target: string, key: string, header: tar.Headers, content: AsyncIterable<Buffer>): Promise<void> {
    const mode = extractedMode(header.mode, 0o644);
    const handle = await fsp.open(target, 'wx', mode);
    try {
      for await (const chunk of content) {
        await handle.write(chunk);
        this.bytes += chunk.length;
      }
    } finally {
      await handle.close();
    }
    await fsp.chmod(target, mode);
    this.files += 1;
    this.links.delete(key);
    this.written.set(key, target);
  }

  private async symlink(target: string, key: string, parts: readonly string[], name: string, linkname: string): Promise<void> {
    if (linkname === '' || linkname.startsWith('/') || linkname.startsWith('\\') || /^[A-Za-z]:/.test(linkname)) {
      throw this.outside(name);
    }
    const parentDir = join(target, '..');
    if (!isInside(this.root, resolve(parentDir, linkname))) throw this.outside(name);
    await this.clear(target, parts, name);
    this.links.add(key);
    try {
      await fsp.symlink(linkname, target);
    } catch (error) {
      if (!isSymlinkUnsupported(error)) throw error;
      this.skippedLinks += 1;
    }
  }

  private async hardLink(target: string, key: string, parts: readonly string[], name: string, linkname: string): Promise<void> {
    let source: string[] | null;
    try {
      source = this.segments(linkname);
    } catch {
      throw this.outside(name);
    }
    const existing = source === null ? undefined : this.written.get(source.join('/'));
    if (existing === undefined) throw this.refuse(name, `its target ${linkname} is not a file extracted earlier from this archive`);
    await this.clear(target, parts, name);
    await fsp.link(existing, target);
    this.files += 1;
    this.links.delete(key);
    this.written.set(key, target);
  }

  async finish(): Promise<void> {
    for (const { path, mode } of this.directoryModes.reverse()) await fsp.chmod(path, mode);
  }
}

/**
 * Extracts a tar stream into `destDir`. Every entry is checked against the filesystem as it is at
 * that moment, because an archive can create a link and then write through it: names that are
 * absolute, carry a drive letter or a `..` component are refused; parents are created as real
 * directories and never followed through a link (on disk or earlier in the archive); the parent's
 * real path must stay inside `destDir`; a symlink target must resolve inside it and a hard link
 * may only point at a file extracted earlier. Devices and FIFOs are skipped with one warning;
 * modes keep their permission bits only.
 */
export async function extractTar(stream: Readable, destDir: string, options: ExtractTarOptions = {}): Promise<ExtractTarResult> {
  await fsp.mkdir(destDir, { recursive: true });
  const extraction = new Extraction(await fsp.realpath(destDir), destDir, options.renameTopEntry ?? null);
  const extract = tar.extract();
  stream.on('error', (error) => extract.destroy(error));
  stream.pipe(extract);
  try {
    for await (const entry of extract) await extraction.entry(entry.header, entry);
  } catch (error) {
    stream.unpipe(extract);
    stream.destroy();
    throw error;
  }
  await extraction.finish();
  const warn = options.onWarning ?? printWarning;
  if (extraction.skippedSpecial > 0) {
    warn(`Skipped ${extraction.skippedSpecial} device or FIFO entr${extraction.skippedSpecial === 1 ? 'y' : 'ies'} of the archive`);
  }
  if (extraction.skippedLinks > 0) {
    warn(`Skipped ${extraction.skippedLinks} symbolic link(s): this system does not allow creating them`);
  }
  return { files: extraction.files, bytes: extraction.bytes };
}
