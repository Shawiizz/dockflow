/**
 * E2E tests for `dockflow exec` and `dockflow logs` on Swarm.
 *
 * The k3s suite already covers these commands for kubectl; this file covers
 * the Swarm backend (container lookup across nodes via docker ps, service
 * logs aggregation). Read-only against the shared test-app stack.
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
});
