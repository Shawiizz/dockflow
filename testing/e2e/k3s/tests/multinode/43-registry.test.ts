/**
 * k3s-multinode / 43-registry (design-07 17.4 E-43): registry image delivery skips the SSH import
 * path, a pre-pushed image is used directly, additional tags reach the registry, an authenticated
 * registry leaks no credential, and a wrong password fails fast and reverts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Secret } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI } from "../../../helpers/cli";
import { exec } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, getJson, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";
import { watchProcesses } from "../../../helpers/leak-watch";
import { currentTopology, E2E_REGISTRY, E2E_REGISTRY_AUTH, E2E_REGISTRY_PASSWORD, E2E_REGISTRY_USER } from "../../../helpers/topology";

const ENV = "e2e";
const NS = nsFor("k3s-registry", ENV);
const REGISTRY = E2E_REGISTRY;
const AUTH_REGISTRY = E2E_REGISTRY_AUTH;
const AUTH_USER = E2E_REGISTRY_USER;
const AUTH_PASSWORD = E2E_REGISTRY_PASSWORD;

interface Catalog {
  repositories: string[];
}
interface TagList {
  tags: string[];
}

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`43-registry.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

describe("registry delivery", () => {
  let fixture: Fixture;
  let authedFixture: Fixture;

  afterAll(async () => {
    fixture?.cleanup();
    if (authedFixture) await deleteStackCompletely(nsFor("k3s-registry-auth", ENV)).catch(() => {});
    authedFixture?.cleanup();
  });

  test("anonymous registry deploy skips the SSH import path", async () => {
    await withDump("no import lines", async () => {
      fixture = makeFixture("test-app-k3s-registry", { cluster: "k3s" });
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "web", "--yes"], { cwd: fixture.dir, timeoutMs: 240_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("imported on");

      const catalog = (await (await fetch(`http://${REGISTRY}/v2/_catalog`)).json()) as Catalog;
      expect(catalog.repositories).toContain("k3s-registry-web");
    });
  }, 240_000);

  test("every node pulls the registry-prefixed image with IfNotPresent", async () => {
    await withDump("image state on every node", async () => {
      await waitWorkloadReady(NS, "deployment", "web", 3, 120_000);
      const pods = await podsForService(NS, "web");
      expect(pods.length).toBe(3);
      for (const pod of pods) {
        const container = pod.spec.containers[0];
        expect(container?.image).toBe(`${REGISTRY}/k3s-registry-web:1.0.0`);
        expect(container?.imagePullPolicy).toBe("IfNotPresent");
        expect(pod.status?.phase).toBe("Running");
      }
    });
  }, 150_000);

  test("a pre-pushed image is used directly by a service with no build", async () => {
    await withDump("pre-pushed image", async () => {
      await exec(["docker", "pull", "traefik/whoami:latest"]);
      await exec(["docker", "tag", "traefik/whoami:latest", `${REGISTRY}/e2e/whoami:latest`]);
      await exec(["docker", "push", `${REGISTRY}/e2e/whoami:latest`]);

      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "whoami", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "whoami", 1, 120_000);

      const pods = await podsForService(NS, "whoami");
      const container = pods[0]?.spec.containers[0];
      expect(container?.image).toBe(`${REGISTRY}/e2e/whoami:latest`);
      expect(container?.imagePullPolicy).toBe("Always");
      expect(pods[0]?.status?.phase).toBe("Running");
    });
  }, 180_000);

  test("additional_tags reach the registry", async () => {
    await withDump("additional tags", async () => {
      const tags = (await (await fetch(`http://${REGISTRY}/v2/k3s-registry-web/tags/list`)).json()) as TagList;
      expect(tags.tags).toContain("1.0.0");
      expect(tags.tags).toContain(`${ENV}-latest`);
    });
  }, 30_000);

  test("an authenticated registry creates a pull secret and leaks no credential", async () => {
    await withDump("authenticated registry", async () => {
      authedFixture = makeFixture("test-app-k3s-registry", { cluster: "k3s" });
      // its own project (and so its own namespace): a stack of its own, not a redeploy of the
      // anonymous-registry stack above
      authedFixture.patchConfig((text) =>
        text
          .replace('project_name: "k3s-registry"', 'project_name: "k3s-registry-auth"')
          .replace('url: "localhost:35010"', `url: "${AUTH_REGISTRY}"`)
          .replace('password: "e2e-dummy"', `password: "${AUTH_PASSWORD}"`)
          .replace("enabled: true", `enabled: true\n  username: "${AUTH_USER}"`),
      );

      const topo = currentTopology();
      const watch = watchProcesses(
        topo.nodes.map((n) => n.key),
        [/E2E_SECRET_REGISTRY/],
      );
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "web", "--yes"], { cwd: authedFixture.dir, timeoutMs: 240_000 });
      const leaks = await watch.stop();
      expect(leaks).toEqual([]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(AUTH_PASSWORD);
      expect(result.stderr).not.toContain(AUTH_PASSWORD);

      const authedNs = nsFor("k3s-registry-auth", ENV);
      await waitWorkloadReady(authedNs, "deployment", "web", 3, 150_000);

      const [secret] = await getJson<Secret>("secrets", { ns: authedNs, name: "dockflow-registry" });
      expect(secret?.type).toBe("kubernetes.io/dockerconfigjson");

      const pods = await podsForService(authedNs, "web");
      for (const pod of pods) {
        expect(pod.spec.imagePullSecrets?.some((s) => s.name === "dockflow-registry")).toBe(true);
        expect(pod.status?.phase).toBe("Running");
      }
    });
  }, 300_000);

  test("a wrong registry password fails fast and reverts", async () => {
    await withDump("wrong password reverts", async () => {
      const authedNs = nsFor("k3s-registry-auth", ENV);
      authedFixture.patchConfig((text) => text.replace(`password: "${AUTH_PASSWORD}"`, 'password: "wrong-password"'));

      const result = await runCLI(["deploy", ENV, "1.0.1", "--only", "web", "--yes"], { cwd: authedFixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(53);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(/unauthorized|auth|denied/i);

      const pods = await podsForService(authedNs, "web");
      for (const pod of pods) expect(pod.spec.containers[0]?.image).toBe(`${AUTH_REGISTRY}/k3s-registry-web:1.0.0`);
    });
  }, 180_000);
});
