import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import { exec } from "../helpers/cluster";
import {
  waitForService,
  isImageOnNode,
  verifyDeployment,
} from "../helpers/docker";
import {
  MANAGER_CONTAINER,
  DEPLOY_USER,
  writeDockflowEnv,
} from "../helpers/connection";
import { join } from "path";
import { rmSync } from "fs";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_APP_DIR = join(FIXTURES_DIR, "test-app-remote");
const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-remote";
const STACK_NAME = `test-app-remote-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;
const REMOTE_REPO_PATH = `/home/${DEPLOY_USER}/repos/test-app-remote`;

describe("remote build", () => {
  beforeAll(async () => {
    writeDockflowEnv(TEST_APP_DIR);
  });

  afterAll(() => {
    // Clean up local git repo
    try {
      rmSync(join(TEST_APP_DIR, ".git"), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(join(TEST_APP_DIR, ".env.dockflow"));
    } catch {}
  });

  test("create git repo on manager", async () => {
    // Clean previous repo and create parent dir
    await exec([
      "docker",
      "exec",
      MANAGER_CONTAINER,
      "bash",
      "-c",
      `rm -rf ${REMOTE_REPO_PATH} && mkdir -p $(dirname ${REMOTE_REPO_PATH}) && chown ${DEPLOY_USER}:${DEPLOY_USER} $(dirname ${REMOTE_REPO_PATH})`,
    ]);

    // Copy test app files to manager
    await exec([
      "docker",
      "cp",
      `${TEST_APP_DIR}/.`,
      `${MANAGER_CONTAINER}:${REMOTE_REPO_PATH}`,
    ]);

    // Init git repo as deploy user
    await exec([
      "docker",
      "exec",
      MANAGER_CONTAINER,
      "bash",
      "-c",
      [
        `chown -R ${DEPLOY_USER}:${DEPLOY_USER} ${REMOTE_REPO_PATH}`,
        `cd ${REMOTE_REPO_PATH}`,
        `sudo -u ${DEPLOY_USER} git init`,
        `sudo -u ${DEPLOY_USER} git config user.email 'test@dockflow.local'`,
        `sudo -u ${DEPLOY_USER} git config user.name 'E2E Test'`,
        `sudo -u ${DEPLOY_USER} git add -A`,
        `sudo -u ${DEPLOY_USER} git commit -m 'init'`,
      ].join(" && "),
    ]);
  }, 30_000);

  test("prepare local git repo with remote origin", async () => {
    // Init local git repo pointing to remote path
    await exec(["git", "init", "-q"], { cwd: TEST_APP_DIR });
    await exec(
      ["git", "config", "user.email", "test@dockflow.local"],
      { cwd: TEST_APP_DIR }
    );
    await exec(["git", "config", "user.name", "E2E Test"], {
      cwd: TEST_APP_DIR,
    });
    await exec(["git", "add", "-A"], { cwd: TEST_APP_DIR });
    await exec(["git", "commit", "-q", "-m", "init"], { cwd: TEST_APP_DIR });
    await exec(["git", "remote", "add", "origin", REMOTE_REPO_PATH], {
      cwd: TEST_APP_DIR,
    });
  });

  test("deploy with remote_build: true", async () => {
    const result = await runCLI(
      ["deploy", TEST_ENV, TEST_VERSION, "--force"],
      { cwd: TEST_APP_DIR }
    );

    if (result.exitCode !== 0) {
      console.error("[remote-build] STDOUT:", result.stdout.slice(-2000));
      console.error("[remote-build] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);
  }, 180_000);

  test("service is running", async () => {
    await waitForService(SERVICE_NAME, "1/1", { timeoutMs: 60_000 });
  }, 90_000);

  test("image was built on remote server", async () => {
    const exists = await isImageOnNode(
      MANAGER_CONTAINER,
      "test-remote-web-app"
    );
    expect(exists).toBe(true);
  });

  test("deployment is healthy", async () => {
    await verifyDeployment({
      stackName: STACK_NAME,
      serviceName: SERVICE_NAME,
      expectedReplicas: "1/1",
      checkDistribution: false, // Single replica
    });
  }, 30_000);
});
