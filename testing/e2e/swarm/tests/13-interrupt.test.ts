/**
 * E2E test for Ctrl+C during a deploy.
 *
 * The deploy is held inside its lock by the fixture's pre-build hook (DOCKFLOW_E2E_HOLD), then
 * interrupted with SIGINT, as a developer's Ctrl+C or a cancelled CI job would. It must clean up:
 * exit 130 and release the lock, so the next deploy is not refused for a holder that is gone.
 *
 * Linux and macOS only: Bun cannot send a Windows child a signal it can handle.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { combinedOutput, GRACEFUL_INTERRUPTS, runCLI, runCLIInBackground } from "../../helpers/cli";
import { dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import { clearLock, lockFileExists, waitForLockFile } from "../../helpers/lock";

const TEST_ENV = "test";
const STACK_NAME = `test-app-lk-${TEST_ENV}`;

describe.skipIf(!GRACEFUL_INTERRUPTS)("Ctrl+C during a deploy", () => {
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

  test("the deploy exits 130 and leaves no lock behind", async () => {
    const run = runCLIInBackground(["deploy", TEST_ENV, "1.0.0-int"], {
      cwd: fixture.dir,
      env: { DOCKFLOW_E2E_HOLD: "120" },
    });

    await waitForLockFile(STACK_NAME);
    run.kill("SIGINT");
    const result = await run.done;

    expect(result.exitCode).toBe(130);
    expect(combinedOutput(result)).toContain("Deploy interrupted");
    expect(await lockFileExists(STACK_NAME)).toBe(false);
  }, 300_000);

  test("the lock can be taken again", async () => {
    const result = await runCLI(["lock", "acquire", TEST_ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
    await runCLI(["lock", "release", TEST_ENV], { cwd: fixture.dir, timeoutMs: 60_000 });

    expect(result.exitCode).toBe(0);
    expect(await lockFileExists(STACK_NAME)).toBe(false);
  }, 180_000);
});
