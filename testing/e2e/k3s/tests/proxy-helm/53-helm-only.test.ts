/**
 * Lane k3s-proxy-helm, file 53 (design-07 17.5 E-53-01..04): a project with no docker-compose.yml
 * anywhere under it, so deploy.ts's Helm-only path (DESIGN-CORE 7.1) is the one under test — no
 * build phase, no image distribution, `status`/`ps` see the release as the stack's only workload.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, getJson, nsFor, waitWorkloadReady } from "../../../helpers/k8s";
import type { ConfigMap } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";

const FILE = "53-helm-only.test.ts";
const ENV = "e2e";
const NS = nsFor("helmonly");
const TRANSITION_NS = nsFor("helmtransition");

function helmOnlyConfig(): string {
  return [
    "project_name: \"helmonly\"",
    "",
    "helm:",
    "  releases:",
    "    - name: web",
    "      chart: e2e-web",
    "      repo: \"http://172.30.0.7:8080/public\"",
    "      version: \"0.1.0\"",
    "      values:",
    "        message: helm-only-v1",
    "",
  ].join("\n");
}

function helmOnlyConfigV2(): string {
  return helmOnlyConfig().replace("helm-only-v1", "helm-only-v2");
}

function transitionConfigWithRelease(): string {
  return [
    "project_name: \"helmtransition\"",
    "",
    "helm:",
    "  releases:",
    "    - name: web2",
    "      chart: e2e-web",
    "      repo: \"http://172.30.0.7:8080/public\"",
    "      version: \"0.1.0\"",
    "      values:",
    "        message: helm-only-transition",
    "",
  ].join("\n");
}

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

describe("53-helm-only", () => {
  describe("E-53-01/02: no compose, one app release", () => {
    let fixture: Fixture | undefined;

    afterAll(() => {
      fixture?.cleanup();
    });

    test("E-53-01: deploy succeeds without a build or distribution phase", async () => {
      await withDump("E-53-01", async () => {
        fixture = makeFixture("test-app-k3s-helm-only", { cluster: "k3s" });
        fixture.write(".dockflow/config.yml", helmOnlyConfig());

        const deploy = await runCLI(["deploy", ENV, "1.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(deploy.exitCode).toBe(0);
        expect(`${deploy.stdout}${deploy.stderr}`).not.toContain("Building ");

        await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);

        const status = await runCLI(["status", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain(ENV);

        const ps = await runCLI(["ps", ENV, "--json"], { cwd: fixture.dir, timeoutMs: 30_000 });
        expect(ps.exitCode).toBe(0);
        const instances: Array<{ service: string }> = JSON.parse(ps.stdout);
        expect(instances.some((instance) => instance.service === "web")).toBe(true);
      });
    }, 200_000);

    test("E-53-02: a second version then `rollback e2e` restores the previous chart values", async () => {
      await withDump("E-53-02", async () => {
        if (!fixture) throw new Error("fixture not initialized");
        fixture.write(".dockflow/config.yml", helmOnlyConfigV2());
        const deploy = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(deploy.exitCode).toBe(0);
        await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
        const [afterV2] = await getJson<ConfigMap>("configmaps", { ns: NS, name: "web-e2e-web" });
        expect(afterV2?.data?.message).toBe("helm-only-v2");

        const rollback = await runCLI(["rollback", ENV], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(rollback.exitCode).toBe(0);
        await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
        const [restored] = await getJson<ConfigMap>("configmaps", { ns: NS, name: "web-e2e-web" });
        expect(restored?.data?.message).toBe("helm-only-v1");
      });
    }, 200_000);
  });

  describe("E-53-03: compose replaced by an app release", () => {
    let fixture: Fixture | undefined;

    afterAll(() => {
      fixture?.cleanup();
    });

    test("E-53-03: refuses to prune live compose workloads, then succeeds after `stop`", async () => {
      await withDump("E-53-03", async () => {
        fixture = makeFixture("test-app-k3s-helm-only/transition", { cluster: "k3s" });
        const composeDeploy = await runCLI(["deploy", ENV, "1.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(composeDeploy.exitCode).toBe(0);
        await waitWorkloadReady(TRANSITION_NS, "deployment", "web", 1);

        rmSync(fixture.path(".dockflow/docker/docker-compose.yml"));
        fixture.write(".dockflow/config.yml", transitionConfigWithRelease());

        const refused = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 120_000 });
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain(`Refusing to prune: the rendered stack has no services but 1 workloads run in ${TRANSITION_NS}`);
        expect(refused.stderr).toContain("Remove them with `dockflow stop e2e`, then deploy again.");

        const stop = await runCLI(["stop", ENV, "--yes"], { cwd: fixture.dir, timeoutMs: 120_000 });
        expect(stop.exitCode).toBe(0);

        const retried = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(retried.exitCode).toBe(0);
        await waitWorkloadReady(TRANSITION_NS, "deployment", "web2-e2e-web", 1);
      });
    }, 300_000);
  });

  describe("E-53-04: no compose and no app release", () => {
    test("refuses with the plain compose-loader message", async () => {
      await withDump("E-53-04", async () => {
        const fixture = makeFixture("test-app-k3s-helm-only", { cluster: "k3s" });
        try {
          const result = await runCLI(["deploy", ENV, "1.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 60_000 });
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("No docker-compose.yml found");
        } finally {
          fixture.cleanup();
        }
      });
    }, 90_000);
  });

  afterAll(async () => {
    await deleteStackCompletely(NS);
    await deleteStackCompletely(TRANSITION_NS);
  });
});
