/**
 * N-OFFLINE-01 (design-07 17.8): setup, a proxy deploy and a Helm release from the local charts
 * container all succeed with the lane network cut off from the internet — proving nothing in the
 * gated path needs a download it did not already verify and cache (16.1's offline-by-default design).
 *
 * docker-compose.k3s.yml (P11-owned) has no `internal: true` toggle, so egress is cut at the host's
 * iptables instead: one `DOCKER-USER` rule drops everything the lane's own subnet sends outside
 * itself, which never touches another project's network and is removed in `afterAll` regardless of
 * outcome. Nothing baked or cached is cleared (the opposite of 81-online-sources), so every download
 * this scenario needs is already local.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { exec, runSetupK3s, startTopology, stopTopology, tryExec, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { curlFrom, deleteStackCompletely, helm, nsFor, waitFor } from "../../../helpers/k8s";
import { chartRepoUrl, SHARED_LANE, TOPOLOGIES } from "../../../helpers/topology";
import { TRAEFIK_CHART_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/versions";

const FILE = "82-offline-canary.test.ts";
const PROJECT = "nightly-offline";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const TOPO = TOPOLOGIES.duo;
const PROXY_DOMAIN = "nightly-offline.e2e.test";
const SUBNET = `${SHARED_LANE.net}.0/24`;
const EGRESS_DROP_RULE = ["DOCKER-USER", "-s", SUBNET, "!", "-d", SUBNET, "-j", "DROP"];

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

/**
 * Dockflow pins Traefik by its index digest, which a node image carries only when it was baked from
 * Docker's containerd image store: the classic store saves the platform image alone, and an offline
 * deploy then waits on a pull that cannot happen.
 */
async function assertTraefikBakedByDigest(): Promise<void> {
  const digest = TRAEFIK_CHART_PIN.imageDigest;
  if (!digest) return;
  const blob = `blobs/sha256/${digest.replace(/^sha256:/, "")}`;
  const listed = await tryExec([
    "docker", "exec", TOPO.nodes[0].container, "sh", "-c",
    `for archive in /var/lib/rancher/k3s/agent/images/e2e-images-*.tar; do tar -tf "$archive"; done | grep -Fqx '${blob}'`,
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(
      `The node image lacks Traefik's index ${digest}: it was baked from Docker's classic image store. ` +
        'Enable the containerd image store ("features": {"containerd-snapshotter": true} in /etc/docker/daemon.json), ' +
        "then rebuild the node image with prepare-images.ts and build-node-image.ts.",
    );
  }
}

/** sudo cannot ask for a password in the middle of a run: it must hold the credentials already */
async function blockEgress(): Promise<void> {
  if ((await tryExec(["sudo", "-n", "true"])).exitCode !== 0) {
    throw new Error(`${FILE} inserts a host iptables rule with sudo: run \`sudo -v\` in this terminal, then start it again.`);
  }
  await exec(["sudo", "-n", "iptables", "-I", ...EGRESS_DROP_RULE]);
}

async function allowEgress(): Promise<void> {
  const removed = await tryExec(["sudo", "-n", "iptables", "-D", ...EGRESS_DROP_RULE]);
  if (removed.exitCode !== 0) {
    process.stderr.write(`warning: the egress rule of ${FILE} is still in place; remove it with: sudo iptables -D ${EGRESS_DROP_RULE.join(" ")}\n`);
  }
}

function configYml(): string {
  return [
    `project_name: ${PROJECT}`,
    "orchestrator: k3s",
    "proxy:",
    "  enabled: true",
    "  acme: false",
    "  domains:",
    `    ${ENV}: ${PROXY_DOMAIN}`,
    "helm:",
    "  releases:",
    "    - name: data",
    "      role: accessory",
    "      chart: e2e-web",
    `      repo: ${chartRepoUrl(SHARED_LANE.net, "public")}`,
    "      version: 0.1.0",
    "      values:",
    "        message: offline-canary",
    "",
  ].join("\n");
}

/** `ports` is what gets the default route injected (design-01 7.5) */
function composeYml(): string {
  return ["services:", "  web:", "    image: docker.io/library/nginx:alpine", "    ports:", '      - "8080:80"', "    deploy:", "      replicas: 1", ""].join("\n");
}

describe("nightly: offline canary", () => {
  let fixture: Fixture | undefined;
  let egressBlocked = false;

  beforeAll(async () => {
    await stopTopology();
    await startTopology(TOPO, { timeoutMs: 600_000 });
    process.env.DOCKFLOW_E2E_TOPOLOGY = TOPO.name;
    await assertTraefikBakedByDigest();
    await blockEgress();
    egressBlocked = true;

    const binary = resolveCliBinaryPath();
    fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: TOPO });
    fixture.write(".dockflow/config.yml", configYml());
    fixture.write(".dockflow/docker/docker-compose.yml", composeYml());

    const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
    if (setup.exitCode !== 0) {
      await dumpDebug(`${FILE}:setup`).catch(() => {});
      throw new Error(`dockflow setup k3s exited ${setup.exitCode} with the lane offline:\n${setup.stderr.slice(-4000)}`);
    }
    await waitForNodesReady(TOPO, 300_000);
    await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);
  });

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await runCLI(["helm", "uninstall", ENV, "data", "--volumes", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await deleteStackCompletely(NS).catch(() => {});
      fixture.cleanup();
    }
    if (egressBlocked) await allowEgress();
    await stopTopology();
    delete process.env.DOCKFLOW_E2E_TOPOLOGY;
  });

  test("N-OFFLINE-01: setup, a proxy deploy and a local Helm release all succeed with no egress", async () => {
    await withDump("offline-canary", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");
      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixture.dir, timeoutMs: 300_000 });
      expect(deploy.exitCode).toBe(0);

      await helm(["status", "dockflow-traefik", "-n", "dockflow-system"]);
      const proxyResponse = await waitFor(
        async () => {
          const result = await curlFrom("server_1", "http://127.0.0.1/", { host: PROXY_DOMAIN, timeoutS: 5 });
          return result.code === 200 ? result : undefined;
        },
        { timeoutMs: 120_000, describe: `${PROXY_DOMAIN} to answer 200 with no egress` },
      );
      expect(proxyResponse.code).toBe(200);

      const status = await helm(["status", "data", "-n", NS]);
      expect(status).toContain("deployed");
    });
  });
});
