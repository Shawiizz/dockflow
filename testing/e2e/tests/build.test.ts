import { describe, test, expect, afterAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import { exec } from "../helpers/cluster";
import { writeDockflowEnv } from "../helpers/connection";
import { join } from "path";

const TEST_APP_DIR = join(import.meta.dir, "..", "fixtures", "test-app");
const TEST_ENV = "test";
const IMAGE_NAME = "test-web-app";

describe("build", () => {
  afterAll(async () => {
    // Clean up built image
    try {
      await exec(["docker", "rmi", IMAGE_NAME]);
    } catch {}
  });

  test("standalone build creates a valid image", async () => {
    writeDockflowEnv(TEST_APP_DIR);

    const result = await runCLI(
      ["build", TEST_ENV, "--skip-hooks", "--debug"],
      { cwd: TEST_APP_DIR }
    );

    expect(result.exitCode).toBe(0);
  }, 120_000);

  test("built image exists and is inspectable", async () => {
    const output = await exec([
      "docker",
      "images",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ]);
    expect(output).toContain(IMAGE_NAME);

    const inspect = await exec([
      "docker",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE_NAME,
    ]);
    expect(inspect).toBeTruthy();
  });

  test("image serves expected content", async () => {
    // Start container, verify content, stop
    const containerId = (
      await exec(["docker", "run", "-d", "--rm", IMAGE_NAME])
    ).trim();

    await Bun.sleep(1000);

    try {
      const html = await exec([
        "docker",
        "exec",
        containerId,
        "cat",
        "/usr/share/nginx/html/index.html",
      ]);
      expect(html).toContain("Deployment Successful");
    } finally {
      await exec(["docker", "stop", containerId]).catch(() => {});
    }
  }, 30_000);

  test("rebuild is idempotent", async () => {
    const result = await runCLI(["build", TEST_ENV, "--skip-hooks"], {
      cwd: TEST_APP_DIR,
    });
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
