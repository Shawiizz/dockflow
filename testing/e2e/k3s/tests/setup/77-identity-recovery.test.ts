/**
 * Lane k3s-setup, E-77 (design-07 17.7): the three ways the orchestrator layer can lose the cluster
 * (missing kubeconfig, a down API, a rejected deploy identity) all surface as exit 44 naming the
 * node, and each is fully recoverable — because the container belongs only to this file, a failure
 * here cannot affect any other file (K67 (a)).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "bun:test";
import { K8S_DEPLOYER_TOKEN_SECRET, K8S_SYSTEM_NAMESPACE } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { namespaceFor } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { writeK3sDockflowEnv } from "../../../helpers/connection";
import { exec, runSetupK3s, startStandaloneNode, stopTopology, tryExec } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { serversYml } from "../../../helpers/fixtures";
import { SETUP_LANE, standaloneNode, type TopologyNode } from "../../../helpers/topology";

const FILE = "77-identity-recovery.test.ts";
const ENV = "e2e";
const PROJECT = "k3s-recovery";
const NAMESPACE = namespaceFor(PROJECT, ENV);

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

const node: TopologyNode = standaloneNode(SETUP_LANE, {
  key: "server_1",
  name: "server_1",
  octet: 41,
  sshPort: SETUP_LANE.sshPorts.server_3,
});

async function mustRootExec(command: string): Promise<string> {
  return exec(["docker", "exec", "--user", "root", node.container, "sh", "-c", command]);
}

async function kubectlOn(args: string[]): Promise<string> {
  return exec(["docker", "exec", node.container, "/usr/local/bin/k3s", "kubectl", ...args]);
}

function buildFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dockflow-e2e-k3s-recovery-"));
  mkdirSync(join(dir, ".dockflow", "docker"), { recursive: true });
  writeFileSync(join(dir, ".dockflow", "config.yml"), `project_name: ${PROJECT}\norchestrator: k3s\n`);
  writeFileSync(
    join(dir, ".dockflow", "docker", "docker-compose.yml"),
    ["services:", "  app:", "    image: busybox:1.36", '    command: ["sh", "-c", "sleep infinity"]', ""].join("\n"),
  );
  writeFileSync(join(dir, ".dockflow", "servers.yml"), serversYml([node], [ENV]));
  writeK3sDockflowEnv(dir, [node], { envs: [ENV] });
  return dir;
}

describe("E-77 identity-recovery", () => {
  let fixtureDir: string | undefined;

  afterAll(async () => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    await stopTopology(SETUP_LANE.project);
  });

  test("provisions the single server and deploys the minimal app", async () => {
    await withDump("provision", async () => {
      await startStandaloneNode(SETUP_LANE, node, { timeoutMs: 180_000 });
      fixtureDir = buildFixtureDir();
      const setup = await runSetupK3s({ dir: fixtureDir }, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (setup.exitCode !== 0) throw new Error(`setup failed (exit ${setup.exitCode}): ${setup.stderr.slice(-4000) || setup.stdout.slice(-4000)}`);
      expect(setup.exitCode).toBe(0);

      const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixtureDir, timeoutMs: 300_000 });
      if (deploy.exitCode !== 0) throw new Error(`deploy failed (exit ${deploy.exitCode}): ${deploy.stderr.slice(-4000) || deploy.stdout.slice(-4000)}`);
      expect(deploy.exitCode).toBe(0);
    });
  }, 900_000);

  test("E-77-01: a missing kubeconfig makes status fail with exit 44, and is recoverable", async () => {
    await withDump("E-77-01", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      await mustRootExec("mv /var/lib/dockflow/kube/config /var/lib/dockflow/kube/config.e2e-bak");
      try {
        const result = await runCLI(["status", ENV], { cwd: fixtureDir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(44);
        expect(result.stderr).toContain("The Dockflow kubeconfig is missing or unreadable on server_1");
        expect(result.stderr).toContain("Re-run `dockflow setup k3s e2e`.");
      } finally {
        await mustRootExec("mv /var/lib/dockflow/kube/config.e2e-bak /var/lib/dockflow/kube/config");
      }
      const restored = await runCLI(["status", ENV], { cwd: fixtureDir, timeoutMs: 60_000 });
      expect(restored.exitCode).toBe(0);
    });
  }, 120_000);

  test("E-77-02: a stopped API answers exit 44, and a deploy attempted while down leaves no Lease", async () => {
    await withDump("E-77-02", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      await mustRootExec("systemctl stop k3s");
      try {
        const status = await runCLI(["status", ENV], { cwd: fixtureDir, timeoutMs: 30_000 });
        expect(status.exitCode).toBe(44);
        expect(status.stderr).toContain("The Kubernetes API is not answering on server_1");

        const deploy = await runCLI(["deploy", ENV, "1.0.0-recovery"], { cwd: fixtureDir, timeoutMs: 30_000 });
        expect(deploy.exitCode).not.toBe(0);
      } finally {
        await mustRootExec("systemctl start k3s");
        await tryExec(["docker", "exec", node.container, "sh", "-c", "for i in $(seq 1 60); do curl -sk -o /dev/null https://127.0.0.1:6443/readyz && exit 0; sleep 2; done; exit 1"], { timeoutMs: 150_000 });
      }
      // the failed deploy above must never have created a Lease for this stack (design-03 5.1): the
      // system namespace holds none at all, since no deploy on this single-project host has succeeded
      // since the last check that could have left one.
      const leases = await kubectlOn(["get", "leases.coordination.k8s.io", "-n", K8S_SYSTEM_NAMESPACE, "-o", "name"]);
      expect(leases.trim().split("\n").filter((line) => line.includes(PROJECT))).toEqual([]);
    });
  }, 300_000);

  test("E-77-03: a rejected deploy identity answers exit 44 and is repaired by re-running setup", async () => {
    await withDump("E-77-03", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      await mustRootExec(`k3s kubectl delete secret ${K8S_DEPLOYER_TOKEN_SECRET} -n ${K8S_SYSTEM_NAMESPACE}`);

      const status = await runCLI(["status", ENV], { cwd: fixtureDir, timeoutMs: 30_000 });
      expect(status.exitCode).toBe(44);
      expect(status.stderr).toContain("The Dockflow deploy identity was rejected by the cluster on server_1");

      const setup = await runSetupK3s({ dir: fixtureDir }, { binary: resolveCliBinaryPath(), timeoutMs: 500_000 });
      if (setup.exitCode !== 0) throw new Error(`repair setup failed (exit ${setup.exitCode}): ${setup.stderr.slice(-4000) || setup.stdout.slice(-4000)}`);
      expect(setup.exitCode).toBe(0);

      const repaired = await runCLI(["status", ENV], { cwd: fixtureDir, timeoutMs: 30_000 });
      expect(repaired.exitCode).toBe(0);
    });
  }, 600_000);

  test("E-77-04: a full deploy after the repairs proves recovery is complete", async () => {
    await withDump("E-77-04", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      const deploy = await runCLI(["deploy", ENV, "1.0.1"], { cwd: fixtureDir, timeoutMs: 300_000 });
      if (deploy.exitCode !== 0) throw new Error(`final deploy failed (exit ${deploy.exitCode}): ${deploy.stderr.slice(-4000) || deploy.stdout.slice(-4000)}`);
      expect(deploy.exitCode).toBe(0);

      const pods = JSON.parse(await kubectlOn(["get", "pods", "-n", NAMESPACE, "-o", "json"])) as { items: { status?: { phase?: string } }[] };
      expect(pods.items.length).toBeGreaterThan(0);
      for (const pod of pods.items) expect(pod.status?.phase).toBe("Running");
    });
  }, 400_000);
});
