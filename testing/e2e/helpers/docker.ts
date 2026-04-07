/**
 * Docker Swarm assertion helpers for E2E tests.
 * All commands run via `docker exec` against the manager container.
 */

import { exec } from "./cluster";
import { MANAGER_CONTAINER } from "./connection";

/**
 * Run a command inside a DinD container.
 */
export async function dockerExec(
  container: string,
  cmd: string[]
): Promise<string> {
  return exec(["docker", "exec", container, ...cmd]);
}

/**
 * Get service replicas as "running/desired" string.
 */
export async function getServiceReplicaStr(
  serviceName: string
): Promise<string> {
  return dockerExec(MANAGER_CONTAINER, [
    "docker",
    "service",
    "ls",
    "--filter",
    `name=${serviceName}`,
    "--format",
    "{{.Replicas}}",
  ]);
}

/**
 * Wait for a service to reach expected replicas (e.g. "2/2").
 */
export async function waitForService(
  serviceName: string,
  expected: string,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const timeout = opts?.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const replicas = await getServiceReplicaStr(serviceName);
      if (replicas === expected) return;
    } catch {
      // Service may not exist yet
    }
    await Bun.sleep(1000);
  }

  const current = await getServiceReplicaStr(serviceName).catch(() => "???");
  throw new Error(
    `Service ${serviceName} did not reach ${expected} replicas within ${timeout}ms (current: ${current})`
  );
}

/**
 * Get service labels as a key-value map.
 */
export async function getServiceLabels(
  serviceName: string
): Promise<Record<string, string>> {
  const raw = await dockerExec(MANAGER_CONTAINER, [
    "docker",
    "service",
    "inspect",
    serviceName,
    "--format",
    "{{json .Spec.Labels}}",
  ]);
  return JSON.parse(raw);
}

/**
 * Get the nodes where a service's tasks are running.
 */
export async function getTaskNodes(
  stackName: string,
  serviceName: string
): Promise<string[]> {
  const output = await dockerExec(MANAGER_CONTAINER, [
    "docker",
    "stack",
    "ps",
    stackName,
    "--filter",
    `name=${serviceName}`,
    "--filter",
    "desired-state=running",
    "--format",
    "{{.Node}}",
  ]);
  return [...new Set(output.split("\n").filter(Boolean))];
}

/**
 * Check if any tasks in a stack are rejected or failed.
 */
export async function hasFailedTasks(stackName: string): Promise<boolean> {
  try {
    const output = await dockerExec(MANAGER_CONTAINER, [
      "docker",
      "stack",
      "ps",
      stackName,
      "--format",
      "{{.CurrentState}}",
    ]);
    return output
      .split("\n")
      .some((s) => s.includes("Rejected") || s.includes("Failed"));
  } catch {
    return false;
  }
}

/**
 * Check if an image exists on a specific node.
 */
export async function isImageOnNode(
  container: string,
  imageName: string
): Promise<boolean> {
  try {
    const output = await dockerExec(container, [
      "docker",
      "images",
      "--format",
      "{{.Repository}}",
    ]);
    return output.includes(imageName);
  } catch {
    return false;
  }
}

/**
 * Verify service stability: no task restarts during observation period.
 */
export async function isServiceStable(
  stackName: string,
  serviceName: string,
  durationMs = 5000
): Promise<boolean> {
  const getTasks = async () => {
    const output = await dockerExec(MANAGER_CONTAINER, [
      "docker",
      "stack",
      "ps",
      stackName,
      "--filter",
      `name=${serviceName}`,
      "--filter",
      "desired-state=running",
      "--format",
      "{{.ID}}",
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .sort()
      .join(",");
  };

  const before = await getTasks();
  await Bun.sleep(durationMs);
  const after = await getTasks();

  return before === after;
}

/**
 * Execute a Redis command inside the Redis container.
 * Searches on manager node first (Redis is pinned to manager in tests).
 */
export async function redisExec(args: string[]): Promise<string> {
  // Find the Redis container on the manager
  const containerId = await dockerExec(MANAGER_CONTAINER, [
    "docker",
    "ps",
    "--filter",
    "label=com.docker.swarm.service.name",
    "--format",
    "{{.ID}} {{.Names}}",
  ]);

  // Look for the redis container
  const lines = containerId.split("\n").filter(Boolean);
  let redisId = "";
  for (const line of lines) {
    if (line.toLowerCase().includes("redis")) {
      redisId = line.split(" ")[0];
      break;
    }
  }

  if (!redisId) {
    // Fallback: try by service name filter
    redisId = (
      await dockerExec(MANAGER_CONTAINER, [
        "docker",
        "ps",
        "--filter",
        "ancestor=redis:7-alpine",
        "--format",
        "{{.ID}}",
      ])
    )
      .split("\n")
      .filter(Boolean)[0];
  }

  if (!redisId) {
    throw new Error("Redis container not found on any node");
  }

  return dockerExec(MANAGER_CONTAINER, [
    "docker",
    "exec",
    redisId,
    "redis-cli",
    ...args,
  ]);
}

/**
 * Wait for Redis to respond to PING.
 */
export async function waitForRedis(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pong = await redisExec(["PING"]);
      if (pong.trim() === "PONG") return;
    } catch {
      // Not ready yet
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Redis did not become responsive within ${timeoutMs}ms`);
}

/**
 * Full deployment verification — checks replicas, failures, distribution, stability.
 */
export async function verifyDeployment(opts: {
  stackName: string;
  serviceName: string;
  expectedReplicas: string;
  checkDistribution?: boolean;
}): Promise<void> {
  const { stackName, serviceName, expectedReplicas, checkDistribution = true } = opts;

  // 1. Check replicas
  const replicaStr = await getServiceReplicaStr(serviceName);
  if (replicaStr !== expectedReplicas) {
    throw new Error(
      `Expected ${expectedReplicas} replicas, got ${replicaStr}`
    );
  }

  // 2. No failed tasks
  if (await hasFailedTasks(stackName)) {
    throw new Error(`Stack ${stackName} has failed/rejected tasks`);
  }

  // 3. Task distribution (only for multi-replica)
  if (checkDistribution) {
    const [, desired] = expectedReplicas.split("/").map(Number);
    if (desired > 1) {
      const nodes = await getTaskNodes(stackName, serviceName);
      if (nodes.length < 2) {
        throw new Error(
          `Expected tasks on >=2 nodes, got ${nodes.length}: ${nodes.join(", ")}`
        );
      }
    }
  }

  // 4. Stability
  const stable = await isServiceStable(stackName, serviceName);
  if (!stable) {
    throw new Error(`Service ${serviceName} is unstable (tasks restarted)`);
  }
}
