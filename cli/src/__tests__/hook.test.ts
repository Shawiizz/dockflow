import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  hookEnvironment,
  isWslStubPath,
  remoteEnvPrefix,
  remoteHookContext,
  remoteHookProgram,
  resolveHookEntries,
  resolveLocalBash,
  resolvePhaseEntries,
  runHook,
  windowsBashCandidates,
} from '../services/hook';
import { type DockflowConfig, HOOK_PHASES, type HookPhase } from '../utils/config';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';
import { fakeNode } from './kubernetes/fakes/fake-kube-executor';
import { FakeOrchestrator } from './kubernetes/fakes/fake-orchestrator';

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

// ---------------------------------------------------------------------------
// Hook environment and working directory (DESIGN-CORE 8.8, U-FLOW-13, U-SWARM-15)
// ---------------------------------------------------------------------------

describe('hookEnvironment', () => {
  it('Swarm: the four DOCKFLOW_* variables and nothing Kubernetes (U-SWARM-15)', () => {
    expect(hookEnvironment(new FakeOrchestrator('swarm'), '1.4.2')).toEqual({
      DOCKFLOW_STACK: 'shop-production',
      DOCKFLOW_ENV: 'production',
      DOCKFLOW_VERSION: '1.4.2',
      DOCKFLOW_ORCHESTRATOR: 'swarm',
    });
  });

  it('k3s: the same four, plus the namespace, the deploy kubeconfig and the kubectl command', () => {
    expect(hookEnvironment(new FakeOrchestrator('k3s'), '1.4.2')).toEqual({
      DOCKFLOW_STACK: 'shop-production',
      DOCKFLOW_ENV: 'production',
      DOCKFLOW_VERSION: '1.4.2',
      DOCKFLOW_ORCHESTRATOR: 'k3s',
      DOCKFLOW_NAMESPACE: 'dockflow-shop-production',
      KUBECONFIG: '/var/lib/dockflow/kube/config',
      DOCKFLOW_KUBECTL: '/usr/local/bin/k3s kubectl',
    });
  });

  it('the namespace is the one the bundle names for the app role', () => {
    const orchestrator = new FakeOrchestrator('k3s', {
      naming: { scope: (ref) => (ref.role === 'app' ? 'dockflow-shop-production-4f2a' : 'unexpected') },
    });
    expect(hookEnvironment(orchestrator, '1.4.2').DOCKFLOW_NAMESPACE).toBe('dockflow-shop-production-4f2a');
  });
});

describe('remoteHookContext', () => {
  it('k3s: the private per-stack directory of the release store, created by the hook, never /tmp', () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const context = remoteHookContext(orchestrator, '1.4.2');

    expect(context.workingDir).toBe('/var/lib/dockflow/hooks/shop-production');
    expect(context.workingDir.startsWith('/tmp')).toBe(false);
    expect(context.createWorkingDir).toBe(true);
    expect(context.connection).toBe(orchestrator.target.controlPlane.connection);
    expect(context.env).toEqual(hookEnvironment(orchestrator, '1.4.2'));
  });

  it('Swarm: the working directory is unchanged, the current release link, never created (U-SWARM-15)', () => {
    const context = remoteHookContext(new FakeOrchestrator('swarm'), '1.4.2');

    expect(context.workingDir).toBe('/var/lib/dockflow/stacks/shop-production/current');
    expect(context.createWorkingDir).toBe(false);
  });

  it('runs on another node when the caller names one', () => {
    const other = fakeNode('server_2');
    expect(remoteHookContext(new FakeOrchestrator('k3s'), '1.4.2', other.connection).connection).toBe(other.connection);
  });
});

describe('remoteHookProgram', () => {
  const base = { workingDir: '/var/lib/dockflow/stacks/demo/current', createWorkingDir: false, env: {}, timeoutS: 30 };

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

  it('Swarm: enters the release link as before', () => {
    expect(remoteHookProgram({ ...base, kind: 'run' })).toContain(
      "cd '/var/lib/dockflow/stacks/demo/current' 2>/dev/null || cd /tmp",
    );
  });

  it('k3s: creates the directory 0700 and enters it, with no fallback to /tmp', () => {
    const program = remoteHookProgram({
      ...base,
      workingDir: '/var/lib/dockflow/hooks/shop-production',
      createWorkingDir: true,
      kind: 'run',
    });

    expect(program).toContain(
      "mkdir -p '/var/lib/dockflow/hooks/shop-production' && chmod 700 '/var/lib/dockflow/hooks/shop-production' && cd '/var/lib/dockflow/hooks/shop-production' || {",
    );
    expect(program).not.toContain('cd /tmp');
    // the umask applies before the directory is created
    expect(program.indexOf('umask 077')).toBeLessThan(program.indexOf('mkdir -p'));
  });

  // Runs the generated program for real, with stdin carrying the entry. Linux CI has
  // bash; on Windows this needs Git Bash, and these rows only run where one exists.
  const bash = resolveLocalBash();
  const run = async (program: string, input: string) => {
    const proc = Bun.spawn([bash as string, '-c', program], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    proc.stdin.write(input);
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return { stdout: stdout.trim(), exitCode: proc.exitCode };
  };
  const posix = (path: string): string => path.replace(/\\/g, '/');

  it.if(bash !== null)('executes the entry it receives on stdin, with the exported variables', async () => {
    const program = remoteHookProgram({ ...base, workingDir: '/nonexistent', env: { DOCKFLOW_ERROR: "it's broken && worse" }, kind: 'run' });
    const result = await run(program, 'echo "got: $DOCKFLOW_ERROR"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("got: it's broken && worse");
  });

  it.if(bash !== null)('propagates the entry exit code', async () => {
    const result = await run(remoteHookProgram({ ...base, workingDir: '/nonexistent', kind: 'run' }), 'exit 3');

    expect(result.exitCode).toBe(3);
  });

  it.if(bash !== null)('removes the file it wrote, even when the entry fails', async () => {
    const result = await run(
      remoteHookProgram({ ...base, workingDir: '/nonexistent', kind: 'run' }),
      'echo "$0" > /tmp/dockflow-hook-probe-path; exit 1',
    );
    const leftover = await run(
      remoteHookProgram({ ...base, workingDir: '/nonexistent', kind: 'run' }),
      'p=$(cat /tmp/dockflow-hook-probe-path); rm -f /tmp/dockflow-hook-probe-path; test -e "$p" && echo present || echo gone',
    );

    expect(result.exitCode).toBe(1);
    expect(leftover.stdout).toBe('gone');
  });

  it.if(bash !== null)('k3s: the entry runs inside the directory it created, which only its owner can open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dockflow-hook-test-'));
    try {
      const dir = join(root, 'hooks', 'shop-production');
      const program = remoteHookProgram({ ...base, workingDir: posix(dir), createWorkingDir: true, kind: 'run' });
      const result = await run(program, 'echo ran > ./marker');

      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(dir, 'marker'), 'utf-8').trim()).toBe('ran');
      if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.if(bash !== null)('k3s: a directory that cannot be created stops the entry instead of running it elsewhere', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dockflow-hook-test-'));
    try {
      writeFileSync(join(root, 'not-a-directory'), '');
      const marker = join(root, 'marker');
      const program = remoteHookProgram({
        ...base,
        workingDir: posix(join(root, 'not-a-directory', 'shop-production')),
        createWorkingDir: true,
        env: { MARKER: posix(marker) },
        kind: 'run',
      });
      const result = await run(program, 'echo ran > "$MARKER"');

      expect(result.exitCode).toBe(125);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runHook on the server', () => {
  interface Opened {
    host: string;
    program: string;
    input: string;
  }
  let opened: Opened[] = [];
  let spies: { mockRestore(): void }[] = [];

  beforeEach(() => {
    opened = [];
    spies = [
      spyOn(ssh, 'sshExecChannel').mockImplementation(async (conn, program) => {
        const record: Opened = { host: conn.host, program, input: '' };
        opened.push(record);
        const stream = {
          end: (data?: unknown) => {
            record.input = String(data ?? '');
          },
        };
        return {
          stream: stream as unknown as Awaited<ReturnType<typeof ssh.sshExecChannel>>['stream'],
          done: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        };
      }),
      spyOn(output, 'printDim').mockImplementation(() => {}),
      spyOn(output, 'printDebug').mockImplementation(() => {}),
      spyOn(output, 'printRaw').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  const config = (phase: HookPhase, entry: string): DockflowConfig => ({ project_name: 'shop', hooks: { [phase]: [entry] } });

  it('k3s: exports the DOCKFLOW_* variables and the phase variables, in the private directory (U-FLOW-13)', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    await runHook('on-failure', '/project', config('on-failure', 'notify "$DOCKFLOW_ERROR"'), undefined, remoteHookContext(orchestrator, '1.4.2'), {
      env: { DOCKFLOW_ERROR: 'boom', DOCKFLOW_ROLLED_BACK_TO: '' },
    });

    expect(opened).toHaveLength(1);
    const [call] = opened;
    expect(call?.host).toBe(orchestrator.target.controlPlane.host);
    expect(call?.input).toBe('notify "$DOCKFLOW_ERROR"');
    expect(call?.program).not.toContain('notify');
    expect(call?.program).toContain(
      "export DOCKFLOW_STACK='shop-production'; export DOCKFLOW_ENV='production'; export DOCKFLOW_VERSION='1.4.2'; " +
        "export DOCKFLOW_ORCHESTRATOR='k3s'; export DOCKFLOW_NAMESPACE='dockflow-shop-production'; " +
        "export KUBECONFIG='/var/lib/dockflow/kube/config'; export DOCKFLOW_KUBECTL='/usr/local/bin/k3s kubectl'; " +
        "export DOCKFLOW_ERROR='boom'; export DOCKFLOW_ROLLED_BACK_TO=''; timeout 300 bash",
    );
    expect(call?.program).toContain("mkdir -p '/var/lib/dockflow/hooks/shop-production'");
    expect(call?.program).not.toContain('cd /tmp');
  });

  it('k3s: a script entry runs in the same private directory, its rendered text on stdin', async () => {
    const orchestrator = new FakeOrchestrator('k3s');
    const hooks: DockflowConfig = { project_name: 'shop', hooks: { 'pre-deploy': [{ script: '.dockflow/hooks/migrate.sh' }] } };
    const rendered = new Map([['.dockflow/hooks/migrate.sh', '#!/bin/sh\n$DOCKFLOW_KUBECTL get pods\n']]);

    await runHook('pre-deploy', '/project', hooks, rendered, remoteHookContext(orchestrator, '1.4.2'));

    const [call] = opened;
    expect(call?.input).toBe('#!/bin/sh\n$DOCKFLOW_KUBECTL get pods\n');
    expect(call?.program).toContain("mkdir -p '/var/lib/dockflow/hooks/shop-production' && chmod 700");
    expect(call?.program).toContain("export DOCKFLOW_KUBECTL='/usr/local/bin/k3s kubectl'; timeout 300 \"$tmp\"");
    expect(call?.program).not.toContain('cd /tmp');
  });

  it('Swarm: the same variable names, without the Kubernetes ones, in the release directory (U-SWARM-15)', async () => {
    const orchestrator = new FakeOrchestrator('swarm');
    await runHook('post-deploy', '/project', config('post-deploy', 'echo done'), undefined, remoteHookContext(orchestrator, '1.4.2'));

    const program = opened[0]?.program ?? '';
    expect(program).toContain(
      "export DOCKFLOW_STACK='shop-production'; export DOCKFLOW_ENV='production'; export DOCKFLOW_VERSION='1.4.2'; export DOCKFLOW_ORCHESTRATOR='swarm'; timeout 300 bash",
    );
    expect(program).not.toContain('KUBECONFIG');
    expect(program).not.toContain('DOCKFLOW_NAMESPACE');
    expect(program).toContain("cd '/var/lib/dockflow/stacks/shop-production/current' 2>/dev/null || cd /tmp");
  });
});
