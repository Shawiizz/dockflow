/**
 * Teardown script — stops the E2E cluster and cleans up artifacts.
 * Usage: bun run testing/e2e/teardown.ts
 */

import { stopCluster, stopK3sCluster } from "./helpers/cluster";
import { cleanDockflowEnv } from "./helpers/connection";
import { join } from "path";
import { rmSync } from "fs";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Stop clusters
await stopCluster();
await stopK3sCluster();

// Clean up generated files
cleanDockflowEnv(join(FIXTURES_DIR, "test-app"));
cleanDockflowEnv(join(FIXTURES_DIR, "test-app-remote"));
cleanDockflowEnv(join(FIXTURES_DIR, "test-app-k3s"));

try {
  rmSync(join(FIXTURES_DIR, "test-app-remote", ".git"), {
    recursive: true,
    force: true,
  });
} catch {}

console.log("Teardown complete.");
