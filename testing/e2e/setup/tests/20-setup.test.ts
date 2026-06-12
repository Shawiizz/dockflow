/**
 * E2E tests for `dockflow setup` host provisioning (pure TypeScript, no
 * Ansible). Runs the real Linux binary inside a clean ubuntu:24.04 container:
 * non-interactive setup, then asserts the provisioned state and that a
 * second run is idempotent.
 *
 * The container deliberately starts fully minimal (no sudo — setup runs as
 * root and uses no sudo binary): the dependency auto-install path
 * (openssh-client, curl) is part of what's being tested.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { exec } from "../../helpers/cluster";

const CONTAINER = "dockflow-test-setup";
const BINARY = join(import.meta.dir, "..", "..", "..", "..", "cli", "dist", "dockflow-linux-x64");
const DEPLOY_USER = "deploytest";
const SETUP_ARGS = [
  "setup", "--yes",
  "--host", "203.0.113.1",
  "--user", DEPLOY_USER,
  "--password", "testpass123",
  "--generate-key",
];

/** Run a command inside the setup container. */
function inContainer(cmd: string[], timeoutMs?: number): Promise<string> {
  return exec(["docker", "exec", CONTAINER, ...cmd], { timeoutMs });
}

/**
 * Run dockflow setup inside the container with stdout+stderr merged —
 * the CLI prints its decorated status messages on stderr.
 */
function runSetup(timeoutMs: number): Promise<string> {
  return exec(
    ["docker", "exec", CONTAINER, "sh", "-c", `dockflow ${SETUP_ARGS.join(" ")} 2>&1`],
    { timeoutMs },
  );
}

describe("dockflow setup (host provisioning)", () => {
  beforeAll(async () => {
    await exec(["docker", "rm", "-f", CONTAINER]).catch(() => {});
    await exec(["docker", "run", "-d", "--name", CONTAINER, "ubuntu:24.04", "sleep", "infinity"]);
    await exec(["docker", "cp", BINARY, `${CONTAINER}:/usr/local/bin/dockflow`]);
    await inContainer(["chmod", "+x", "/usr/local/bin/dockflow"]);
  }, 300_000);

  afterAll(async () => {
    await exec(["docker", "rm", "-f", CONTAINER]).catch(() => {});
  });

  test("non-interactive setup completes on a clean host", async () => {
    const output = await runSetup(420_000);

    expect(output).toContain("Host provisioning complete");
    // The connection string block is the setup deliverable
    expect(output).toContain("Connection String");
  }, 480_000);

  test("docker is installed and the daemon binary works", async () => {
    const version = await inContainer(["docker", "--version"]);
    expect(version).toContain("Docker version");
  });

  test("/var/lib/dockflow belongs to the deploy user with mode 0750", async () => {
    const stat = await inContainer(["stat", "-c", "%U:%G %a", "/var/lib/dockflow"]);
    expect(stat.trim()).toBe(`${DEPLOY_USER}:${DEPLOY_USER} 750`);
  });

  test("deploy user exists, has docker group access and an authorized key", async () => {
    const id = await inContainer(["id", DEPLOY_USER]);
    expect(id).toContain(`(${DEPLOY_USER})`);
    expect(id).toContain("(docker)");

    const authKeys = await inContainer([
      "sh", "-c", `wc -l < /home/${DEPLOY_USER}/.ssh/authorized_keys`,
    ]);
    expect(parseInt(authKeys.trim(), 10)).toBeGreaterThanOrEqual(1);
  });

  test("the server stays light: no ansible, no repo clone", async () => {
    const check = await inContainer([
      "sh", "-c",
      'command -v ansible >/dev/null && echo ansible-present || echo ansible-absent; ' +
      'test -d /opt/dockflow && echo clone-present || echo clone-absent',
    ]);
    expect(check).toContain("ansible-absent");
    expect(check).toContain("clone-absent");
  });

  test("re-running setup is idempotent", async () => {
    const output = await runSetup(180_000);

    expect(output).toContain("Docker already installed — skipping");
    expect(output).toContain("Host provisioning complete");
  }, 240_000);
});
