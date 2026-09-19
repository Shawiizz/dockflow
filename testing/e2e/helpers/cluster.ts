/**
 * Docker Compose cluster management for E2E tests.
 * - Swarm: starting/stopping the DinD Swarm and waiting for health.
 * - k3s: node image, topology start/stop (helpers/topology.ts), waiting for systemd and sshd,
 *   `dockflow setup k3s` against a topology, cluster readiness, and the shared-lane guard.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { connect } from "net";
import { join } from "path";
import { readImagesLock, repositoryOf } from "../k3s/tools/lock-images";
import { type CLIResult, getCliBinaryName, runCLI } from "./cli";
import { BOOTSTRAP_KEY_PATH, MANAGER_CONTAINER, WORKER_CONTAINER } from "./connection";
import {
  auxAddress,
  E2E_CHARTS_PASSWORD,
  E2E_CHARTS_USER,
  E2E_REGISTRY_PASSWORD,
  E2E_REGISTRY_USER,
  managersOf,
  type NetworkPlan,
  SETUP_LANE,
  SHARED_LANE,
  TOPOLOGY_NAMES,
  type Topology,
  type TopologyNode,
} from "./topology";

export const E2E_DIR = join(import.meta.dir, "..");
const DOCKER_DIR = join(E2E_DIR, "docker");
export const CACHE_DIR = join(E2E_DIR, ".cache");
export const AUTH_DIR = join(CACHE_DIR, "auth");
export const CHARTS_DIR = join(CACHE_DIR, "charts");
export const K3S_COMPOSE_FILE = join(DOCKER_DIR, "docker-compose.k3s.yml");
const BUILD_NODE_IMAGE_TOOL = join(E2E_DIR, "k3s", "tools", "build-node-image.ts");
const PEBBLE_CONFIG = join(E2E_DIR, "fixtures", "acme", "pebble-config.json");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function warn(message: string, error?: unknown): void {
  process.stderr.write(`${message}${error === undefined ? "" : ` ${errorText(error)}`}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─── Process helpers ───────────────────────────────────────────────

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** merged over the current environment */
  env?: Readonly<Record<string, string>>;
  /** written to the command's stdin */
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

/**
 * Run a long command (image builds, pulls) with its output streamed to the terminal.
 */
export async function execStreaming(cmd: string[], opts?: Omit<ExecOptions, "input">): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts?.cwd ?? E2E_DIR,
    stdout: "inherit",
    stderr: "inherit",
    ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
  });
  const timeout = opts?.timeoutMs ?? 1_800_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`Command timed out after ${timeout}ms: ${cmd.join(" ")}`);
  if (exitCode !== 0) throw new Error(`Command failed (exit ${exitCode}): ${cmd.join(" ")}`);
}

/** A probe either has the value, is still waiting (an exception counts as waiting), or failed for good. */
type ProbeResult<T> = { value: T } | { waiting: string } | { failed: string };

async function poll<T>(
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

// ─── Swarm cluster ─────────────────────────────────────────────────

/**
 * Start the Docker Compose cluster (build + up).
 */
export async function startCluster(): Promise<void> {
  log("[cluster] Starting test containers...");
  await exec(
    ["docker", "compose", "-p", "dockflow-swarm", "up", "-d", "--build", "--wait"],
    { cwd: DOCKER_DIR, timeoutMs: 300_000 }
  );
  log("[cluster] Containers started.");

  // Pre-pull images into DinD containers in parallel
  await preloadImages([MANAGER_CONTAINER, WORKER_CONTAINER], [
    "redis:8-alpine",
    "traefik:v3.6",
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
  log("[cluster] Starting e2e registry on the manager (localhost:35000)...");
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
        log(`[cluster] Pulling ${image} in ${container}...`);
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
  log("[cluster] Tearing down...");
  try {
    await exec(
      ["docker", "compose", "-p", "dockflow-swarm", "down", "-v", "--remove-orphans"],
      { cwd: DOCKER_DIR, timeoutMs: 60_000 }
    );
  } catch (e) {
    warn("[cluster] Teardown warning:", e);
  }
}

/**
 * Wait for Docker Swarm to have the expected number of nodes.
 */
export async function waitForSwarm(
  expectedNodes: number,
  timeoutMs = 90_000
): Promise<void> {
  log(`[cluster] Waiting for Swarm with ${expectedNodes} nodes...`);
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
        log(`[cluster] Swarm ready with ${nodes} nodes.`);
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

  log("[cli] Building CLI binary...");
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: cliDir });

  const buildTarget = binaryName.replace("dockflow-", "").replace(/\.exe$/, "");
  await exec(["bun", "run", "build", buildTarget], {
    cwd: cliDir,
    timeoutMs: 120_000,
  });

  log(`[cli] CLI built: ${binaryName}`);
  return binaryPath;
}

// ─── k3s node image ────────────────────────────────────────────────

export const DEFAULT_NODE_IMAGE = "dockflow-e2e-k3s-node:local";

/** The node image the k3s topologies run: DOCKFLOW_E2E_NODE_IMAGE (CI) or the local build. */
export function nodeImage(): string {
  return process.env.DOCKFLOW_E2E_NODE_IMAGE || DEFAULT_NODE_IMAGE;
}

/**
 * Make the node image available. An image named by DOCKFLOW_E2E_NODE_IMAGE must already be loaded
 * (CI loads the artifact of the node-image job); the local image is (re)built by
 * tools/build-node-image.ts when its pins or build files changed.
 */
export async function ensureNodeImage(): Promise<string> {
  const image = nodeImage();
  if (process.env.DOCKFLOW_E2E_NODE_IMAGE) {
    const inspect = await tryExec(["docker", "image", "inspect", image]);
    if (inspect.exitCode !== 0) {
      throw new Error(`The node image ${image} named by DOCKFLOW_E2E_NODE_IMAGE is not loaded in Docker`);
    }
    return image;
  }
  await execStreaming([process.execPath, "run", BUILD_NODE_IMAGE_TOOL, "--tag", image, "--if-stale"], {
    cwd: E2E_DIR,
    timeoutMs: 3_600_000,
  });
  return image;
}

// ─── k3s host-side files ───────────────────────────────────────────

/**
 * Credentials files mounted by the registry-auth and charts containers: bcrypt htpasswd for the
 * registry, `{SHA}` for nginx basic auth. The registry file is rewritten only when it no longer
 * matches the password, so a running registry never sees it change.
 */
export async function writeAuthFiles(): Promise<void> {
  mkdirSync(AUTH_DIR, { recursive: true });
  const registryFile = join(AUTH_DIR, "htpasswd");
  if (!(await htpasswdMatches(registryFile, E2E_REGISTRY_USER, E2E_REGISTRY_PASSWORD))) {
    const hash = await Bun.password.hash(E2E_REGISTRY_PASSWORD, { algorithm: "bcrypt" });
    writeFileSync(registryFile, `${E2E_REGISTRY_USER}:${hash}\n`);
  }
  const sha1 = createHash("sha1").update(E2E_CHARTS_PASSWORD).digest("base64");
  writeFileSync(join(AUTH_DIR, "htpasswd-charts"), `${E2E_CHARTS_USER}:{SHA}${sha1}\n`);
}

async function htpasswdMatches(file: string, user: string, password: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const line = readFileSync(file, "utf-8").split("\n").find((entry) => entry.startsWith(`${user}:`));
  if (!line) return false;
  try {
    return await Bun.password.verify(password, line.slice(user.length + 1).trim());
  } catch {
    return false;
  }
}

async function prepareHostFiles(): Promise<void> {
  await writeAuthFiles();
  // Created here so Docker does not create the bind-mount sources as root
  for (const access of ["public", "private"]) mkdirSync(join(CHARTS_DIR, access), { recursive: true });
  if (!existsSync(PEBBLE_CONFIG)) {
    throw new Error(`${PEBBLE_CONFIG} is missing; the acme container of every k3s topology mounts testing/e2e/fixtures/acme`);
  }
}

// ─── k3s topologies ────────────────────────────────────────────────

const PROJECT_LABEL = "dockflow.e2e.project";
const ALL_PROFILES = TOPOLOGY_NAMES.flatMap((name) => ["--profile", name]);

/** Images of the auxiliary containers, pinned by the digests of images.lock.json once resolved. */
const AUX_IMAGE_VARS: ReadonlyArray<readonly [string, string]> = [
  ["E2E_REGISTRY_IMAGE", "docker.io/library/registry"],
  ["E2E_NGINX_IMAGE", "docker.io/library/nginx"],
  ["E2E_PEBBLE_IMAGE", "ghcr.io/letsencrypt/pebble"],
  ["E2E_PEBBLE_CHALLTESTSRV_IMAGE", "ghcr.io/letsencrypt/pebble-challtestsrv"],
];

function composeCommand(project: string): string[] {
  return ["docker", "compose", "-p", project, "-f", K3S_COMPOSE_FILE];
}

function composeEnv(topo: Topology): Record<string, string> {
  const env: Record<string, string> = { E2E_NET: topo.net, E2E_NODE_IMAGE: nodeImage() };
  for (const node of topo.nodes) env[`E2E_PORT_${node.key.toUpperCase()}`] = String(node.sshPort);
  const lock = readImagesLock();
  for (const [variable, repository] of AUX_IMAGE_VARS) {
    const image = lock.images.find((entry) => repositoryOf(entry.ref) === repository);
    if (image) env[variable] = image.digest ? `${repository}@${image.digest}` : image.ref;
  }
  return env;
}

/**
 * Start a topology (`compose --profile <name> up -d --wait`) and wait until every node runs systemd
 * with sshd and the registry forwarders active, and answers on its published SSH port.
 * Nothing k3s-related exists on the nodes afterwards: `runSetupK3s` provisions the cluster.
 */
export async function startTopology(topo: Topology, opts: { timeoutMs?: number } = {}): Promise<void> {
  await prepareHostFiles();
  const env = composeEnv(topo);
  log(`[k3s] Starting topology ${topo.name} (project ${topo.project}, ${topo.net}.0/24)...`);
  try {
    await exec([...composeCommand(topo.project), "--profile", topo.name, "up", "-d", "--wait"], {
      cwd: DOCKER_DIR,
      timeoutMs: opts.timeoutMs ?? 600_000,
      env,
    });
  } catch (error) {
    const ps = await tryExec([...composeCommand(topo.project), "--profile", topo.name, "ps", "-a"], { cwd: DOCKER_DIR, env });
    throw new Error(`Topology ${topo.name} did not start: ${errorText(error)}\n${ps.stdout}`);
  }
  await waitForNodes(topo.nodes);
  log(`[k3s] Topology ${topo.name} is up: ${topo.nodes.map((node) => `${node.key} localhost:${node.sshPort}`).join(", ")}.`);
}

/**
 * Remove every container, anonymous volume and network of a project: the compose topology of any
 * profile and the standalone nodes started with `startStandaloneNode`.
 */
export async function stopTopology(project: string = SHARED_LANE.project): Promise<void> {
  log(`[k3s] Removing project ${project}...`);
  const listed = await tryExec(["docker", "ps", "-aq", "--filter", `label=${PROJECT_LABEL}=${project}`]);
  const standalone = listed.stdout.split(/\s+/).filter(Boolean);
  if (standalone.length > 0) await tryExec(["docker", "rm", "-f", "-v", ...standalone], { timeoutMs: 180_000 });
  const down = await tryExec([...composeCommand(project), ...ALL_PROFILES, "down", "-v", "--remove-orphans", "--timeout", "20"], {
    cwd: DOCKER_DIR,
    timeoutMs: 300_000,
  });
  if (down.exitCode !== 0) warn(`[k3s] Teardown warning for ${project}: ${down.stderr.trim()}`);
  await tryExec(["docker", "network", "rm", `${project}_standalone`]);
}

/** Stop every k3s e2e project: the shared lanes and the setup lane. */
export async function stopK3sCluster(): Promise<void> {
  await stopTopology(SHARED_LANE.project);
  await stopTopology(SETUP_LANE.project);
}

/**
 * Start one node with `docker run` (a setup-lane file that needs a host of its own). It joins the
 * project's compose network when that topology is up, otherwise a network of its own on the same
 * subnet; `stopTopology(plan.project)` removes it.
 */
export async function startStandaloneNode(plan: NetworkPlan, node: TopologyNode, opts: { timeoutMs?: number } = {}): Promise<void> {
  const network = await standaloneNetwork(plan);
  await tryExec(["docker", "rm", "-f", "-v", node.container]);
  const serverDb = node.role === "manager" ? ["--tmpfs", "/var/lib/rancher/k3s/server/db:size=1g"] : [];
  log(`[k3s] Starting standalone node ${node.service} (${node.ip}, SSH localhost:${node.sshPort})...`);
  await exec([
    "docker", "run", "-d",
    "--name", node.container,
    "--hostname", node.service,
    "--label", `${PROJECT_LABEL}=${plan.project}`,
    "--privileged",
    "--cgroupns", "private",
    "--stop-signal", "SIGRTMIN+3",
    "--tmpfs", "/run",
    "--tmpfs", "/run/lock",
    "--tmpfs", "/tmp:exec,mode=1777",
    ...serverDb,
    "-v", "/lib/modules:/lib/modules:ro",
    "-v", "/var/lib/rancher/k3s",
    "-v", "/var/lib/kubelet",
    "-v", "/var/log",
    "-e", `E2E_REGISTRY_ADDR=${auxAddress(plan.net, "registry")}:5000`,
    "-e", `E2E_REGISTRY_AUTH_ADDR=${auxAddress(plan.net, "registry-auth")}:5000`,
    "--add-host", "k3s.e2e.test:127.0.0.1",
    "--add-host", "dashboard.k3s.e2e.test:127.0.0.1",
    "--health-cmd", "/usr/local/bin/healthcheck.k3s.sh",
    "--health-interval", "3s",
    "--health-timeout", "3s",
    "--health-retries", "40",
    "--health-start-period", "5s",
    "-p", `${node.sshPort}:22`,
    "--network", network,
    "--ip", node.ip,
    nodeImage(),
  ], { timeoutMs: 180_000 });
  await waitForNodes([node], opts.timeoutMs);
}

async function standaloneNetwork(plan: NetworkPlan): Promise<string> {
  const composeNetwork = `${plan.project}_k3s`;
  if ((await tryExec(["docker", "network", "inspect", composeNetwork])).exitCode === 0) return composeNetwork;
  const own = `${plan.project}_standalone`;
  if ((await tryExec(["docker", "network", "inspect", own])).exitCode !== 0) {
    await exec([
      "docker", "network", "create",
      "--driver", "bridge",
      "--subnet", `${plan.net}.0/24`,
      "--label", `${PROJECT_LABEL}=${plan.project}`,
      own,
    ]);
  }
  return own;
}

// ─── k3s node and cluster readiness ────────────────────────────────

async function containerState(container: string): Promise<string> {
  const inspect = await tryExec([
    "docker", "inspect", "--format", "{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container,
  ]);
  return inspect.exitCode === 0 ? inspect.stdout.trim() : "absent";
}

/** First line an SSH server sends (`SSH-2.0-...`), or null when nothing answers. */
export function sshBanner(port: number, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let received = "";
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (banner: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(banner);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf-8");
      const line = received.split("\n")[0]?.trim() ?? "";
      if (received.includes("\n")) finish(line.startsWith("SSH-") ? line : null);
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function waitForSshd(port: number, timeoutMs = 60_000): Promise<string> {
  return poll<string>(`sshd did not answer on localhost:${port}`, timeoutMs, 1000, async () => {
    const banner = await sshBanner(port);
    return banner ? { value: banner } : { waiting: "no SSH banner" };
  });
}

/**
 * Wait until each node container is healthy (systemd running or degraded, sshd and the registry
 * forwarders active) and its published SSH port answers from the runner.
 */
export async function waitForNodes(nodes: readonly TopologyNode[], timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await Promise.all(
    nodes.map(async (node) => {
      await poll<string>(`${node.key} (${node.container}) did not become healthy`, timeoutMs, 2000, async () => {
        const state = await containerState(node.container);
        if (state === "running/healthy") return { value: state };
        if (state.startsWith("exited") || state.startsWith("dead") || state === "absent") return { failed: `container is ${state}` };
        return { waiting: state };
      });
      await waitForSshd(node.sshPort, Math.max(5000, deadline - Date.now()));
    }),
  );
}

interface KubeCondition {
  type: string;
  status: string;
}

interface KubeItem {
  name: string;
  phase: string;
  conditions: KubeCondition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kubeItems(json: string): KubeItem[] {
  const parsed: unknown = JSON.parse(json);
  const items = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return items.filter(isRecord).map((item) => {
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const status = isRecord(item.status) ? item.status : {};
    const conditions = Array.isArray(status.conditions) ? status.conditions.filter(isRecord) : [];
    return {
      name: typeof metadata.name === "string" ? metadata.name : "",
      phase: typeof status.phase === "string" ? status.phase : "",
      conditions: conditions.map((condition) => ({ type: String(condition.type), status: String(condition.status) })),
    };
  });
}

function isReady(item: KubeItem): boolean {
  return item.conditions.some((condition) => condition.type === "Ready" && condition.status === "True");
}

/** kubectl as root on a server node, with k3s's own admin kubeconfig (setup must have run). */
async function rootKubectl(topo: Topology, args: string[]): Promise<string> {
  const server = managersOf(topo)[0];
  if (!server) throw new Error(`Topology ${topo.name} has no server node`);
  return exec(["docker", "exec", server.container, "/usr/local/bin/k3s", "kubectl", ...args], { timeoutMs: 60_000 });
}

async function notReadyNodes(topo: Topology): Promise<string[]> {
  const nodes = kubeItems(await rootKubectl(topo, ["get", "nodes", "-o", "json"]));
  return topo.nodes
    .filter((node) => !nodes.some((item) => item.name === node.service && isReady(item)))
    .map((node) => node.service);
}

/** Wait until every node of the topology is registered under its hostname and Ready. */
export async function waitForNodesReady(topo: Topology, timeoutMs = 300_000): Promise<void> {
  log(`[k3s] Waiting for ${topo.nodes.length} Ready nodes...`);
  await poll<boolean>(`The ${topo.name} cluster did not have every node Ready`, timeoutMs, 3000, async () => {
    const missing = await notReadyNodes(topo);
    return missing.length === 0 ? { value: true } : { waiting: `not Ready: ${missing.join(", ")}` };
  });
}

/** Wait until the kube-system pods whose names start with each prefix exist and are all Ready. */
export async function waitForSystemPods(topo: Topology, prefixes: readonly string[], timeoutMs = 300_000): Promise<void> {
  log(`[k3s] Waiting for system pods: ${prefixes.join(", ")}...`);
  await poll<boolean>("kube-system pods did not become Ready", timeoutMs, 3000, async () => {
    const pods = kubeItems(await rootKubectl(topo, ["get", "pods", "-n", "kube-system", "-o", "json"]));
    const pending = prefixes.filter((prefix) => {
      const matching = pods.filter((pod) => pod.name.startsWith(`${prefix}-`));
      return matching.length === 0 || !matching.every((pod) => pod.phase === "Running" && isReady(pod));
    });
    return pending.length === 0 ? { value: true } : { waiting: `not Ready: ${pending.join(", ")}` };
  });
}

/** What is wrong with a provisioned topology: unhealthy containers, an API that does not answer, nodes not Ready. */
export async function clusterProblems(topo: Topology): Promise<string[]> {
  const problems: string[] = [];
  for (const node of topo.nodes) {
    const state = await containerState(node.container);
    if (state !== "running/healthy") problems.push(`${node.key} (${node.container}) is ${state}`);
  }
  if (problems.length > 0) return problems;
  try {
    const missing = await notReadyNodes(topo);
    if (missing.length > 0) problems.push(`nodes not Ready: ${missing.join(", ")}`);
  } catch (error) {
    problems.push(`the Kubernetes API does not answer on ${managersOf(topo)[0]?.key}: ${errorText(error).split("\n")[0]}`);
  }
  return problems;
}

export async function clusterHealthy(topo: Topology): Promise<boolean> {
  return (await clusterProblems(topo)).length === 0;
}

/** Fail at once, naming the cluster, when an earlier file left the shared cluster broken. */
export async function assertClusterHealthy(topo: Topology): Promise<void> {
  const problems = await clusterProblems(topo);
  if (problems.length > 0) {
    throw new Error(
      `The ${topo.name} cluster of project ${topo.project} is not healthy, so this file cannot run: ${problems.join("; ")}. ` +
        "An earlier file of the lane probably damaged it; see that file's debug dump",
    );
  }
}

// ─── dockflow setup k3s ────────────────────────────────────────────

export interface SetupK3sOptions {
  /** Linux binary shipped to the nodes (hidden `--binary` of `dockflow setup k3s`) */
  binary: string;
  env?: string;
  extraArgs?: readonly string[];
  timeoutMs?: number;
}

/**
 * Provision the cluster of a fixture's servers.yml exactly as a user does: root over SSH with the
 * bootstrap key, the binary under test on the nodes, no prompt.
 */
export function runSetupK3s(fixture: { dir: string }, opts: SetupK3sOptions): Promise<CLIResult> {
  return runCLI(
    [
      "setup", "k3s", opts.env ?? "e2e",
      "--ssh-user", "root",
      "--key", BOOTSTRAP_KEY_PATH,
      "--binary", opts.binary,
      "--yes",
      ...(opts.extraArgs ?? []),
    ],
    { cwd: fixture.dir, timeoutMs: opts.timeoutMs ?? 900_000 },
  );
}

// ─── Shared-lane guard ─────────────────────────────────────────────
//
// No file of a shared-cluster lane may damage cluster-level state (kubeconfig, k3s service, deploy
// identity, dockflow-system, StorageClass, sudoers, node set): a failure between "break" and
// "repair" would fail every later file for an unrelated reason. The lane preload installs the guard;
// harness helpers that run root commands or kubectl call the checks below. Stopping k3s is allowed
// only inside `allowingNodeDown` (the ha lane's withNodeDown).

let guardInstalled = false;
let nodeDownScopes = 0;

export function installSharedLaneGuard(): void {
  guardInstalled = true;
}

export async function allowingNodeDown<T>(fn: () => Promise<T>): Promise<T> {
  nodeDownScopes++;
  try {
    return await fn();
  } finally {
    nodeDownScopes--;
  }
}

const PROTECTED_PATHS = ["/var/lib/dockflow/kube", "/etc/rancher", "/etc/sudoers.d"];
const MUTATING_VERB =
  /(^|[\s;&|(`])(rm|mv|cp|tee|truncate|chmod|chown|chgrp|ln|install|touch|mkdir|rmdir|dd|shred|unlink|sed\s+(-[a-zA-Z]*i|--in-place))(?=\s|$)/;
const PROTECTED_REDIRECT = /[^<]>>?\s*['"]?(\/var\/lib\/dockflow\/kube|\/etc\/rancher|\/etc\/sudoers\.d)/;
const K3S_SERVICE_STOP = /\bsystemctl\s+(stop|disable|mask|kill)\s+(\S+\s+)*k3s(-agent)?(\.service)?\b/;
const K3S_DESTROY = /\bk3s-(killall|uninstall|agent-uninstall)\.sh\b/;

/** Why a root command would damage the shared cluster, or null. */
export function clusterDamage(command: string): string | null {
  if (K3S_DESTROY.test(command)) return "it kills or uninstalls k3s";
  if (K3S_SERVICE_STOP.test(command)) return "it stops the k3s service (only withNodeDown may, in the ha lane)";
  const touchesProtected = PROTECTED_PATHS.some((path) => command.includes(path));
  if (PROTECTED_REDIRECT.test(command) || (touchesProtected && MUTATING_VERB.test(command))) {
    return `it writes or moves a file under ${PROTECTED_PATHS.join(", ")}`;
  }
  return null;
}

/** Throws when the guard is installed and a root command on a node would damage the shared cluster. */
export function guardNodeCommand(command: string, user: "root" | "deploytest"): void {
  if (!guardInstalled || user !== "root") return;
  const reason = clusterDamage(command);
  if (reason === null) return;
  if (nodeDownScopes > 0 && K3S_SERVICE_STOP.test(command) && !K3S_DESTROY.test(command)) return;
  throw new Error(`Refusing \`${command}\` in a shared-cluster lane: ${reason}. Tests that break the cluster belong in the setup lane`);
}

const PROTECTED_OBJECTS = [
  /^(storageclass|storageclasses|sc)(\.storage\.k8s\.io)?\/dockflow-local$/,
  /^(namespace|namespaces|ns)\/dockflow-system$/,
  /^(node|nodes|no)\//,
];
/** kubectl flags whose value may follow as a separate argument */
const VALUE_FLAGS = new Set([
  "-n", "--namespace", "-l", "--selector", "-f", "--filename", "-o", "--output", "--field-selector",
  "--grace-period", "--timeout", "--context", "--kubeconfig",
]);

/** Throws when the guard is installed and harness kubectl would delete cluster-level Dockflow state. */
export function guardKubectl(args: readonly string[]): void {
  if (!guardInstalled || !args.includes("delete")) return;
  let namespace = "";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    if (flag === undefined || !flag.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    let value = inline;
    if (flag.startsWith("-n") && flag.length > 2 && !flag.startsWith("--")) value = flag.slice(2);
    else if (value === undefined && VALUE_FLAGS.has(flag)) value = args[++i];
    if (flag === "--namespace" || flag.startsWith("-n")) namespace = value ?? namespace;
  }
  const verbAt = positional.indexOf("delete");
  const [kind = "", ...names] = positional.slice(verbAt + 1);
  const targets = names.length > 0 ? names.map((name) => `${kind}/${name}`) : [kind];
  const protectedTarget = targets.some((target) => PROTECTED_OBJECTS.some((pattern) => pattern.test(target)));
  if (namespace === "dockflow-system" || protectedTarget) {
    const joined = args.join(" ");
    throw new Error(
      `Refusing \`kubectl ${joined}\` in a shared-cluster lane: it deletes cluster-level Dockflow state. Tests that break the cluster belong in the setup lane`,
    );
  }
}
