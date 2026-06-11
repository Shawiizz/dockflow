import { describe, expect, it } from 'bun:test';
import tar from 'tar-stream';
import { createTar, buildExcludeFilter } from '../utils/tar';

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
