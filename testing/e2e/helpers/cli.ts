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
 * Get the path to the CLI binary.
 */
export function getCliBinaryPath(): string {
  const cliDir = join(DOCKFLOW_ROOT, "cli-ts");
  const binaryName =
    process.platform === "linux" && process.arch === "arm64"
      ? "dockflow-linux-arm64"
      : "dockflow-linux-x64";
  return join(cliDir, "dist", binaryName);
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

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}
