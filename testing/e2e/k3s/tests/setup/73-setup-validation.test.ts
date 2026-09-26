/**
 * Lane k3s-setup, E-73 (design-07 17.7; design-05 22.3): servers.yml topology and reachability
 * refusals, all of which must fire before any node is touched — every row of this file runs against
 * the SAME two bare containers and re-asserts that neither ever got a k3s binary.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { M } from "../../../../../cli/src/services/orchestrator/messages";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { BOOTSTRAP_KEY_PATH } from "../../../helpers/connection";
import { startTopology, stopTopology, tryExec } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture, type Fixture } from "../../../helpers/fixtures";
import { SETUP_LANE, topology, type Topology } from "../../../helpers/topology";

const FILE = "73-setup-validation.test.ts";
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
const [server1, agent1] = topo.nodes;

function runSetup(fixture: Fixture, extraArgs: string[] = []): ReturnType<typeof runCLI> {
  return runCLI(
    ["setup", "k3s", ENV, "--ssh-user", "root", "--key", BOOTSTRAP_KEY_PATH, "--binary", resolveCliBinaryPath(), "--yes", ...extraArgs],
    { cwd: fixture.dir, timeoutMs: 120_000 },
  );
}

async function noK3sInstalled(): Promise<void> {
  for (const node of topo.nodes) {
    const result = await tryExec(["docker", "exec", node.container, "test", "-e", "/usr/local/bin/k3s"]);
    expect(result.exitCode).not.toBe(0);
  }
}

describe("E-73 setup-validation", () => {
  beforeAll(async () => {
    await startTopology(topo, { timeoutMs: 300_000 });
  });

  afterAll(async () => {
    await stopTopology(SETUP_LANE.project);
  });

  test("E-73-01: an even manager count refuses with M.managerCount, nothing installed", async () => {
    await withDump("E-73-01", async () => {
      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.write(
        ".dockflow/servers.yml",
        [
          "defaults:",
          "  user: deploytest",
          "servers:",
          "  server_1:",
          `    host: localhost`,
          `    port: ${server1.sshPort}`,
          `    private_host: ${server1.ip}`,
          "    role: manager",
          `    tags: [${ENV}]`,
          "  agent_1:",
          `    host: localhost`,
          `    port: ${agent1.sshPort}`,
          `    private_host: ${agent1.ip}`,
          "    role: manager",
          `    tags: [${ENV}]`,
          "",
        ].join("\n"),
      );
      const result = await runSetup(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toContain(M.managerCount(ENV, 2));
      await noK3sInstalled();
    });
  });

  test("E-73-02: colliding node names refuse before anything is installed", async () => {
    await withDump("E-73-02", async () => {
      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.write(
        ".dockflow/servers.yml",
        [
          "defaults:",
          "  user: deploytest",
          "servers:",
          "  worker_1:",
          `    host: localhost`,
          `    port: ${server1.sshPort}`,
          `    private_host: ${server1.ip}`,
          "    role: manager",
          `    tags: [${ENV}]`,
          "  worker-1:",
          `    host: localhost`,
          `    port: ${agent1.sshPort}`,
          `    private_host: ${agent1.ip}`,
          "    role: worker",
          `    tags: [${ENV}]`,
          "",
        ].join("\n"),
      );
      const result = await runSetup(fixture);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/both become node name/);
      await noK3sInstalled();
    });
  });

  test("E-73-03: a hostname private_host is refused as a schema error (exit 11)", async () => {
    await withDump("E-73-03", async () => {
      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.write(
        ".dockflow/servers.yml",
        [
          "defaults:",
          "  user: deploytest",
          "servers:",
          "  server_1:",
          `    host: localhost`,
          `    port: ${server1.sshPort}`,
          "    private_host: node-a.internal",
          "    role: manager",
          `    tags: [${ENV}]`,
          "",
        ].join("\n"),
      );
      const result = await runSetup(fixture);
      expect(result.exitCode).toBe(11);
      await noK3sInstalled();
    });
  });

  test("E-73-04: a reserved node label key is refused as a schema error (exit 11)", async () => {
    await withDump("E-73-04", async () => {
      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.write(
        ".dockflow/servers.yml",
        [
          "defaults:",
          "  user: deploytest",
          "servers:",
          "  server_1:",
          `    host: localhost`,
          `    port: ${server1.sshPort}`,
          `    private_host: ${server1.ip}`,
          "    role: manager",
          `    tags: [${ENV}]`,
          "    node_labels:",
          "      kubernetes.io/role: x",
          "",
        ].join("\n"),
      );
      const result = await runSetup(fixture);
      expect(result.exitCode).toBe(11);
      expect(result.stderr + result.stdout).toContain(M.labelKeyReserved);
      await noK3sInstalled();
    });
  });

  test("E-73-05: a closed bootstrap SSH port is refused, naming the unreachable node", async () => {
    await withDump("E-73-05", async () => {
      // servers.yml and the connection secrets both give agent_1 a port nothing listens on (a
      // connection secret's host and port win over servers.yml's): a closed bootstrap SSH port
      const fixture = makeFixture("test-app-k3s-cluster");
      fixture.useNodes([server1, { ...agent1, sshPort: 1 }], { envs: [ENV] });
      const result = await runSetup(fixture, ["--dry-run"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("agent_1");
      await noK3sInstalled();
    });
  });
});
