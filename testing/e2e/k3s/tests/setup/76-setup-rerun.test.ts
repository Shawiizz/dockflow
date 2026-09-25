/**
 * Lane k3s-setup, E-76 (design-07 17.7; design-05 22.3 E16): re-running setup repairs files an
 * operator (or another tool) removed or edited, and a host carrying the pre-D13 legacy sudo rules
 * gets exactly Dockflow's own file afterward, silently (no nginx installed, so nothing is left for
 * the summary to warn about; design-05 22.3 E16's no-nginx variant, not design-07's own paraphrase).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { renderK3sSudoers } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/sudoers";
import { resolveCliBinaryPath } from "../../../helpers/cli";
import { runSetupK3s, startStandaloneNode, startTopology, stopTopology, tryExec, waitForNodesReady, type ExecResult } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture } from "../../../helpers/fixtures";
import { SETUP_LANE, standaloneNode, topology, type Topology, type TopologyNode } from "../../../helpers/topology";

const FILE = "76-setup-rerun.test.ts";
const DEPLOY_USER = "deploytest";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

async function rootExec(container: string, command: string): Promise<ExecResult> {
  return tryExec(["docker", "exec", "--user", "root", container, "sh", "-c", command]);
}

async function mustRootExec(container: string, command: string): Promise<string> {
  const result = await rootExec(container, command);
  if (result.exitCode !== 0) throw new Error(`${container}: ${command} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function statOn(container: string, path: string): Promise<{ owner: string; group: string; mode: string } | null> {
  const result = await rootExec(container, `stat -c '%U %G %a' '${path}' 2>/dev/null`);
  if (result.exitCode !== 0) return null;
  const [owner, group, mode] = result.stdout.trim().split(/\s+/);
  return owner && group && mode ? { owner, group, mode } : null;
}

describe("E-76 setup-rerun: repairs and legacy sudoers", () => {
  const topo: Topology = topology("duo", SETUP_LANE);
  const [server1] = topo.nodes;

  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("provisions the duo once", async () => {
    await withDump("provision", async () => {
      await startTopology(topo, { timeoutMs: 300_000 });
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (result.exitCode !== 0) throw new Error(`initial setup failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);
      await waitForNodesReady(topo, 300_000);
    });
  }, 600_000);

  test("E-76-01: a deleted kubeconfig is recreated at 0600", async () => {
    await withDump("E-76-01", async () => {
      await rootExec(server1.container, "rm -f /var/lib/dockflow/kube/config");
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      expect(result.exitCode).toBe(0);
      const stat = await statOn(server1.container, "/var/lib/dockflow/kube/config");
      expect(stat).toEqual({ owner: DEPLOY_USER, group: DEPLOY_USER, mode: "600" });
    });
  }, 600_000);

  test("E-76-02: a deleted dockflow-k3s sudoers file is recreated identically", async () => {
    await withDump("E-76-02", async () => {
      const before = renderK3sSudoers(DEPLOY_USER);
      await rootExec(server1.container, "rm -f /etc/sudoers.d/dockflow-k3s");
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      expect(result.exitCode).toBe(0);
      const after = await mustRootExec(server1.container, "cat /etc/sudoers.d/dockflow-k3s");
      expect(after).toBe(before);
      const stat = await statOn(server1.container, "/etc/sudoers.d/dockflow-k3s");
      expect(stat?.mode).toBe("440");
    });
  }, 600_000);

  test("E-76-03: an edited config drop-in is never silently left edited", async () => {
    await withDump("E-76-03", async () => {
      await mustRootExec(server1.container, "sed -i '/secrets-encryption/d' /etc/rancher/k3s/config.yaml.d/50-dockflow.yaml");
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      const dropin = await mustRootExec(server1.container, "cat /etc/rancher/k3s/config.yaml.d/50-dockflow.yaml");
      if (result.exitCode === 0) {
        // repaired: the drop-in is restored and the run still reports success
        expect(dropin).toContain("secrets-encryption: true");
      } else {
        // refused: the edit is left as evidence, never silently accepted
        expect(dropin).not.toContain("secrets-encryption: true");
        expect(result.stderr + result.stdout).toMatch(/secrets.encryption|drift|encryption/i);
      }
    });
  }, 600_000);
});

describe("E-76-04 setup-rerun: pre-existing legacy sudo rules", () => {
  const node: TopologyNode = standaloneNode(SETUP_LANE, {
    key: "server_1",
    name: "rerun-legacy",
    octet: 42,
    sshPort: SETUP_LANE.sshPorts.server_2,
  });

  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("legacy sudoers with no nginx installed are fully replaced by dockflow-k3s", async () => {
    await withDump("E-76-04", async () => {
      await startStandaloneNode(SETUP_LANE, node, { timeoutMs: 180_000 });
      await mustRootExec(
        node.container,
        [
          "cat > /etc/sudoers.d/deploytest << 'EOF'",
          `${DEPLOY_USER} ALL=(ALL) NOPASSWD: /usr/local/bin/k3s ctr -n k8s.io images *`,
          `${DEPLOY_USER} ALL=(ALL) NOPASSWD: /bin/cat /var/lib/rancher/k3s/server/node-token`,
          "EOF",
          "chmod 440 /etc/sudoers.d/deploytest",
        ].join("\n"),
      );

      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.useNodes([node], { envs: ["e2e"] });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (result.exitCode !== 0) throw new Error(`setup failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);

      const legacyStat = await statOn(node.container, "/etc/sudoers.d/deploytest");
      expect(legacyStat).toBeNull();
      const dockflowRules = await mustRootExec(node.container, "cat /etc/sudoers.d/dockflow-k3s");
      expect(dockflowRules).toBe(renderK3sSudoers(DEPLOY_USER));
      const visudo = await rootExec(node.container, "visudo -c");
      expect(visudo.exitCode).toBe(0);
      // The legacy file is dropped inside the `sudoers` step itself (syncUserSudoers, K57b: no
      // nginx means no new user-scoped rule, so the file recognized as Dockflow's own is removed
      // outright); the later `legacy-sudoers` probe then finds nothing left to warn about, so —
      // unlike the nginx variant of design-05 22.3 E16 — the summary carries no legacy-rule warning.
      expect(result.stdout).not.toMatch(/legacy/i);

      const listDir = await mustRootExec(node.container, "ls /etc/sudoers.d");
      expect(listDir.split("\n").filter(Boolean)).toEqual(["dockflow-k3s"]);
    });
  }, 600_000);
});
