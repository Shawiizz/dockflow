/**
 * Preload for the Swarm e2e suite.
 * Builds the CLI, resets the 2-node DinD Swarm cluster, and pre-deploys the
 * shared test-app so the 01→05 chain can run regardless of file order.
 */

import {
  stopCluster,
  startCluster,
  waitForSwarm,
  buildCLI,
} from "../helpers/cluster";
import { runCLI } from "../helpers/cli";
import { verifyDeployment } from "../helpers/docker";
import { createSharedAppFixture } from "../helpers/fixtures";

await buildCLI();

console.log("\n=== Resetting Swarm E2E cluster ===\n");
await stopCluster();
await startCluster();
await waitForSwarm(2);
console.log("\n=== Swarm E2E cluster ready ===\n");

const appDir = createSharedAppFixture();

// Pre-deploy the base version so tests can run in any order.
// On Linux bun picks up test files in inode order (not alphabetical),
// so tests that depend on the app being deployed cannot rely on 02-deploy
// having run first.
console.log("[setup] Pre-deploying test-app 1.0.0-e2e...");
const result = await runCLI(["deploy", "test", "1.0.0-e2e", "--force"], {
  cwd: appDir,
});
if (result.exitCode !== 0) {
  throw new Error(`Pre-deploy failed:\n${result.stderr.slice(-3000)}`);
}
await verifyDeployment({
  stackName: "test-app-test",
  serviceName: "test-app-test_web",
  expectedReplicas: "2/2",
  checkDistribution: true,
});
console.log("[setup] Pre-deploy complete.");
