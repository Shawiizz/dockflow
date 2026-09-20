/**
 * Lane preload (design-07 16.9): prepares the binaries, the node image and the charts once, then —
 * for a lane with a shared topology — provisions its cluster with the real `dockflow setup k3s e2e`,
 * exactly as an operator would run it.
 *
 * Loaded two ways:
 * - as `bunfig.toml`'s `[test].preload`, once per `bun test` process `run.ts` spawns (one per file);
 *   `DOCKFLOW_E2E_PREPARED=1` (set by `run.ts` after its own call to `prepareLane`) makes every file's
 *   own preload skip straight to asserting the already-provisioned cluster is healthy;
 * - imported by `run.ts` itself, which calls `prepareLane` once before spawning any file.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { Lane } from "./lanes";
import { LANES, LANE_NAMES, isLaneName } from "./lanes";
import { packageCharts } from "./tools/package-charts";
import {
  assertClusterHealthy,
  clusterHealthy,
  ensureNodeImage,
  exec,
  installSharedLaneGuard,
  runSetupK3s,
  stopTopology,
  startTopology,
  waitForNodesReady,
  waitForSystemPods,
  writeAuthFiles,
} from "../helpers/cluster";
import { getCliBinaryName, type CLIResult } from "../helpers/cli";
import { dumpDebug } from "../helpers/debug-dump";
import { makeFixture } from "../helpers/fixtures";
import { TOPOLOGIES } from "../helpers/topology";

const CLI_DIR = join(import.meta.dir, "..", "..", "..", "cli");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function tail(result: Pick<CLIResult, "stdout" | "stderr">): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-4000);
}

/** The host-platform binary the tests spawn: DOCKFLOW_E2E_BINARY, or built locally on demand. */
async function ensureCliBinary(): Promise<string> {
  if (process.env.DOCKFLOW_E2E_BINARY) return process.env.DOCKFLOW_E2E_BINARY;
  const path = join(CLI_DIR, "dist", getCliBinaryName());
  if (existsSync(path)) return path;
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: CLI_DIR, timeoutMs: 180_000 });
  const target = getCliBinaryName().replace("dockflow-", "").replace(/\.exe$/, "");
  await exec(["bun", "run", "build", target], { cwd: CLI_DIR, timeoutMs: 180_000 });
  return path;
}

/**
 * The Linux binary shipped to the nodes (design-05's hidden `--binary`, K59): DOCKFLOW_E2E_BINARY
 * (CI: already the release artifact under test, linux-x64), the same file as `ensureCliBinary` on a
 * linux-x64 host, or a cross-build on Windows/macOS (16.12).
 */
async function ensureLinuxBinary(): Promise<string> {
  if (process.env.DOCKFLOW_E2E_BINARY) return process.env.DOCKFLOW_E2E_BINARY;
  if (process.platform === "linux" && process.arch === "x64") return ensureCliBinary();
  const path = join(CLI_DIR, "dist", "dockflow-linux-x64");
  await exec(["bun", "install", "--frozen-lockfile"], { cwd: CLI_DIR, timeoutMs: 180_000 });
  await exec(["bun", "run", "build", "linux-x64"], { cwd: CLI_DIR, timeoutMs: 180_000 });
  return path;
}

/**
 * Prepares a lane: binaries, node image, charts, and — when the lane owns a shared topology — a
 * freshly provisioned cluster (or the already-healthy one, with DOCKFLOW_E2E_REUSE=1).
 */
export async function prepareLane(lane: Lane): Promise<void> {
  await ensureCliBinary();
  const nodeBinary = await ensureLinuxBinary();
  await ensureNodeImage();
  await writeAuthFiles();
  await packageCharts();

  if (!lane.topology) return; // k3s-setup, nightly: each file provisions what it needs itself

  const topo = TOPOLOGIES[lane.topology];
  const reuse = process.env.DOCKFLOW_E2E_REUSE === "1" && (await clusterHealthy(topo));
  if (reuse) {
    log(`[setup] reusing the already-healthy ${topo.name} cluster (DOCKFLOW_E2E_REUSE=1).`);
    return;
  }

  await stopTopology();
  await startTopology(topo);
  const cluster = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
  log(`[setup] provisioning ${topo.name} with dockflow setup k3s e2e...`);
  const result = await runSetupK3s(cluster, { binary: nodeBinary, timeoutMs: 900_000 });
  if (result.exitCode !== 0) {
    await dumpDebug("preload-setup");
    throw new Error(`dockflow setup k3s failed for topology ${topo.name} (exit ${result.exitCode}):\n${tail(result)}`);
  }
  await waitForNodesReady(topo, 300_000);
  await waitForSystemPods(topo, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);
  log(`[setup] ${topo.name} cluster ready.`);
}

// ─── bunfig.toml preload ────────────────────────────────────────────
// A file run by hand (`bun test tests/core/...test.ts`) prepares its own lane; run.ts has already
// done it for a file it spawns (DOCKFLOW_E2E_PREPARED=1), so this just re-attaches to it.
//
// run.ts imports `prepareLane` from this same module to call it once up front (16.9); it sets
// DOCKFLOW_E2E_SETUP_IMPORT_ONLY first (and clears it right after) so that one import evaluation
// does not also run the block below a second time in run.ts's own process.

function requireLane(): Lane & { name: string } {
  const name = process.env.DOCKFLOW_E2E_LANE;
  if (!name) {
    throw new Error(
      "DOCKFLOW_E2E_LANE is not set; run this file through its lane (bun run run.ts <lane>) or export DOCKFLOW_E2E_LANE yourself",
    );
  }
  if (!isLaneName(name)) throw new Error(`DOCKFLOW_E2E_LANE is ${name}; expected one of ${LANE_NAMES.join(", ")}`);
  return { ...LANES[name], name };
}

if (process.env.DOCKFLOW_E2E_SETUP_IMPORT_ONLY !== "1") {
  const lane = requireLane();
  if (process.env.DOCKFLOW_E2E_PREPARED !== "1") await prepareLane(lane);
  if (lane.topology) {
    const topo = TOPOLOGIES[lane.topology];
    await assertClusterHealthy(topo);
    installSharedLaneGuard();
    process.env.DOCKFLOW_E2E_TOPOLOGY = topo.name;
  }
}
