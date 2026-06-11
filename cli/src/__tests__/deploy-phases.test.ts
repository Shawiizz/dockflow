import { describe, expect, it } from 'bun:test';
import {
  filterUploads,
  resolveFileDestPath,
  fileBackupPath,
  dirBackupPath,
  runWithConcurrency,
} from '../commands/deploy-phases';
import type { UploadItem } from '../utils/config';

describe('filterUploads', () => {
  const uploads: UploadItem[] = [
    { src: 'global.conf', dest: '/etc/global.conf' },                          // no service
    { src: 'web.conf', dest: '/etc/web.conf', service: 'web' },               // string service
    { src: 'shared.conf', dest: '/etc/shared.conf', service: ['web', 'api'] }, // array service
  ];

  it('no uploads → empty list', () => {
    expect(filterUploads(undefined)).toEqual([]);
    expect(filterUploads([])).toEqual([]);
  });

  it('no --only filter → everything', () => {
    expect(filterUploads(uploads)).toHaveLength(3);
  });

  it('uploads without service always apply', () => {
    const result = filterUploads(uploads, 'worker');
    expect(result.map(u => u.src)).toEqual(['global.conf']);
  });

  it('string service matches', () => {
    const result = filterUploads(uploads, 'web');
    expect(result.map(u => u.src)).toEqual(['global.conf', 'web.conf', 'shared.conf']);
  });

  it('array service matches any targeted service', () => {
    const result = filterUploads(uploads, 'api');
    expect(result.map(u => u.src)).toEqual(['global.conf', 'shared.conf']);
  });

  it('comma-separated filter with spaces', () => {
    const result = filterUploads(uploads, 'worker, web');
    expect(result).toHaveLength(3);
  });
});

describe('resolveFileDestPath', () => {
  it('trailing slash → dest dir + source basename', () => {
    expect(resolveFileDestPath('/etc/app/', 'config.yml')).toBe('/etc/app/config.yml');
  });

  it('no trailing slash → dest used verbatim (rename allowed)', () => {
    expect(resolveFileDestPath('/etc/app/renamed.yml', 'config.yml')).toBe('/etc/app/renamed.yml');
  });
});

describe('upload backup paths', () => {
  const base = '/var/lib/dockflow/upload-backups/demo/1.0.0';

  it('file backup mirrors the destination path under the backup dir', () => {
    expect(fileBackupPath(base, '/etc/app/config.yml')).toBe(`${base}/etc/app/config.yml`);
  });

  it('dir backup is a tar.gz named after the destination', () => {
    expect(dirBackupPath(base, '/srv/app')).toBe(`${base}/srv/app.tar.gz`);
  });

  it('invariant: rollback reads the exact path upload wrote', () => {
    // uploadFiles writes fileBackupPath(base, destPath); rollbackUploads
    // recomputes it from the same inputs — they must always agree.
    const destPath = resolveFileDestPath('/etc/nginx/', 'site.conf');
    expect(fileBackupPath(base, destPath)).toBe(`${base}/etc/nginx/site.conf`);
  });
});

describe('runWithConcurrency', () => {
  it('runs every task exactly once', async () => {
    const done: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      done.push(i);
    });
    await runWithConcurrency(tasks, 3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 12 }, () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    await runWithConcurrency(tasks, 4);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('propagates task errors', async () => {
    const tasks = [async () => {}, async () => { throw new Error('boom'); }];
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('boom');
  });

  it('handles empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toBeUndefined();
  });
});
