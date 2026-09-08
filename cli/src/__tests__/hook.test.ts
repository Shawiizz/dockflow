import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { windowsBashCandidates, isWslStubPath, isFatalPhase, type HookPhase } from '../services/hook';

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

describe('isFatalPhase', () => {
  it('undefined keeps hooks non-fatal', () => {
    expect(isFatalPhase(undefined, 'post-deploy')).toBe(false);
  });

  it('a boolean applies to every phase', () => {
    expect(isFatalPhase(true, 'pre-build')).toBe(true);
    expect(isFatalPhase(true, 'post-deploy')).toBe(true);
    expect(isFatalPhase(false, 'pre-build')).toBe(false);
  });

  it('a list makes only the named phases fatal', () => {
    const fatal: HookPhase[] = ['post-upload'];

    expect(isFatalPhase(fatal, 'post-upload')).toBe(true);
    expect(isFatalPhase(fatal, 'post-deploy')).toBe(false);
    expect(isFatalPhase(fatal, 'pre-build')).toBe(false);
  });

  it('an empty list is equivalent to false', () => {
    expect(isFatalPhase([], 'post-upload')).toBe(false);
  });

  it('several phases can be fatal at once', () => {
    const fatal: HookPhase[] = ['pre-deploy', 'post-upload'];

    expect(isFatalPhase(fatal, 'pre-deploy')).toBe(true);
    expect(isFatalPhase(fatal, 'post-upload')).toBe(true);
    expect(isFatalPhase(fatal, 'pre-upload')).toBe(false);
  });
});
