/**
 * Lane k3s-setup, E-72 (design-07 17.7): one node blocked from the API port fails setup without
 * touching the nodes that succeeded, and a clean re-run after the block is lifted completes without
 * redoing the already-provisioned server.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath } from "../../../helpers/cli";
import { exec, runSetupK3s, startTopology, stopTopology, tryExec, waitForNodesReady } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture } from "../../../helpers/fixtures";
import { SETUP_LANE, topology, type Topology } from "../../../helpers/topology";

const FILE = "72-setup-partial-failure.test.ts";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

const topo: Topology = topology("trio", SETUP_LANE);
const [server1, agent1, agent2] = topo.nodes;

async function mustRootExec(container: string, command: string): Promise<string> {
  return exec(["docker", "exec", "--user", "root", container, "sh", "-c", command]);
}

describe("E-72 setup-partial-failure", () => {
  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("E-72-01: agent-2 blocked from 6443 fails the run without a success line", async () => {
    await withDump("E-72-01", async () => {
      await startTopology(topo, { timeoutMs: 300_000 });
      await mustRootExec(agent2.container, "iptables -I OUTPUT -p tcp --dport 6443 -j DROP");

      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });

      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/is ready/);
      const summary = result.stderr;
      expect(summary).toMatch(new RegExp(`${server1.key}\\s+\\S+\\s+\\S+\\s+ok`));
      expect(summary).toMatch(new RegExp(`${agent1.key}\\s+\\S+\\s+\\S+\\s+ok`));
      expect(summary).toMatch(new RegExp(`${agent2.key}\\s+\\S+\\s+\\S+\\s+failed`));
    });
  }, 600_000);

  test("E-72-02: removing the rule and re-running succeeds with server-1 untouched", async () => {
    await withDump("E-72-02", async () => {
      const before = await mustRootExec(server1.container, "systemctl show k3s -p ActiveEnterTimestamp");

      await mustRootExec(agent2.container, "iptables -D OUTPUT -p tcp --dport 6443 -j DROP");

      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (result.exitCode !== 0) throw new Error(`re-run failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);

      await waitForNodesReady(topo, 300_000);
      const after = await mustRootExec(server1.container, "systemctl show k3s -p ActiveEnterTimestamp");
      expect(after).toBe(before);

      const namesResult = await tryExec(["docker", "exec", server1.container, "/usr/local/bin/k3s", "kubectl", "get", "nodes", "-o", "name"]);
      expect(namesResult.stdout.trim().split("\n").filter(Boolean).length).toBe(3);
    });
  }, 600_000);
});
