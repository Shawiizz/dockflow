/**
 * E2E tests for secrets hygiene.
 *
 * A marker secret in each place where Dockflow handles one must stay out of everything it could
 * leak into: the CLI's stdout and stderr (with --debug and --verbose too) and the command line of
 * every process on the nodes, which any user of a node can read. A poller reads /proc/<pid>/cmdline
 * on the manager and the worker for the whole length of each command (helpers/leak-watch.ts).
 *
 * The secrets:
 *  - the registry password, templated from .env.dockflow into registry.password
 *  - an app secret, templated from .env.dockflow into the compose file and into a hook that runs
 *    on the manager
 *  - the SSH access itself: the deploy user's private key and the connection strings
 *
 * Runs on its own stack (project_name test-app-sec), through the registry that asks for
 * credentials.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { type CLIResult, combinedOutput, runCLI } from "../../helpers/cli";
import { exec } from "../../helpers/cluster";
import { dockerExec, waitForService } from "../../helpers/docker";
import {
  AUTH_REGISTRY_PASSWORD,
  AUTH_REGISTRY_PORT,
  MANAGER_CONTAINER,
  WORKER_CONTAINER,
  writeDockflowEnv,
} from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import { type LeakHit, type WatchedSecret, watchCommandLines } from "../../helpers/leak-watch";

const TEST_ENV = "test";
const STACK_NAME = `test-app-sec-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;
const REGISTRY = `localhost:${AUTH_REGISTRY_PORT}`;
const IMAGE_REPO = "test-sec-web-app-test";
const APP_SECRET = "E2E_SECRET_APPENV_7f3a9c";
const VERSIONS = { plain: "1.0.0-sec", debug: "2.0.0-sec" };
const NODES = [MANAGER_CONTAINER, WORKER_CONTAINER];

const KEY_FILE = join(import.meta.dir, "..", "..", "fixtures", "keys", "id_ed25519");

/** The lines of the private key's body: each one alone is enough to recognise the key */
function privateKeyLines(): WatchedSecret[] {
  return readFileSync(KEY_FILE, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.length >= 20 && !line.startsWith("-----"))
    .map((value, index) => ({ label: `ssh private key, line ${index + 1}`, value }));
}

/** The connection strings the harness wrote to the fixture's .env.dockflow */
function connectionStrings(fixtureDir: string): WatchedSecret[] {
  return readFileSync(join(fixtureDir, ".env.dockflow"), "utf-8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+_CONNECTION=/.test(line))
    .map((line) => ({ label: `ssh connection string ${line.slice(0, line.indexOf("="))}`, value: line.slice(line.indexOf("=") + 1) }));
}

interface Watched {
  result: CLIResult;
  hits: LeakHit[];
}

async function runWatched(args: string[], cwd: string, secrets: readonly WatchedSecret[]): Promise<Watched> {
  const watch = await watchCommandLines(NODES, secrets);
  let result: CLIResult;
  try {
    result = await runCLI(args, { cwd, timeoutMs: 300_000 });
  } catch (error) {
    await watch.stop();
    throw error;
  }
  return { result, hits: await watch.stop() };
}

function expectNoLeak(run: Watched, secrets: readonly WatchedSecret[]): void {
  const output = combinedOutput(run.result);
  const inOutput = secrets.filter((secret) => output.includes(secret.value)).map((secret) => secret.label);
  expect(inOutput).toEqual([]);
  expect(run.hits).toEqual([]);
}

describe("secrets hygiene", () => {
  let fixture: Fixture;
  let secrets: WatchedSecret[];

  beforeAll(() => {
    fixture = makeFixture("test-app-secrets");
    writeDockflowEnv(fixture.dir, {
      TEST_REGISTRY_PASSWORD: AUTH_REGISTRY_PASSWORD,
      TEST_APP_SECRET: APP_SECRET,
    });
    secrets = [
      { label: "registry password", value: AUTH_REGISTRY_PASSWORD },
      { label: "app secret", value: APP_SECRET },
      ...privateKeyLines(),
      ...connectionStrings(fixture.dir),
    ];
  });

  afterAll(async () => {
    fixture?.cleanup();
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
    for (const version of Object.values(VERSIONS)) {
      await exec(["docker", "rmi", `${REGISTRY}/${IMAGE_REPO}:${version}`]).catch(() => {});
    }
    await exec(["docker", "rmi", `${REGISTRY}/${IMAGE_REPO}:${TEST_ENV}-latest`]).catch(() => {});
    await exec(["docker", "logout", REGISTRY]).catch(() => {});
  }, 60_000);

  test("the watcher sees a marker in a command line, so a clean run means something", async () => {
    const canary: WatchedSecret = { label: "canary", value: "E2E_SECRET_CANARY_7f3a9c" };
    const watch = await watchCommandLines(NODES, [canary]);
    await dockerExec(MANAGER_CONTAINER, ["sh", "-c", "sleep 1", canary.value]);
    await dockerExec(WORKER_CONTAINER, ["sh", "-c", "sleep 1", canary.value]);
    const hits = await watch.stop();

    expect(new Set(hits.map((hit) => hit.container))).toEqual(new Set(NODES));
    expect(hits[0].secret).toBe("canary");
    expect(hits[0].commandLine).not.toContain(canary.value);
  }, 60_000);

  test("a deploy keeps every secret out of the CLI output and the nodes' command lines", async () => {
    const run = await runWatched(["deploy", TEST_ENV, VERSIONS.plain, "--force"], fixture.dir, secrets);

    if (run.result.exitCode !== 0) {
      console.error("[secrets] STDOUT:", run.result.stdout.slice(-3000));
      console.error("[secrets] STDERR:", run.result.stderr.slice(-3000));
    }
    expect(run.result.exitCode).toBe(0);
    expectNoLeak(run, secrets);

    await waitForService(SERVICE_NAME, "1/1", { timeoutMs: 90_000 });
  }, 420_000);

  test("the secrets did reach the service, so the clean run above is not an empty one", async () => {
    const env = await dockerExec(MANAGER_CONTAINER, [
      "docker",
      "service",
      "inspect",
      SERVICE_NAME,
      "--format",
      "{{json .Spec.TaskTemplate.ContainerSpec.Env}}",
    ]);
    expect(env).toContain(`APP_SECRET=${APP_SECRET}`);
  });

  test("a deploy with --debug keeps every secret out of the output and the command lines", async () => {
    const run = await runWatched(["deploy", TEST_ENV, VERSIONS.debug, "--force", "--debug"], fixture.dir, secrets);

    if (run.result.exitCode !== 0) {
      console.error("[secrets debug] STDOUT:", run.result.stdout.slice(-3000));
      console.error("[secrets debug] STDERR:", run.result.stderr.slice(-3000));
    }
    expect(run.result.exitCode).toBe(0);
    expect(combinedOutput(run.result)).toContain("[debug]");
    expectNoLeak(run, secrets);
  }, 420_000);

  test("a rollback and the lock status with --verbose keep them out as well", async () => {
    const rollback = await runWatched(["--verbose", "rollback", TEST_ENV], fixture.dir, secrets);
    if (rollback.result.exitCode !== 0) {
      console.error("[secrets rollback] STDOUT:", rollback.result.stdout.slice(-3000));
      console.error("[secrets rollback] STDERR:", rollback.result.stderr.slice(-3000));
    }
    expect(rollback.result.exitCode).toBe(0);
    expectNoLeak(rollback, secrets);

    expectNoLeak(await runWatched(["--verbose", "lock", "status", TEST_ENV], fixture.dir, secrets), secrets);
  }, 420_000);

  // The remote build runs `docker build --build-arg K=V` through an SSH command, so a build arg's
  // value is on the build node's command line for the whole build.
  test.todo("a remote build keeps build args out of the build node's command line", () => {});
});
