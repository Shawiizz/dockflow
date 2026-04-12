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

import { describe, test, expect, beforeAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import { writeDockflowEnv } from "../helpers/connection";
import { dockerExec } from "../helpers/docker";
import { MANAGER_CONTAINER } from "../helpers/connection";
import { join } from "path";

const TEST_APP_DIR = join(import.meta.dir, "..", "fixtures", "test-app");
const TEST_ENV = "test";
const TEST_VERSION = "1.0.1-e2e-healthcheck";

describe("remote HTTP health checks", () => {
  beforeAll(async () => {
    writeDockflowEnv(TEST_APP_DIR);
  });

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
      "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:8080/",
    ]);
    expect(status.trim()).toBe("200");
  }, 30_000);

  test("deploy succeeds with remote HTTP health check endpoint", async () => {
    // The test-app config.yml includes a remote endpoint for http://localhost:{{ current.env.web_port }}.
    // This redeploy exercises the full remote check path: SSH curl on the manager.
    const result = await runCLI(
      ["deploy", TEST_ENV, TEST_VERSION, "--force"],
      { cwd: TEST_APP_DIR },
    );

    if (result.exitCode !== 0) {
      console.error("[healthcheck] STDOUT:", result.stdout.slice(-3000));
      console.error("[healthcheck] STDERR:", result.stderr.slice(-3000));
    }

    expect(result.exitCode).toBe(0);
  }, 300_000);

  test("deploy output confirms HTTP health check passed", async () => {
    // Re-run to capture output — the previous test already proved exit 0,
    // here we assert the expected log line is present.
    const result = await runCLI(
      ["deploy", TEST_ENV, TEST_VERSION, "--force"],
      { cwd: TEST_APP_DIR },
    );

    expect(result.exitCode).toBe(0);
    // The service emits this warning prefix on any HTTP check failure;
    // its absence means all checks passed.
    expect(result.stdout + result.stderr).not.toContain("HTTP check failed");
  }, 300_000);

  test("deploy fails when remote endpoint returns wrong status", async () => {
    // Point the check at a port that is not listening on the manager.
    // We do this by overriding the env variable used in the URL template
    // via a temporary servers.yml override — simulated by deploying with
    // an inline config string via the CLI's --config flag if available,
    // or by checking that a known-bad URL produces exit code 53.
    //
    // Since the CLI does not expose a --config override, we verify the
    // error path indirectly: the production config uses `on_failure: fail`
    // and a mismatched port must produce exit 53 (HEALTH_CHECK_FAILED).
    //
    // This test is skipped if the platform cannot simulate a bad endpoint.
    const PORT_UNUSED = "19999"; // Assumed unused on the test VM
    const badUrl = `http://localhost:${PORT_UNUSED}/`;

    // Confirm the port is not listening (curl exits non-zero = connection refused)
    const curlCheck = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${badUrl} || echo "CONN_REFUSED"`,
    ]);
    if (!curlCheck.includes("CONN_REFUSED") && curlCheck.trim() === "200") {
      // Port is actually in use — skip the negative test
      console.warn(`Port ${PORT_UNUSED} appears to be in use, skipping failure test`);
      return;
    }

    // Build a patched config that points at the bad port
    const patchedConfigPath = join(
      TEST_APP_DIR,
      ".dockflow",
      "config.yml",
    );
    const originalConfig = await Bun.file(patchedConfigPath).text();
    const patchedConfig = originalConfig.replace(
      /url:\s*"http:\/\/localhost:.*?"/,
      `url: "http://localhost:${PORT_UNUSED}/"`,
    );

    await Bun.write(patchedConfigPath, patchedConfig);

    try {
      const result = await runCLI(
        ["deploy", TEST_ENV, "1.0.2-e2e-badhc", "--force"],
        { cwd: TEST_APP_DIR },
      );

      // Exit code 53 = HEALTH_CHECK_FAILED
      expect(result.exitCode).toBe(53);
      expect(result.stdout + result.stderr).toContain("HTTP health checks failed");
    } finally {
      // Always restore the original config
      await Bun.write(patchedConfigPath, originalConfig);
    }
  }, 300_000);
});
