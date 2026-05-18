/**
 * Preload script for E2E tests.
 * Tears down any existing cluster, rebuilds CLI + containers, and waits for Swarm health.
 */

import {
  stopCluster,
  startCluster,
  waitForSwarm,
  buildCLI,
} from "./helpers/cluster";
import { writeDockflowEnv } from "./helpers/connection";
import { runCLI } from "./helpers/cli";
import { join } from "path";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const TEST_APP_DIR = join(FIXTURES_DIR, "test-app");
const TEST_APP_REMOTE_DIR = join(FIXTURES_DIR, "test-app-remote");

async function ensureCluster() {
  await buildCLI();

  console.log("\n=== Resetting E2E cluster ===\n");
  await stopCluster();
  await startCluster();
  await waitForSwarm(2);
  console.log("\n=== E2E cluster ready ===\n");

  // Write connection strings for both test apps
  writeDockflowEnv(TEST_APP_DIR);
  writeDockflowEnv(TEST_APP_REMOTE_DIR);

  // Pre-deploy the base version so tests can run in any order.
  // On Linux bun picks up test files in inode order (not alphabetical),
  // so tests that depend on the app being deployed cannot rely on 02-deploy
  // having run first.
  console.log("[setup] Pre-deploying test-app 1.0.0-e2e...");
  const result = await runCLI(["deploy", "test", "1.0.0-e2e", "--force"], {
    cwd: TEST_APP_DIR,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Pre-deploy failed:\n${result.stderr.slice(-3000)}`);
  }
  console.log("[setup] Pre-deploy complete.");
}

await ensureCluster();
