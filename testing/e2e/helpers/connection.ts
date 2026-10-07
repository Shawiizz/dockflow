/**
 * Static SSH connection configuration for E2E tests.
 * Uses a pre-generated keypair baked into the Docker image — no runtime extraction.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const PRIVATE_KEY = readFileSync(
  join(FIXTURES_DIR, "keys", "id_ed25519"),
  "utf-8"
);

export const DEPLOY_USER = "deploytest";

const MANAGER = {
  host: "localhost",
  port: 32222,
  user: DEPLOY_USER,
  privateKey: PRIVATE_KEY,
} as const;

const WORKER = {
  host: "localhost",
  port: 32223,
  user: DEPLOY_USER,
  privateKey: PRIVATE_KEY,
} as const;

export const MANAGER_CONTAINER = "dockflow-test-manager";
export const WORKER_CONTAINER = "dockflow-test-worker-1";

/**
 * Encode a connection as base64 JSON (matches CLI's `generateConnectionString` format).
 */
function encodeConnection(conn: {
  host: string;
  port: number;
  user: string;
  privateKey: string;
}): string {
  return Buffer.from(JSON.stringify(conn)).toString("base64");
}

/**
 * Write .env.dockflow with connection strings for the test-app, plus `extra` entries.
 * Uses localhost + mapped ports so the CLI (running on the host) can reach containers.
 */
export function writeDockflowEnv(appDir: string, extra: Readonly<Record<string, string>> = {}): void {
  const content = [
    `TEST_MAIN_SERVER_CONNECTION=${encodeConnection(MANAGER)}`,
    `TEST_WORKER_1_CONNECTION=${encodeConnection(WORKER)}`,
    ...Object.entries(extra).map(([key, value]) => `${key}=${value}`),
  ].join("\n");
  writeFileSync(join(appDir, ".env.dockflow"), content + "\n");
}
