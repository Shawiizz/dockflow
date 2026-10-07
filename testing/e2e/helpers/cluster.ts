/**
 * Docker Compose cluster management for E2E tests.
 * Handles starting/stopping the DinD Swarm and waiting for health.
 */

import { existsSync } from "fs";
import { join } from "path";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "./connection";
import { getCliBinaryName } from "./cli";
import { SOCKET_PROXY_IMAGE, TRAEFIK_IMAGE } from "../../../cli/src/constants";

const E2E_DIR = join(import.meta.dir, "..");
const DOCKER_DIR = join(E2E_DIR, "docker");

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Merged over the current environment */
  env?: Readonly<Record<string, string>>;
  /** Written to the command's stdin */
  input?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command and capture its output without throwing on failure.
 */
export async function tryExec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? E2E_DIR,
    stdout: "pipe",
    stderr: "pipe",
    ...(opts?.input === undefined ? {} : { stdin: new Blob([opts.input]) }),
    ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
  });

  const timeout = opts?.timeoutMs ?? 120_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Read stdout and stderr in parallel to avoid pipe deadlock
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

/**
 * Run a shell command and return stdout. Throws on non-zero exit.
 */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<string> {
  const timeout = opts?.timeoutMs ?? 120_000;
  const { exitCode, stdout, stderr, timedOut } = await tryExec(cmd, { ...opts, timeoutMs: timeout });

  if (timedOut) {
    throw new Error(
      `Command timed out after ${timeout}ms: ${cmd.join(" ")}\nstderr: ${stderr}\nstdout: ${stdout}`
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${exitCode}): ${cmd.join(" ")}\nstderr: ${stderr}\nstdout: ${stdout}`
    );
  }
  return stdout.trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A probe either has the value, is still waiting (an exception counts as waiting), or failed for good. */
export type ProbeResult<T> = { value: T } | { waiting: string } | { failed: string };

/**
 * Call `probe` until it has a value. The timeout error carries the last state the probe reported,
 * so a failure says what the system was doing instead of only that time ran out.
 */
export async function poll<T>(
  what: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<ProbeResult<T>>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer yet";
  for (;;) {
    let result: ProbeResult<T> | undefined;
    try {
      result = await probe();
    } catch (error) {
      last = errorText(error);
    }
    if (result !== undefined) {
      if ("value" in result) return result.value;
      if ("failed" in result) throw new Error(`${what}: ${result.failed}`);
      last = result.waiting;
    }
    if (Date.now() >= deadline) throw new Error(`${what} within ${timeoutMs}ms (last state: ${last})`);
    await Bun.sleep(intervalMs);
  }
}

/**
 * Start the Docker Compose cluster (build + up).
 */
export async function startCluster(): Promise<void> {
  console.log("[cluster] Starting test containers...");
  await exec(
    ["docker", "compose", "-p", "dockflow-swarm", "up", "-d", "--build", "--wait"],
    { cwd: DOCKER_DIR, timeoutMs: 300_000 }
  );
  console.log("[cluster] Containers started.");

  // Pre-pull images into DinD containers in parallel; the proxy's two come from the CLI
  await preloadImages([MANAGER_CONTAINER, WORKER_CONTAINER], [
    "redis:8-alpine",
    TRAEFIK_IMAGE,
    SOCKET_PROXY_IMAGE,
    "nginx:alpine",
  ]);

  await startRegistry();
}

/**
 * Start an anonymous Docker registry inside the manager DinD node.
 *
 * It publishes port 35000 inside the manager, and docker-compose.yml maps
 * 35000:35000 to the host — so the SAME image name `localhost:35000/...`
 * resolves to this registry from the host (CLI push) and from the manager's
 * inner daemon (service pull). Loopback registries are exempt from TLS
 * requirements, so no insecure-registries daemon config is needed anywhere.
 * The worker cannot reach it — registry-mode fixtures pin services to the
 * manager, which also lets tests assert the SSH distribution was skipped.
 */
async function startRegistry(): Promise<void> {
  console.log("[cluster] Starting e2e registry on the manager (localhost:35000)...");
  await exec(
    ["docker", "exec", MANAGER_CONTAINER, "docker", "pull", "registry:2"],
    { timeoutMs: 120_000 },
  );
  await exec([
    "docker", "exec", MANAGER_CONTAINER, "sh", "-c",
    "docker rm -f e2e-registry 2>/dev/null; docker run -d --name e2e-registry --restart unless-stopped -p 35000:5000 registry:2",
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
      ["docker", "compose", "-p", "dockflow-swarm", "down", "-v", "--remove-orphans"],
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
  const nodes = await poll(`Swarm did not reach ${expectedNodes} nodes`, timeoutMs, 2000, async () => {
    const output = await exec(["docker", "exec", MANAGER_CONTAINER, "docker", "node", "ls", "--format", "{{.ID}}"]);
    const count = output.split("\n").filter(Boolean).length;
    return count >= expectedNodes ? { value: count } : { waiting: `${count} node(s)` };
  });
  console.log(`[cluster] Swarm ready with ${nodes} nodes.`);
}

/**
 * Build the CLI binary. Returns the path to the binary.
 *
 * With DOCKFLOW_E2E_BINARY set the suites test that file and nothing is built.
 */
export async function buildCLI(binaryName = getCliBinaryName()): Promise<string> {
  const provided = process.env.DOCKFLOW_E2E_BINARY;
  if (provided) {
    if (!existsSync(provided)) throw new Error(`DOCKFLOW_E2E_BINARY does not exist: ${provided}`);
    console.log(`[cli] Testing ${provided}, nothing to build.`);
    return provided;
  }

  const cliDir = join(E2E_DIR, "..", "..", "cli");
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
