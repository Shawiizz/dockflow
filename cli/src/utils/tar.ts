/**
 * Tar archive utilities.
 * Uses tar-stream + zlib for pure-JS archive creation — no binary dependency.
 */

import tar from 'tar-stream';
import { createGzip } from 'zlib';
import { readFileSync } from 'fs';
import { relative } from 'path';
import { walkDir } from './fs';

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
