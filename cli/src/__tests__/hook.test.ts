import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { windowsBashCandidates, isWslStubPath, resolveHookEntries } from '../services/hook';
import type { HookPhase } from '../utils/config';

describe('windowsBashCandidates', () => {
  it('derives Git Bash locations from ProgramFiles variables', () => {
    const candidates = windowsBashCandidates({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    });
    expect(candidates).toContain(join('C:\\Program Files', 'Git', 'bin', 'bash.exe'));
    expect(candidates).toContain(join('C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'));
    expect(candidates).toContain(join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'));
  });

  it('includes the per-user Git install when LOCALAPPDATA is set', () => {
    const candidates = windowsBashCandidates({
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    });
    expect(candidates).toContain(
      join('C:\\Users\\dev\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe'),
    );
  });

  it('missing env vars produce no candidates instead of broken paths', () => {
    expect(windowsBashCandidates({})).toEqual([]);
  });
});

describe('isWslStubPath', () => {
  it('flags the System32 WSL stub regardless of case', () => {
    expect(isWslStubPath('C:\\Windows\\System32\\bash.exe')).toBe(true);
    expect(isWslStubPath('c:\\windows\\system32\\bash.exe')).toBe(true);
  });

  it('does not flag real bash installs', () => {
    expect(isWslStubPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(false);
    expect(isWslStubPath('C:\\msys64\\usr\\bin\\bash.exe')).toBe(false);
    expect(isWslStubPath('/usr/bin/bash')).toBe(false);
  });
});

describe('HookPhase type', () => {
  it('covers all six deploy phases', () => {
    const phases: HookPhase[] = ['pre-build', 'post-build', 'pre-upload', 'post-upload', 'pre-deploy', 'post-deploy'];
    expect(phases).toHaveLength(6);
    expect(phases).toContain('pre-upload');
    expect(phases).toContain('post-upload');
  });
});

describe('resolveHookEntries', () => {
  it('no entries at all', () => {
    expect(resolveHookEntries(undefined)).toEqual([]);
    expect(resolveHookEntries([])).toEqual([]);
  });

  it('a bare string is an inline command', () => {
    const [entry] = resolveHookEntries(['echo hi']);

    expect(entry.kind).toBe('run');
    expect(entry.value).toBe('echo hi');
    expect(entry.label).toBe('#1');
  });

  it('phase defaults apply when an entry says nothing', () => {
    const [entry] = resolveHookEntries(['echo hi'], { fatal: true, timeout: 42 });

    expect(entry.fatal).toBe(true);
    expect(entry.timeoutS).toBe(42);
  });

  it('an entry overrides the phase defaults', () => {
    const [strict, lax] = resolveHookEntries(
      [{ run: 'nginx -t', fatal: true, timeout: 10 }, { run: 'notify' }],
      { fatal: false, timeout: 300 },
    );

    expect(strict.fatal).toBe(true);
    expect(strict.timeoutS).toBe(10);
    expect(lax.fatal).toBe(false);
    expect(lax.timeoutS).toBe(300);
  });

  it('falls back to 300s when nothing sets a timeout', () => {
    expect(resolveHookEntries(['echo hi'])[0].timeoutS).toBe(300);
  });

  it('a script entry keeps its path and labels itself with it', () => {
    const [entry] = resolveHookEntries([{ script: '.dockflow/hooks/migrate.sh' }]);

    expect(entry.kind).toBe('script');
    expect(entry.value).toBe('.dockflow/hooks/migrate.sh');
    expect(entry.label).toBe('.dockflow/hooks/migrate.sh');
  });

  it('name wins over the generated label', () => {
    expect(resolveHookEntries([{ name: 'nginx', run: 'nginx -t' }])[0].label).toBe('nginx');
  });

  it('several scripts can share one phase, in order', () => {
    const entries = resolveHookEntries([{ script: 'a.sh' }, { script: 'b.sh' }, 'echo done']);

    expect(entries.map((e) => e.value)).toEqual(['a.sh', 'b.sh', 'echo done']);
    expect(entries.map((e) => e.kind)).toEqual(['script', 'script', 'run']);
  });
});
