/**
 * N-WG-01 (design-07 17.8): a cluster whose nodes only share a non-RFC1918 address
 * (198.51.100.0/24, TEST-NET-2) is "public" address mode (design-05 2.2), which forces the
 * `wireguard-native` flannel backend (D19) instead of `vxlan`. This needs a bridge network of its
 * own — the shared lanes' `/24` (10.197.30.0/24 by default) is an RFC1918 range, so `servers.yml.private_host` on it
 * would always read as "private" — so, unlike every other nightly file, this one does not reuse
 * `TOPOLOGIES.duo`/project `dockflow-k3s`; it builds its own topology on its own project and talks to
 * `helpers/k8s.ts` only through the plain `docker exec` plumbing below, since that module's assertion
 * helpers resolve the *shared* lanes' topology by name (`currentTopology()`), not a custom one.
 *
 * `servers.yml` carries `host: <bridge ip>` and no `private_host`, so `privateIp(node)` (design-05
 * 2.2) falls through to the `isPrivate(host)` check and comes back null — SSH therefore goes straight
 * to the container's bridge address on its real port 22 rather than a published host port, which only
 * a Linux Docker Engine host routes to directly (this file is Linux-only, like the setup and ha lanes).
 */

import { readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { exec, runSetupK3s, startTopology, stopTopology, tryExec, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { DEPLOY_KEY_PATH, DEPLOY_USER, connectionEnvKey, encodeConnection } from "../../../helpers/connection";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { nsFor } from "../../../helpers/k8s";
import { managersOf, nodeFor, topology, type NetworkPlan, type NodeKey, type Topology } from "../../../helpers/topology";

const FILE = "84-wireguard.test.ts";
const PROJECT = "nightly-wireguard";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);

const WG_PLAN: NetworkPlan = {
  project: "dockflow-k3s-nightly-wg",
  net: "198.51.100",
  sshPorts: { server_1: 32255, server_2: 32256, server_3: 32257, agent_1: 32258, agent_2: 32259 },
};
const TOPO: Topology = topology("duo", WG_PLAN);

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function nodeShell(key: NodeKey, command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const node = nodeFor(TOPO, key);
  return tryExec(["docker", "exec", "--user", "root", node.container, "sh", "-c", command]);
}

async function nodeKubectl(args: string[]): Promise<string> {
  const server = managersOf(TOPO)[0];
  if (!server) throw new Error(`Topology ${TOPO.name} has no manager node`);
  return exec(["docker", "exec", server.container, "/usr/local/bin/k3s", "kubectl", ...args]);
}

interface NodeLike {
  metadata: { name: string; annotations?: Record<string, string> };
}

interface PodLike {
  metadata: { name: string };
  status?: { phase?: string; podIP?: string };
  spec?: { nodeName?: string };
}

function serversYml(): string {
  const lines = ["defaults:", `  user: ${DEPLOY_USER}`, "servers:"];
  for (const node of TOPO.nodes) {
    lines.push(`  ${node.key}:`, `    host: ${node.ip}`, "    port: 22", `    role: ${node.role}`, "    tags: [e2e]");
  }
  return `${lines.join("\n")}\n`;
}

function envDockflow(): string {
  const privateKey = readFileSync(DEPLOY_KEY_PATH, "utf-8");
  const lines = TOPO.nodes.map((node) => {
    const conn = { host: node.ip, port: 22, user: DEPLOY_USER, privateKey };
    return `${connectionEnvKey(ENV, node.key)}=${encodeConnection(conn)}`;
  });
  return `${lines.join("\n")}\n`;
}

function configYml(): string {
  return [`project_name: ${PROJECT}`, "orchestrator: k3s", "stack_management:", "  keep_releases: 2", ""].join("\n");
}

/** `max_replicas_per_node: 1` (E-41-04's trait) pins the two replicas to the two different nodes deterministically. */
function composeYml(): string {
  return [
    "services:",
    "  spread:",
    "    image: docker.io/library/nginx:alpine",
    "    deploy:",
    "      replicas: 2",
    "    x-dockflow:",
    "      max_replicas_per_node: 1",
    "",
  ].join("\n");
}

describe("nightly: wireguard", () => {
  let fixture: Fixture | undefined;

  beforeAll(async () => {
    await stopTopology(WG_PLAN.project);
    await startTopology(TOPO, { timeoutMs: 600_000 });

    // Firewall rules are only ever written onto an already-active ufw (design-07 E-71-07): enable it
    // first so this scenario can assert setup added the wireguard rule to it.
    for (const node of TOPO.nodes) {
      const enable = await nodeShell(node.key, "ufw allow 22/tcp && ufw --force enable");
      if (enable.exitCode !== 0) throw new Error(`ufw enable failed on ${node.key}: ${enable.stderr || enable.stdout}`);
    }

    const binary = resolveCliBinaryPath();
    fixture = makeFixture("test-app-k3s-cluster");
    fixture.write(".dockflow/servers.yml", serversYml());
    fixture.write(".env.dockflow", envDockflow());
    fixture.write(".dockflow/config.yml", configYml());
    fixture.write(".dockflow/docker/docker-compose.yml", composeYml());

    const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
    if (setup.exitCode !== 0) {
      await dumpDebug(`${FILE}:setup`).catch(() => {});
      throw new Error(`dockflow setup k3s exited ${setup.exitCode} on the public/wireguard topology:\n${setup.stderr.slice(-4000)}`);
    }
    await waitForNodesReady(TOPO, 300_000);
    await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);
  });

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      fixture.cleanup();
    }
    await stopTopology(WG_PLAN.project);
  });

  test("N-WG-01: wireguard-native is chosen, its firewall rule is written, and cross-node pod traffic works", async () => {
    await withDump("wireguard", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");

      const nodesJson: unknown = JSON.parse(await nodeKubectl(["get", "nodes", "-o", "json"]));
      const nodeItems = (nodesJson as { items?: NodeLike[] }).items ?? [];
      for (const server of managersOf(TOPO)) {
        const live = nodeItems.find((item) => item.metadata.name === server.service);
        expect(live).toBeDefined();
        const backend = live?.metadata.annotations?.["flannel.alpha.coreos.com/backend-type"] ?? "";
        expect(backend).toContain("wireguard");
      }

      for (const node of TOPO.nodes) {
        const ufw = await nodeShell(node.key, "ufw status");
        expect(ufw.stdout).toContain("51820/udp");
      }

      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixture.dir, timeoutMs: 300_000 });
      expect(deploy.exitCode).toBe(0);

      const podsJson: unknown = JSON.parse(await nodeKubectl(["get", "pods", "-n", NS, "-o", "json"]));
      const pods = ((podsJson as { items?: PodLike[] }).items ?? []).filter((pod) => pod.status?.phase === "Running");
      expect(pods.length).toBe(2);
      const nodeNames = new Set(pods.map((pod) => pod.spec?.nodeName));
      expect(nodeNames.size).toBe(2);

      for (const from of TOPO.nodes) {
        for (const pod of pods) {
          if (pod.spec?.nodeName === from.service || !pod.status?.podIP) continue;
          const curl = await nodeShell(
            from.key,
            `curl -4 -s -o /dev/null -w '%{http_code}' --max-time 5 http://${pod.status.podIP}/`,
          );
          expect(curl.stdout.trim()).toBe("200");
        }
      }
    });
  });
});
