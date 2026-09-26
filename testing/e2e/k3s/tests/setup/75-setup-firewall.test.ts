/**
 * Lane k3s-setup, E-75 (design-07 17.7; design-05 22.3 E9, E24): ufw enabled before setup gets
 * exactly the interface-scoped rules of design-05 14.1/14.2 — peer-sourced cluster ports plus the pod
 * and service CIDRs bound to cni0/flannel.1, never an un-scoped "from anywhere" rule for them — while
 * the cluster still works through it and a published Service port still bypasses it (DESIGN-CORE 11).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "bun:test";
import { parseUfwShowAdded } from "../../../../../cli/src/commands/setup/k3s/firewall";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { writeK3sDockflowEnv } from "../../../helpers/connection";
import { exec, runSetupK3s, startTopology, stopTopology, tryExec, waitForNodesReady } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture, serversYml } from "../../../helpers/fixtures";
import { auxContainer, SETUP_LANE, topology, type Topology } from "../../../helpers/topology";

const FILE = "75-setup-firewall.test.ts";
const ENV = "e2e";

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
const outsider = auxContainer(topo.project, "outsider");
const LB_HOST_PORT = 18095;

async function mustRootExec(container: string, command: string): Promise<string> {
  return exec(["docker", "exec", "--user", "root", container, "sh", "-c", command]);
}

async function ufwShowAdded(container: string): Promise<string> {
  return mustRootExec(container, "ufw show added");
}

describe("E-75 setup-firewall", () => {
  let fixtureDir: string | undefined;

  afterAll(async () => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    await stopTopology(SETUP_LANE.project);
  });

  test("E-75-01: ufw is enabled on every node before setup", async () => {
    await withDump("E-75-01", async () => {
      await startTopology(topo, { timeoutMs: 300_000 });
      for (const node of topo.nodes) {
        await mustRootExec(node.container, "ufw allow 22/tcp && ufw --force enable");
        const status = await mustRootExec(node.container, "ufw status");
        expect(status).toMatch(/Status:\s*active/);
      }
    });
  }, 300_000);

  test("E-75-02: setup leaves only the documented, interface-scoped, peer-sourced rules", async () => {
    await withDump("E-75-02", async () => {
      const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: topo });
      const result = await runSetupK3s(fixture, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (result.exitCode !== 0) throw new Error(`setup failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);
      await waitForNodesReady(topo, 300_000);

      for (const node of topo.nodes) {
        const { rules, unrecognised } = parseUfwShowAdded(await ufwShowAdded(node.container));
        expect(unrecognised).toEqual([]);
        const podRule = rules.find((r) => r.id === "pods");
        const serviceRule = rules.find((r) => r.id === "services");
        expect(podRule?.source).toBe("10.42.0.0/16");
        expect(podRule?.iface).not.toBeNull();
        expect(serviceRule?.source).toBe("10.43.0.0/16");
        expect(serviceRule?.iface).not.toBeNull();

        const kubelet = rules.find((r) => r.id === "kubelet");
        expect(kubelet?.ports).toBe("10250");
        expect(kubelet?.source).not.toBe("any");
        const vxlan = rules.find((r) => r.id === "vxlan");
        expect(vxlan?.proto).toBe("udp");
        expect(vxlan?.ports).toBe("8472");
        expect(vxlan?.source).not.toBe("any");

        if (node.role === "manager") {
          const apiserver = rules.find((r) => r.id === "apiserver");
          expect(apiserver?.ports).toBe("6443");
          expect(apiserver?.source).not.toBe("any");
        }
        // no un-scoped "from anywhere" rule for the cluster ports
        for (const rule of rules) {
          if (["apiserver", "kubelet", "vxlan"].includes(rule.id)) expect(rule.source).not.toBe("any");
        }
      }
    });
  }, 600_000);

  test("E-75-03: 6443 is unreachable from outside the cluster, reachable from a peer", async () => {
    await withDump("E-75-03", async () => {
      const fromOutsider = await tryExec([
        "docker", "exec", outsider, "curl", "-k", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--max-time", "3", `https://${server1.ip}:6443/readyz`,
      ]);
      expect(fromOutsider.exitCode).not.toBe(0);

      const fromPeer = await tryExec([
        "docker", "exec", agent1.container, "curl", "-k", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--max-time", "5", `https://${server1.ip}:6443/readyz`,
      ]);
      expect(fromPeer.exitCode).toBe(0);
      // the API server answered: 401, since k3s serves no anonymous requests, not a timeout
      expect(fromPeer.stdout.trim()).toBe("401");
    });
  }, 60_000);

  test("E-75-04 & E-75-05: cross-node pod traffic works and the published LB port bypasses ufw", async () => {
    await withDump("E-75-04-05", async () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "dockflow-e2e-k3s-firewall-"));
      mkdirSync(join(fixtureDir, ".dockflow", "docker"), { recursive: true });
      writeFileSync(join(fixtureDir, ".dockflow", "config.yml"), "project_name: k3s-firewall\norchestrator: k3s\n");
      writeFileSync(
        join(fixtureDir, ".dockflow", "docker", "docker-compose.yml"),
        ["services:", "  web:", "    image: nginx:alpine", "    ports:", `      - "${LB_HOST_PORT}:80"`, "    deploy:", "      replicas: 2", ""].join("\n"),
      );
      writeFileSync(join(fixtureDir, ".dockflow", "servers.yml"), serversYml(topo.nodes, [ENV]));
      writeK3sDockflowEnv(fixtureDir, topo.nodes, { envs: [ENV] });

      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixtureDir, timeoutMs: 300_000 });
      if (deploy.exitCode !== 0) throw new Error(`deploy failed (exit ${deploy.exitCode}): ${deploy.stderr.slice(-4000) || deploy.stdout.slice(-4000)}`);
      expect(deploy.exitCode).toBe(0);

      // E-75-04: the Service is reachable through the LB port from a peer node whether or not the
      // local replica handles it — proves cross-node pod traffic, not just loopback.
      for (const node of [server1, agent1, agent2]) {
        const fromNode = await tryExec(["docker", "exec", node.container, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${LB_HOST_PORT}/`]);
        expect(fromNode.stdout.trim()).toBe("200");
      }

      // E-75-05: reachable from outside the cluster too, despite ufw's default-deny, because
      // published ServiceLB ports bind directly and bypass the host firewall (DESIGN-CORE 11).
      const fromOutsider = await tryExec(["docker", "exec", outsider, "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://${server1.ip}:${LB_HOST_PORT}/`]);
      expect(fromOutsider.stdout.trim()).toBe("200");
    });
  }, 400_000);
});
