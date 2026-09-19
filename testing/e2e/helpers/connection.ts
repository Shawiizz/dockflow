/**
 * SSH connection configuration for E2E tests.
 * Uses pre-generated keypairs baked into the node images — no runtime extraction:
 * - `id_ed25519`: the deploy user's key (Swarm and k3s deploys, `.env.dockflow`);
 * - `bootstrap_ed25519`: root's key on k3s nodes, used only by `dockflow setup k3s --key`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { TopologyNode } from "./topology";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

export const DEPLOY_KEY_PATH = join(FIXTURES_DIR, "keys", "id_ed25519");
export const BOOTSTRAP_KEY_PATH = join(FIXTURES_DIR, "keys", "bootstrap_ed25519");
const PRIVATE_KEY = readFileSync(DEPLOY_KEY_PATH, "utf-8");

export const DEPLOY_USER = "deploytest";

export interface SshConnection {
  host: string;
  port: number;
  user: string;
  privateKey: string;
}

const MANAGER: SshConnection = {
  host: "localhost",
  port: 32222,
  user: DEPLOY_USER,
  privateKey: PRIVATE_KEY,
};

const WORKER: SshConnection = {
  host: "localhost",
  port: 32223,
  user: DEPLOY_USER,
  privateKey: PRIVATE_KEY,
};

export const MANAGER_CONTAINER = "dockflow-test-manager";
export const WORKER_CONTAINER = "dockflow-test-worker-1";

/**
 * Encode a connection as base64 JSON (matches CLI's `generateConnectionString` format).
 */
export function encodeConnection(conn: SshConnection): string {
  return Buffer.from(JSON.stringify(conn)).toString("base64");
}

/**
 * Write .env.dockflow with connection strings for the Swarm test-app.
 * Uses localhost + mapped ports so the CLI (running on the host) can reach containers.
 */
export function writeDockflowEnv(appDir: string, extra: Readonly<Record<string, string>> = {}): void {
  writeEnvFile(appDir, [
    `TEST_MAIN_SERVER_CONNECTION=${encodeConnection(MANAGER)}`,
    `TEST_WORKER_1_CONNECTION=${encodeConnection(WORKER)}`,
  ], extra);
}

// ─── k3s ───────────────────────────────────────────────────────────

/** Deploy-user connection to a k3s node through its published SSH port. */
export function deployConnection(node: TopologyNode): SshConnection {
  return { host: "localhost", port: node.sshPort, user: DEPLOY_USER, privateKey: PRIVATE_KEY };
}

/** CI secret name the CLI reads for a server of an environment (`E2E_SERVER_1_CONNECTION`). */
export function connectionEnvKey(env: string, serverKey: string): string {
  return `${env.toUpperCase()}_${serverKey.toUpperCase()}_CONNECTION`;
}

/**
 * Write .env.dockflow for a k3s fixture: one connection per node and environment, as the deploy
 * user with the deploy key. Root and the bootstrap key never appear here.
 */
export function writeK3sDockflowEnv(
  appDir: string,
  nodes: readonly TopologyNode[],
  opts: { envs?: readonly string[]; extra?: Readonly<Record<string, string>> } = {},
): void {
  const envs = opts.envs ?? ["e2e"];
  const lines = envs.flatMap((env) =>
    nodes.map((node) => `${connectionEnvKey(env, node.key)}=${encodeConnection(deployConnection(node))}`),
  );
  writeEnvFile(appDir, lines, opts.extra ?? {});
}

function writeEnvFile(appDir: string, lines: string[], extra: Readonly<Record<string, string>>): void {
  const all = [...lines, ...Object.entries(extra).map(([key, value]) => `${key}=${value}`)];
  writeFileSync(join(appDir, ".env.dockflow"), `${all.join("\n")}\n`);
}
