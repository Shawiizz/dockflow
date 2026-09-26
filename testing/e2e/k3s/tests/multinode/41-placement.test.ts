/**
 * k3s-multinode / 41-placement (design-07 17.4 E-41): node names and labels, and every placement
 * form (label constraint, spread preference, max_replicas_per_node, role constraint, arch constraint,
 * x-dockflow tolerations + node_selector against a tainted node).
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Node } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";
import { getJson, kubectl, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";

const ENV = "e2e";
const NS = nsFor("k3s-multi", ENV);
const TAINT = "dedicated=db:NoSchedule";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`41-placement.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

function nodesOf(pods: { spec: { nodeName?: string } }[]): string[] {
  return pods.map((p) => p.spec.nodeName ?? "").filter(Boolean);
}

describe("placement", () => {
  let fixture: Fixture;

  afterAll(async () => {
    fixture?.cleanup();
    await kubectl(["taint", "node", "agent-2", `${TAINT}-`], { allowFailure: true });
  });

  test("node names and zone labels", async () => {
    await withDump("node names and labels", async () => {
      const nodes = await getJson<Node>("nodes");
      const names = nodes.map((n) => n.metadata.name).sort();
      expect(names).toEqual(["agent-1", "agent-2", "server-1"]);

      const byName = new Map(nodes.map((n) => [n.metadata.name, n]));
      expect(byName.get("agent-1")?.metadata.labels?.zone).toBe("a");
      expect(byName.get("agent-2")?.metadata.labels?.zone).toBe("b");
    });
  }, 60_000);

  test("a node.labels constraint schedules only on the matching node", async () => {
    await withDump("zone-b constraint", async () => {
      fixture = await multinodeFixture();
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "zone-b", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "zone-b", 2, 120_000);

      const pods = await podsForService(NS, "zone-b");
      expect(nodesOf(pods)).toEqual(["agent-2", "agent-2"]);
    });
  }, 180_000);

  test("a spread preference places pods in both zones", async () => {
    await withDump("spread preference", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "spread", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "spread", 4, 120_000);

      const pods = await podsForService(NS, "spread");
      const nodeNames = new Set(nodesOf(pods));
      expect(nodeNames.has("agent-1")).toBe(true);
      expect(nodeNames.has("agent-2")).toBe(true);
    });
  }, 180_000);

  test("max_replicas_per_node spreads one pod onto every node", async () => {
    await withDump("one-per-node", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "one-per-node", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "one-per-node", 3, 120_000);

      const pods = await podsForService(NS, "one-per-node");
      expect(new Set(nodesOf(pods)).size).toBe(3);
    });
  }, 180_000);

  test("node.role constraints separate managers from workers", async () => {
    await withDump("managers and workers", async () => {
      const managers = await runCLI(["deploy", ENV, "1.0.0", "--only", "managers,workers", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(managers.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "managers", 1, 120_000);
      await waitWorkloadReady(NS, "deployment", "workers", 2, 120_000);

      const managerPods = await podsForService(NS, "managers");
      expect(nodesOf(managerPods)).toEqual(["server-1"]);

      const workerPods = await podsForService(NS, "workers");
      for (const node of nodesOf(workerPods)) expect(["agent-1", "agent-2"]).toContain(node);
    });
  }, 180_000);

  test("a node.platform.arch constraint schedules the amd64 workload", async () => {
    await withDump("amd64 constraint", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "amd64", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "amd64", 1, 120_000);
    });
  }, 180_000);

  test("x-dockflow tolerations let a pod land on a tainted, selected node", async () => {
    await withDump("tolerant on tainted agent-2", async () => {
      await kubectl(["taint", "node", "agent-2", TAINT]);
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "tolerant", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "tolerant", 1, 120_000);

      const pods = await podsForService(NS, "tolerant");
      expect(nodesOf(pods)).toEqual(["agent-2"]);
    });
  }, 180_000);
});
