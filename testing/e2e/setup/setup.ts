/**
 * Preload for the setup e2e suite.
 * Cross-compiles the Linux x64 CLI binary — the suite runs it inside a clean
 * Ubuntu container to validate host provisioning end to end.
 */

import { join } from "path";
import { exec } from "../helpers/cluster";

const CLI_DIR = join(import.meta.dir, "..", "..", "..", "cli");

console.log("[setup-suite] Building Linux x64 CLI binary...");
await exec(["bun", "install", "--frozen-lockfile"], { cwd: CLI_DIR });
await exec(["bun", "run", "build", "linux-x64"], { cwd: CLI_DIR, timeoutMs: 120_000 });
console.log("[setup-suite] Binary ready.");
