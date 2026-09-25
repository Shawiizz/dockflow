/**
 * Lane k3s-setup, E-71 (design-07 17.7; design-05 22.3 E3, E9, E10): a fresh 3-node cluster
 * (`setup-single`'s trio, on the setup lane's own network: <net>.11/.21/.22) provisioned with the
 * real coordinator flow (`dockflow setup k3s e2e --ssh-user root --key <bootstrap> --binary <bin>
 * --yes`), and the token-leak, identity and firewall checks that only make sense on a cluster nobody
 * else is touching.
 */

import { randomUUID } from "crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath } from "../../../helpers/cli";
import { exec, runSetupK3s, startTopology, stopTopology, tryExec, waitForNodesReady, type ExecResult } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture } from "../../../helpers/fixtures";
import { SETUP_LANE, serviceFor, topology, type NodeKey, type Topology } from "../../../helpers/topology";

const FILE = "71-setup-cluster.test.ts";
const DEPLOY_USER = "deploytest";

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

async function rootExec(node: NodeKey, command: string): Promise<ExecResult> {
  const container = topo.nodes.find((n) => n.key === node)?.container;
  if (!container) throw new Error(`no node ${node} in the setup-lane trio`);
  return tryExec(["docker", "exec", "--user", "root", container, "sh", "-c", command]);
}

async function mustRootExec(node: NodeKey, command: string): Promise<string> {
  const result = await rootExec(node, command);
  if (result.exitCode !== 0) throw new Error(`${node}: ${command} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function statOn(node: NodeKey, path: string): Promise<{ owner: string; group: string; mode: string } | null> {
  const result = await rootExec(node, `stat -c '%U %G %a' '${path}' 2>/dev/null`);
  if (result.exitCode !== 0) return null;
  const [owner, group, mode] = result.stdout.trim().split(/\s+/);
  return owner && group && mode ? { owner, group, mode } : null;
}

async function kubectlOn(args: string[]): Promise<string> {
  return exec(["docker", "exec", server1.container, "/usr/local/bin/k3s", "kubectl", ...args]);
}

/**
 * A cmdline poller local to this file (leak-watch.ts's helper is bound to `currentTopology()`, which
 * the setup lane never sets — see 74-setup-upgrade.test.ts and the dependency-defect note in the P84
 * report for the same reason). Same protocol: append every /proc cmdline every 100ms, grep on stop.
 */
function watchTokenLeaks(containers: readonly string[]): { stop(): Promise<string[]> } {
  const id = randomUUID().slice(0, 8);
  const file = `/tmp/e2e-cmdlines-${id}`;
  const pidFile = `${file}.pid`;
  const needle = /K10[0-9a-f]{20,}/;
  const script =
    `echo $$ > '${pidFile}'; : > '${file}'; ` +
    `while :; do for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done; sleep 0.1; done >> '${file}'`;
  const started = Promise.all(containers.map((container) => exec(["docker", "exec", "-d", container, "sh", "-c", script])));
  return {
    async stop(): Promise<string[]> {
      await started;
      const hits: string[] = [];
      for (const container of containers) {
        await tryExec(["docker", "exec", container, "sh", "-c", `kill "$(cat '${pidFile}' 2>/dev/null)" 2>/dev/null; true`]);
        const read = await tryExec(["docker", "exec", container, "cat", file]);
        if (read.exitCode === 0) {
          for (const line of read.stdout.split("\n")) if (needle.test(line)) hits.push(`${container}: ${line.trim()}`);
        }
        await tryExec(["docker", "exec", container, "rm", "-f", file, pidFile]);
      }
      return hits;
    },
  };
}

describe("E-71 setup-cluster (fresh trio)", () => {
  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("provisions the trio bare and runs dockflow setup k3s e2e", async () => {
    await withDump("provision", async () => {
      await startTopology(topo, { timeoutMs: 300_000 });

      const watch = watchTokenLeaks(topo.nodes.map((n) => n.container));
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      const leaks = await watch.stop();

      if (result.exitCode !== 0) throw new Error(`setup k3s failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);
      // E-71-01: summary lists the three nodes ready
      for (const node of topo.nodes) expect(result.stdout).toContain(node.key);

      // E-71-02: no K10... token in CLI stdout, and no leaked cmdline hit on any node
      expect(result.stdout).not.toMatch(/K10[0-9a-f]{20,}/);
      expect(leaks).toEqual([]);
      for (const node of topo.nodes) {
        const journal = await mustRootExec(node.key, "journalctl -u k3s -u k3s-agent --no-pager -n 2000 2>/dev/null || true");
        expect(journal).not.toMatch(/K10[0-9a-f]{20,}/);
      }

      await waitForNodesReady(topo, 300_000);
    });
  }, 600_000);

  test("E-71-03: agent and server token files, differing and correctly permissioned", async () => {
    await withDump("E-71-03", async () => {
      const serverStat = await statOn(server1.key, "/etc/rancher/k3s/dockflow/agent-token");
      expect(serverStat).toEqual({ owner: "root", group: "root", mode: "600" });
      const serverAgentToken = (await mustRootExec(server1.key, "cat /etc/rancher/k3s/dockflow/agent-token")).trim();

      for (const agent of [agent1, agent2]) {
        const stat = await statOn(agent.key, "/etc/rancher/k3s/dockflow/token");
        expect(stat).toEqual({ owner: "root", group: "root", mode: "600" });
        const agentToken = (await mustRootExec(agent.key, "cat /etc/rancher/k3s/dockflow/token")).trim();
        expect(agentToken).not.toBe(serverAgentToken);
        expect(agentToken.length).toBeGreaterThan(0);
      }
    });
  });

  test("E-71-04: node names, InternalIP and node_labels", async () => {
    await withDump("E-71-04", async () => {
      interface NodeJson {
        metadata: { name: string; labels?: Record<string, string> };
        status?: { addresses?: { type: string; address: string }[] };
      }
      const nodesJson = JSON.parse(await kubectlOn(["get", "nodes", "-o", "json"])) as { items: NodeJson[] };
      for (const node of topo.nodes) {
        const expectedName = serviceFor(node.key);
        const live = nodesJson.items.find((item) => item.metadata.name === expectedName);
        expect(live, `node ${expectedName} registered`).toBeDefined();
        const internal = live?.status?.addresses?.find((a) => a.type === "InternalIP")?.address;
        expect(internal).toBe(node.ip);
        for (const [key, value] of Object.entries(node.labels)) {
          expect(live?.metadata.labels?.[key]).toBe(value);
        }
      }
    });
  });

  test("E-71-05: the admin kubeconfig directory exists only on server-1", async () => {
    await withDump("E-71-05", async () => {
      expect(await statOn(server1.key, "/var/lib/dockflow/kube/config")).not.toBeNull();
      for (const agent of [agent1, agent2]) {
        expect(await statOn(agent.key, "/var/lib/dockflow/kube")).toBeNull();
      }
    });
  });

  test("E-71-06: the deploy user has no blanket sudo and is not in the docker group", async () => {
    await withDump("E-71-06", async () => {
      for (const node of topo.nodes) {
        const sudoList = await rootExec(node.key, `sudo -n -l -U ${DEPLOY_USER} 2>&1 || true`);
        expect(sudoList.stdout).not.toMatch(/NOPASSWD:\s*ALL/);
        const groups = await rootExec(node.key, `id -nG ${DEPLOY_USER} 2>&1 || true`);
        expect(groups.stdout.split(/\s+/)).not.toContain("docker");
      }
    });
  });

  test("E-71-07: ufw is inactive before and after, with no rules added", async () => {
    await withDump("E-71-07", async () => {
      for (const node of topo.nodes) {
        const status = await mustRootExec(node.key, "ufw status");
        expect(status).toMatch(/Status:\s*inactive/);
        const added = await mustRootExec(node.key, "ufw show added");
        expect(added.trim().split("\n").filter((l) => l.startsWith("ufw ")).length).toBe(0);
      }
    });
  });
});
