import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../helpers/cli";
import { startK3sCluster, stopK3sCluster, waitForK3s } from "../helpers/cluster";
import { writeK3sDockflowEnv, cleanDockflowEnv } from "../helpers/connection";
import {
  waitForDeployment,
  getDeploymentReplicas,
  isDeploymentStable,
  namespaceExists,
  dumpK3sDebug,
} from "../helpers/k8s";
import { join } from "path";

const TEST_APP_DIR = join(import.meta.dir, "..", "fixtures", "test-app-k3s");
const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-k3s";
const STACK_NAME = `test-app-k3s-${TEST_ENV}`;
const NAMESPACE = `dockflow-${STACK_NAME}`;

describe("k3s deploy", () => {
  beforeAll(async () => {
    // Ensure clean state
    await stopK3sCluster();
    await startK3sCluster();
    await waitForK3s();
    writeK3sDockflowEnv(TEST_APP_DIR);
  }, 480_000);

  afterAll(async () => {
    // Dump debug info before teardown (useful for CI failures)
    try { await dumpK3sDebug(NAMESPACE); } catch { /* ignore */ }
    cleanDockflowEnv(TEST_APP_DIR);
    await stopK3sCluster();
  }, 60_000);

  test("deploys to k3s successfully", async () => {
    const result = await runCLI(["deploy", TEST_ENV, TEST_VERSION, "--force"], {
      cwd: TEST_APP_DIR,
    });

    if (result.exitCode !== 0) {
      console.error("[k3s-deploy] STDOUT:", result.stdout.slice(-2000));
      console.error("[k3s-deploy] STDERR:", result.stderr.slice(-2000));
      await dumpK3sDebug(NAMESPACE);
    }
    expect(result.exitCode).toBe(0);
  }, 180_000);

  test("namespace is created", async () => {
    expect(await namespaceExists(NAMESPACE)).toBe(true);
  });

  test("deployment reaches 1/1 replicas", async () => {
    await waitForDeployment(NAMESPACE, "web", "1/1", 90_000);
  }, 120_000);

  test("deployment is stable", async () => {
    const stable = await isDeploymentStable(NAMESPACE, "web");
    expect(stable).toBe(true);
  }, 15_000);

  test("logs work", async () => {
    const result = await runCLI(["logs", TEST_ENV, "web", "-n", "5"], {
      cwd: TEST_APP_DIR,
    });

    if (result.exitCode !== 0) {
      console.error("[k3s-logs] STDOUT:", result.stdout);
      console.error("[k3s-logs] STDERR:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("exec works", async () => {
    const result = await runCLI(
      ["exec", TEST_ENV, "web", "--", "echo", "hello-k3s"],
      { cwd: TEST_APP_DIR },
    );

    if (result.exitCode !== 0) {
      console.error("[k3s-exec] STDOUT:", result.stdout);
      console.error("[k3s-exec] STDERR:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-k3s");
  }, 30_000);

  test("scale up to 2 replicas", async () => {
    const result = await runCLI(["scale", TEST_ENV, "web", "2"], {
      cwd: TEST_APP_DIR,
    });

    if (result.exitCode !== 0) {
      console.error("[k3s-scale] STDOUT:", result.stdout);
      console.error("[k3s-scale] STDERR:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    await waitForDeployment(NAMESPACE, "web", "2/2", 60_000);
    const replicas = await getDeploymentReplicas(NAMESPACE, "web");
    expect(replicas).toBe("2/2");
  }, 90_000);

  test("scale back to 1 replica", async () => {
    const result = await runCLI(["scale", TEST_ENV, "web", "1"], {
      cwd: TEST_APP_DIR,
    });
    expect(result.exitCode).toBe(0);

    await waitForDeployment(NAMESPACE, "web", "1/1", 60_000);
  }, 90_000);
});
