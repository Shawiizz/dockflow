import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { exec } from "../../helpers/cluster";
import {
  waitForService,
  isImageOnNode,
  verifyDeployment,
} from "../../helpers/docker";
import { MANAGER_CONTAINER, DEPLOY_USER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-remote";
const STACK_NAME = `test-app-remote-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;
const REMOTE_REPO_PATH = `/home/${DEPLOY_USER}/repos/test-app-remote`;

describe("remote build", () => {
  // The local git repo is created inside a throwaway fixture copy - the
  // fixture template in the repo tree is never touched.
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-remote");
  });

  afterAll(() => {
    fixture?.cleanup();
  });

  test("prepare git repo (local + identical mirror on the manager)", async () => {
    // The CLI resolves the LOCAL commit sha and checks it out after cloning
    // the origin ON the server — so the manager-side repo must share the
    // local history. Commit locally first, then copy the repo (.git included)
    // to the manager. Two independent `git init` would produce different
    // shas and the deploy would (rightly) refuse to build.
    await exec(["git", "init", "-q", "-b", "main"], { cwd: fixture.dir });
    await exec(
      ["git", "config", "user.email", "test@dockflow.local"],
      { cwd: fixture.dir }
    );
    await exec(["git", "config", "user.name", "E2E Test"], {
      cwd: fixture.dir,
    });
    await exec(["git", "add", "-A"], { cwd: fixture.dir });
    await exec(["git", "commit", "-q", "-m", "init"], { cwd: fixture.dir });
    await exec(["git", "remote", "add", "origin", REMOTE_REPO_PATH], {
      cwd: fixture.dir,
    });

    await exec([
      "docker",
      "exec",
      MANAGER_CONTAINER,
      "bash",
      "-c",
      `rm -rf ${REMOTE_REPO_PATH} && mkdir -p ${REMOTE_REPO_PATH} && chown -R ${DEPLOY_USER}:${DEPLOY_USER} $(dirname ${REMOTE_REPO_PATH})`,
    ]);

    await exec([
      "docker",
      "cp",
      `${fixture.dir}/.`,
      `${MANAGER_CONTAINER}:${REMOTE_REPO_PATH}`,
    ]);

    await exec([
      "docker",
      "exec",
      MANAGER_CONTAINER,
      "bash",
      "-c",
      `chown -R ${DEPLOY_USER}:${DEPLOY_USER} ${REMOTE_REPO_PATH}`,
    ]);
  }, 30_000);

  test("deploy with remote_build: true", async () => {
    const result = await runCLI(
      ["deploy", TEST_ENV, TEST_VERSION, "--force", "--branch", "main"],
      { cwd: fixture.dir }
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
