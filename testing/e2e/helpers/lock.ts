/**
 * The deploy lock of a stack as the manager holds it: one JSON file in /var/lib/dockflow/locks.
 */

import { DEPLOY_USER, MANAGER_CONTAINER } from "./connection";
import { exec, poll, tryExec } from "./cluster";
import { dockerExec } from "./docker";

const LOCKS_DIR = "/var/lib/dockflow/locks";

export function lockFilePath(stackName: string): string {
  return `${LOCKS_DIR}/${stackName}.lock`;
}

export async function lockFileExists(stackName: string): Promise<boolean> {
  const result = await tryExec(["docker", "exec", MANAGER_CONTAINER, "test", "-f", lockFilePath(stackName)]);
  return result.exitCode === 0;
}

/** Wait until a deploy (or `lock acquire`) holds the lock. */
export function waitForLockFile(stackName: string, timeoutMs = 180_000): Promise<void> {
  return poll(`Lock file of ${stackName} did not appear`, timeoutMs, 500, async () =>
    (await lockFileExists(stackName)) ? { value: undefined } : { waiting: "no lock file" },
  );
}

/** A lock whose holder died two hours ago, past the default stale threshold of 30 minutes. */
export async function plantStaleLock(stackName: string): Promise<void> {
  const startedAt = new Date(Date.now() - 2 * 3600 * 1000);
  const lock = {
    performer: "crashed@ci",
    started_at: startedAt.toISOString(),
    timestamp: Math.floor(startedAt.getTime() / 1000),
    version: "0.0.0-crashed",
    stack: stackName,
    message: "Deploy 0.0.0-crashed",
  };
  const file = lockFilePath(stackName);
  await exec(
    ["docker", "exec", "-i", "-u", DEPLOY_USER, MANAGER_CONTAINER, "sh", "-c", `mkdir -p '${LOCKS_DIR}' && cat > '${file}'`],
    { input: JSON.stringify(lock, null, 2) },
  );
}

/** Remove a lock a failed test may have left, so the next file starts clean. */
export async function clearLock(stackName: string): Promise<void> {
  await dockerExec(MANAGER_CONTAINER, ["rm", "-f", lockFilePath(stackName)]).catch(() => {});
}
