/**
 * Hook — deploy phase hook module.
 *
 * Runs user-defined commands at four deploy phases:
 *   - pre-build  (local, or remote when remote_build: true)
 *   - post-build (local, or remote when remote_build: true)
 *   - pre-deploy (remote)
 *   - post-deploy (remote)
 *
 * Hooks are non-fatal by default — failures log warnings but
 * do not block the deploy.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { SSHKeyConnection } from '../types';
import { sshExec, shellEscape } from '../utils/ssh';
import { printDebug, printDim, printRaw, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import type { DockflowConfig } from '../utils/config';
import { DOCKFLOW_HOOKS_DIR, DOCKFLOW_STACKS_DIR } from '../constants';
import type { RenderedFiles } from './compose';

export type HookPhase = 'pre-build' | 'post-build' | 'pre-deploy' | 'post-deploy';

export interface HookRemoteContext {
  connection: SSHKeyConnection;
  stackName: string;
}

const DEFAULT_HOOK_TIMEOUT_S = 300;

function normalizeCommands(commands: string | string[]): string[] {
  return Array.isArray(commands) ? commands : [commands];
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
  phase: HookPhase,
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
        `${phase} hook exited with code ${proc.exitCode}`,
        ErrorCode.DEPLOY_FAILED,
        `Fix the hook or set hooks.fatal: false to treat failures as warnings.`,
      );
    }
    printWarning(`${phase} hook exited with code ${proc.exitCode}`);
  } else {
    printDebug(`${phase} hook completed`);
  }
}

async function execRemote(
  connection: SSHKeyConnection,
  cmd: string,
  fatal: boolean,
  phase: HookPhase,
): Promise<void> {
  const result = await sshExec(connection, cmd);
  if (result.stdout.trim()) printRaw(result.stdout.trim());

  if (result.exitCode !== 0) {
    if (fatal) {
      throw new DeployError(
        `Remote ${phase} hook exited with code ${result.exitCode}`,
        ErrorCode.DEPLOY_FAILED,
        `Fix the hook or set hooks.fatal: false to treat failures as warnings.`,
      );
    }
    printWarning(`Remote ${phase} hook exited with code ${result.exitCode}`);
  } else {
    printDebug(`Remote ${phase} hook completed`);
  }
}

/**
 * Run the hook for a given phase.
 *
 * Executes in order:
 *   1. File-based hook (.dockflow/hooks/{phase}.sh)
 *   2. Inline commands from config.yml
 *
 * Build phases (pre-build, post-build) run locally by default.
 * When remote_build: true they run on the server — pass `remote` to enable this.
 * Deploy phases (pre-deploy, post-deploy) always run on the server; `remote` is required.
 */
export async function runHook(
  phase: HookPhase,
  projectRoot: string,
  config: DockflowConfig,
  rendered?: RenderedFiles,
  remote?: HookRemoteContext,
): Promise<void> {
  if (config.hooks?.enabled === false) return;

  const inlineCommands = config.hooks?.[phase];
  const hookRelPath = `${DOCKFLOW_HOOKS_DIR}/${phase}.sh`;
  const hookAbsPath = join(projectRoot, hookRelPath);
  const hasFile = existsSync(hookAbsPath);

  if (!inlineCommands && !hasFile) {
    printDebug(`No ${phase} hook found`);
    return;
  }

  const timeoutS = config.hooks?.timeout ?? DEFAULT_HOOK_TIMEOUT_S;
  const fatal = config.hooks?.fatal ?? false;

  const isBuildPhase = phase === 'pre-build' || phase === 'post-build';
  const runRemotely = !isBuildPhase || config.options?.remote_build === true;

  if (runRemotely && !remote) {
    printWarning(`${phase} hook skipped: no remote connection available`);
    return;
  }

  let localBash = '';
  if (!runRemotely) {
    const resolved = resolveLocalBash();
    if (!resolved) {
      const message = `${phase} hook skipped: no usable bash found for local hooks`;
      const suggestion = process.platform === 'win32'
        ? 'Install Git for Windows (Git Bash) — the System32 WSL stub cannot run hooks without a WSL distro.'
        : 'Install bash to run local hooks.';
      if (fatal) {
        throw new DeployError(message, ErrorCode.DEPLOY_FAILED, suggestion);
      }
      printWarning(`${message} — ${suggestion}`);
      return;
    }
    localBash = resolved;
  }

  printDim(`Running ${phase} hook...`);

  const stackDir = remote ? `${DOCKFLOW_STACKS_DIR}/${remote.stackName}/current` : '';

  // File-based hook
  if (hasFile) {
    if (runRemotely && remote) {
      const tmpPath = `/tmp/dockflow_hook_${phase}_${Date.now()}.sh`;
      try {
        const hookContent = rendered?.get(hookRelPath.replace(/\\/g, '/'))
          ?? readFileSync(hookAbsPath, 'utf-8');
        const escapedHook = shellEscape(hookContent);
        await sshExec(remote.connection, `printf '%s' '${escapedHook}' > "${tmpPath}" && chmod +x "${tmpPath}"`);
        await execRemote(remote.connection, `cd "${stackDir}" 2>/dev/null || cd /tmp; timeout ${timeoutS} "${tmpPath}" 2>&1`, fatal, phase);
      } catch (error) {
        if (error instanceof DeployError) throw error;
        printWarning(`Remote ${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await sshExec(remote.connection, `rm -f "${tmpPath}"`).catch(() => {});
      }
    } else {
      const renderedContent = rendered?.get(hookRelPath.replace(/\\/g, '/'));
      let scriptPath = hookAbsPath;
      let tmpFile: string | undefined;
      if (renderedContent) {
        tmpFile = join(tmpdir(), `dockflow-hook-${phase}-${Date.now()}.sh`);
        writeFileSync(tmpFile, renderedContent, { mode: 0o755 });
        scriptPath = tmpFile;
      }
      try {
        await execLocal([localBash, scriptPath], projectRoot, timeoutS * 1000, fatal, phase);
      } catch (error) {
        if (error instanceof DeployError) throw error;
        printWarning(`${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (tmpFile) try { unlinkSync(tmpFile); } catch {}
      }
    }
  }

  // Inline commands from config
  if (inlineCommands) {
    const commands = normalizeCommands(inlineCommands);
    if (runRemotely && remote) {
      for (const cmd of commands) {
        try {
          await execRemote(
            remote.connection,
            `cd "${stackDir}" 2>/dev/null || cd /tmp; timeout ${timeoutS} bash -c ${shellEscape(cmd)} 2>&1`,
            fatal,
            phase,
          );
        } catch (error) {
          if (error instanceof DeployError) throw error;
          printWarning(`Remote ${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      for (const cmd of commands) {
        try {
          await execLocal([localBash, '-c', cmd], projectRoot, timeoutS * 1000, fatal, phase);
        } catch (error) {
          if (error instanceof DeployError) throw error;
          printWarning(`${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}
