import { describe, test, expect, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { exec } from "../../helpers/cluster";
import { sharedAppDir } from "../../helpers/fixtures";

const TEST_ENV = "test";
const IMAGE_NAME = "test-web-app";

describe("build", () => {
  afterAll(async () => {
    try {
      await exec(["docker", "rmi", IMAGE_NAME]);
    } catch {}
  });

  test("standalone build creates a valid image", async () => {
    const result = await runCLI(
      ["build", TEST_ENV, "--skip-hooks", "--debug"],
      { cwd: sharedAppDir() }
    );

    if (result.exitCode !== 0) {
      console.error("[build] STDOUT:", result.stdout.slice(-2000));
      console.error("[build] STDERR:", result.stderr.slice(-2000));
    }
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

    const imageId = await exec([
      "docker",
      "inspect",
      "--format",
      "{{.Id}}",
      IMAGE_NAME,
    ]);
    expect(imageId).toBeTruthy();
  });

  test("image serves expected content", async () => {
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
      cwd: sharedAppDir(),
    });
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
