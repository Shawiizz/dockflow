import { describe, test, expect, beforeAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import {
  waitForService,
  getServiceLabels,
  verifyDeployment,
} from "../helpers/docker";
import { writeDockflowEnv } from "../helpers/connection";
import { join } from "path";

const TEST_APP_DIR = join(import.meta.dir, "..", "fixtures", "test-app");
const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-e2e";
const STACK_NAME = `test-app-${TEST_ENV}`;
const SERVICE_NAME = `${STACK_NAME}_web`;

describe("deploy", () => {
  beforeAll(async () => {
    writeDockflowEnv(TEST_APP_DIR);
  });

  test("deploys app successfully", async () => {
    const result = await runCLI(["deploy", TEST_ENV, TEST_VERSION, "--force"], {
      cwd: TEST_APP_DIR,
    });

    expect(result.exitCode).toBe(0);
  }, 180_000);

  test("service reaches 2/2 replicas", async () => {
    await waitForService(SERVICE_NAME, "2/2", { timeoutMs: 90_000 });
  }, 120_000);

  test("deployment is healthy (no failures, distributed, stable)", async () => {
    await verifyDeployment({
      stackName: STACK_NAME,
      serviceName: SERVICE_NAME,
      expectedReplicas: "2/2",
    });
  }, 30_000);

  test("traefik labels are injected", async () => {
    const labels = await getServiceLabels(SERVICE_NAME);
    expect(labels["traefik.enable"]).toBe("true");
  });

  test("HTTP routing via Traefik works", async () => {
    // Wait for Traefik to be running first
    await waitForService("traefik_traefik", "1/1", { timeoutMs: 60_000 });

    // Retry HTTP request — Traefik may need time to discover the backend
    let lastStatus = 0;
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      try {
        const res = await fetch("http://localhost:80/", {
          headers: { Host: "test.local" },
          signal: AbortSignal.timeout(5000),
        });
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 400) {
          return; // Success
        }
      } catch {
        // Connection refused or timeout
      }
      await Bun.sleep(1000);
    }

    throw new Error(`Traefik HTTP routing failed (last status: ${lastStatus})`);
  }, 120_000);
});
