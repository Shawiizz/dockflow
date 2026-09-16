import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { windowsBashCandidates, isWslStubPath, resolveHookEntries, resolvePhaseEntries, remoteEnvPrefix, remoteHookProgram, resolveLocalBash } from '../services/hook';
import { HOOK_PHASES, type HookPhase } from '../utils/config';

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

describe('HOOK_PHASES', () => {
  it('lists the seven phases in the order a deploy runs them', () => {
    const expected: HookPhase[] = ['pre-build', 'post-build', 'pre-upload', 'post-upload', 'pre-deploy', 'post-deploy', 'on-failure'];
    expect([...HOOK_PHASES]).toEqual(expected);
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

describe('resolvePhaseEntries', () => {
  it('applies the config defaults to the phase entries', () => {
    const [entry] = resolvePhaseEntries('post-deploy', { fatal: true, timeout: 12, 'post-deploy': ['notify'] });

    expect(entry.fatal).toBe(true);
    expect(entry.timeoutS).toBe(12);
  });

  it('on-failure entries are never fatal, even when asked to be', () => {
    const entries = resolvePhaseEntries('on-failure', {
      fatal: true,
      'on-failure': ['alert', { run: 'cleanup', fatal: true }],
    });

    expect(entries.map((e) => e.fatal)).toEqual([false, false]);
  });

  it('a phase with nothing declared runs nothing', () => {
    expect(resolvePhaseEntries('on-failure', { fatal: true })).toEqual([]);
    expect(resolvePhaseEntries('pre-build', undefined)).toEqual([]);
  });
});

describe('remoteEnvPrefix', () => {
  it('nothing to export', () => {
    expect(remoteEnvPrefix({})).toBe('');
  });

  it('exports each variable, quoted', () => {
    expect(remoteEnvPrefix({ DOCKFLOW_ROLLED_BACK_TO: '1.0.3' })).toBe("export DOCKFLOW_ROLLED_BACK_TO='1.0.3'; ");
  });

  it('an error message with quotes and operators stays one inert value', () => {
    const prefix = remoteEnvPrefix({ DOCKFLOW_ERROR: "can't reach host && rm -rf /" });

    expect(prefix).toBe("export DOCKFLOW_ERROR='can'\\''t reach host && rm -rf /'; ");
  });
});

describe('remoteHookProgram', () => {
  const base = { stackDir: '/var/lib/dockflow/stacks/demo/current', env: {}, timeoutS: 30 };

  it('never carries the hook text: it only reads stdin', () => {
    const program = remoteHookProgram({ ...base, kind: 'run' });

    expect(program).toContain('cat > "$tmp"');
    expect(program).toContain('umask 077');
    expect(program).toContain('mktemp');
    expect(program).toContain(`trap 'rm -f "$tmp"' EXIT`);
  });

  it('runs a script directly, so its shebang applies, and a command with bash', () => {
    expect(remoteHookProgram({ ...base, kind: 'script' })).toContain('timeout 30 "$tmp" < /dev/null 2>&1');
    expect(remoteHookProgram({ ...base, kind: 'run' })).toContain('timeout 30 bash "$tmp" < /dev/null 2>&1');
  });

  // Runs the generated program for real, with stdin carrying the entry. Linux CI has
  // bash; on Windows this needs Git Bash, and the test is skipped without it.
  const bash = resolveLocalBash();
  const run = async (program: string, input: string) => {
    const proc = Bun.spawn([bash as string, '-c', program], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input);
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return { stdout: stdout.trim(), exitCode: proc.exitCode };
  };

  it.skipIf(!bash)('executes the entry it receives on stdin, with the exported variables', async () => {
    const program = remoteHookProgram({ ...base, stackDir: '/nonexistent', env: { DOCKFLOW_ERROR: "it's broken && worse" }, kind: 'run' });
    const result = await run(program, 'echo "got: $DOCKFLOW_ERROR"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("got: it's broken && worse");
  });

  it.skipIf(!bash)('propagates the entry exit code', async () => {
    const result = await run(remoteHookProgram({ ...base, stackDir: '/nonexistent', kind: 'run' }), 'exit 3');

    expect(result.exitCode).toBe(3);
  });

  it.skipIf(!bash)('removes the file it wrote, even when the entry fails', async () => {
    const result = await run(
      remoteHookProgram({ ...base, stackDir: '/nonexistent', kind: 'run' }),
      'echo "$0" > /tmp/dockflow-hook-probe-path; exit 1',
    );
    const leftover = await run(
      remoteHookProgram({ ...base, stackDir: '/nonexistent', kind: 'run' }),
      'p=$(cat /tmp/dockflow-hook-probe-path); rm -f /tmp/dockflow-hook-probe-path; test -e "$p" && echo present || echo gone',
    );

    expect(result.exitCode).toBe(1);
    expect(leftover.stdout).toBe('gone');
  });
});
