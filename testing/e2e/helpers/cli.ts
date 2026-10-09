/**
 * CLI runner helper — spawns the dockflow binary under test as a subprocess.
 *
 * DOCKFLOW_E2E_BINARY replaces the local cli/dist build: CI points it at the release artifact, so
 * the suites test exactly the file that gets published.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ARTIFACTS_DIR, scrub } from "./artifacts";

const E2E_DIR = join(import.meta.dir, "..");
const DOCKFLOW_ROOT = join(E2E_DIR, "..", "..");
const DIST_DIR = join(DOCKFLOW_ROOT, "cli", "dist");

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Everything the command printed: the CLI writes its decorated messages to stderr. */
export function combinedOutput(result: CLIResult): string {
  return result.stdout + result.stderr;
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
  return process.env.DOCKFLOW_E2E_BINARY || join(DIST_DIR, getCliBinaryName());
}

/** The Linux x64 binary the setup suites copy into their containers, whatever the host is. */
export function resolveLinuxBinaryPath(): string {
  return process.env.DOCKFLOW_E2E_BINARY || join(DIST_DIR, "dockflow-linux-x64");
}

export interface RunCLIOptions {
  /** Working directory (a fixture dir from makeFixture/sharedAppDir) */
  cwd: string;
  /** Timeout in milliseconds (defaults to 300s) */
  timeoutMs?: number;
  /** Written to the process's stdin, then the stream is closed */
  stdin?: string;
  /** Merged over the current environment; its own DOCKFLOW_E2E_BINARY picks the binary of this call */
  env?: Readonly<Record<string, string>>;
}

interface Invocation {
  readonly args: readonly string[];
  readonly result: CLIResult;
}

/**
 * The latest results. More than the last one, so a cleanup command run in a `finally` does not
 * hide the command that failed. They are also written to the artifacts folder, where a failed CI
 * job finds them after the test process is gone.
 */
const recentInvocations: Invocation[] = [];
const KEPT_INVOCATIONS = 3;

function describeInvocation({ args, result }: Invocation): string {
  return [
    `dockflow ${args.join(" ")}`,
    `exit ${result.exitCode} (${result.durationMs}ms)`,
    "",
    "--- stdout ---",
    result.stdout,
    "",
    "--- stderr ---",
    result.stderr,
    "",
  ].join("\n");
}

function record(invocation: Invocation): void {
  recentInvocations.push(invocation);
  if (recentInvocations.length > KEPT_INVOCATIONS) recentInvocations.shift();
  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const text = [...recentInvocations].reverse().map(describeInvocation).join("\n========== earlier invocation ==========\n\n");
    writeFileSync(join(ARTIFACTS_DIR, "last-cli-invocations.txt"), scrub(text));
  } catch {
    // a read-only checkout loses the dump input, not the test
  }
}

/** Newest first. */
export function recentCliInvocations(): readonly Invocation[] {
  return [...recentInvocations].reverse();
}

function spawnCli(args: string[], opts: RunCLIOptions) {
  const binary = opts.env?.DOCKFLOW_E2E_BINARY || resolveCliBinaryPath();
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

  return {
    exitCode,
    stdout,
    stderr: timedOut
      ? `${stderr}\n[runCLI] command killed after ${timeoutMs}ms timeout: dockflow ${args.join(" ")}`
      : stderr,
    durationMs: Date.now() - started,
  };
}

/**
 * Run a dockflow CLI command to completion and capture its output.
 *
 * @param args - CLI arguments (e.g. ["deploy", "test", "1.0.0"])
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
 * Whether `kill("SIGINT")` reaches the CLI as the Ctrl+C it can clean up after. On Windows Bun
 * ends a child outright, so the tests of the interrupt path run on Linux and macOS only.
 */
export const GRACEFUL_INTERRUPTS = process.platform !== "win32";

export interface CLIBackgroundHandle {
  /** Resolves once the process exits */
  readonly done: Promise<CLIResult>;
  /** SIGINT by default, the Ctrl+C a user sends; SIGKILL for a CLI that dies without cleaning up */
  kill(signal?: "SIGINT" | "SIGKILL"): void;
}

/** Start a dockflow CLI command without waiting for it, to act while it holds the lock. */
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
