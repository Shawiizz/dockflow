/**
 * CLI runner helper — spawns the dockflow binary under test as a subprocess.
 *
 * DOCKFLOW_E2E_BINARY overrides the local dist/ build (16.1: CI points it at the release artifact
 * under test — a hidden `--binary` upload uses this same file for the k3s nodes, so the gate tests
 * exactly what gets published).
 */

import { join } from "path";

const E2E_DIR = join(import.meta.dir, "..");
const DOCKFLOW_ROOT = join(E2E_DIR, "..", "..");

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function getCliBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") return "dockflow-windows-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "dockflow-macos-arm64";
  if (platform === "darwin") return "dockflow-macos-x64";
  if (platform === "linux" && arch === "arm64") return "dockflow-linux-arm64";
  return "dockflow-linux-x64";
}

/** DOCKFLOW_E2E_BINARY when set, else the local dist/ build for the host platform. */
export function resolveCliBinaryPath(): string {
  return process.env.DOCKFLOW_E2E_BINARY || join(DOCKFLOW_ROOT, "cli", "dist", getCliBinaryName());
}

export interface RunCLIOptions {
  /** Working directory (a fixture dir from makeFixture/sharedAppDir) */
  cwd: string;
  /** Timeout in milliseconds (defaults to 300s) */
  timeoutMs?: number;
  /** written to the process's stdin, then the stream is closed (e.g. E-37-12's piped input) */
  stdin?: string;
  /** merged over the current environment */
  env?: Readonly<Record<string, string>>;
}

interface Invocation {
  readonly args: readonly string[];
  readonly result: CLIResult;
}

/**
 * The most recent runCLI/runCLIInBackground results, read by debug-dump.ts on a failure (16.11).
 * More than one, so a cleanup command run in a `finally` does not hide the one that failed.
 */
const recentInvocations: Invocation[] = [];
const KEPT_INVOCATIONS = 3;

function record(invocation: Invocation): void {
  recentInvocations.push(invocation);
  if (recentInvocations.length > KEPT_INVOCATIONS) recentInvocations.shift();
}

/** Newest first. */
export function recentCliInvocations(): readonly Invocation[] {
  return [...recentInvocations].reverse();
}

function spawnCli(args: string[], opts: RunCLIOptions) {
  const binary = resolveCliBinaryPath();
  return Bun.spawn([binary, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin === undefined ? {} : { stdin: new Blob([opts.stdin]) }),
    env: { ...process.env, ...opts.env, DOCKFLOW_DEV_PATH: DOCKFLOW_ROOT },
  });
}

async function collect(
  proc: ReturnType<typeof spawnCli>,
  args: readonly string[],
  timeoutMs: number,
  started: number,
): Promise<CLIResult> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Read stdout and stderr in parallel to avoid pipe deadlock
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  return {
    exitCode,
    stdout,
    stderr: timedOut
      ? `${stderr}\n[runCLI] command killed after ${timeoutMs}ms timeout: dockflow ${args.join(" ")}`
      : stderr,
    durationMs,
  };
}

/**
 * Run a dockflow CLI command to completion and capture its output.
 *
 * @param args - CLI arguments (e.g. ["deploy", "e2e", "1.0.0"])
 */
export async function runCLI(args: string[], opts: RunCLIOptions): Promise<CLIResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const started = Date.now();
  const proc = spawnCli(args, opts);
  const result = await collect(proc, args, timeoutMs, started);
  record({ args, result });
  return result;
}

/**
 * Whether `kill("SIGINT")` reaches the CLI as a Ctrl+C it can clean up after. On Windows a child
 * cannot be sent one: Bun's kill terminates it outright, like SIGKILL, so the tests of the interrupt
 * path run on Linux and macOS only.
 */
export const GRACEFUL_INTERRUPTS = process.platform !== "win32";

export interface CLIBackgroundHandle {
  /** resolves once the process exits (also records the result as the last invocation, 16.11) */
  readonly done: Promise<CLIResult>;
  /** SIGINT by default, the Ctrl+C a user sends (see GRACEFUL_INTERRUPTS); SIGKILL for a CLI that dies outright */
  kill(signal?: "SIGINT" | "SIGKILL"): void;
}

/**
 * Start a dockflow CLI command without waiting for it to finish (E-35-12: assert on a Lease
 * appearing while a `deploy` is still holding the lock).
 */
export function runCLIInBackground(args: string[], opts: RunCLIOptions): CLIBackgroundHandle {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const started = Date.now();
  const proc = spawnCli(args, opts);
  const done = collect(proc, args, timeoutMs, started).then((result) => {
    record({ args, result });
    return result;
  });
  return { done, kill: (signal = "SIGINT") => proc.kill(signal) };
}
