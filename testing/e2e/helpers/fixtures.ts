/**
 * Fixture factory — every test runs against a throwaway copy of a fixture
 * template. The templates under fixtures/ are read-only: nothing in the repo
 * tree is ever written to, so a killed test process cannot corrupt the
 * working tree.
 */

import { cpSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeDockflowEnv, writeK3sDockflowEnv } from "./connection";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

export interface Fixture {
  /** Absolute path of the temp copy — pass as cwd to runCLI */
  dir: string;
  /** Remove the temp copy. Safe to call even if the dir is already gone. */
  cleanup(): void;
}

/**
 * Copy a fixture template into a temp dir and write the SSH connection
 * env file for the target cluster there.
 */
export function makeFixture(
  name: string,
  opts?: { cluster?: "swarm" | "k3s" },
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `dockflow-e2e-${name}-`));
  cpSync(join(FIXTURES_DIR, name), dir, { recursive: true });

  if (opts?.cluster === "k3s") {
    writeK3sDockflowEnv(dir);
  } else {
    writeDockflowEnv(dir);
  }

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Shared fixture for the Swarm happy-path chain
// ---------------------------------------------------------------------------
//
// The 01→05 Swarm tests form an ordered scenario chain on one stack. The
// suite preload (swarm/setup.ts) creates a single temp copy of test-app and
// publishes its path through an env var so every test file in the same
// process resolves the same directory.

const SHARED_DIR_ENV = "DOCKFLOW_E2E_SHARED_APP_DIR";

/** Called once by the Swarm suite preload. */
export function createSharedAppFixture(): string {
  const fixture = makeFixture("test-app");
  process.env[SHARED_DIR_ENV] = fixture.dir;
  return fixture.dir;
}

/** Resolve the shared test-app fixture created by the suite preload. */
export function sharedAppDir(): string {
  const dir = process.env[SHARED_DIR_ENV];
  if (!dir) {
    throw new Error(
      "Shared test-app fixture not initialized — run tests via the swarm/ suite so its preload executes",
    );
  }
  return dir;
}
