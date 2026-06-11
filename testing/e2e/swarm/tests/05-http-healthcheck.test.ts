/**
 * E2E tests for remote HTTP health checks.
 *
 * Verifies that `health_checks.endpoints[].remote: true` runs curl on the
 * remote server via SSH rather than locally — letting you check localhost
 * ports and internal services that are not exposed to the outside world.
 *
 * Prerequisites: the test-app must already be deployed (02-deploy.test.ts).
 * The web service publishes port WEB_PORT (8080) on the Swarm ingress, so
 * `http://localhost:8080` is reachable from within the manager container.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, sharedAppDir, type Fixture } from "../../helpers/fixtures";
import { join } from "path";

const TEST_ENV = "test";
const TEST_VERSION = "1.0.1-e2e-healthcheck";

describe("remote HTTP health checks", () => {

  test("curl is available on the manager node", async () => {
    const output = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      "curl --version | head -1",
    ]);
    expect(output).toContain("curl");
  });

  test("web service is reachable on localhost:8080 from the manager", async () => {
    // Sanity check: the Swarm ingress port must be accessible locally on the manager.
    // If this fails, the remote health check would also fail.
    const status = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      "curl -4 -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:8080/",
    ]);
    expect(status.trim()).toBe("200");
  }, 30_000);

  test("deploy succeeds with remote HTTP health check endpoint", async () => {
    // The test-app config.yml includes a remote endpoint for http://localhost:{{ current.env.web_port }}.
    // This redeploy exercises the full remote check path: SSH curl on the manager.
    const result = await runCLI(
      ["deploy", TEST_ENV, TEST_VERSION, "--force"],
      { cwd: sharedAppDir() },
    );

    if (result.exitCode !== 0) {
      console.error("[healthcheck] STDOUT:", result.stdout.slice(-3000));
      console.error("[healthcheck] STDERR:", result.stderr.slice(-3000));
    }

    expect(result.exitCode).toBe(0);
    // The CLI emits this prefix when any HTTP check fails; combined with
    // exit 0 above, its absence confirms the check ran and passed.
    expect(result.stdout + result.stderr).not.toContain("HTTP check failed");
  }, 300_000);

  describe("failing endpoint", () => {
    // The negative test deploys from a throwaway fixture copy — the fixture
    // template in the repo is never mutated, even if the test process is
    // killed mid-run (timeout).
    let badApp: Fixture | undefined;

    afterAll(() => {
      badApp?.cleanup();
    });

    test("deploy fails when remote endpoint returns wrong status", async () => {
      const PORT_UNUSED = "19999";
      const badUrl = `http://localhost:${PORT_UNUSED}/`;

      // Confirm the port is not listening on the manager (otherwise the
      // negative test would be meaningless) — skip if it unexpectedly is.
      const curlCheck = await dockerExec(MANAGER_CONTAINER, [
        "sh",
        "-c",
        `curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${badUrl} || echo "CONN_REFUSED"`,
      ]);
      if (!curlCheck.includes("CONN_REFUSED") && curlCheck.trim() === "200") {
        console.warn(`Port ${PORT_UNUSED} appears to be in use, skipping failure test`);
        return;
      }

      // Point the throwaway fixture's health check at the dead port.
      badApp = makeFixture("test-app");
      const configPath = join(badApp.dir, ".dockflow", "config.yml");
      const original = await Bun.file(configPath).text();
      const patched = original.replace(
        /url:\s*"http:\/\/localhost:.*?"/,
        `url: "http://localhost:${PORT_UNUSED}/"`,
      );
      expect(patched).not.toBe(original); // the pattern must have matched
      await Bun.write(configPath, patched);

      const result = await runCLI(
        ["deploy", TEST_ENV, "1.0.2-e2e-badhc", "--force"],
        { cwd: badApp.dir },
      );

      // Exit code 53 = HEALTH_CHECK_FAILED
      expect(result.exitCode).toBe(53);
      expect(result.stdout + result.stderr).toContain("HTTP health checks failed");
    }, 300_000);
  });
});
