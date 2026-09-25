/**
 * Lane k3s-setup, E-74 (design-07 17.7; design-05 22.3 E11): a cluster provisioned by a Dockflow
 * build pinned to the previous k3s minor, then upgraded in place by the binary under test —
 * `--upgrade` must reach the pinned version, servers before agents, without losing the workload's
 * volume data or release history.
 *
 * The deployable fixture (a compose service backed by a named volume) is built entirely under the OS
 * temp directory at runtime, like helpers/fixtures.ts's own `makeFixture`: this file owns no fixture
 * directory under testing/e2e/fixtures, so nothing is written into the repository tree.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, test } from "bun:test";
import { K3S_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { namespaceFor } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { BOOTSTRAP_KEY_PATH, writeK3sDockflowEnv } from "../../../helpers/connection";
import { exec, startTopology, stopTopology, tryExec, waitForNodesReady } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { serversYml } from "../../../helpers/fixtures";
import { SETUP_LANE, topology, type Topology } from "../../../helpers/topology";
import { buildPreviousPinCli } from "../../tools/build-previous-pin-cli";

const FILE = "74-setup-upgrade.test.ts";
const ENV = "e2e";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

const topo: Topology = topology("duo", SETUP_LANE);
const [server1] = topo.nodes;
const PROJECT = "k3s-upgrade";
const NAMESPACE = namespaceFor(PROJECT, ENV);

function buildFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dockflow-e2e-k3s-upgrade-"));
  mkdirSync(join(dir, ".dockflow", "docker"), { recursive: true });
  writeFileSync(join(dir, ".dockflow", "config.yml"), `project_name: ${PROJECT}\norchestrator: k3s\n`);
  writeFileSync(
    join(dir, ".dockflow", "docker", "docker-compose.yml"),
    [
      "services:",
      "  app:",
      "    image: busybox:1.36",
      '    command: ["sh", "-c", "test -f /data/marker.txt || echo dockflow-e2e-marker > /data/marker.txt; sleep infinity"]',
      "    volumes:",
      "      - data:/data",
      "volumes:",
      "  data: {}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".dockflow", "servers.yml"), serversYml(topo.nodes, [ENV]));
  writeK3sDockflowEnv(dir, topo.nodes, { envs: [ENV] });
  return dir;
}

async function runSetupWithBinary(coordinatorBinary: string, fixtureDir: string, uploadBinary: string, extraArgs: string[] = []) {
  return runCLI(
    ["setup", "k3s", ENV, "--ssh-user", "root", "--key", BOOTSTRAP_KEY_PATH, "--binary", uploadBinary, "--yes", ...extraArgs],
    { cwd: fixtureDir, timeoutMs: 600_000, env: { DOCKFLOW_E2E_BINARY: coordinatorBinary } },
  );
}

async function mustRootExec(container: string, command: string): Promise<string> {
  return exec(["docker", "exec", "--user", "root", container, "sh", "-c", command]);
}

async function kubectlOn(args: string[]): Promise<string> {
  return exec(["docker", "exec", server1.container, "/usr/local/bin/k3s", "kubectl", ...args]);
}

describe("E-74 setup-upgrade", () => {
  let fixtureDir: string | undefined;

  afterAll(async () => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    await stopTopology(SETUP_LANE.project);
  });

  test("E-74-01: the previous-pin CLI provisions the cluster at the previous version", async () => {
    await withDump("E-74-01", async () => {
      const previousPinBinary = await buildPreviousPinCli();
      await startTopology(topo, { timeoutMs: 300_000 });
      fixtureDir = buildFixtureDir();

      const result = await runSetupWithBinary(previousPinBinary, fixtureDir, previousPinBinary);
      if (result.exitCode !== 0) throw new Error(`previous-pin setup failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);
      await waitForNodesReady(topo, 300_000);

      for (const node of topo.nodes) {
        const version = await mustRootExec(node.container, "k3s --version");
        expect(version).not.toContain(K3S_PIN.version);
      }
    });
  }, 900_000);

  test("E-74-02: the current CLI deploys the app, writing the volume marker", async () => {
    await withDump("E-74-02", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      const result = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixtureDir, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`deploy failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);
    });
  }, 400_000);

  test("E-74-03: dockflow setup k3s e2e --upgrade updates every node, keeps the app and the PVC marker", async () => {
    await withDump("E-74-03", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      const result = await runSetupWithBinary(resolveCliBinaryPath(), fixtureDir, resolveCliBinaryPath(), ["--upgrade"]);
      if (result.exitCode !== 0) throw new Error(`upgrade failed (exit ${result.exitCode}): ${result.stderr.slice(-4000) || result.stdout.slice(-4000)}`);
      expect(result.exitCode).toBe(0);

      const serverIndex = result.stdout.indexOf(server1.key);
      const agentIndex = result.stdout.indexOf(topo.nodes[1].key);
      expect(serverIndex).toBeGreaterThanOrEqual(0);
      expect(agentIndex).toBeGreaterThan(serverIndex);

      await waitForNodesReady(topo, 300_000);
      for (const node of topo.nodes) {
        const version = await mustRootExec(node.container, "k3s --version");
        expect(version).toContain(K3S_PIN.version);
      }

      const pods = JSON.parse(await kubectlOn(["get", "pods", "-A", "-l", "app.kubernetes.io/name=app", "-o", "json"])) as {
        items: { status?: { phase?: string } }[];
      };
      expect(pods.items.length).toBeGreaterThan(0);
      for (const pod of pods.items) expect(pod.status?.phase).toBe("Running");

      const marker = await tryExec([
        "docker", "exec", server1.container, "/usr/local/bin/k3s", "kubectl", "exec", "-n", NAMESPACE,
        "deploy/app", "--", "cat", "/data/marker.txt",
      ]);
      expect(marker.exitCode).toBe(0);
      expect(marker.stdout).toContain("dockflow-e2e-marker");

      const secrets = await kubectlOn(["get", "secrets", "-A", "-l", "dockflow.shawiizz.dev/part=release", "-o", "name"]);
      expect(secrets.trim().split("\n").filter(Boolean).length).toBeGreaterThan(0);
    });
  }, 900_000);

  test("E-74-04: re-running the upgraded cluster is a no-op", async () => {
    await withDump("E-74-04", async () => {
      if (!fixtureDir) throw new Error("fixture not prepared");
      const before = await mustRootExec(server1.container, "systemctl show k3s -p ActiveEnterTimestamp");
      const result = await runSetupWithBinary(resolveCliBinaryPath(), fixtureDir, resolveCliBinaryPath(), ["--upgrade"]);
      expect(result.exitCode).toBe(0);
      const after = await mustRootExec(server1.container, "systemctl show k3s -p ActiveEnterTimestamp");
      expect(after).toBe(before);
    });
  }, 400_000);
});
