/**
 * E2E test for `accessories remove --volumes`.
 *
 * Scenario: an accessory with a named volume is deployed, then its stack is removed by hand, as
 * an interrupted `accessories remove` would leave it. `accessories remove --volumes -y` must
 * finish the job (no volume left on any node), and a plain deploy of the accessories must create
 * them again: the change-detection hash went with the stack.
 *
 * Runs on its own stacks (project_name test-app-acc).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { dockerExec, waitForService } from "../../helpers/docker";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

const TEST_ENV = "test";
const STACK_NAME = `test-app-acc-${TEST_ENV}`;
const ACCESSORIES_STACK = `${STACK_NAME}-accessories`;
const CACHE_SERVICE = `${ACCESSORIES_STACK}_cache`;
const VOLUME = `${ACCESSORIES_STACK}_data`;

async function volumeNodes(): Promise<string[]> {
  const nodes: string[] = [];
  for (const node of [MANAGER_CONTAINER, WORKER_CONTAINER]) {
    const names = await dockerExec(node, ["docker", "volume", "ls", "-q", "--filter", `name=${VOLUME}`]);
    if (names.split("\n").includes(VOLUME)) nodes.push(node);
  }
  return nodes;
}

async function waitForStackGone(stack: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const services = await dockerExec(MANAGER_CONTAINER, ["sh", "-c", `docker stack services ${stack} -q 2>/dev/null || true`]);
    const containers = await dockerExec(MANAGER_CONTAINER, ["sh", "-c", `docker ps -aq --filter label=com.docker.stack.namespace=${stack}`]);
    if (!services.trim() && !containers.trim()) return;
    await Bun.sleep(1000);
  }
  throw new Error(`stack ${stack} was still there after ${timeoutMs / 1000}s`);
}

describe("accessories remove", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-acc");
  });

  afterAll(async () => {
    fixture?.cleanup();
    for (const stack of [STACK_NAME, ACCESSORIES_STACK]) {
      await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", stack]).catch(() => {});
    }
    await dockerExec(MANAGER_CONTAINER, ["rm", "-rf", `/var/lib/dockflow/accessories/${STACK_NAME}`]).catch(() => {});
  });

  test("deploys the accessory with its volume", async () => {
    const result = await runCLI(["deploy", TEST_ENV, "1.0.0-acc"], { cwd: fixture.dir });
    if (result.exitCode !== 0) console.error("[acc-remove] deploy:", result.stdout, result.stderr);
    expect(result.exitCode).toBe(0);

    await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 90_000 });
    expect((await volumeNodes()).length).toBe(1);
  }, 180_000);

  test("--volumes finishes a removal interrupted after the stack was gone", async () => {
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", ACCESSORIES_STACK]);
    await waitForStackGone(ACCESSORIES_STACK);

    const result = await runCLI(["accessories", "remove", TEST_ENV, "--volumes", "-y"], { cwd: fixture.dir });
    if (result.exitCode !== 0) console.error("[acc-remove] remove:", result.stdout, result.stderr);
    expect(result.exitCode).toBe(0);
    expect(await volumeNodes()).toEqual([]);
  }, 120_000);

  test("the next deploy creates the accessories again", async () => {
    const result = await runCLI(["deploy", TEST_ENV, "1.0.1-acc"], { cwd: fixture.dir });
    if (result.exitCode !== 0) console.error("[acc-remove] redeploy:", result.stdout, result.stderr);
    expect(result.exitCode).toBe(0);

    await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 90_000 });
  }, 180_000);
});
