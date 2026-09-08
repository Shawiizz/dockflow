/**
 * Hook — deploy phase hook module.
 *
 * Runs user-defined commands at six deploy phases:
 *   - pre-build    (local, or remote when remote_build: true)
 *   - post-build   (local, or remote when remote_build: true)
 *   - pre-upload   (remote, before files are uploaded to the server)
 *   - post-upload  (remote, after files are uploaded to the server)
 *   - pre-deploy   (remote, before stack deployment)
 *   - post-deploy  (remote, after successful deployment and health checks)
 *
 * Hooks are non-fatal by default — failures log warnings but do not block the
 * deploy. `hooks.fatal` flips that for every phase, or for a chosen few when
 * given as a list of phase names.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SSHKeyConnection } from '../types';
import { sshExec, shellQuote } from '../utils/ssh';
import { printDebug, printDim, printRaw, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { DockflowConfig, HookEntry, HookEntryInput, HookPhase } from '../utils/config';
import { DOCKFLOW_STACKS_DIR } from '../constants';
import type { RenderedFiles } from './compose';

export type { HookPhase };

export interface HookRemoteContext {
  connection: SSHKeyConnection;
  stackName: string;
}

const DEFAULT_HOOK_TIMEOUT_S = 300;

/** A phase entry with its defaults applied, ready to run. */
export interface ResolvedHookEntry {
  /** Label for the deploy output. */
  label: string;
  kind: 'run' | 'script';
  /** The command, or the script path relative to the project root. */
  value: string;
  fatal: boolean;
  timeoutS: number;
}

/**
 * Apply the phase defaults to each entry.
 *
 * Entries run in declaration order, and each carries its own fatality and
 * timeout — so a config reload that must abort the deploy can sit next to a
 * notification that must not, in the same phase.
 */
export function resolveHookEntries(
  entries: HookEntryInput[] | undefined,
  defaults: { fatal?: boolean; timeout?: number } = {},
): ResolvedHookEntry[] {
  const fallbackFatal = defaults.fatal ?? false;
  const fallbackTimeout = defaults.timeout ?? DEFAULT_HOOK_TIMEOUT_S;

  return (entries ?? []).map((entry, i) => {
    const e: HookEntry = typeof entry === 'string' ? { run: entry } : entry;
    const kind: 'run' | 'script' = e.script !== undefined ? 'script' : 'run';
    const value = (kind === 'script' ? e.script : e.run) ?? '';

    return {
      label: e.name ?? (kind === 'script' ? value : `#${i + 1}`),
      kind,
      value,
      fatal: e.fatal ?? fallbackFatal,
      timeoutS: e.timeout ?? fallbackTimeout,
    };
  });
}

// ─── Local bash resolution ────────────────────────────────────
//
// Local hooks run through bash. On Windows, plain `bash` in PATH usually
// resolves to the System32 WSL stub, which fails with a cryptic
// "execvpe(/bin/bash) failed" when no WSL distro is configured — so Git Bash
// is preferred, and the stub is never used.

/** Candidate Git Bash locations on Windows, most common first. */
export function windowsBashCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: string[] = [];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (base) {
      candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
      candidates.push(join(base, 'Git', 'usr', 'bin', 'bash.exe'));
    }
  }
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  return candidates;
}

/** True for the System32 WSL stub (unusable without a configured distro). */
export function isWslStubPath(bashPath: string): boolean {
  return /\\system32\\bash\.exe$/i.test(bashPath);
}

let cachedLocalBash: string | null | undefined;

/**
 * Resolve the bash executable used for local hooks.
 * Returns null when no usable bash exists on this machine.
 */
function resolveLocalBash(): string | null {
  if (cachedLocalBash !== undefined) return cachedLocalBash;

  if (process.platform !== 'win32') {
    cachedLocalBash = 'bash';
    return cachedLocalBash;
  }

  const gitBash = windowsBashCandidates().find((p) => existsSync(p));
  if (gitBash) {
    cachedLocalBash = gitBash;
    return cachedLocalBash;
  }

  // Any other bash in PATH (MSYS2, Cygwin, scoop…) is fine — only the WSL
  // stub is rejected.
  const fromPath = Bun.which('bash');
  cachedLocalBash = fromPath && !isWslStubPath(fromPath) ? fromPath : null;
  return cachedLocalBash;
}

async function execLocal(
  args: string[],
  cwd: string,
  timeoutMs: number,
  fatal: boolean,
  label: string,
): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => { proc.kill(); }, timeoutMs);

  const decoder = new TextDecoder();
  const readStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        printRaw(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  };

  await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
  await proc.exited;
  clearTimeout(timer);

  if (proc.exitCode !== 0) {
    if (fatal) {
      throw new DeployError(
        `hook ${label} exited with code ${proc.exitCode}`,
        ErrorCode.DEPLOY_FAILED,
        `Fix the hook, or set fatal: false on it to treat its failures as warnings.`,
      );
    }
    printWarning(`hook ${label} exited with code ${proc.exitCode}`);
  } else {
    printDebug(`hook ${label} completed`);
  }
}

async function execRemote(
  connection: SSHKeyConnection,
  cmd: string,
  fatal: boolean,
  label: string,
): Promise<void> {
  const result = await sshExec(connection, cmd);
  if (result.stdout.trim()) printRaw(result.stdout.trim());

  if (result.exitCode !== 0) {
    if (fatal) {
      throw new DeployError(
        `hook ${label} exited with code ${result.exitCode}`,
        ErrorCode.DEPLOY_FAILED,
        `Fix the hook, or set fatal: false on it to treat its failures as warnings.`,
      );
    }
    printWarning(`hook ${label} exited with code ${result.exitCode}`);
  } else {
    printDebug(`hook ${label} completed`);
  }
}

/** Read a script entry, preferring the Nunjucks-rendered content when there is one. */
function readScript(entry: ResolvedHookEntry, projectRoot: string, rendered?: RenderedFiles): string {
  const relPath = entry.value.replace(/\\/g, '/');
  const fromRender = rendered?.get(relPath);
  if (fromRender !== undefined) return fromRender;

  const absPath = join(projectRoot, entry.value);
  if (!existsSync(absPath)) {
    throw new DeployError(
      `hook script not found: ${entry.value}`,
      ErrorCode.DEPLOY_FAILED,
      'The path is relative to the project root. Fix it or remove the entry.',
    );
  }
  return readFileSync(absPath, 'utf-8');
}

async function runScriptEntry(
  entry: ResolvedHookEntry,
  label: string,
  projectRoot: string,
  rendered: RenderedFiles | undefined,
  remote: HookRemoteContext | undefined,
  localBash: string,
  stackDir: string,
): Promise<void> {
  const content = readScript(entry, projectRoot, rendered);

  if (remote) {
    const tmpPath = `/tmp/dockflow_hook_${Date.now()}.sh`;
    try {
      await sshExec(remote.connection, `printf '%s' ${shellQuote(content)} > "${tmpPath}" && chmod +x "${tmpPath}"`);
      await execRemote(
        remote.connection,
        `cd "${stackDir}" 2>/dev/null || cd /tmp; timeout ${entry.timeoutS} "${tmpPath}" 2>&1`,
        entry.fatal,
        label,
      );
    } finally {
      await sshExec(remote.connection, `rm -f "${tmpPath}"`).catch(() => {});
    }
    return;
  }

  const tmpFile = join(tmpdir(), `dockflow-hook-${Date.now()}.sh`);
  writeFileSync(tmpFile, content, { mode: 0o755 });
  try {
    await execLocal([localBash, tmpFile], projectRoot, entry.timeoutS * 1000, entry.fatal, label);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function runCommandEntry(
  entry: ResolvedHookEntry,
  label: string,
  projectRoot: string,
  remote: HookRemoteContext | undefined,
  localBash: string,
  stackDir: string,
): Promise<void> {
  if (remote) {
    await execRemote(
      remote.connection,
      `cd "${stackDir}" 2>/dev/null || cd /tmp; timeout ${entry.timeoutS} bash -c ${shellQuote(entry.value)} 2>&1`,
      entry.fatal,
      label,
    );
    return;
  }
  await execLocal([localBash, '-c', entry.value], projectRoot, entry.timeoutS * 1000, entry.fatal, label);
}

/**
 * Run every entry declared for a phase, in order.
 *
 * Build phases (pre-build, post-build) run locally by default. When
 * remote_build: true they run on the server — pass `remote` to enable this.
 * Upload and deploy phases always run on the server; `remote` is required.
 */
export async function runHook(
  phase: HookPhase,
  projectRoot: string,
  config: DockflowConfig,
  rendered?: RenderedFiles,
  remote?: HookRemoteContext,
): Promise<void> {
  if (config.hooks?.enabled === false) return;

  const entries = resolveHookEntries(config.hooks?.[phase], {
    fatal: config.hooks?.fatal,
    timeout: config.hooks?.timeout,
  });

  if (entries.length === 0) {
    printDebug(`No ${phase} hook found`);
    return;
  }

  const isBuildPhase = phase === 'pre-build' || phase === 'post-build';
  const runRemotely = !isBuildPhase || config.options?.remote_build === true;

  if (runRemotely && !remote) {
    printWarning(`${phase} hooks skipped: no remote connection available`);
    return;
  }

  let localBash = '';
  if (!runRemotely) {
    const resolved = resolveLocalBash();
    if (!resolved) {
      const message = `${phase} hooks skipped: no usable bash found for local hooks`;
      const suggestion = process.platform === 'win32'
        ? 'Install Git for Windows (Git Bash) — the System32 WSL stub cannot run hooks without a WSL distro.'
        : 'Install bash to run local hooks.';
      if (entries.some((e) => e.fatal)) {
        throw new DeployError(message, ErrorCode.DEPLOY_FAILED, suggestion);
      }
      printWarning(`${message} — ${suggestion}`);
      return;
    }
    localBash = resolved;
  }

  const target = runRemotely ? remote : undefined;
  const stackDir = target ? `${DOCKFLOW_STACKS_DIR}/${target.stackName}/current` : '';

  for (const entry of entries) {
    const label = `${phase} ${entry.label}`;
    printDim(`Running ${label}...`);
    try {
      if (entry.kind === 'script') {
        await runScriptEntry(entry, label, projectRoot, rendered, target, localBash, stackDir);
      } else {
        await runCommandEntry(entry, label, projectRoot, target, localBash, stackDir);
      }
    } catch (error) {
      if (error instanceof DeployError) throw error;
      const message = `hook ${label} failed: ${error instanceof Error ? error.message : String(error)}`;
      if (entry.fatal) throw new DeployError(message, ErrorCode.DEPLOY_FAILED);
      printWarning(message);
    }
  }
}
