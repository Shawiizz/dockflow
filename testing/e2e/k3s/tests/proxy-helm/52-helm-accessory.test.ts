/**
 * Lane k3s-proxy-helm, file 52 (design-07 17.5 E-52-01..03): an accessory-role Helm release
 * deployed alongside the compose app, matched against the harness's own `helm list`/`get values`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, helm, nsFor, waitWorkloadReady } from "../../../helpers/k8s";
import { chartRepoUrl, SHARED_LANE } from "../../../helpers/topology";

const FILE = "52-helm-accessory.test.ts";
const ENV = "e2e";
const PUBLIC_REPO = chartRepoUrl(SHARED_LANE.net, "public");
const NS = nsFor("helmapp");
const RELEASE = "cache";

interface HelmListEntry {
  name: string;
  revision: number;
  updated: string;
}

function configWithAccessory(message: string): string {
  return [
    'project_name: "helmapp"',
    "",
    "helm:",
    "  releases:",
    `    - name: ${RELEASE}`,
    "      chart: e2e-web",
    `      repo: "${PUBLIC_REPO}"`,
    '      version: "0.1.0"',
    "      role: accessory",
    "      values:",
    `        message: ${message}`,
    "",
  ].join("\n");
}

function configWithoutAccessory(): string {
  return 'project_name: "helmapp"\n';
}

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function releaseEntry(): Promise<HelmListEntry> {
  const raw = await helm(["list", "-n", NS, "-o", "json"]);
  const entries: HelmListEntry[] = JSON.parse(raw);
  const entry = entries.find((candidate) => candidate.name === RELEASE);
  if (!entry) throw new Error(`Helm release ${RELEASE} not found in ${NS}`);
  return entry;
}

describe("52-helm-accessory", () => {
  let fixture: Fixture | undefined;

  afterAll(async () => {
    fixture?.cleanup();
    await deleteStackCompletely(NS);
  });

  test("E-52-01: deployed with accessories; an unchanged redeploy skips it", async () => {
    await withDump("E-52-01", async () => {
      fixture = makeFixture("test-app-k3s-helm", { cluster: "k3s" });
      fixture.write(".dockflow/config.yml", configWithAccessory("cache-v1"));

      const first = await runCLI(["deploy", ENV, "1.0.0", "--all", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(first.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 1);
      await waitWorkloadReady(NS, "deployment", `${RELEASE}-e2e-web`, 1);
      const afterFirst = await releaseEntry();
      expect(afterFirst.revision).toBe(1);

      const second = await runCLI(["deploy", ENV, "1.0.0", "--all", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(second.exitCode).toBe(0);
      const afterSecond = await releaseEntry();
      expect(afterSecond.revision).toBe(1);
    });
  }, 220_000);

  test("E-52-02: a values change creates revision 2", async () => {
    await withDump("E-52-02", async () => {
      if (!fixture) throw new Error("fixture not initialized");
      fixture.write(".dockflow/config.yml", configWithAccessory("cache-v2"));
      const result = await runCLI(["deploy", ENV, "1.0.1", "--all", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", `${RELEASE}-e2e-web`, 1);
      const entry = await releaseEntry();
      expect(entry.revision).toBe(2);
    });
  }, 200_000);

  test("E-52-03: removed from config.yml prints the orphan warning and keeps running", async () => {
    await withDump("E-52-03", async () => {
      if (!fixture) throw new Error("fixture not initialized");
      fixture.write(".dockflow/config.yml", configWithoutAccessory());
      const result = await runCLI(["deploy", ENV, "1.0.2", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        `Helm release ${RELEASE} (accessory) is no longer in config.yml and keeps running`,
      );
      const entry = await releaseEntry();
      expect(entry.revision).toBe(2);
    });
  }, 200_000);
});
