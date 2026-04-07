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
}

await ensureCluster();
