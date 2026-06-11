import { describe, test, expect, beforeAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { redisExec, waitForRedis, waitForService } from "../../helpers/docker";
import { sharedAppDir } from "../../helpers/fixtures";

const TEST_ENV = "test";
const ACCESSORIES_STACK = `test-app-${TEST_ENV}-accessories`;
const REDIS_SERVICE = `${ACCESSORIES_STACK}_redis`;

const TEST_KEY = "dockflow_e2e_key";
const TEST_VALUE = `backup_test_${Date.now()}`;

describe("backup & restore", () => {
  let backupId = "";

  beforeAll(async () => {
    await waitForService(REDIS_SERVICE, "1/1", { timeoutMs: 30_000 });
    await waitForRedis();
  });

  test("inject test data into Redis", async () => {
    await redisExec(["SET", TEST_KEY, TEST_VALUE]);
    const stored = await redisExec(["GET", TEST_KEY]);
    expect(stored.trim()).toBe(TEST_VALUE);
  });

  test("create backup", async () => {
    const result = await runCLI(["backup", "create", TEST_ENV, "redis", "--json"], {
      cwd: sharedAppDir(),
    });

    if (result.exitCode !== 0) {
      console.error("[backup create] STDOUT:", result.stdout.slice(-2000));
      console.error("[backup create] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);

    const metadata: { id: string; service: string; sizeBytes: number } = JSON.parse(result.stdout);
    expect(metadata.service).toBe("redis");
    expect(metadata.sizeBytes).toBeGreaterThan(0);
    backupId = metadata.id;
  }, 60_000);

  test("backup appears in list", async () => {
    const result = await runCLI(
      ["backup", "list", TEST_ENV, "redis", "--json"],
      { cwd: sharedAppDir() }
    );

    expect(result.exitCode).toBe(0);

    const backups: { id: string }[] = JSON.parse(result.stdout);
    const found = backups.some((b) => b.id === backupId);
    expect(found).toBe(true);
  });

  test("restore after data corruption", async () => {
    await redisExec(["SET", TEST_KEY, "CORRUPTED"]);
    await redisExec(["SET", "dockflow_e2e_extra", "should_vanish"]);

    const corrupted = await redisExec(["GET", TEST_KEY]);
    expect(corrupted.trim()).toBe("CORRUPTED");

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
      { cwd: sharedAppDir() }
    );

    expect(result.exitCode).toBe(0);
  }, 60_000);

  test("data integrity after restore", async () => {
    // The restore kills the Redis container; Swarm + the CLI's forced service
    // update bring it back — allow more than the default 30s for the replace.
    await waitForRedis(60_000);

    const restored = await redisExec(["GET", TEST_KEY]);
    expect(restored.trim()).toBe(TEST_VALUE);

    const extra = await redisExec(["EXISTS", "dockflow_e2e_extra"]);
    expect(extra.trim()).toBe("0");
  }, 30_000);

  describe("prune", () => {
    test("create additional backups beyond the retention count", async () => {
      // One backup already exists from the create test — add three more so
      // the total (4) exceeds the fixture's retention_count: 3.
      for (let i = 0; i < 3; i++) {
        const result = await runCLI(
          ["backup", "create", TEST_ENV, "redis", "--json"],
          { cwd: sharedAppDir() },
        );
        expect(result.exitCode).toBe(0);
      }

      const list = await runCLI(
        ["backup", "list", TEST_ENV, "redis", "--json"],
        { cwd: sharedAppDir() },
      );
      expect(list.exitCode).toBe(0);
      const backups: { id: string }[] = JSON.parse(list.stdout);
      expect(backups.length).toBeGreaterThanOrEqual(4);
    }, 180_000);

    test("prune keeps retention_count backups and drops the oldest", async () => {
      const result = await runCLI(
        ["backup", "prune", TEST_ENV, "redis", "--yes"],
        { cwd: sharedAppDir() },
      );

      if (result.exitCode !== 0) {
        console.error("[backup prune] STDOUT:", result.stdout.slice(-2000));
        console.error("[backup prune] STDERR:", result.stderr.slice(-2000));
      }
      expect(result.exitCode).toBe(0);

      const list = await runCLI(
        ["backup", "list", TEST_ENV, "redis", "--json"],
        { cwd: sharedAppDir() },
      );
      const backups: { id: string }[] = JSON.parse(list.stdout);
      expect(backups).toHaveLength(3);
      // The backup created at the start of this file is the oldest — gone
      expect(backups.some((b) => b.id === backupId)).toBe(false);
    }, 60_000);
  });
});
