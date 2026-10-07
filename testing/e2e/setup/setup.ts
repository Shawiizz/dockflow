/**
 * Preload for the setup e2e suite.
 * Cross-compiles the Linux x64 CLI binary — the suite runs it inside a clean
 * Ubuntu container to validate host provisioning end to end. Nothing is built
 * when DOCKFLOW_E2E_BINARY names the binary to test.
 */

import { buildCLI } from "../helpers/cluster";

console.log("[setup-suite] Preparing the Linux x64 CLI binary...");
await buildCLI("dockflow-linux-x64");
console.log("[setup-suite] Binary ready.");
