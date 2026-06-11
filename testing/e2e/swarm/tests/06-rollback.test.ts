/**
 * E2E test for automatic rollback on failed HTTP health checks.
 *
 * Scenario: deploy a healthy v1, then deploy a broken v2 (the app moves to a
 * different port while the health check still targets the original one, with
 * `on_failure: rollback`). The CLI must roll the stack back to v1, restore the
 * `current` release symlink, delete the failed release directory, and v1 must
 * be serving traffic again.
 *
 * Runs on its own stack (project_name test-app-rb) so it cannot interfere
 * with the shared happy-path chain.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { waitForService, dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import { join } from "path";

const TEST_ENV = "test";
const V1 = "1.0.0-rb";
const V2 = "2.0.0-rb";
const STACK_NAME = `test-app-rb-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;
const RELEASES_DIR = `/var/lib/dockflow/stacks/${STACK_NAME}`;
const WEB_PORT = "8085";

/** Fetch the page served on the manager's published port. */
async function curlManager(port: string): Promise<string> {
  return dockerExec(MANAGER_CONTAINER, [
    "sh",
    "-c",
    `curl -4 -s --max-time 5 http://localhost:${port}/ || true`,
  ]);
}

/** Poll until the page on `port` contains `marker` (content settles after convergence). */
async function waitForContent(port: string, marker: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await curlManager(port);
    if (last.includes(marker)) return;
    await Bun.sleep(2000);
  }
  throw new Error(`Content on :${port} never contained "${marker}" (last response: ${last.slice(0, 200)})`);
}

describe("automatic rollback on failed health check", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-rollback");
  });

  afterAll(async () => {
    fixture?.cleanup();
    // Remove the dedicated stack so re-runs against a kept cluster start clean
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
  });

  test("v1 deploys successfully and serves traffic", async () => {
    const result = await runCLI(["deploy", TEST_ENV, V1, "--force"], {
      cwd: fixture.dir,
    });

    if (result.exitCode !== 0) {
      console.error("[rollback v1] STDOUT:", result.stdout.slice(-2000));
      console.error("[rollback v1] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);

    await waitForService(SERVICE_NAME, "1/1", { timeoutMs: 60_000 });
    await waitForContent(WEB_PORT, "ROLLBACK_TEST_V1", 30_000);
  }, 240_000);

  test("broken v2 deploy fails and reports the rollback", async () => {
    // Break v2: the app moves to port 8086 while the health check still
    // targets WEB_PORT. Mark the page as V2 so we can tell which build
    // actually serves after the rollback. Both patches apply to the temp
    // fixture copy only.
    const composePath = join(fixture.dir, ".dockflow", "docker", "docker-compose.yml");
    const compose = await Bun.file(composePath).text();
    const patchedCompose = compose.replace('"{{ current.env.web_port }}:80"', '"8086:80"');
    expect(patchedCompose).not.toBe(compose); // the pattern must have matched
    await Bun.write(composePath, patchedCompose);

    const indexPath = join(fixture.dir, "index.html");
    const index = await Bun.file(indexPath).text();
    await Bun.write(indexPath, index.replace("ROLLBACK_TEST_V1", "ROLLBACK_TEST_V2"));

    const result = await runCLI(["deploy", TEST_ENV, V2, "--force"], {
      cwd: fixture.dir,
    });

    // Exit code 50 = DEPLOY_FAILED ("Deployment failed and was rolled back to ...")
    if (result.exitCode !== 50) {
      console.error("[rollback v2] STDOUT:", result.stdout.slice(-3000));
      console.error("[rollback v2] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(50);
    expect(result.stdout + result.stderr).toContain(`rolled back to ${V1}`);
  }, 300_000);

  test("service runs the v1 image again", async () => {
    await waitForService(SERVICE_NAME, "1/1", { timeoutMs: 60_000 });

    const image = await dockerExec(MANAGER_CONTAINER, [
      "docker",
      "service",
      "inspect",
      SERVICE_NAME,
      "--format",
      "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    ]);
    expect(image).toContain(`test-rb-web-app-test:${V1}`);
  }, 90_000);

  test("v1 content serves on the original port again", async () => {
    await waitForContent(WEB_PORT, "ROLLBACK_TEST_V1");
  }, 90_000);

  test("current release symlink points back to v1", async () => {
    const target = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      `readlink '${RELEASES_DIR}/current'`,
    ]);
    expect(target.trim()).toBe(`${RELEASES_DIR}/${V1}`);
  });

  test("failed v2 release directory was removed", async () => {
    const out = await dockerExec(MANAGER_CONTAINER, [
      "sh",
      "-c",
      `test -d '${RELEASES_DIR}/${V2}' && echo exists || echo gone`,
    ]);
    expect(out.trim()).toBe("gone");
  });

  // -------------------------------------------------------------------------
  // Manual rollback (dockflow rollback) and release retention — continues the
  // scenario on the same stack: after the auto-rollback the stack runs V1 and
  // only the v1 release dir remains.
  // -------------------------------------------------------------------------

  describe("manual rollback & release retention", () => {
    const V3 = "3.0.0-rb";

    /** List release directories (excluding the `current` symlink). */
    async function listReleaseDirs(): Promise<string[]> {
      const out = await dockerExec(MANAGER_CONTAINER, [
        "sh",
        "-c",
        `ls -1 '${RELEASES_DIR}' 2>/dev/null`,
      ]);
      return out.split("\n").map(l => l.trim()).filter(l => l && l !== "current").sort();
    }

    test("a healthy v3 deploys on top of v1", async () => {
      // Re-point the app at the health-checked port (the compose still has the
      // broken 8086 patch from the v2 test). The index still carries the V2
      // marker, so v3 visibly serves different content than v1.
      const composePath = join(fixture.dir, ".dockflow", "docker", "docker-compose.yml");
      const compose = await Bun.file(composePath).text();
      const patched = compose.replace('"8086:80"', `"${WEB_PORT}:80"`);
      expect(patched).not.toBe(compose);
      await Bun.write(composePath, patched);

      const result = await runCLI(["deploy", TEST_ENV, V3, "--force"], {
        cwd: fixture.dir,
      });

      if (result.exitCode !== 0) {
        console.error("[rollback v3] STDOUT:", result.stdout.slice(-2000));
        console.error("[rollback v3] STDERR:", result.stderr.slice(-2000));
      }
      expect(result.exitCode).toBe(0);
      await waitForContent(WEB_PORT, "ROLLBACK_TEST_V2");
      expect(await listReleaseDirs()).toEqual([V1, V3]);
    }, 240_000);

    test("dockflow rollback returns to v1", async () => {
      const result = await runCLI(["rollback", TEST_ENV], { cwd: fixture.dir });

      if (result.exitCode !== 0) {
        console.error("[manual-rollback] STDOUT:", result.stdout.slice(-2000));
        console.error("[manual-rollback] STDERR:", result.stderr.slice(-2000));
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(V1);

      await waitForContent(WEB_PORT, "ROLLBACK_TEST_V1");

      const target = await dockerExec(MANAGER_CONTAINER, [
        "sh",
        "-c",
        `readlink '${RELEASES_DIR}/current'`,
      ]);
      expect(target.trim()).toBe(`${RELEASES_DIR}/${V1}`);

      // Manual rollback (no failed version) keeps the v3 release available
      expect(await listReleaseDirs()).toEqual([V1, V3]);
    }, 240_000);

    test("keep_releases retention removes the oldest releases", async () => {
      // Three more healthy deploys on top of [v1, v3]; keep_releases: 3 must
      // leave only the three newest release dirs and update the symlink.
      for (const version of ["4.0.0-rb", "5.0.0-rb", "6.0.0-rb"]) {
        const result = await runCLI(["deploy", TEST_ENV, version, "--force"], {
          cwd: fixture.dir,
        });
        if (result.exitCode !== 0) {
          console.error(`[retention ${version}] STDERR:`, result.stderr.slice(-2000));
        }
        expect(result.exitCode).toBe(0);
      }

      expect(await listReleaseDirs()).toEqual(["4.0.0-rb", "5.0.0-rb", "6.0.0-rb"]);

      const target = await dockerExec(MANAGER_CONTAINER, [
        "sh",
        "-c",
        `readlink '${RELEASES_DIR}/current'`,
      ]);
      expect(target.trim()).toBe(`${RELEASES_DIR}/6.0.0-rb`);
    }, 600_000);
  });
});
