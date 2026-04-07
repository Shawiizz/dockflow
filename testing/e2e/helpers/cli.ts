/**
 * CLI runner helper — spawns the dockflow binary as a subprocess.
 */

import { join } from "path";

const E2E_DIR = join(import.meta.dir, "..");
const DOCKFLOW_ROOT = join(E2E_DIR, "..", "..");

export interface CLIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Get the path to the CLI binary for the current platform.
 */
export function getCliBinaryPath(): string {
  const cliDir = join(DOCKFLOW_ROOT, "cli-ts");
  return join(cliDir, "dist", getCliBinaryName());
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

/**
 * Run a dockflow CLI command and capture output.
 *
 * @param args - CLI arguments (e.g. ["deploy", "test", "1.0.0"])
 * @param opts.cwd - Working directory (defaults to fixtures/test-app)
 * @param opts.timeoutMs - Timeout in milliseconds (defaults to 300s)
 */
export async function runCLI(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<CLIResult> {
  const binary = getCliBinaryPath();
  const cwd = opts?.cwd ?? join(E2E_DIR, "fixtures", "test-app");
  const timeoutMs = opts?.timeoutMs ?? 300_000;

  const proc = Bun.spawn([binary, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DOCKFLOW_DEV_PATH: DOCKFLOW_ROOT,
    },
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  // Read stdout and stderr in parallel to avoid pipe deadlock
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { exitCode, stdout, stderr };
}
