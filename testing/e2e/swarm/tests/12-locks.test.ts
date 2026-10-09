/**
 * E2E tests for the deploy lock.
 *
 * A deploy holds the lock of its stack for as long as it runs, `dockflow lock` takes and frees it
 * by hand, and a lock whose holder died is taken over by exactly one of the deploys that find it.
 *
 * Runs on its own stack (project_name test-app-lk). The fixture's pre-build hook sleeps for
 * DOCKFLOW_E2E_HOLD seconds, which keeps a deploy inside its lock while the test acts on it.
 * None of these deploys passes --force: that flag overrides the lock.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { type CLIResult, combinedOutput, runCLI, runCLIInBackground } from "../../helpers/cli";
import { dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import { clearLock, lockFileExists, plantStaleLock, waitForLockFile } from "../../helpers/lock";

const TEST_ENV = "test";
const STACK_NAME = `test-app-lk-${TEST_ENV}`;
const HOLD_SECONDS = "25";

describe("deploy lock", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = makeFixture("test-app-lock");
    await clearLock(STACK_NAME);
  });

  afterAll(async () => {
    fixture?.cleanup();
    await clearLock(STACK_NAME);
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
  });

  test("a running deploy holds the lock: a second deploy is refused and lock status shows the holder", async () => {
    const holder = runCLIInBackground(["deploy", TEST_ENV, "1.0.0-lk"], {
      cwd: fixture.dir,
      env: { DOCKFLOW_E2E_HOLD: HOLD_SECONDS },
    });

    let first: CLIResult;
    try {
      await waitForLockFile(STACK_NAME);

      const blocked = await runCLI(["deploy", TEST_ENV, "2.0.0-lk"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(blocked.exitCode).toBe(51);
      expect(combinedOutput(blocked)).toContain("Already locked by");

      const status = await runCLI(["lock", "status", TEST_ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("Holder");
    } finally {
      first = await holder.done;
    }

    if (first.exitCode !== 0) {
      console.error("[locks holder] STDOUT:", first.stdout.slice(-3000));
      console.error("[locks holder] STDERR:", first.stderr.slice(-3000));
    }
    expect(first.exitCode).toBe(0);
    expect(await lockFileExists(STACK_NAME)).toBe(false);
  }, 420_000);

  test("lock acquire returns at once, keeps the lock and blocks a deploy until lock release", async () => {
    const results: { acquire?: CLIResult; blocked?: CLIResult; again?: CLIResult } = {};
    try {
      results.acquire = await runCLI(["lock", "acquire", TEST_ENV, "-m", "e2e manual lock"], {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      results.blocked = await runCLI(["deploy", TEST_ENV, "3.0.0-lk"], { cwd: fixture.dir, timeoutMs: 120_000 });
      results.again = await runCLI(["lock", "acquire", TEST_ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
    } finally {
      await runCLI(["lock", "release", TEST_ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
    }

    expect(results.acquire?.exitCode).toBe(0);
    expect(results.acquire?.durationMs).toBeLessThan(20_000);
    expect(results.blocked?.exitCode).toBe(51);
    expect(combinedOutput(results.blocked as CLIResult)).toContain("Already locked by");
    expect(results.again?.exitCode).toBe(51);
    expect(await lockFileExists(STACK_NAME)).toBe(false);
  }, 300_000);

  test("of two deploys that find a stale lock exactly one takes it over, and says so", async () => {
    await plantStaleLock(STACK_NAME);

    const first = runCLIInBackground(["deploy", TEST_ENV, "4.0.0-lk"], { cwd: fixture.dir });
    await Bun.sleep(150);
    const second = runCLIInBackground(["deploy", TEST_ENV, "5.0.0-lk"], { cwd: fixture.dir });
    const results = await Promise.all([first.done, second.done]);

    expect(results.map((r) => r.exitCode).sort()).toEqual([0, 51]);

    const winner = results.find((r) => r.exitCode === 0) as CLIResult;
    const loser = results.find((r) => r.exitCode === 51) as CLIResult;
    expect(combinedOutput(winner)).toContain("is stale; taking it over");
    expect(combinedOutput(loser)).toMatch(/Lock was stale but another deploy acquired it first|Already locked by /);
    expect(await lockFileExists(STACK_NAME)).toBe(false);
  }, 420_000);
});
