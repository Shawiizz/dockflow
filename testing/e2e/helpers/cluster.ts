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

  // Pre-load images that DinD can't pull (TLS/proxy issues)
  await preloadImages([MANAGER_CONTAINER, WORKER_CONTAINER], [
    "redis:7-alpine",
    "traefik:v3.3",
    "nginx:alpine",
  ]);
}

/**
 * Transfer images from host Docker into DinD containers.
 * Pulls missing images on host first, then pipes via docker save/load.
 */
async function preloadImages(
  containers: string[],
  images: string[]
): Promise<void> {
  for (const image of images) {
    // Ensure image exists on host
    const exists = await exec([
      "docker", "images", "-q", image,
    ]).catch(() => "");
    if (!exists.trim()) {
      console.log(`[cluster] Pulling ${image} on host...`);
      await exec(["docker", "pull", image], { timeoutMs: 120_000 });
    }

    // Load into each DinD container via pipe
    for (const container of containers) {
      console.log(`[cluster] Loading ${image} into ${container}...`);

      const save = Bun.spawn(["docker", "save", image], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const load = Bun.spawn(
        ["docker", "exec", "-i", container, "docker", "load"],
        {
          stdin: save.stdout,
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const [saveExit, loadExit] = await Promise.all([
        save.exited,
        load.exited,
      ]);

      if (saveExit !== 0) {
        const stderr = await new Response(save.stderr).text();
        throw new Error(`docker save failed for ${image}: ${stderr.trim()}`);
      }
      if (loadExit !== 0) {
        const stderr = await new Response(load.stderr).text();
        throw new Error(`docker load failed in ${container}: ${stderr.trim()}`);
      }

      // Verify image is actually available inside the container
      const verify = await exec([
        "docker", "exec", container, "docker", "images", "-q", image,
      ]).catch(() => "");
      if (!verify.trim()) {
        throw new Error(`Image ${image} not found in ${container} after docker load`);
      }
    }
  }
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
