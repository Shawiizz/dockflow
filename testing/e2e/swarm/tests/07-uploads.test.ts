/**
 * E2E tests for the uploads feature.
 *
 * Verifies that `uploads:` entries (single file + directory) land on every
 * cluster node during deploy, and — the critical part — that a failed deploy
 * rolls the uploaded files back to their previous content: modified files are
 * restored, files added by the failed deploy disappear, and the per-deploy
 * backup directory is cleaned up.
 *
 * Runs on its own stack (project_name test-app-up) so it cannot interfere
 * with the shared happy-path chain.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import { join } from "path";

const TEST_ENV = "test";
const V1 = "1.0.0-up";
const V2 = "2.0.0-up";
const STACK_NAME = `test-app-up-${TEST_ENV}`;
const NODES = [MANAGER_CONTAINER, WORKER_CONTAINER];

const DEST_BASE = "/home/deploytest/test-app-up";
const CONF_PATH = `${DEST_BASE}/app.conf`;
const ASSET_A_PATH = `${DEST_BASE}/assets/a.txt`;
const ASSET_B_PATH = `${DEST_BASE}/assets/b.txt`;
const UPLOAD_BACKUPS_DIR = `/var/lib/dockflow/upload-backups/${STACK_NAME}`;

/** Read a remote file on a node ("<missing>" when absent). */
async function readRemote(container: string, path: string): Promise<string> {
  return dockerExec(container, [
    "sh",
    "-c",
    `cat '${path}' 2>/dev/null || echo "<missing>"`,
  ]);
}

describe("uploads", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-uploads");
  });

  afterAll(async () => {
    fixture?.cleanup();
    // Remove the dedicated stack and uploaded files so re-runs against a
    // kept cluster start clean.
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
    for (const node of NODES) {
      await dockerExec(node, ["sh", "-c", `rm -rf '${DEST_BASE}' '${UPLOAD_BACKUPS_DIR}'`]).catch(() => {});
    }
  });

  test("v1 deploy uploads file and directory to every node", async () => {
    const result = await runCLI(["deploy", TEST_ENV, V1, "--force"], {
      cwd: fixture.dir,
    });

    if (result.exitCode !== 0) {
      console.error("[uploads v1] STDOUT:", result.stdout.slice(-3000));
      console.error("[uploads v1] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(0);

    for (const node of NODES) {
      expect(await readRemote(node, CONF_PATH)).toContain("CONF_V1");
      expect(await readRemote(node, ASSET_A_PATH)).toContain("ASSET_A_V1");
    }
  }, 240_000);

  test("successful deploy leaves no upload backups behind", async () => {
    for (const node of NODES) {
      const out = await dockerExec(node, [
        "sh",
        "-c",
        `test -d '${UPLOAD_BACKUPS_DIR}/${V1}' && echo exists || echo gone`,
      ]);
      expect(out.trim()).toBe("gone");
    }
  });

  test("failed v2 deploy rolls uploaded files back on every node", async () => {
    // v2 changes the uploaded contents and adds a new file in the directory,
    // then fails its health check (app moves port while the remote check
    // still targets WEB_PORT, on_failure: fail). All patches apply to the
    // temp fixture copy only.
    await Bun.write(join(fixture.dir, "uploads", "app.conf"), "marker=CONF_V2\n");
    await Bun.write(join(fixture.dir, "uploads", "assets", "a.txt"), "ASSET_A_V2\n");
    await Bun.write(join(fixture.dir, "uploads", "assets", "b.txt"), "ASSET_B_V2\n");

    const composePath = join(fixture.dir, ".dockflow", "docker", "docker-compose.yml");
    const compose = await Bun.file(composePath).text();
    const patchedCompose = compose.replace('"{{ current.env.web_port }}:80"', '"8088:80"');
    expect(patchedCompose).not.toBe(compose); // the pattern must have matched
    await Bun.write(composePath, patchedCompose);

    const result = await runCLI(["deploy", TEST_ENV, V2, "--force"], {
      cwd: fixture.dir,
    });

    // Exit code 53 = HEALTH_CHECK_FAILED (on_failure: fail)
    if (result.exitCode !== 53) {
      console.error("[uploads v2] STDOUT:", result.stdout.slice(-3000));
      console.error("[uploads v2] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(53);

    for (const node of NODES) {
      // Modified file restored to the previous content
      expect(await readRemote(node, CONF_PATH)).toContain("CONF_V1");
      // Modified file inside an uploaded directory restored
      expect(await readRemote(node, ASSET_A_PATH)).toContain("ASSET_A_V1");
      // File added by the failed deploy removed with the directory restore
      expect(await readRemote(node, ASSET_B_PATH)).toContain("<missing>");
    }
  }, 300_000);

  test("upload backups of the failed deploy are cleaned up", async () => {
    for (const node of NODES) {
      const out = await dockerExec(node, [
        "sh",
        "-c",
        `test -d '${UPLOAD_BACKUPS_DIR}/${V2}' && echo exists || echo gone`,
      ]);
      expect(out.trim()).toBe("gone");
    }
  });
});
