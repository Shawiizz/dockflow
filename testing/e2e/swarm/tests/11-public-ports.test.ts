/**
 * E2E test for the filter of published ports (dockflow-public-ports).
 *
 * Scenario: the filter is installed on both nodes, as `dockflow setup` would. A deploy records
 * the project's public ports on every node: the declared 8094 and Traefik's 80 answer the other
 * node, which stands for the internet (it reaches the manager through the manager's default
 * route interface), while the published but undeclared 8095 does not. Declaring 8095 opens it on
 * the next deploy. A node without the filter is reported, unless it opted out.
 *
 * Runs on its own stack (project_name test-app-ports), and removes the filter from both nodes
 * afterwards so the other files see the cluster as they expect.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runCLI } from "../../helpers/cli";
import { waitForService, dockerExec } from "../../helpers/docker";
import { exec } from "../../helpers/cluster";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

const TEST_ENV = "test";
const STACK_NAME = `test-app-ports-${TEST_ENV}`;
const NODES = [MANAGER_CONTAINER, WORKER_CONTAINER];
const SCRIPT = join(import.meta.dir, "..", "..", "..", "..", "cli", "src", "services", "public-ports.sh");
const BIN = "/usr/local/sbin/dockflow-public-ports";

/** HTTP status of the manager's port, asked from the worker; 000 when nothing answers in time */
async function statusFromWorker(port: number): Promise<string> {
  const out = await dockerExec(WORKER_CONTAINER, [
    "sh",
    "-c",
    `curl -4 -s -o /dev/null --max-time 5 -w '%{http_code}' http://${MANAGER_CONTAINER}:${port}/ || true`,
  ]);
  return out.trim();
}

/** Poll until the port answers the expected status from the worker */
async function waitForStatus(port: number, expected: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await statusFromWorker(port);
    if (last === expected) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Port ${port} of the manager answered ${last} from the worker, not ${expected}`);
}

async function deploy(fixture: Fixture, version: string): Promise<string> {
  const result = await runCLI(["deploy", TEST_ENV, version, "--force"], { cwd: fixture.dir });
  const output = result.stdout + result.stderr;
  if (result.exitCode !== 0) console.error("[public-ports] output:", output.slice(-3000));
  expect(result.exitCode).toBe(0);
  return output;
}

describe("filter of published ports", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = makeFixture("test-app-ports");
    for (const node of NODES) {
      await exec(["docker", "cp", SCRIPT, `${node}:${BIN}`]);
      await dockerExec(node, ["sh", "-c", `chmod 755 ${BIN} && mkdir -p /etc/dockflow/public-ports`]);
    }
  }, 60_000);

  afterAll(async () => {
    fixture?.cleanup();
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
    for (const node of NODES) {
      await dockerExec(node, [
        "sh",
        "-c",
        `[ -x ${BIN} ] && ${BIN} off; rm -rf ${BIN} /etc/dockflow/public-ports /etc/dockflow/public-ports.off`,
      ]).catch(() => {});
    }
  }, 60_000);

  test("a deploy records the project's public ports on every node", async () => {
    const output = await deploy(fixture, "1.0.0-ports");

    expect(output).toContain("Public ports: 8094/tcp, 80/tcp");
    expect(output).toContain("Published but closed to the internet: admin 8095/tcp");
    for (const node of NODES) {
      const recorded = await dockerExec(node, ["cat", `/etc/dockflow/public-ports/${STACK_NAME}`]);
      expect(recorded.trim().split("\n")).toEqual(["8094/tcp", "80/tcp"]);
      const jump = await dockerExec(node, ["iptables", "-S", "DOCKER-USER"]);
      expect(jump.split("\n")[1]).toBe("-A DOCKER-USER -j DOCKFLOW-PUBLIC-PORTS");
    }
    await waitForService(`${STACK_NAME}_web`, "1/1", { timeoutMs: 90_000 });
    await waitForService(`${STACK_NAME}_admin`, "1/1", { timeoutMs: 90_000 });
  }, 240_000);

  test("the other node reaches the declared port and Traefik's, not the undeclared one", async () => {
    await waitForStatus(8094, "200");
    // Traefik answers, with a 404 for a host no route serves
    await waitForStatus(80, "404");
    expect(await statusFromWorker(8095)).toBe("000");
    // the manager itself still reaches every published port, as nginx on the host does
    const local = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      "curl -4 -s -o /dev/null --max-time 5 -w '%{http_code}' http://localhost:8095/ || true",
    ]);
    expect(local.trim()).toBe("200");
  }, 150_000);

  test("declaring a port opens it on the next deploy", async () => {
    const configPath = join(fixture.dir, ".dockflow", "config.yml");
    writeFileSync(configPath, readFileSync(configPath, "utf-8").replace("    - 8094", "    - 8094\n    - 8095"));

    const output = await deploy(fixture, "1.0.1-ports");

    expect(output).toContain("Public ports: 8094/tcp, 8095/tcp, 80/tcp");
    expect(output).not.toContain("Published but closed to the internet");
    await waitForStatus(8095, "200");
  }, 240_000);

  test("a node without the filter is reported, unless it opted out", async () => {
    await dockerExec(WORKER_CONTAINER, ["sh", "-c", `${BIN} off && rm -f ${BIN}`]);
    const unfiltered = await deploy(fixture, "1.0.2-ports");
    expect(unfiltered).toContain("worker_1 does not filter published ports");

    await dockerExec(WORKER_CONTAINER, ["touch", "/etc/dockflow/public-ports.off"]);
    const optedOut = await deploy(fixture, "1.0.3-ports");
    expect(optedOut).not.toContain("does not filter published ports");
  }, 300_000);
});
