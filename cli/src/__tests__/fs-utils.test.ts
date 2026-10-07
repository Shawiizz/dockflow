import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureDir } from '../utils/fs';

const posix = process.platform !== 'win32';
const modeOf = (path: string) => lstatSync(path).mode & 0o7777;

describe.skipIf(!posix)('ensureDir', () => {
  let dir = '';
  let umask = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-ensure-dir-'));
    umask = process.umask(0o077);
  });
  afterEach(() => {
    process.umask(umask);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives the directory its mode under a restrictive umask', () => {
    const target = join(dir, 'etc-dockflow');
    mkdirSync(target, { recursive: true, mode: 0o755 });
    expect(modeOf(target)).toBe(0o700);

    const fresh = join(dir, 'fresh');
    ensureDir(fresh, 0o755);
    expect(modeOf(fresh)).toBe(0o755);
  });

  it('repairs a directory created earlier under that umask', () => {
    const target = join(dir, 'state');
    mkdirSync(target);
    chmodSync(target, 0o700);
    ensureDir(target, 0o755);
    expect(modeOf(target)).toBe(0o755);
  });

  it('is a no-op on a directory that already has the mode, and creates the parents it needs', () => {
    const nested = join(dir, 'a', 'b');
    ensureDir(nested, 0o755);
    ensureDir(nested, 0o755);
    expect(modeOf(nested)).toBe(0o755);
  });
});
