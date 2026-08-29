/**
 * E2E test for `dockflow init` scaffolding.
 *
 * Runs the real compiled binary rather than `bun run dev` — template
 * embedding is a property of `bun build --compile` and can't be verified
 * any other way.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { exec } from "../../helpers/cluster";

const CONTAINER = "dockflow-test-init";
const BINARY = join(import.meta.dir, "..", "..", "..", "..", "cli", "dist", "dockflow-linux-x64");
const WORKDIR = "/workspace/dockflow-init-test";

/** Run a command inside the init container, stdin closed (non-interactive). */
function inContainer(cmd: string[], timeoutMs?: number): Promise<string> {
  return exec(["docker", "exec", "-w", WORKDIR, CONTAINER, ...cmd], { timeoutMs });
}

/**
 * Run `dockflow init` with stdout+stderr merged — the CLI prints its
 * decorated status messages (via @clack/prompts) on stderr.
 */
function runInit(timeoutMs: number): Promise<string> {
  return exec(
    ["docker", "exec", "-w", WORKDIR, CONTAINER, "sh", "-c", "dockflow init 2>&1"],
    { timeoutMs },
  );
}

describe("dockflow init (project scaffolding)", () => {
  beforeAll(async () => {
    await exec(["docker", "rm", "-f", CONTAINER]).catch(() => {});
    await exec(["docker", "run", "-d", "--name", CONTAINER, "ubuntu:24.04", "sleep", "infinity"]);
    await exec(["docker", "exec", CONTAINER, "mkdir", "-p", WORKDIR]);
    await exec(["docker", "cp", BINARY, `${CONTAINER}:/usr/local/bin/dockflow`]);
    await exec(["docker", "exec", CONTAINER, "chmod", "+x", "/usr/local/bin/dockflow"]);
  }, 120_000);

  afterAll(async () => {
    await exec(["docker", "rm", "-f", CONTAINER]).catch(() => {});
  });

  test("init scaffolds .dockflow/ from embedded templates", async () => {
    // docker exec (no -it) gives the process a non-TTY stdin, so every
    // interactive prompt takes its non-interactive default — no input needed.
    const output = await runInit(60_000);
    expect(output).toContain("Project initialized successfully");

    const config = await inContainer(["cat", ".dockflow/config.yml"]);
    expect(config).toContain('project_name: "dockflow-init-test"');

    const servers = await inContainer(["cat", ".dockflow/servers.yml"]);
    expect(servers.length).toBeGreaterThan(0);

    const compose = await inContainer(["cat", ".dockflow/docker/docker-compose.yml"]);
    expect(compose.length).toBeGreaterThan(0);

    const gitignore = await inContainer(["cat", ".gitignore"]);
    expect(gitignore).toContain(".env.dockflow");
  });

  test("the scaffold satisfies dockflow validate", async () => {
    // Guards against a scaffold that writes files the CLI's own schemas reject:
    // the tests above only assert the files exist and are non-empty.
    const output = await inContainer(["sh", "-c", "dockflow validate 2>&1"], 60_000);
    expect(output).toContain("All configuration files are valid");
  });

  test("init also scaffolds CI workflow templates", async () => {
    // Non-interactive default selects GitHub Actions with both build + deploy jobs.
    const build = await inContainer(["cat", ".github/workflows/dockflow-build.yml"]);
    expect(build.length).toBeGreaterThan(0);

    const deploy = await inContainer(["cat", ".github/workflows/dockflow-deploy.yml"]);
    expect(deploy.length).toBeGreaterThan(0);
  });
});
