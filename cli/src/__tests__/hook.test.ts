import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { windowsBashCandidates, isWslStubPath } from '../services/hook';

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
