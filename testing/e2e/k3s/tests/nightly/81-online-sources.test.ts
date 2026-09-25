/**
 * N-ONLINE-01/02 (design-07 17.8): the only file allowed to hit real upstream URLs (16.1). Reuses the
 * shared lanes' `duo` topology/project so the pre-baked chart server address (172.30.0.7, packaged by
 * the lane preload) still resolves; the node-local content-addressed cache
 * (`/var/cache/dockflow/sha256`) is emptied before `setup k3s` runs, so k3s, `install.sh` and Helm are
 * downloaded for real from GitHub / get.helm.sh, and the proxy's Traefik chart from
 * `https://traefik.github.io/charts` (that pin is never touched by setup, so clearing the node cache
 * once, before anything runs, covers it too).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { runSetupK3s, startTopology, stopTopology, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { curlFrom, deleteStackCompletely, getJson, helm, nodeExec, nsFor, waitFor } from "../../../helpers/k8s";
import { TOPOLOGIES } from "../../../helpers/topology";

const FILE = "81-online-sources.test.ts";
const PROJECT = "nightly-online";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const TOPO = TOPOLOGIES.duo;
const PROXY_DOMAIN = "nightly-online.e2e.test";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
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
    "",
  ].join("\n");
}

/** Appended for N-ONLINE-02 only, so N-ONLINE-01's own deploy is not also the first fetch of these charts. */
const PODINFO_RELEASES = [
  "helm:",
  "  releases:",
  "    - name: podinfo-http",
  "      role: accessory",
  "      chart: podinfo",
  "      repo: https://stefanprodan.github.io/podinfo",
  "      version: 6.15.0",
  "    - name: podinfo-oci",
  "      role: accessory",
  "      chart: oci://ghcr.io/stefanprodan/charts/podinfo",
  "      version: 6.15.0",
  "",
].join("\n");

function composeYml(): string {
  return ["services:", "  web:", "    image: docker.io/library/nginx:alpine", "    deploy:", "      replicas: 1", ""].join("\n");
}

interface PodLike {
  status?: { phase?: string; conditions?: { type: string; status: string }[] };
}

function podReady(pod: PodLike): boolean {
  return pod.status?.phase === "Running" && (pod.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

async function waitHelmReleaseReady(release: string, timeoutMs = 180_000): Promise<void> {
  await waitFor(
    async () => {
      const pods = await getJson<PodLike>("pods", { ns: NS, selector: `app.kubernetes.io/instance=${release}` });
      return pods.length > 0 && pods.every(podReady) ? true : undefined;
    },
    { timeoutMs, describe: `helm release ${release} pods to be Ready` },
  );
}

describe("nightly: online sources", () => {
  let fixture: Fixture | undefined;

  beforeAll(async () => {
    await stopTopology();
    await startTopology(TOPO, { timeoutMs: 600_000 });
    process.env.DOCKFLOW_E2E_TOPOLOGY = TOPO.name;

    // Empty the on-node verified-download cache before setup ever runs, so every pinned download of
    // this scenario (k3s, install.sh, Helm, later the Traefik chart) has nothing to reuse.
    for (const node of TOPO.nodes) {
      await nodeExec(node.key, "rm -rf /var/cache/dockflow/sha256 && mkdir -p /var/cache/dockflow/sha256", { user: "root" });
    }

    const binary = resolveCliBinaryPath();
    fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: TOPO });
    fixture.write(".dockflow/config.yml", configYml());
    fixture.write(".dockflow/docker/docker-compose.yml", composeYml());

    const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
    if (setup.exitCode !== 0) {
      await dumpDebug(`${FILE}:setup`).catch(() => {});
      throw new Error(`dockflow setup k3s exited ${setup.exitCode} with an empty download cache:\n${setup.stderr.slice(-4000)}`);
    }
    await waitForNodesReady(TOPO, 300_000);
    await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);
  });

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await runCLI(["helm", "uninstall", ENV, "podinfo-http", "--volumes", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await runCLI(["helm", "uninstall", ENV, "podinfo-oci", "--volumes", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await deleteStackCompletely(NS).catch(() => {});
      fixture.cleanup();
    }
    await stopTopology();
    delete process.env.DOCKFLOW_E2E_TOPOLOGY;
  });

  test("N-ONLINE-01: setup downloads k3s/install.sh/Helm live, and a proxy deploy pulls the Traefik chart live", async () => {
    await withDump("online-sources", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");
      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixture.dir, timeoutMs: 300_000 });
      expect(deploy.exitCode).toBe(0);

      await helm(["status", "dockflow-traefik", "-n", "dockflow-system"]);

      const response = await waitFor(
        async () => {
          const result = await curlFrom("server_1", "http://127.0.0.1/", { host: PROXY_DOMAIN, timeoutS: 5 });
          return result.code === 200 ? result : undefined;
        },
        { timeoutMs: 120_000, describe: `${PROXY_DOMAIN} to answer 200 through the live-downloaded Traefik` },
      );
      expect(response.code).toBe(200);
    });
  });

  test("N-ONLINE-02: podinfo deploys from the HTTPS repo and from the OCI registry", async () => {
    await withDump("podinfo", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");
      fixture.patchConfig((text) => `${text}${PODINFO_RELEASES}`);
      const deploy = await runCLI(["deploy", ENV, "1.0.1"], { cwd: fixture.dir, timeoutMs: 300_000 });
      expect(deploy.exitCode).toBe(0);

      for (const release of ["podinfo-http", "podinfo-oci"]) {
        const status = await helm(["status", release, "-n", NS]);
        expect(status).toContain("deployed");
        await waitHelmReleaseReady(release);
      }
    });
  });
});
