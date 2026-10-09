/**
 * E2E tests for the registry distribution mode.
 *
 * With registry.enabled, the deploy must: prefix image tags with the registry
 * URL, build under that name, push it (plus additional_tags) to the registry,
 * log the manager in, and let the cluster pull the image instead of receiving
 * the default base64-over-SSH transfer.
 *
 * The registry is an anonymous registry:2 running inside the manager DinD
 * node, reachable as localhost:35000 from both the host (push) and the
 * manager's inner daemon (pull) — see startRegistry() in helpers/cluster.ts.
 * The service is pinned to the manager, which also lets us assert the worker
 * never received the image.
 *
 * A second registry on localhost:35001 asks for credentials: the second suite
 * deploys through it with a password and with a token, and checks that a wrong
 * password stops the deploy at the login.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { combinedOutput, runCLI } from "../../helpers/cli";
import { exec } from "../../helpers/cluster";
import { waitForService, dockerExec, releaseModes, PRIVATE_RELEASE_MODES } from "../../helpers/docker";
import {
  AUTH_REGISTRY_PASSWORD,
  AUTH_REGISTRY_PORT,
  AUTH_REGISTRY_USER,
  MANAGER_CONTAINER,
  WORKER_CONTAINER,
} from "../../helpers/connection";
import { makeFixture, patchFile, type Fixture } from "../../helpers/fixtures";
import { join } from "path";

const TEST_ENV = "test";
const VERSION = "1.0.0-reg";
const STACK_NAME = `test-app-reg-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;
const REGISTRY = "localhost:35000";
const IMAGE_REPO = "test-reg-web-app-test";
const FULL_IMAGE = `${REGISTRY}/${IMAGE_REPO}:${VERSION}`;

describe("registry distribution", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-registry");
  });

  afterAll(async () => {
    fixture?.cleanup();
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", STACK_NAME]).catch(() => {});
    // Remove the registry-tagged images built on the host
    await exec(["docker", "rmi", FULL_IMAGE]).catch(() => {});
    await exec(["docker", "rmi", `${REGISTRY}/${IMAGE_REPO}:${TEST_ENV}-latest`]).catch(() => {});
    // The deploy logged this machine's engine in
    await exec(["docker", "logout", REGISTRY]).catch(() => {});
  }, 60_000);

  test("registry API is reachable from the host", async () => {
    const res = await fetch(`http://${REGISTRY}/v2/`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
  });

  test("deploy builds, pushes and deploys through the registry", async () => {
    const result = await runCLI(["deploy", TEST_ENV, VERSION, "--force"], {
      cwd: fixture.dir,
    });

    if (result.exitCode !== 0) {
      console.error("[registry] STDOUT:", result.stdout.slice(-3000));
      console.error("[registry] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(0);
  }, 240_000);

  test("the release directory and its files are private to the deploy user", async () => {
    expect(await releaseModes(STACK_NAME, VERSION)).toEqual(PRIVATE_RELEASE_MODES);
  });

  test("service runs the registry-prefixed image", async () => {
    await waitForService(SERVICE_NAME, "1/1", { timeoutMs: 90_000 });

    const image = await dockerExec(MANAGER_CONTAINER, [
      "docker",
      "service",
      "inspect",
      SERVICE_NAME,
      "--format",
      "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    ]);
    expect(image.trim()).toStartWith(FULL_IMAGE);
  }, 120_000);

  test("image and additional tags are in the registry", async () => {
    const catalog = await (await fetch(`http://${REGISTRY}/v2/_catalog`)).json() as { repositories: string[] };
    expect(catalog.repositories).toContain(IMAGE_REPO);

    const tags = await (await fetch(`http://${REGISTRY}/v2/${IMAGE_REPO}/tags/list`)).json() as { tags: string[] };
    expect(tags.tags).toContain(VERSION);
    // additional_tags: ["{env}-latest"] → "test-latest"
    expect(tags.tags).toContain(`${TEST_ENV}-latest`);
  });

  test("manager pulled the image, worker never received it", async () => {
    // Registry mode must skip the default SSH transfer (which loads the
    // image on EVERY node) — the manager pulls on schedule, the worker
    // has no task and therefore no image.
    //
    // Swarm pins service images by digest, and digest-only pulls carry no
    // repo tag (invisible in `docker images`) — presence must be checked
    // with `docker image inspect <exact spec reference>` on each node.
    const specImage = (
      await dockerExec(MANAGER_CONTAINER, [
        "docker", "service", "inspect", SERVICE_NAME,
        "--format", "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
      ])
    ).trim();

    const hasImage = (node: string) =>
      dockerExec(node, ["docker", "image", "inspect", specImage])
        .then(() => true)
        .catch(() => false);

    expect(await hasImage(MANAGER_CONTAINER)).toBe(true);
    expect(await hasImage(WORKER_CONTAINER)).toBe(false);
  });

  test("app serves traffic", async () => {
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      last = await dockerExec(MANAGER_CONTAINER, [
        "sh",
        "-c",
        "curl -4 -s --max-time 5 http://localhost:8089/ || true",
      ]);
      if (last.includes("REGISTRY_TEST_APP")) return;
      await Bun.sleep(2000);
    }
    throw new Error(`App never served content (last response: ${last.slice(0, 200)})`);
  }, 60_000);
});

describe("registry that asks for credentials", () => {
  const AUTH_REGISTRY = `localhost:${AUTH_REGISTRY_PORT}`;
  const AUTH_STACK = `test-app-regauth-${TEST_ENV}`;
  const AUTH_SERVICE = `${AUTH_STACK}_web`;
  const WRONG_PASSWORD = "E2E_SECRET_WRONG_7f3a9c";
  const VERSIONS = { password: "1.0.0-auth", wrong: "2.0.0-auth", token: "3.0.0-auth" };
  const imageOf = (version: string) => `${AUTH_REGISTRY}/${IMAGE_REPO}:${version}`;
  const basicAuth = `Basic ${btoa(`${AUTH_REGISTRY_USER}:${AUTH_REGISTRY_PASSWORD}`)}`;

  let fixture: Fixture;
  let configPath: string;

  /** The image the service runs, with the digest Swarm pins it to */
  const runningImage = () =>
    dockerExec(MANAGER_CONTAINER, [
      "docker",
      "service",
      "inspect",
      AUTH_SERVICE,
      "--format",
      "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    ]);

  beforeAll(() => {
    fixture = makeFixture("test-app-registry");
    configPath = join(fixture.dir, ".dockflow", "config.yml");
    patchFile(configPath, 'project_name: "test-app-reg"', 'project_name: "test-app-regauth"');
    patchFile(configPath, 'url: "localhost:35000"', `url: "${AUTH_REGISTRY}"`);
    patchFile(configPath, "password: e2e-dummy", `password: ${AUTH_REGISTRY_PASSWORD}`);
    patchFile(join(fixture.dir, ".dockflow", "servers.yml"), 'WEB_PORT: "8089"', 'WEB_PORT: "8090"');
  });

  afterAll(async () => {
    fixture?.cleanup();
    await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", AUTH_STACK]).catch(() => {});
    for (const version of Object.values(VERSIONS)) {
      await exec(["docker", "rmi", imageOf(version)]).catch(() => {});
    }
    await exec(["docker", "rmi", `${AUTH_REGISTRY}/${IMAGE_REPO}:${TEST_ENV}-latest`]).catch(() => {});
    await exec(["docker", "logout", AUTH_REGISTRY]).catch(() => {});
  }, 60_000);

  test("the registry refuses requests without credentials", async () => {
    const res = await fetch(`http://${AUTH_REGISTRY}/v2/`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(401);
  });

  test("a deploy with the right password pushes the image and runs it", async () => {
    const result = await runCLI(["deploy", TEST_ENV, VERSIONS.password, "--force"], { cwd: fixture.dir });

    if (result.exitCode !== 0) {
      console.error("[registry auth] STDOUT:", result.stdout.slice(-3000));
      console.error("[registry auth] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(0);
    expect(combinedOutput(result)).not.toContain(AUTH_REGISTRY_PASSWORD);

    await waitForService(AUTH_SERVICE, "1/1", { timeoutMs: 90_000 });
    expect((await runningImage()).trim()).toStartWith(imageOf(VERSIONS.password));

    const tags = (await (
      await fetch(`http://${AUTH_REGISTRY}/v2/${IMAGE_REPO}/tags/list`, { headers: { Authorization: basicAuth } })
    ).json()) as { tags: string[] };
    expect(tags.tags).toContain(VERSIONS.password);
  }, 300_000);

  test("a wrong password stops the deploy at the login and leaves the stack on its image", async () => {
    patchFile(configPath, `password: ${AUTH_REGISTRY_PASSWORD}`, `password: ${WRONG_PASSWORD}`);
    try {
      const result = await runCLI(["deploy", TEST_ENV, VERSIONS.wrong, "--force"], { cwd: fixture.dir });
      const output = combinedOutput(result);

      expect(result.exitCode).toBe(50);
      expect(output).toContain(`Registry login to ${AUTH_REGISTRY} failed`);
      expect(output).not.toContain(WRONG_PASSWORD);
      expect(output).not.toContain(AUTH_REGISTRY_PASSWORD);
    } finally {
      patchFile(configPath, `password: ${WRONG_PASSWORD}`, `password: ${AUTH_REGISTRY_PASSWORD}`);
    }

    expect((await runningImage()).trim()).toStartWith(imageOf(VERSIONS.password));
  }, 300_000);

  test("registry.token logs in like a password", async () => {
    patchFile(configPath, `password: ${AUTH_REGISTRY_PASSWORD}`, `token: ${AUTH_REGISTRY_PASSWORD}`);

    const result = await runCLI(["deploy", TEST_ENV, VERSIONS.token, "--force"], { cwd: fixture.dir });

    if (result.exitCode !== 0) {
      console.error("[registry token] STDOUT:", result.stdout.slice(-3000));
      console.error("[registry token] STDERR:", result.stderr.slice(-3000));
    }
    expect(result.exitCode).toBe(0);
    await waitForService(AUTH_SERVICE, "1/1", { timeoutMs: 90_000 });
    expect((await runningImage()).trim()).toStartWith(imageOf(VERSIONS.token));
  }, 300_000);
});
