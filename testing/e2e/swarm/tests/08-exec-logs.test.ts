/**
 * E2E tests for `dockflow exec` and `dockflow logs` on Swarm.
 *
 * Covers the container lookup across nodes (docker ps) and service logs
 * aggregation. Read-only against the shared test-app stack.
 */

import { describe, test, expect } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { dockerExec, waitForService } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { sharedAppDir } from "../../helpers/fixtures";

const TEST_ENV = "test";
const SERVICE_NAME = "test-app-test_web";
const WEB_PORT = "8080";

describe("swarm exec & logs", () => {
  test("exec runs a command inside a running container", async () => {
    await waitForService(SERVICE_NAME, "2/2", { timeoutMs: 60_000 });

    const result = await runCLI(
      ["exec", TEST_ENV, "web", "--", "echo", "hello-swarm"],
      { cwd: sharedAppDir() },
    );

    if (result.exitCode !== 0) {
      console.error("[swarm-exec] STDOUT:", result.stdout);
      console.error("[swarm-exec] STDERR:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-swarm");
  }, 90_000);

  test("logs returns service output", async () => {
    // Generate at least one access log line, then poll until the aggregated
    // service logs contain it (docker service logs lags slightly).
    await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      `curl -4 -s -o /dev/null --max-time 5 http://localhost:${WEB_PORT}/ || true`,
    ]);

    const deadline = Date.now() + 30_000;
    let lastOutput = "";
    while (Date.now() < deadline) {
      const result = await runCLI(["logs", TEST_ENV, "web", "-n", "50"], {
        cwd: sharedAppDir(),
      });
      expect(result.exitCode).toBe(0);
      lastOutput = result.stdout + result.stderr;
      if (lastOutput.includes("GET /")) return;
      await Bun.sleep(2000);
    }

    throw new Error(`Service logs never contained an access log line (last output: ${lastOutput.slice(-500)})`);
  }, 90_000);

  test("logs -n all returns the whole log", async () => {
    const result = await runCLI(["logs", TEST_ENV, "web", "-n", "all"], { cwd: sharedAppDir() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("GET /");
  }, 60_000);

  test("logs refuses a --tail that is not a count before reaching the server", async () => {
    const result = await runCLI(["logs", TEST_ENV, "web", "-n", "10abc"], { cwd: sharedAppDir() });

    expect(result.exitCode).toBe(60);
    expect(result.stdout + result.stderr).toContain("--tail must be a non-negative integer or all");
  }, 30_000);

  test("exec passes on the exit code of the command and the variables given with -e", async () => {
    const result = await runCLI(
      ["exec", TEST_ENV, "web", "-T", "-e", "GREETING=hello=swarm", "--", "sh", "-c", 'echo "$GREETING"; exit 7'],
      { cwd: sharedAppDir() },
    );

    expect(result.stdout).toContain("hello=swarm");
    expect(result.exitCode).toBe(7);
  }, 60_000);
});
