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
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { exec } from "../../helpers/cluster";
import { waitForService, dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

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
  });

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
