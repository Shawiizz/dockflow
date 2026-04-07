import { describe, test, expect, beforeAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import { redisExec, waitForRedis, waitForService } from "../helpers/docker";
import { writeDockflowEnv } from "../helpers/connection";
import { join } from "path";

const TEST_APP_DIR = join(import.meta.dir, "..", "fixtures", "test-app");
const TEST_ENV = "test";
const ACCESSORIES_STACK = `test-app-${TEST_ENV}-accessories`;
const REDIS_SERVICE = `${ACCESSORIES_STACK}_redis`;

const TEST_KEY = "dockflow_e2e_key";
const TEST_VALUE = `backup_test_${Date.now()}`;

describe("backup & restore", () => {
  let backupId = "";

  beforeAll(async () => {
    writeDockflowEnv(TEST_APP_DIR);

    // Ensure Redis is running (deployed by the deploy test)
    await waitForService(REDIS_SERVICE, "1/1", { timeoutMs: 30_000 });
    await waitForRedis();
  });

  test("inject test data into Redis", async () => {
    await redisExec(["SET", TEST_KEY, TEST_VALUE]);
    const stored = await redisExec(["GET", TEST_KEY]);
    expect(stored.trim()).toBe(TEST_VALUE);
  });

  test("create backup", async () => {
    const result = await runCLI(["backup", "create", TEST_ENV, "redis"], {
      cwd: TEST_APP_DIR,
    });

    if (result.exitCode !== 0) {
      console.error("[backup create] STDOUT:", result.stdout.slice(-2000));
      console.error("[backup create] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);

    // Extract backup ID from output (format: YYYYMMDD-HHMMSS-xxxx)
    // Log output to debug regex if it doesn't match
    const match = result.stdout.match(/(\d{8}-\d{6}-[a-f0-9]{4})/);
    if (!match) {
      console.error("[backup create] Could not extract backup ID from output:");
      console.error("[backup create] STDOUT:", result.stdout);
      console.error("[backup create] STDERR:", result.stderr);
    }
    expect(match).toBeTruthy();
    backupId = match![1];
  }, 60_000);

  test("backup appears in list", async () => {
    const result = await runCLI(
      ["backup", "list", TEST_ENV, "redis", "--json"],
      { cwd: TEST_APP_DIR }
    );

    expect(result.exitCode).toBe(0);

    // The JSON may be preceded by CLI output — find the JSON array
    const jsonStart = result.stdout.indexOf("[");
    expect(jsonStart).toBeGreaterThanOrEqual(0);

    const backups = JSON.parse(result.stdout.slice(jsonStart));
    const found = backups.some(
      (b: { id: string }) => b.id === backupId
    );
    expect(found).toBe(true);
  });

  test("restore after data corruption", async () => {
    // Corrupt data
    await redisExec(["SET", TEST_KEY, "CORRUPTED"]);
    await redisExec(["SET", "dockflow_e2e_extra", "should_vanish"]);

    const corrupted = await redisExec(["GET", TEST_KEY]);
    expect(corrupted.trim()).toBe("CORRUPTED");

    // Restore
    const result = await runCLI(
      [
        "backup",
        "restore",
        TEST_ENV,
        "redis",
        "--from",
        backupId,
        "--yes",
      ],
      { cwd: TEST_APP_DIR }
    );

    expect(result.exitCode).toBe(0);
  }, 60_000);

  test("data integrity after restore", async () => {
    // Wait for Redis to come back after restore (container restart)
    await waitForRedis();

    const restored = await redisExec(["GET", TEST_KEY]);
    expect(restored.trim()).toBe(TEST_VALUE);

    // Extra key injected after backup should be gone
    const extra = await redisExec(["EXISTS", "dockflow_e2e_extra"]);
    expect(extra.trim()).toBe("0");
  }, 30_000);
});
