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

  describe("redis with appendonly", () => {
    const APPENDONLY_SERVICE = "journal";

    // each command gets a timeout well under the test's: a hang then shows which one and its output
    async function journalCli(args: string[]): Promise<string> {
      const result = await runCLI(
        ["accessories", "exec", TEST_ENV, APPENDONLY_SERVICE, "--", "redis-cli", ...args],
        { cwd: sharedAppDir(), timeoutMs: 20_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(`redis-cli ${args.join(" ")} failed: ${result.stderr.slice(-500)}`);
      }
      return result.stdout.trim();
    }

    test("a restore is refused and the data is left untouched", async () => {
      await waitForService(`${ACCESSORIES_STACK}_${APPENDONLY_SERVICE}`, "1/1", { timeoutMs: 30_000 });

      await journalCli(["SET", TEST_KEY, "before"]);
      const created = await runCLI(
        ["backup", "create", TEST_ENV, APPENDONLY_SERVICE, "--json"],
        { cwd: sharedAppDir(), timeoutMs: 50_000 },
      );
      if (created.exitCode !== 0) console.error("[appendonly] create:", created.stdout.slice(-2000), created.stderr.slice(-2000));
      expect(created.exitCode).toBe(0);
      const { id }: { id: string } = JSON.parse(created.stdout);

      await journalCli(["SET", TEST_KEY, "after"]);
      const restore = await runCLI(
        ["backup", "restore", TEST_ENV, APPENDONLY_SERVICE, "--from", id, "--yes"],
        { cwd: sharedAppDir(), timeoutMs: 50_000 },
      );
      if (restore.exitCode !== 72) console.error("[appendonly] restore:", restore.stdout.slice(-2000), restore.stderr.slice(-2000));

      expect(restore.exitCode).toBe(72); // RESTORE_FAILED
      const output = restore.stdout + restore.stderr;
      expect(output).toContain(
        `Redis in service ${APPENDONLY_SERVICE} has appendonly enabled; a restored dump.rdb would be ignored at startup, so nothing was changed`,
      );
      expect(output).not.toContain("DOCKFLOW_REFUSED");
      expect(await journalCli(["GET", TEST_KEY])).toBe("after");
    }, 200_000);
  });
});
