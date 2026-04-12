import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { tmpdir } from 'os';
import { detectProjectName } from '../commands/init/detect';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dockflow-test-'));
}

describe('detectProjectName', () => {
  it('reads name from package.json', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    expect(detectProjectName(dir)).toMatchObject({ name: 'my-app', source: 'package.json', sanitized: false });
    rmSync(dir, { recursive: true });
  });

  it('strips npm scope from package.json', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@org/my-lib' }));
    expect(detectProjectName(dir)).toMatchObject({ name: 'my-lib', source: 'package.json' });
    rmSync(dir, { recursive: true });
  });

  it('sanitizes invalid name from package.json', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'My App' }));
    const result = detectProjectName(dir);
    expect(result.name).toBe('my-app');
    expect(result.sanitized).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('reads module name from go.mod', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'go.mod'), 'module github.com/org/my-service\n\ngo 1.21\n');
    expect(detectProjectName(dir)).toMatchObject({ name: 'my-service', source: 'go.mod' });
    rmSync(dir, { recursive: true });
  });

  it('reads name from Cargo.toml', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n');
    expect(detectProjectName(dir)).toMatchObject({ name: 'my-rust-app', source: 'Cargo.toml' });
    rmSync(dir, { recursive: true });
  });

  it('falls back to directory name', () => {
    const dir = tempDir();
    const result = detectProjectName(dir);
    expect(result.source).toBe('directory name');
    rmSync(dir, { recursive: true });
  });

  it('package.json takes priority over go.mod', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'from-package' }));
    writeFileSync(join(dir, 'go.mod'), 'module github.com/org/from-gomod\n');
    expect(detectProjectName(dir)).toMatchObject({ name: 'from-package', source: 'package.json' });
    rmSync(dir, { recursive: true });
  });
});
