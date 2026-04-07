/**
 * Docker Compose cluster management for E2E tests.
 * Handles starting/stopping the DinD Swarm and waiting for health.
 */

import { join } from "path";
import { MANAGER_CONTAINER } from "./connection";

const E2E_DIR = join(import.meta.dir, "..");
const DOCKER_DIR = join(E2E_DIR, "docker");

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
export async function exec(
  cmd: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? E2E_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts?.timeoutMs ?? 120_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${exitCode}): ${cmd.join(" ")}\nstderr: ${stderr}\nstdout: ${stdout}`
    );
  }
  return stdout.trim();
}

/**
 * Check if the test containers are running.
 */
export async function isClusterRunning(): Promise<boolean> {
  try {
    const output = await exec(["docker", "ps", "--format", "{{.Names}}"]);
    return (
      output.includes("dockflow-test-manager") &&
      output.includes("dockflow-test-worker-1")
    );
  } catch {
    return false;
  }
}

/**
 * Start the Docker Compose cluster (build + up).
 */
export async function startCluster(): Promise<void> {
  console.log("[cluster] Starting test containers...");
  await exec(
    ["docker", "compose", "up", "-d", "--build", "--wait"],
    { cwd: DOCKER_DIR, timeoutMs: 300_000 }
  );
  console.log("[cluster] Containers started.");
}

/**
 * Stop and remove the cluster.
 */
export async function stopCluster(): Promise<void> {
  console.log("[cluster] Tearing down...");
  try {
    await exec(
      ["docker", "compose", "down", "-v", "--remove-orphans"],
      { cwd: DOCKER_DIR, timeoutMs: 60_000 }
    );
  } catch (e) {
    console.error("[cluster] Teardown warning:", e);
  }
}

/**
 * Wait for Docker Swarm to have the expected number of nodes.
 */
export async function waitForSwarm(
  expectedNodes: number,
  timeoutMs = 90_000
): Promise<void> {
  console.log(`[cluster] Waiting for Swarm with ${expectedNodes} nodes...`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const output = await exec([
        "docker",
        "exec",
        MANAGER_CONTAINER,
        "docker",
        "node",
        "ls",
        "--format",
        "{{.ID}}",
      ]);
      const nodes = output.split("\n").filter(Boolean).length;
      if (nodes >= expectedNodes) {
        console.log(`[cluster] Swarm ready with ${nodes} nodes.`);
        return;
      }
    } catch {
      // Swarm not ready yet
    }
    await Bun.sleep(2000);
  }

  throw new Error(
    `Swarm did not reach ${expectedNodes} nodes within ${timeoutMs}ms`
  );
}

/**
 * Build the CLI binary. Returns the path to the binary.
 */
export async function buildCLI(): Promise<string> {
  const cliDir = join(E2E_DIR, "..", "..", "cli-ts");
  const binaryName = process.platform === "win32" ? "dockflow-linux-x64" : getCliBinaryName();
  const binaryPath = join(cliDir, "dist", binaryName);

  // Check if binary already exists
  if (await Bun.file(binaryPath).exists()) {
    console.log(`[cli] Using existing binary: ${binaryName}`);
    return binaryPath;
  }

  console.log("[cli] Building CLI binary...");
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: cliDir });

  const buildTarget = binaryName.replace("dockflow-", "");
  await exec(["bun", "run", "build", buildTarget], {
    cwd: cliDir,
    timeoutMs: 120_000,
  });

  console.log(`[cli] CLI built: ${binaryName}`);
  return binaryPath;
}

function getCliBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") return "dockflow-linux-x64";
  if (platform === "linux" && arch === "arm64") return "dockflow-linux-arm64";
  if (platform === "darwin" && arch === "x64") return "dockflow-macos-x64";
  if (platform === "darwin" && arch === "arm64") return "dockflow-macos-arm64";
  // Default for CI (ubuntu-latest)
  return "dockflow-linux-x64";
}
