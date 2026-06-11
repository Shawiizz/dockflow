/**
 * Preload for the k3s e2e suite.
 * Only builds the CLI binary — the k3s cluster lifecycle is owned by the
 * test files themselves (beforeAll/afterAll) since the cluster is cheap
 * to start and each file resets it for isolation.
 */

import { buildCLI } from "../helpers/cluster";

await buildCLI();
