/**
 * Harness smoke test (P74's "done when"): the lane's topology booted, `dockflow setup k3s e2e`
 * (run by the lane preload) succeeded, and `dockflow status e2e` answers. Every later k3s-core file
 * builds on the same provisioned cluster; this is the file that proves there is one to build on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { clusterHealthy, clusterProblems } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { getJson, kubectl } from "../../../helpers/k8s";
import { currentTopology } from "../../../helpers/topology";

const FILE = "00-harness-smoke.test.ts";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

describe("harness smoke", () => {
  let fixture: Fixture | undefined;

  afterAll(() => {
    fixture?.cleanup();
  });

  test("the lane's topology is up and healthy", async () => {
    await withDump("topology healthy", async () => {
      const topo = currentTopology();
      expect(topo.nodes.length).toBeGreaterThan(0);
      const problems = await clusterProblems(topo);
      expect(problems).toEqual([]);
      expect(await clusterHealthy(topo)).toBe(true);
    });
  });

  test("harness kubectl reaches the API server and sees every node Ready", async () => {
    await withDump("kubectl reaches the API", async () => {
      const topo = currentTopology();
      const names = await kubectl(["get", "nodes", "-o", "name"]);
      const lines = names.trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(topo.nodes.length);

      interface NodeLike {
        metadata: { name: string };
        status?: { conditions?: { type: string; status: string }[] };
      }
      const nodes = await getJson<NodeLike>("nodes");
      for (const node of topo.nodes) {
        const live = nodes.find((n) => n.metadata.name === node.service);
        expect(live).toBeDefined();
        const ready = live?.status?.conditions?.find((c) => c.type === "Ready");
        expect(ready?.status).toBe("True");
      }
    });
  });

  test("dockflow status e2e answers", async () => {
    await withDump("dockflow status", async () => {
      fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s" });
      const result = await runCLI(["status", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("e2e");
    });
  });
});
