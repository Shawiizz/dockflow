/**
 * Docker Compose cluster management for E2E tests.
 * Handles starting/stopping the DinD Swarm and waiting for health.
 */

import { join } from "path";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "./connection";
import { getCliBinaryName } from "./cli";

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

  // Read stdout and stderr in parallel to avoid pipe deadlock
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${exitCode}): ${cmd.join(" ")}\nstderr: ${stderr}\nstdout: ${stdout}`
    );
  }
  return stdout.trim();
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

  // Pre-pull images into DinD containers in parallel
  await preloadImages([MANAGER_CONTAINER, WORKER_CONTAINER], [
    "redis:8-alpine",
    "traefik:v3.6",
    "nginx:alpine",
  ]);
}

/**
 * Pull images directly inside each DinD container, in parallel.
 * Host SSL certs are mounted into the containers via docker-compose.yml
 * so the inner Docker daemon can verify TLS certificates from proxies.
 */
async function preloadImages(
  containers: string[],
  images: string[]
): Promise<void> {
  await Promise.all(
    containers.flatMap((container) =>
      images.map((image) => {
        console.log(`[cluster] Pulling ${image} in ${container}...`);
        return exec(["docker", "exec", container, "docker", "pull", image], {
          timeoutMs: 120_000,
        });
      })
    )
  );
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
  const cliDir = join(E2E_DIR, "..", "..", "cli");
  const binaryName = getCliBinaryName();
  const binaryPath = join(cliDir, "dist", binaryName);

  console.log("[cli] Building CLI binary...");
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: cliDir });

  const buildTarget = binaryName.replace("dockflow-", "").replace(/\.exe$/, "");
  await exec(["bun", "run", "build", buildTarget], {
    cwd: cliDir,
    timeoutMs: 120_000,
  });

  console.log(`[cli] CLI built: ${binaryName}`);
  return binaryPath;
}
