/**
 * E2E test for proxy.routes.
 *
 * Scenario: an accessory publishes no port and listens on two, 4326 and 4327.
 * Two routes send its domain to 4326 and the /ws path of that domain to 4327,
 * while the app keeps its route on proxy.domains. Before that, a route naming
 * a service that does not exist must stop the deploy.
 *
 * Runs on its own stacks (project_name test-app-routes) so its routes cannot
 * interfere with the shared happy-path chain.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runCLI } from "../../helpers/cli";
import { waitForService, getServiceLabels, dockerExec } from "../../helpers/docker";
import { MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";

const TEST_ENV = "test";
const VERSION = "1.0.0-routes";
const STACK_NAME = `test-app-routes-${TEST_ENV}`;
const ACCESSORIES_STACK = `${STACK_NAME}-accessories`;
const PANEL_SERVICE = `${ACCESSORIES_STACK}_panel`;
const ROUTER = `${STACK_NAME}-panel-route2`;

/** GET through Traefik (manager port 80, published on the host as 38080) until the body holds `marker`. */
async function waitForRoute(host: string, path: string, marker: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:38080${path}`, {
        headers: { Host: host },
        signal: AbortSignal.timeout(5000),
      });
      last = `${res.status} ${await res.text()}`;
      if (res.status === 200 && last.includes(marker)) return;
    } catch (e) {
      last = String(e);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${host}${path} never answered "${marker}" through Traefik (last: ${last.slice(0, 200)})`);
}

describe("proxy.routes", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-routes");
  });

  afterAll(async () => {
    fixture?.cleanup();
    // Remove the stacks, and the accessories hash so a re-run deploys them again
    for (const stack of [STACK_NAME, ACCESSORIES_STACK]) {
      await dockerExec(MANAGER_CONTAINER, ["docker", "stack", "rm", stack]).catch(() => {});
    }
    await dockerExec(MANAGER_CONTAINER, ["rm", "-rf", `/var/lib/dockflow/accessories/${STACK_NAME}`]).catch(() => {});
  });

  test("a route to a missing service stops the deploy before it starts", async () => {
    const configPath = join(fixture.dir, ".dockflow", "config.yml");
    const config = readFileSync(configPath, "utf-8");
    writeFileSync(configPath, config.replace("- service: panel", "- service: pannel"));
    try {
      const result = await runCLI(["deploy", TEST_ENV, VERSION, "--all"], { cwd: fixture.dir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'proxy.routes[0]: no service "pannel" in docker-compose.yml or accessories.yml',
      );
    } finally {
      writeFileSync(configPath, config);
    }
  }, 120_000);

  test("deploys the app and the routed accessory", async () => {
    const result = await runCLI(["deploy", TEST_ENV, VERSION, "--all", "--force"], { cwd: fixture.dir });

    if (result.exitCode !== 0) {
      console.error("[routes] STDOUT:", result.stdout.slice(-2000));
      console.error("[routes] STDERR:", result.stderr.slice(-2000));
    }
    expect(result.exitCode).toBe(0);

    await waitForService(PANEL_SERVICE, "1/1", { timeoutMs: 90_000 });
    await waitForService(`${STACK_NAME}_web`, "1/1", { timeoutMs: 90_000 });
  }, 240_000);

  test("the accessory publishes nothing and carries a router per route", async () => {
    const ports = await dockerExec(MANAGER_CONTAINER, [
      "docker", "service", "inspect", PANEL_SERVICE, "--format", "{{json .Endpoint.Ports}}",
    ]);
    expect(ports.trim()).toBe("null");

    const labels = await getServiceLabels(PANEL_SERVICE);
    expect(labels[`traefik.http.routers.${ROUTER}.rule`]).toBe("Host(`panel.test.local`) && PathPrefix(`/ws`)");
    expect(labels[`traefik.http.routers.${ROUTER}.service`]).toBe(ROUTER);
    expect(labels[`traefik.http.services.${ROUTER}.loadbalancer.server.port`]).toBe("4327");
  }, 30_000);

  test("Traefik sends the domain to one port and its /ws path, unchanged, to the other", async () => {
    await waitForRoute("panel.test.local", "/", "panel-http");
    await waitForRoute("panel.test.local", "/ws", "panel-ws");
  }, 150_000);

  test("the app keeps its route on proxy.domains", async () => {
    await waitForRoute("routes.test.local", "/", "Welcome to nginx");
  }, 90_000);
});
