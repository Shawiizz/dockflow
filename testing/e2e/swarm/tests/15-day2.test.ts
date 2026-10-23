/**
 * E2E tests for the day-2 commands: what an operator runs against a stack that is already deployed.
 *
 * One dedicated stack (project_name test-app-day2): `web` with two replicas, `agent` as a global
 * service (one task per node, which `scale` must refuse) and one accessory. The file reads the
 * stack first, then changes it step by step: scale, restart, stop and redeploy the accessories,
 * stop and redeploy the app. Each test relies on the state the previous one left.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { combinedOutput, runCLI, type CLIResult } from "../../helpers/cli";
import { dockerExec, waitForService, waitForStackGone } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

const TEST_ENV = "test";
const V1 = "1.0.0-day2";
const V2 = "1.0.1-day2";
const V3 = "1.0.2-day2";
const STACK_NAME = `test-app-day2-${TEST_ENV}`;
const ACCESSORIES_STACK = `${STACK_NAME}-accessories`;
const WEB_SERVICE = `${STACK_NAME}_web`;
const AGENT_SERVICE = `${STACK_NAME}_agent`;
const CACHE_SERVICE = `${ACCESSORIES_STACK}_cache`;

/** The exit codes of the errors these tests provoke (ErrorCode in cli/src/utils/errors.ts) */
const EXIT = { NO_SERVERS_FOR_ENV: 21, STACK_NOT_FOUND: 41, SERVICE_NOT_FOUND: 42, INVALID_ARGUMENT: 61 } as const;

/** Colors depend on the terminal; the assertions read the words. */
function plain(result: CLIResult): string {
  return combinedOutput(result).replace(/\u001b\[[0-9;]*m/g, "");
}

function expectSuccess(label: string, result: CLIResult): void {
  if (result.exitCode !== 0) console.error(`[day2] ${label}:`, result.stdout, result.stderr);
  expect(result.exitCode).toBe(0);
}

function expectFailure(label: string, result: CLIResult, exitCode: number): void {
  if (result.exitCode !== exitCode) console.error(`[day2] ${label}:`, result.stdout, result.stderr);
  expect(result.exitCode).toBe(exitCode);
}

function parseStdout<T>(result: CLIResult): T {
  return JSON.parse(result.stdout) as T;
}

async function runningTaskIds(service: string): Promise<string[]> {
  const out = await dockerExec(MANAGER_CONTAINER, [
    "docker", "service", "ps", service, "--filter", "desired-state=running", "--format", "{{.ID}}",
  ]);
  return out.split("\n").filter(Boolean).sort();
}

/** A restart replaces every task: wait until `count` tasks run and none of them is one of `before`. */
async function waitForReplacedTasks(service: string, before: readonly string[], count: number, timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let current: string[] = [];
  while (Date.now() < deadline) {
    current = await runningTaskIds(service);
    if (current.length === count && !current.some((id) => before.includes(id))) return current;
    await Bun.sleep(1000);
  }
  throw new Error(`${service} still ran tasks from before the restart after ${timeoutMs / 1000}s (now: ${current.join(", ")})`);
}

/** Swarm removes a stack's network after its containers: a deploy started too early meets it half gone. */
async function waitForStackRemoved(stack: string): Promise<void> {
  await waitForStackGone(stack);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const networks = await dockerExec(MANAGER_CONTAINER, ["docker", "network", "ls", "-q", "--filter", `label=com.docker.stack.namespace=${stack}`]);
    if (!networks.trim()) return;
    await Bun.sleep(1000);
  }
  throw new Error(`the network of ${stack} was still there after 60s`);
}

async function stackNames(): Promise<string[]> {
  const out = await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "ls", "--format", "{{.Name}}"]);
  return out.split("\n").filter(Boolean);
}

interface AccessoryRow {
  name: string;
  replicas: string;
  image: string;
}

interface AuditEntry {
  action: string;
  version: string;
  message: string;
}

describe("day-2 commands", () => {
  let fixture: Fixture;

  const run = (args: string[], timeoutMs = 120_000) => runCLI(args, { cwd: fixture.dir, timeoutMs });

  beforeAll(() => {
    fixture = makeFixture("test-app-day2");
  });

  afterAll(async () => {
    fixture?.cleanup();
    for (const stack of [STACK_NAME, ACCESSORIES_STACK]) {
      await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", stack]).catch(() => {});
    }
    await dockerExec(MANAGER_CONTAINER, ["rm", "-rf", `/var/lib/dockflow/accessories/${STACK_NAME}`]).catch(() => {});
  });

  describe("reading a deployed stack", () => {
    test("deploys the app and its accessory", async () => {
      expectSuccess("deploy", await run(["deploy", TEST_ENV, V1], 240_000));

      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 90_000 });
      await waitForService(AGENT_SERVICE, "2/2", { timeoutMs: 90_000 });
      await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 90_000 });
    }, 300_000);

    test("the app reaches its accessory by name over the accessories network", async () => {
      // ping resolves through the container's resolver; busybox nslookup tries the host's search domains first
      const result = await run(["exec", TEST_ENV, "web", "-T", "--", "ping", "-c", "1", "-W", "5", "cache"]);

      expectSuccess("exec ping cache", result);
      expect(result.stdout).toMatch(/PING cache \(\d+\.\d+\.\d+\.\d+\)/);
    }, 60_000);

    test("status shows the version and the replicas of the stack", async () => {
      const result = await run(["status", TEST_ENV]);

      expectSuccess("status", result);
      expect(plain(result)).toMatch(new RegExp(`\\btest\\s+${V1}\\s+4/4`));
    }, 60_000);

    test("status names an environment that does not exist and exits 21", async () => {
      const result = await run(["status", "nowhere"]);

      expectFailure("status nowhere", result, EXIT.NO_SERVERS_FOR_ENV);
      expect(plain(result)).toContain('Environment "nowhere" not found');
      expect(plain(result)).toContain("Available: test");
    }, 60_000);

    test("version prints the deployed version, as text and as JSON", async () => {
      const text = await run(["version", TEST_ENV]);

      expectSuccess("version", text);
      expect(plain(text)).toContain(`Stack: ${STACK_NAME}`);
      expect(plain(text)).toMatch(new RegExp(`Version:\\s+${V1}`));
      expect(plain(text)).toMatch(/web: nginx/);

      const json = await run(["version", TEST_ENV, "--json"]);

      expectSuccess("version --json", json);
      const metadata = parseStdout<{ version: string; env: string }>(json);
      expect(metadata.version).toBe(V1);
      expect(metadata.env).toBe(TEST_ENV);
    }, 60_000);

    test("ps lists the containers of both nodes, and the tasks with --tasks", async () => {
      const containers = await run(["ps", TEST_ENV]);

      expectSuccess("ps", containers);
      const text = plain(containers);
      expect(text).toContain(`Stack: ${STACK_NAME}`);
      expect(text).toContain(WEB_SERVICE);
      expect(text).toContain(AGENT_SERVICE);
      expect(text).toContain("main_server");
      expect(text).toContain("worker_1");

      const tasks = await run(["ps", TEST_ENV, "--tasks"]);

      expectSuccess("ps --tasks", tasks);
      expect(plain(tasks)).toContain("State:");
      expect(plain(tasks)).toContain("Running");
    }, 90_000);

    test("details shows the services and the resource usage of the stack", async () => {
      const result = await run(["details", TEST_ENV]);

      expectSuccess("details", result);
      const text = plain(result);
      expect(text).toContain(`Stack: ${STACK_NAME}`);
      expect(text).toContain(WEB_SERVICE);
      expect(text).toContain(AGENT_SERVICE);
      expect(text).toContain("CPU %");
    }, 90_000);

    test("list services shows the replicas of each service", async () => {
      const text = await run(["list", "services", TEST_ENV]);

      expectSuccess("list services", text);
      expect(plain(text)).toMatch(/web\s+2\/2/);
      expect(plain(text)).toMatch(/agent\s+2\/2/);
      expect(plain(text)).toContain("2 service(s)");

      const json = await run(["list", "services", TEST_ENV, "--json"]);

      expectSuccess("list services --json", json);
      const listed = parseStdout<{ stack: string; services: { name: string; replicas: string }[] }>(json);
      expect(listed.stack).toBe(STACK_NAME);
      expect(listed.services.map((s) => `${s.name} ${s.replicas}`).sort()).toEqual(["agent 2/2", "web 2/2"]);
    }, 60_000);

    test("list images shows the images on every node", async () => {
      const result = await run(["list", "images", TEST_ENV, "--all"]);

      expectSuccess("list images", result);
      const text = plain(result);
      expect(text).toContain("on main_server");
      expect(text).toContain("on worker_1");
      expect(text).toMatch(/nginx\s+alpine/);
    }, 90_000);

    test("accessories list shows the accessory and its replicas", async () => {
      const result = await run(["accessories", "list", TEST_ENV, "--json"]);

      expectSuccess("accessories list", result);
      const rows = parseStdout<AccessoryRow[]>(result);
      expect(rows.map((row) => `${row.name} ${row.replicas}`)).toEqual([`${CACHE_SERVICE} 1/1`]);
      expect(rows[0].image.startsWith("redis:8-alpine")).toBe(true);
    }, 60_000);

    test("diagnose exits 0 on a healthy stack", async () => {
      const result = await run(["diagnose", TEST_ENV]);

      expectSuccess("diagnose", result);
      const text = plain(result);
      expect(text).toContain("Stack exists");
      expect(text).toMatch(/web: 2\/2 replicas/);
      expect(text).toMatch(/agent: 2\/2 replicas/);
      expect(text).toContain("No task errors found");
    }, 90_000);
  });

  describe("scale", () => {
    test("scales a service up and back down", async () => {
      expectSuccess("scale up", await run(["scale", TEST_ENV, "web", "3"]));
      await waitForService(WEB_SERVICE, "3/3", { timeoutMs: 60_000 });

      expectSuccess("scale down", await run(["scale", TEST_ENV, "web", "2"]));
      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 60_000 });
    }, 240_000);

    test("--no-wait returns once Swarm accepted the change, which then converges", async () => {
      expectSuccess("scale up --no-wait", await run(["scale", TEST_ENV, "web", "3", "--no-wait"]));
      await waitForService(WEB_SERVICE, "3/3", { timeoutMs: 60_000 });

      expectSuccess("scale down --no-wait", await run(["scale", TEST_ENV, "web", "2", "--no-wait"]));
      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 60_000 });
    }, 240_000);

    test("refuses a replica count that is not an integer", async () => {
      const result = await run(["scale", TEST_ENV, "web", "2.5"]);

      expectFailure("scale 2.5", result, EXIT.INVALID_ARGUMENT);
      expect(plain(result)).toContain("Replicas must be a non-negative integer");
    }, 60_000);

    test("refuses a global service, which has no replica count", async () => {
      const result = await run(["scale", TEST_ENV, "agent", "3"]);

      expectFailure("scale agent", result, EXIT.INVALID_ARGUMENT);
      expect(plain(result)).toContain("runs in global mode");
    }, 60_000);

    test("refuses a service that does not exist, and an accessory", async () => {
      const unknown = await run(["scale", TEST_ENV, "nowhere", "2"]);

      expectFailure("scale nowhere", unknown, EXIT.SERVICE_NOT_FOUND);
      expect(plain(unknown)).toContain(`No service nowhere in ${STACK_NAME}`);

      const accessory = await run(["scale", TEST_ENV, "cache", "2"]);

      expectFailure("scale cache", accessory, EXIT.SERVICE_NOT_FOUND);
      expect(plain(accessory)).toContain("is an accessory of test");
    }, 90_000);

    test("a refused scale leaves the replicas as they were", async () => {
      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 30_000 });
      await waitForService(AGENT_SERVICE, "2/2", { timeoutMs: 30_000 });
    }, 60_000);
  });

  describe("restart", () => {
    test("restart replaces the tasks of a service", async () => {
      const before = await runningTaskIds(WEB_SERVICE);
      expect(before.length).toBe(2);

      expectSuccess("restart web", await run(["restart", TEST_ENV, "web"]));

      await waitForReplacedTasks(WEB_SERVICE, before, 2);
      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 60_000 });
    }, 180_000);

    test("restart of an accessory name points to accessories restart", async () => {
      const result = await run(["restart", TEST_ENV, "cache"]);

      expectFailure("restart cache", result, EXIT.SERVICE_NOT_FOUND);
      expect(plain(result)).toContain("is an accessory of test");
    }, 60_000);

    test("accessories restart replaces the tasks of the accessory", async () => {
      const before = await runningTaskIds(CACHE_SERVICE);
      expect(before.length).toBe(1);

      expectSuccess("accessories restart", await run(["accessories", "restart", TEST_ENV, "cache"]));

      await waitForReplacedTasks(CACHE_SERVICE, before, 1);
      await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 60_000 });
    }, 180_000);
  });

  describe("stopping and bringing back the accessories", () => {
    test("accessories stop refuses an accessory that does not exist", async () => {
      const result = await run(["accessories", "stop", TEST_ENV, "nowhere", "-y"]);

      expectFailure("accessories stop nowhere", result, EXIT.SERVICE_NOT_FOUND);
      expect(plain(result)).toContain(`No accessory nowhere in ${ACCESSORIES_STACK}`);
    }, 60_000);

    test("accessories stop -y scales them to 0 and leaves the app running", async () => {
      const result = await run(["accessories", "stop", TEST_ENV, "-y"]);

      expectSuccess("accessories stop", result);
      expect(plain(result)).toContain("Accessories stopped");
      await waitForService(CACHE_SERVICE, "0/0", { timeoutMs: 60_000 });

      const listed = await run(["accessories", "list", TEST_ENV, "--json"]);
      expectSuccess("accessories list", listed);
      expect(parseStdout<AccessoryRow[]>(listed).map((row) => row.replicas)).toEqual(["0/0"]);

      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 30_000 });
    }, 180_000);

    test("deploy --accessories brings them back without touching the app", async () => {
      const webBefore = await runningTaskIds(WEB_SERVICE);

      const result = await run(["deploy", TEST_ENV, V2, "--accessories"], 240_000);

      expectSuccess("deploy --accessories", result);
      expect(plain(result)).toContain("Deploying accessories");
      await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 90_000 });
      expect(await runningTaskIds(WEB_SERVICE)).toEqual(webBefore);
    }, 300_000);
  });

  describe("stopping and redeploying the app", () => {
    test("stop -y removes the app stack and keeps the accessories", async () => {
      const result = await run(["stop", TEST_ENV, "-y"]);

      expectSuccess("stop", result);
      expect(plain(result)).toContain(`Stack ${STACK_NAME} stopped`);
      await waitForStackRemoved(STACK_NAME);

      const stacks = await stackNames();
      expect(stacks).not.toContain(STACK_NAME);
      expect(stacks).toContain(ACCESSORIES_STACK);
      await waitForService(CACHE_SERVICE, "1/1", { timeoutMs: 30_000 });
    }, 240_000);

    test("the commands that read the stack report that nothing runs", async () => {
      const status = await run(["status", TEST_ENV]);
      expectSuccess("status", status);
      expect(plain(status)).toMatch(/\btest\s+\S+\s+0\/0/);

      const ps = await run(["ps", TEST_ENV]);
      expectSuccess("ps", ps);
      expect(plain(ps)).toContain("No running containers");

      const diagnose = await run(["diagnose", TEST_ENV]);
      expectSuccess("diagnose", diagnose);
      expect(plain(diagnose)).toContain("Stack not found");

      const services = await run(["list", "services", TEST_ENV]);
      expectFailure("list services", services, EXIT.STACK_NOT_FOUND);
      expect(plain(services)).toContain(`No services found for stack "${STACK_NAME}"`);

      const scale = await run(["scale", TEST_ENV, "web", "2"]);
      expectFailure("scale", scale, EXIT.STACK_NOT_FOUND);
      expect(plain(scale)).toContain(`Nothing is deployed to ${TEST_ENV}`);
    }, 180_000);

    test("the next deploy restores the stack and leaves unchanged accessories alone", async () => {
      const result = await run(["deploy", TEST_ENV, V3], 240_000);

      expectSuccess("deploy", result);
      expect(plain(result)).toContain("Accessories unchanged");
      await waitForService(WEB_SERVICE, "2/2", { timeoutMs: 90_000 });
      await waitForService(AGENT_SERVICE, "2/2", { timeoutMs: 90_000 });

      const status = await run(["status", TEST_ENV]);
      expectSuccess("status", status);
      expect(plain(status)).toMatch(new RegExp(`\\btest\\s+${V3}\\s+4/4`));
    }, 300_000);
  });

  describe("history", () => {
    test("history lists the deploys, the latest first, and audit is the same command", async () => {
      const json = await run(["history", TEST_ENV, "--all", "--json"]);

      expectSuccess("history --json", json);
      const deployed = parseStdout<AuditEntry[]>(json).filter((entry) => entry.action.toLowerCase() === "deployed");
      expect(deployed.map((entry) => entry.version)).toEqual([V3, V2, V1]);
      expect(deployed[0].message).toContain(`Deployed ${V3} to ${TEST_ENV}`);

      const text = await run(["audit", TEST_ENV, "--all"]);

      expectSuccess("audit", text);
      expect(plain(text)).toContain(`Audit Log: ${STACK_NAME}`);
      for (const version of [V1, V2, V3]) expect(plain(text)).toContain(version);
    }, 90_000);
  });
});
