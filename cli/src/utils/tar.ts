/**
 * Tar archive utilities for Docker build contexts.
 * Uses tar-stream for robust archive creation.
 */

import tar from 'tar-stream';

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
