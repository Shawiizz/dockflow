/**
 * N-ARM-01 (design-07 17.8): the node image and pins work end to end on whatever architecture this
 * runner is — arm64 in the nightly workflow's own job matrix, which picks the architecture, never this
 * file. `nightly` provisions nothing itself (k3s/lanes.ts: `topology: null`), so this file is
 * responsible for its own cluster, exactly like a setup-lane file: it starts the shared lanes' own
 * `duo` topology (project `dockflow-k3s`) rather than a topology of its own, because the chart server
 * package-charts.ts baked at preload time already points at that project's fixed address (172.30.0.7).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { runSetupK3s, startTopology, stopTopology, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, imagesOnNode, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";
import { TOPOLOGIES } from "../../../helpers/topology";

const FILE = "80-arm64-smoke.test.ts";
const PROJECT = "nightly-arm64-smoke";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const TOPO = TOPOLOGIES.duo;

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

function configYml(): string {
  return ["project_name: nightly-arm64-smoke", "orchestrator: k3s", "stack_management:", "  keep_releases: 2", ""].join("\n");
}

function composeYml(): string {
  return ["services:", "  web:", "    image: docker.io/library/nginx:alpine", "    deploy:", "      replicas: 2", ""].join("\n");
}

describe("nightly: arm64 smoke", () => {
  let fixture: Fixture | undefined;

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await deleteStackCompletely(NS).catch(() => {});
      fixture.cleanup();
    }
    await stopTopology();
    delete process.env.DOCKFLOW_E2E_TOPOLOGY;
  });

  test("the node image and pins bring up a cluster and a basic deploy converges", async () => {
    await withDump("smoke", async () => {
      await stopTopology();
      await startTopology(TOPO, { timeoutMs: 600_000 });
      process.env.DOCKFLOW_E2E_TOPOLOGY = TOPO.name;

      const binary = resolveCliBinaryPath();
      fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: TOPO });
      fixture.write(".dockflow/config.yml", configYml());
      fixture.write(".dockflow/docker/docker-compose.yml", composeYml());

      const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
      expect(setup.exitCode).toBe(0);
      await waitForNodesReady(TOPO, 300_000);
      await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);

      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixture.dir, timeoutMs: 300_000 });
      expect(deploy.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 2, 180_000);

      const pods = await podsForService(NS, "web");
      expect(pods.length).toBe(2);

      for (const node of TOPO.nodes) {
        const images = await imagesOnNode(node.key);
        expect(images.some((image) => image.ref.includes("nginx") && image.pinned)).toBe(true);
      }

      const status = await runCLI(["status", ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(ENV);
    });
  });
});
