/**
 * E-30 (design-07 17.1, DESIGN-CORE 8.9 "e2e contract"): every golden expected YAML must be accepted
 * by the pinned server (E-30-01/02), a real object must stay stable across an unchanged re-apply
 * (E-30-03), and the offline/online paths of an invalid compose file must both refuse before any
 * mutation (E-30-04/05), with the render contract itself checked once more on a dry-run (E-30-06).
 *
 * The golden cases themselves (`cli/src/__tests__/kubernetes/golden/**`) are P57/P58's; this file
 * only reads their already-verified expected YAML (P51's harness) and applies it to a real cluster —
 * the one check no offline test can do.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { TRAEFIK_CHART_PIN } from "../../../../../cli/src/services/orchestrator/kubernetes/versions";
import { parseManifests } from "../../../../../cli/src/services/orchestrator/kubernetes/yaml";
import { isManifestKind, KIND_REGISTRY } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/registry";
import { identity } from "../../../../../cli/src/__tests__/kubernetes/support/builders";
import { discoverCases, readExpectedText, type GoldenCase } from "../../../../../cli/src/__tests__/kubernetes/support/golden";
import { runCLI } from "../../../helpers/cli";
import { tryExec } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { makeFixture } from "../../../helpers/fixtures";
import {
  extractRenderedManifest,
  getJson,
  kubectl,
  leaseFor,
  nodeExec,
  nsFor,
  releaseSecrets,
  renderedLeafMismatches,
} from "../../../helpers/k8s";
import { currentTopology, managersOf } from "../../../helpers/topology";

const FILE = "30-render-contract.test.ts";
const FIELD_MANAGER = "e2e-contract";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

// ─── shared setup: Traefik CRDs, and every golden case's expected role output ──────

const CRD_TMP_DIR = "/tmp/e2e-traefik-crds";

/** design-07 16.4/16.8: the pinned Traefik chart is already verified in the node's content-addressed cache. */
async function installTraefikCrds(): Promise<{ exitCode: number; stderr: string }> {
  const cachePath = `/var/cache/dockflow/sha256/${TRAEFIK_CHART_PIN.sha256}`;
  const command = [
    `mkdir -p ${CRD_TMP_DIR}`,
    `tar -xzf ${cachePath} -C ${CRD_TMP_DIR} --strip-components=2 --wildcards 'traefik/crds/*.yaml'`,
    `/usr/local/bin/k3s kubectl apply --server-side --field-manager=${FIELD_MANAGER} -f ${CRD_TMP_DIR}`,
  ].join(" && ");
  const result = await nodeExec("server_1", command, { user: "root" });
  return { exitCode: result.exitCode, stderr: result.stderr };
}

interface CaseRole {
  case: GoldenCase;
  role: "app" | "accessory";
  namespace: string;
  yaml: string;
}

async function everyRoleWithExpectedYaml(cases: readonly GoldenCase[]): Promise<CaseRole[]> {
  const roles: CaseRole[] = [];
  for (const c of cases) {
    if (c.input.expectLoadError !== undefined) continue;
    const id = identity(c.input.identity);
    for (const role of ["app", "accessory"] as const) {
      if (c.input.expectRenderError?.[role] === true) continue;
      const yaml = await readExpectedText(c, `expected-${role}.yaml`);
      if (yaml !== null) roles.push({ case: c, role, namespace: id.namespace, yaml });
    }
  }
  return roles;
}

const createdNamespaces = new Set<string>();

async function ensureNamespace(ns: string): Promise<void> {
  if (createdNamespaces.has(ns)) return;
  createdNamespaces.add(ns);
  await kubectl(["create", "namespace", ns], { allowFailure: true });
}

/** Raw harness kubectl (stdout AND stderr, never throwing): kubectl() drops stderr on success, and
 * E-30-01 needs it to check for a deprecation `Warning:` line on an otherwise-successful dry-run. */
async function rawKubectl(args: readonly string[], stdin: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const container = managersOf(currentTopology())[0]?.container;
  if (!container) throw new Error(`Topology ${currentTopology().name} has no manager node`);
  return tryExec(["docker", "exec", "-i", container, "/usr/local/bin/k3s", "kubectl", ...args], { input: stdin });
}

describe("core 8.9 e2e render contract", () => {
  afterAll(async () => {
    for (const ns of createdNamespaces) {
      await kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=false"], { allowFailure: true });
    }
  });

  test("E-30-01: every golden expected object is accepted server-side (dry-run)", async () => {
    await withDump("E-30-01", async () => {
      const crds = await installTraefikCrds();
      expect(crds.exitCode).toBe(0);
      expect(crds.stderr).not.toMatch(/Warning:/);

      const cases = await discoverCases();
      const roles = await everyRoleWithExpectedYaml(cases);
      expect(roles.length).toBeGreaterThan(0);

      // One pass, every case recorded (not stopped at the first failure): the row's own "list of
      // failing cases printed" contract.
      const failing: string[] = [];
      for (const entry of roles) {
        await ensureNamespace(entry.namespace);
        const applied = await rawKubectl(
          ["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "--dry-run=server", "-f", "-"],
          entry.yaml,
        );
        if (applied.exitCode !== 0) {
          failing.push(`${entry.case.name} (${entry.role}): exit ${applied.exitCode}: ${applied.stderr.trim().slice(0, 300)}`);
        } else if (/Warning:/.test(applied.stderr)) {
          failing.push(`${entry.case.name} (${entry.role}): deprecation warning: ${applied.stderr.trim()}`);
        }
      }
      expect(failing).toEqual([]);
    });
  }, 300_000);

  test("E-30-02: kitchen-sink dry-run -o json equals the rendered leaves", async () => {
    await withDump("E-30-02", async () => {
      const cases = await discoverCases();
      const kitchenSink = cases.find((c) => c.name === "kitchen-sink");
      if (!kitchenSink) throw new Error("golden case kitchen-sink not found (owned by P57/P58)");
      const id = identity(kitchenSink.input.identity);
      await ensureNamespace(id.namespace);

      const mismatches: string[] = [];
      for (const role of ["app", "accessory"] as const) {
        const yaml = await readExpectedText(kitchenSink, `expected-${role}.yaml`);
        if (yaml === null) continue;
        for (const rendered of parseManifests(yaml)) {
          if (!isManifestKind(rendered.kind)) continue;
          const out = await kubectl(
            ["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "--dry-run=server", "-o", "json", "-f", "-"],
            { stdin: `${JSON.stringify(rendered)}\n` },
          );
          const server: unknown = JSON.parse(out);
          mismatches.push(...renderedLeafMismatches(rendered, server, { secretDataMasked: false }));
        }
      }
      expect(mismatches).toEqual([]);
    });
  }, 180_000);

  test("E-30-03: a real apply of kitchen-sink twice leaves generation/resourceVersion unchanged", async () => {
    await withDump("E-30-03", async () => {
      const cases = await discoverCases();
      const kitchenSink = cases.find((c) => c.name === "kitchen-sink");
      if (!kitchenSink) throw new Error("golden case kitchen-sink not found");
      const id = identity(kitchenSink.input.identity);
      await ensureNamespace(id.namespace);

      const objects: { kind: string; name: string; namespace: string | null }[] = [];
      for (const role of ["app", "accessory"] as const) {
        const yaml = await readExpectedText(kitchenSink, `expected-${role}.yaml`);
        if (yaml === null) continue;
        for (const obj of parseManifests(yaml)) {
          if (!isManifestKind(obj.kind)) continue;
          objects.push({ kind: obj.kind, name: obj.metadata.name, namespace: obj.metadata.namespace ?? null });
          await kubectl(["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "-f", "-"], { stdin: `${JSON.stringify(obj)}\n` });
        }
      }

      const before = await readMetaStamps(objects);
      for (const role of ["app", "accessory"] as const) {
        const yaml = await readExpectedText(kitchenSink, `expected-${role}.yaml`);
        if (yaml === null) continue;
        for (const obj of parseManifests(yaml)) {
          if (!isManifestKind(obj.kind)) continue;
          await kubectl(["apply", "--server-side", `--field-manager=${FIELD_MANAGER}`, "-f", "-"], { stdin: `${JSON.stringify(obj)}\n` });
        }
      }
      const after = await readMetaStamps(objects);

      expect(after).toEqual(before);
      await kubectl(["delete", "namespace", id.namespace, "--ignore-not-found", "--wait=true"], { allowFailure: true });
      createdNamespaces.delete(id.namespace);
    });
  }, 180_000);

  test("E-30-04: validate refuses an invalid compose file offline, fast (no SSH to an unroutable host)", async () => {
    await withDump("E-30-04", async () => {
      const fixture = makeFixture("test-app-k3s-invalid", { cluster: "k3s" });
      try {
        const started = Date.now();
        const result = await runCLI(["validate", "e2e"], { cwd: fixture.dir, timeoutMs: 10_000 });
        const elapsed = Date.now() - started;
        expect(result.exitCode).toBe(60);
        const out = result.stdout + result.stderr;
        expect(out).toContain("docker-compose.yml cannot be deployed with orchestrator: k3s");
        expect(out).toContain("include");
        expect(out).toContain("services.web.cpu_count");
        expect(out).toContain('volumes["bad name!"]');
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        fixture.cleanup();
      }
    });
  }, 20_000);

  test("E-30-05: deploy of the same invalid compose refuses before any cluster mutation", async () => {
    await withDump("E-30-05", async () => {
      const fixture = makeFixture("test-app-k3s-invalid", { cluster: "k3s", topology: currentTopology() });
      try {
        const result = await runCLI(["deploy", "e2e", "1.0.0"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(60);
        const ns = nsFor("k3s-invalid");
        expect(ns).toBe("dockflow-k3s-invalid-e2e");
        expect(await getJson("namespaces", { name: ns })).toEqual([]);
        expect(await leaseFor(ns)).toBeNull();
        expect(await releaseSecrets(ns)).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    });
  }, 60_000);

  test("E-30-06: deploy --dry-run --render prints the artifact and creates nothing", async () => {
    await withDump("E-30-06", async () => {
      const fixture = makeFixture("test-app-k3s-basic", { cluster: "k3s", topology: currentTopology() });
      try {
        const result = await runCLI(["deploy", "e2e", "1.0.0", "--dry-run", "--render"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("# dockflow-artifact: k8s-manifests/1");
        expect(result.stdout).toContain("namespace: dockflow-k3s-basic-e2e");

        const manifest = extractRenderedManifest(result.stdout);
        for (const obj of parseManifests(manifest)) {
          if (obj.kind !== "Secret") continue;
          const data = (obj as unknown as { data?: Record<string, string> }).data ?? {};
          for (const value of Object.values(data)) expect(value).toBe("***");
        }

        expect(await getJson("namespaces", { name: "dockflow-k3s-basic-e2e" })).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    });
  }, 60_000);
});

// ─── local helpers ──────────────────────────────────────────────────

interface MetaStamp {
  kind: string;
  name: string;
  namespace: string | null;
  generation: unknown;
  resourceVersion: unknown;
}

async function readMetaStamps(objects: readonly { kind: string; name: string; namespace: string | null }[]): Promise<MetaStamp[]> {
  const stamps: MetaStamp[] = [];
  for (const obj of objects) {
    const resource = KIND_REGISTRY[obj.kind as keyof typeof KIND_REGISTRY]?.resource;
    if (!resource) continue;
    const [live] = await getJson<{ metadata?: { generation?: unknown; resourceVersion?: unknown } }>(resource, {
      ...(obj.namespace ? { ns: obj.namespace } : {}),
      name: obj.name,
    });
    stamps.push({
      kind: obj.kind,
      name: obj.name,
      namespace: obj.namespace,
      generation: live?.metadata?.generation,
      resourceVersion: live?.metadata?.resourceVersion,
    });
  }
  return stamps;
}
