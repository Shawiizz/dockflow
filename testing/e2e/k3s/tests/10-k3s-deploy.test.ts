import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCLI } from "../../helpers/cli";
import { exec, startK3sCluster, stopK3sCluster, waitForK3s } from "../../helpers/cluster";
import { K3S_MANAGER_CONTAINER } from "../../helpers/connection";
import { makeFixture, type Fixture } from "../../helpers/fixtures";
import {
  kubectlExec,
  waitForDeployment,
  getDeploymentReplicas,
  isDeploymentStable,
  namespaceExists,
  dumpK3sDebug,
} from "../../helpers/k8s";

const TEST_ENV = "test";
const TEST_VERSION = "1.0.0-k3s";
const STACK_NAME = `test-app-k3s-${TEST_ENV}`;
const NAMESPACE = `dockflow-${STACK_NAME}`;

describe("k3s deploy", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    // Ensure clean state
    await stopK3sCluster();
    await startK3sCluster();
    await waitForK3s();
    fixture = makeFixture("test-app-k3s", { cluster: "k3s" });
  }, 480_000);

  afterAll(async () => {
    // Dump debug info before teardown (useful for CI failures)
    try { await dumpK3sDebug(NAMESPACE); } catch { /* ignore */ }
    fixture?.cleanup();
    await stopK3sCluster();
  }, 60_000);

  test("deploys to k3s successfully (incl. remote HTTP health check)", async () => {
    const result = await runCLI(["deploy", TEST_ENV, TEST_VERSION, "--force"], {
      cwd: fixture.dir,
    });

    if (result.exitCode !== 0) {
      console.error("[k3s-deploy] STDOUT:", result.stdout.slice(-2000));
      console.error("[k3s-deploy] STDERR:", result.stderr.slice(-2000));
      await dumpK3sDebug(NAMESPACE);
    }
    expect(result.exitCode).toBe(0);
    // The fixture has a remote endpoint check (on_failure: fail) curling
    // through the bundled Traefik — exit 0 plus the absence of this prefix
    // proves the HTTP health check path ran and passed on k3s.
    expect(result.stdout + result.stderr).not.toContain("HTTP check failed");
  }, 240_000);

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

  test("ingressroute is generated from proxy config", async () => {
    const out = await kubectlExec([
      "get", "ingressroute", "web", "-n", NAMESPACE, "-o", "json",
    ]);
    const ingress = JSON.parse(out);
    const route = ingress.spec.routes[0];
    expect(route.match).toContain("k3s.test.local");
    expect(route.services[0].name).toBe("web");
    // acme: false → plain web entrypoint, no TLS resolver
    expect(ingress.spec.entryPoints).toEqual(["web"]);
  }, 30_000);

  test("traefik routes HTTP to the app", async () => {
    // The k3s-bundled Traefik exposes its web entrypoint on the node's port
    // 80 via svclb. Poll: Traefik may still be rolling out on a fresh cluster.
    const deadline = Date.now() + 120_000;
    let last = "";
    while (Date.now() < deadline) {
      last = await exec([
        "docker", "exec", K3S_MANAGER_CONTAINER, "sh", "-c",
        "curl -4 -s --max-time 5 -H 'Host: k3s.test.local' http://localhost:80/ || true",
      ]);
      if (last.includes("Deployment Successful")) return;
      await Bun.sleep(3000);
    }
    throw new Error(`Traefik never routed to the app (last response: ${last.slice(0, 300)})`);
  }, 150_000);

  test("logs work", async () => {
    const result = await runCLI(["logs", TEST_ENV, "web", "-n", "5"], {
      cwd: fixture.dir,
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
      { cwd: fixture.dir },
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
      cwd: fixture.dir,
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
      cwd: fixture.dir,
    });
    expect(result.exitCode).toBe(0);

    await waitForDeployment(NAMESPACE, "web", "1/1", 60_000);
  }, 90_000);
});
