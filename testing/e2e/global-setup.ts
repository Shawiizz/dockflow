/**
 * Preload script for E2E tests.
 * Ensures the DinD Swarm cluster is running before any test file executes.
 * Idempotent — skips setup if cluster is already up.
 */

import {
  stopCluster,
  startCluster,
  waitForSwarm,
  buildCLI,
} from "./helpers/cluster";
import { writeDockflowEnv } from "./helpers/connection";
import { join } from "path";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const TEST_APP_DIR = join(FIXTURES_DIR, "test-app");
const TEST_APP_REMOTE_DIR = join(FIXTURES_DIR, "test-app-remote");

async function ensureCluster() {
  // Build CLI first (fast no-op if binary is up to date)
  await buildCLI();

  // Always teardown + rebuild to ensure fresh images and clean state
  console.log("\n=== Resetting E2E cluster ===\n");
  await stopCluster();
  await startCluster();
  await waitForSwarm(2);
  console.log("\n=== E2E cluster ready ===\n");

  // Write connection strings for both test apps
  writeDockflowEnv(TEST_APP_DIR);
  writeDockflowEnv(TEST_APP_REMOTE_DIR);
}

await ensureCluster();
