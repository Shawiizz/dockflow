/**
 * Fixture factory — every test runs against a throwaway copy of a fixture
 * template. The templates under fixtures/ are read-only: nothing in the repo
 * tree is ever written to, so a killed test process cannot corrupt the
 * working tree.
 *
 * k3s fixtures get a generated `.dockflow/servers.yml` and `.env.dockflow` for
 * the lane topology (helpers/topology.ts); templates ship `config.yml` and the
 * compose files only.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { DEPLOY_USER, writeDockflowEnv, writeK3sDockflowEnv } from "./connection";
import { currentTopology, TOPOLOGIES, type Topology, type TopologyName, type TopologyNode } from "./topology";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

const CONFIG_FILE = join(".dockflow", "config.yml");
const COMPOSE_FILE = join(".dockflow", "docker", "docker-compose.yml");
const SERVERS_FILE = join(".dockflow", "servers.yml");

export type TextPatch = (text: string) => string;

export interface NodeSetOptions {
  /** environments (servers.yml tags and connection secrets), default `['e2e']` */
  envs?: readonly string[];
  /** extra `.env.dockflow` entries, e.g. registry credentials */
  extraEnv?: Readonly<Record<string, string>>;
}

export interface FixtureOptions extends NodeSetOptions {
  cluster?: "swarm" | "k3s";
  /**
   * k3s only. Given: servers.yml and .env.dockflow are generated for it. Omitted: a template
   * servers.yml is kept as is, otherwise both files are generated for the lane topology.
   */
  topology?: Topology | TopologyName;
}

export interface Fixture {
  /** Absolute path of the temp copy — pass as cwd to runCLI */
  dir: string;
  /** Remove the temp copy. Safe to call even if the dir is already gone. */
  cleanup(): void;
  /** Absolute path of a file inside the copy */
  path(relativePath: string): string;
  read(relativePath: string): string;
  write(relativePath: string, content: string): void;
  /** Apply a text patch to a file of the copy; a patch that changes nothing throws. */
  patchFile(relativePath: string, patch: TextPatch): void;
  patchConfig(patch: TextPatch): void;
  patchCompose(patch: TextPatch): void;
  patchServers(patch: TextPatch): void;
  /** k3s: (re)generate servers.yml and .env.dockflow for a topology or an explicit node set. */
  useNodes(nodes: Topology | readonly TopologyNode[], opts?: NodeSetOptions): void;
}

/**
 * Copy a fixture template into a temp dir and write the SSH connection
 * env file for the target cluster there.
 */
export function makeFixture(name: string, opts: FixtureOptions = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `dockflow-e2e-${name}-`));
  cpSync(join(FIXTURES_DIR, name), dir, { recursive: true });
  const fixture = fixtureAt(dir);

  if (opts.cluster === "k3s") {
    if (opts.topology !== undefined || !existsSync(join(dir, SERVERS_FILE))) {
      const topo = typeof opts.topology === "string" ? TOPOLOGIES[opts.topology] : (opts.topology ?? currentTopology());
      fixture.useNodes(topo, opts);
    }
  } else {
    writeDockflowEnv(dir, opts.extraEnv);
  }

  return fixture;
}

function fixtureAt(dir: string): Fixture {
  const path = (relativePath: string) => join(dir, relativePath);
  const read = (relativePath: string) => readFileSync(path(relativePath), "utf-8");
  const write = (relativePath: string, content: string) => {
    mkdirSync(dirname(path(relativePath)), { recursive: true });
    writeFileSync(path(relativePath), content);
  };
  const patchFile = (relativePath: string, patch: TextPatch) => {
    const before = read(relativePath);
    const after = patch(before);
    if (after === before) throw new Error(`Patch of ${relativePath} in fixture ${dir} changed nothing`);
    write(relativePath, after);
  };

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    path,
    read,
    write,
    patchFile,
    patchConfig: (patch) => patchFile(CONFIG_FILE, patch),
    patchCompose: (patch) => patchFile(COMPOSE_FILE, patch),
    patchServers: (patch) => patchFile(SERVERS_FILE, patch),
    useNodes: (nodes, nodeOpts = {}) => {
      const list = "nodes" in nodes ? nodes.nodes : nodes;
      write(SERVERS_FILE, serversYml(list, nodeOpts.envs));
      writeK3sDockflowEnv(dir, list, { envs: nodeOpts.envs, extra: nodeOpts.extraEnv });
    },
  };
}

/** servers.yml for k3s nodes reached through their published SSH ports on the runner. */
export function serversYml(nodes: readonly TopologyNode[], envs: readonly string[] = ["e2e"]): string {
  const lines = [
    "# written by helpers/fixtures.ts from helpers/topology.ts",
    "defaults:",
    `  user: ${DEPLOY_USER}`,
    "servers:",
  ];
  for (const node of nodes) {
    lines.push(
      `  ${node.key}:`,
      "    host: localhost",
      `    port: ${node.sshPort}`,
      `    private_host: ${node.ip}`,
      `    role: ${node.role}`,
      `    tags: [${envs.map(yamlScalar).join(", ")}]`,
    );
    const labels = Object.entries(node.labels);
    if (labels.length > 0) {
      lines.push("    node_labels:", ...labels.map(([key, value]) => `      ${yamlScalar(key)}: ${yamlScalar(value)}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

const YAML_RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const YAML_NUMBER_LIKE = /^[-+]?(\d[\d_]*)?(\.\d*)?([eE][-+]?\d+)?$|^0[xob]/;

/** Plain scalar when YAML reads it back as the same string, JSON (double-quoted YAML) otherwise. */
function yamlScalar(value: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !YAML_RESERVED.test(value) && !YAML_NUMBER_LIKE.test(value);
  return plain ? value : JSON.stringify(value);
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
