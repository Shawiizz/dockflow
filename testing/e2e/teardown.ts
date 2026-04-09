/**
 * Teardown script — stops the E2E cluster and cleans up artifacts.
 * Usage: bun run testing/e2e/teardown.ts
 */

import { stopCluster } from "./helpers/cluster";
import { cleanDockflowEnv } from "./helpers/connection";
import { join } from "path";
import { rmSync } from "fs";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Stop cluster
await stopCluster();

// Clean up generated files
cleanDockflowEnv(join(FIXTURES_DIR, "test-app"));
cleanDockflowEnv(join(FIXTURES_DIR, "test-app-remote"));

try {
  rmSync(join(FIXTURES_DIR, "test-app-remote", ".git"), {
    recursive: true,
    force: true,
  });
} catch {}

console.log("Teardown complete.");
