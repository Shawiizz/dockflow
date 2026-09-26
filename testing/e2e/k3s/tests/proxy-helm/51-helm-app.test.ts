/**
 * Lane k3s-proxy-helm, file 51 (design-07 17.5 E-51-01..15, plus the `--adopt` and chart-drift
 * scenarios WORK-PACKAGES names from design-04 4.3 `helm-adopt`/`helm-chart-drift`): one app-role
 * Helm release chain against the harness's own `helm`/kubectl, `dockflow helm *` and `dockflow
 * rollback`.
 *
 * A single fixture carries the whole chain (rows share state the way the design table itself does:
 * "add `bad`", "remove `web` from config", ... each depends on what the row before it left behind).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync, gzipSync } from "zlib";
import { CHARTS_DIR } from "../../../helpers/cluster";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { decodeRelease, deleteStackCompletely, getJson, helm, nodeExec, nsFor, P, waitWorkloadReady } from "../../../helpers/k8s";
import { watchProcesses } from "../../../helpers/leak-watch";
import { chartRepoUrl, E2E_CHARTS_PASSWORD, E2E_CHARTS_USER, SHARED_LANE } from "../../../helpers/topology";
import { K8S_MANAGED_BY, LABELS } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { releaseSecretName } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import type { ConfigMap, Namespace, PersistentVolumeClaim, Pod } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import type { Job } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/batch";

const FILE = "51-helm-app.test.ts";
const ENV = "e2e";
const PROJECT = "helmapp";
const NS = nsFor(PROJECT);
const PUBLIC_REPO = chartRepoUrl(SHARED_LANE.net, "public");
const PRIVATE_REPO = chartRepoUrl(SHARED_LANE.net, "private");

interface ReleaseSpec {
  name: string;
  chart: string;
  repo?: string;
  version: string;
  role?: "app" | "accessory";
  namespace?: string;
  timeout?: string;
  values?: Readonly<Record<string, string>>;
  auth?: { username: string; passwordEnvVar: string };
  /** opts into e2e-web's post-install/post-upgrade hook Job (E-51-03, fixture chart flag) */
  hookEnabled?: boolean;
}

/** Builds config.yml's `helm.releases[]` from a small description, so each row only states its diff. */
function configYml(releases: readonly ReleaseSpec[], extraTop: readonly string[] = []): string {
  const lines: string[] = [`project_name: "${PROJECT}"`, "orchestrator: k3s", "", ...extraTop];
  if (releases.length === 0) return `${lines.join("\n")}\n`;
  lines.push("helm:", "  releases:");
  for (const r of releases) {
    lines.push(`    - name: ${r.name}`, `      chart: ${r.chart}`);
    if (r.repo) lines.push(`      repo: "${r.repo}"`);
    lines.push(`      version: "${r.version}"`);
    if (r.role) lines.push(`      role: ${r.role}`);
    if (r.namespace) lines.push(`      namespace: ${r.namespace}`);
    if (r.timeout) lines.push(`      timeout: ${r.timeout}`);
    if (r.auth) {
      lines.push("      auth:", `        username: "${r.auth.username}"`, `        password: "{{ current.env.${r.auth.passwordEnvVar} }}"`);
    }
    if (r.values || r.hookEnabled) {
      lines.push("      values:");
      if (r.values) for (const [key, value] of Object.entries(r.values)) lines.push(`        ${key}: ${value}`);
      if (r.hookEnabled) lines.push("        hook:", "          enabled: true");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

interface HelmListEntry {
  name: string;
  revision: number;
  chart: string;
  status: string;
}

async function listReleases(ns = NS): Promise<HelmListEntry[]> {
  return JSON.parse(await helm(["list", "-n", ns, "-o", "json"]));
}

async function findRelease(name: string, ns = NS): Promise<HelmListEntry | undefined> {
  return (await listReleases(ns)).find((entry) => entry.name === name);
}

async function configMapMessage(releaseName: string): Promise<string | undefined> {
  const [cm] = await getJson<ConfigMap>("configmaps", { ns: NS, name: `${releaseName}-e2e-web` });
  return cm?.data?.message;
}

async function getHookJobUid(releaseName: string): Promise<string | undefined> {
  const [job] = await getJson<Job>("jobs", { ns: NS, name: `${releaseName}-e2e-web-hook` });
  return job?.metadata.uid;
}

describe("51-helm-app", () => {
  let fixture: Fixture;
  let hookJobUid: string | undefined;

  afterAll(async () => {
    fixture?.cleanup();
    await deleteStackCompletely(NS);
    await deleteStackCompletely("e2e-operator");
  });

  test("E-51-01: first install", async () => {
    await withDump("E-51-01", async () => {
      fixture = makeFixture("test-app-k3s-helm", { cluster: "k3s", extraEnv: { CHARTS_PASSWORD: E2E_CHARTS_PASSWORD } });
      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "hello" } }]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);

      const entry = await findRelease("web");
      expect(entry?.revision).toBe(1);
      const roleLabelled = await helm(["list", "-n", NS, "-l", `${P}/stack=${NS},${P}/role=app`, "-o", "json"]);
      expect(JSON.parse(roleLabelled).some((e: HelmListEntry) => e.name === "web")).toBe(true);

      const decoded = await decodeRelease(NS, "1.0.0");
      const record = decoded.metadata.helm?.find((r) => r.name === "web");
      expect(record?.chart).toContain("e2e-web");
      expect(record?.version).toBe("0.1.0");
      expect(record?.values_sha256).toMatch(/^[a-f0-9]{64}$/);
    });
  }, 200_000);

  test("E-51-02: a values change creates revision 2", async () => {
    await withDump("E-51-02", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "hello2" }, hookEnabled: true }]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
      expect((await findRelease("web"))?.revision).toBe(2);
      expect(await configMapMessage("web")).toBe("hello2");

      // the post-upgrade hook this revision opted into ran once; E-51-03 checks it does not run again.
      hookJobUid = await getHookJobUid("web");
      expect(hookJobUid).toBeDefined();
    });
  }, 200_000);

  test("E-51-03: an unchanged redeploy keeps the revision", async () => {
    await withDump("E-51-03", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.1", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("unchanged");
      expect((await findRelease("web"))?.revision).toBe(2);

      // the chart's post-install/post-upgrade hook Job (design-07 E-51-03) did not run a second time:
      // Dockflow skips the Helm call entirely, so the same Job object (`before-hook-creation` never
      // fired) is still the one E-51-02 observed.
      expect(await getHookJobUid("web")).toBe(hookJobUid);
    });
  }, 180_000);

  test("E-51-04: a chart version bump creates revision 3 with the 0.2.0-only pod label", async () => {
    await withDump("E-51-04", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.2.0", values: { message: "hello2" } }]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.2", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
      expect((await findRelease("web"))?.revision).toBe(3);
      const pods = await getJson<Pod>("pods", { ns: NS, selector: `${LABELS.name}=e2e-web,${LABELS.instance}=web` });
      expect(pods.some((pod) => pod.metadata.labels?.["chart-version"] === "0.2.0")).toBe(true);
    });
  }, 200_000);

  test("E-51-05: a failing release leaves `current` unchanged and is removed", async () => {
    await withDump("E-51-05", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([
          { name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.2.0", values: { message: "hello2" } },
          { name: "bad", chart: "e2e-broken", repo: PUBLIC_REPO, version: "0.1.0", timeout: "60s" },
        ]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.3", "--force"], { cwd: fixture.dir, timeoutMs: 150_000 });
      expect([50, 53]).toContain(result.exitCode);

      // `current` (releases.current) never moved past 1.0.2: its release Secret exists, 1.0.3's does not.
      const [previous] = await getJson("secrets", { ns: NS, name: releaseSecretName("1.0.2") });
      const [failed] = await getJson("secrets", { ns: NS, name: releaseSecretName("1.0.3") });
      expect(previous).toBeDefined();
      expect(failed).toBeUndefined();

      expect(await findRelease("bad")).toBeUndefined();
    });
  }, 180_000);

  test("E-51-06: `rollback e2e` restores the previous release record", async () => {
    await withDump("E-51-06", async () => {
      const result = await runCLI(["rollback", ENV], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
      expect(await configMapMessage("web")).toBe("hello2");
      const entry = await findRelease("web");
      expect(entry?.chart).toContain("e2e-web-0.1.0");
    });
  }, 200_000);

  test("E-51-07: removing `web` from config.yml uninstalls it on the next deploy", async () => {
    await withDump("E-51-07", async () => {
      fixture.write(".dockflow/config.yml", configYml([]));
      const result = await runCLI(["deploy", ENV, "1.0.4", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      expect(await findRelease("web")).toBeUndefined();
    });
  }, 180_000);

  test("E-51-08: an orphaned PVC-owning release keeps running (DV3)", async () => {
    await withDump("E-51-08", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "data", chart: "e2e-pvc", repo: PUBLIC_REPO, version: "0.1.0" }]),
      );
      const installed = await runCLI(["deploy", ENV, "1.0.5", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(installed.exitCode).toBe(0);
      expect(await findRelease("data")).toBeDefined();

      fixture.write(".dockflow/config.yml", configYml([]));
      const removed = await runCLI(["deploy", ENV, "1.0.6", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(removed.exitCode).toBe(0);
      expect(`${removed.stdout}${removed.stderr}`).toContain(
        `Helm release data is no longer in config.yml but owns volumes`,
      );
      expect(await findRelease("data")).toBeDefined();
      const pvcs = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: NS });
      expect(pvcs.some((pvc) => pvc.metadata.name === "data-e2e-pvc")).toBe(true);
    });
  }, 220_000);

  test("E-51-09: `helm uninstall` refuses without `--volumes`, then deletes the PVC with it", async () => {
    await withDump("E-51-09", async () => {
      const refused = await runCLI(["helm", "uninstall", ENV, "data", "--yes"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("--volumes");

      const removed = await runCLI(["helm", "uninstall", ENV, "data", "--volumes", "--yes"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(removed.exitCode).toBe(0);
      expect(await findRelease("data")).toBeUndefined();
      const pvcs = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: NS });
      expect(pvcs.some((pvc) => pvc.metadata.name === "data-e2e-pvc")).toBe(false);
    });
  }, 150_000);

  test("E-51-10: a private repo's credentials never reach a node process or the release payload", async () => {
    await withDump("E-51-10", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([
          {
            name: "priv",
            chart: "e2e-web",
            repo: PRIVATE_REPO,
            version: "0.1.0",
            values: { message: "private-repo" },
            auth: { username: E2E_CHARTS_USER, passwordEnvVar: "CHARTS_PASSWORD" },
          },
        ]),
        // the auth password is read from .env.dockflow (CHARTS_PASSWORD, set on the fixture in
        // E-51-01), never written into config.yml as plaintext
      );

      const watch = watchProcesses(["server_1", "agent_1"], [/E2E_SECRET_/]);
      const result = await runCLI(["deploy", ENV, "1.0.7", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      const leaks = await watch.stop();
      expect(result.exitCode).toBe(0);
      expect(leaks).toEqual([]);
      await waitWorkloadReady(NS, "deployment", "priv-e2e-web", 1);

      const tmp = await nodeExec("server_1", "ls -A /var/lib/dockflow/helm/tmp 2>/dev/null | wc -l");
      expect(tmp.stdout.trim()).toBe("0");

      const decoded = await decodeRelease(NS, "1.0.7");
      const dump = JSON.stringify(decoded);
      expect(dump).not.toContain(E2E_CHARTS_PASSWORD);
    });
  }, 220_000);

  test("E-51-11: a CRD accessory in its own namespace survives `stop`", async () => {
    await withDump("E-51-11", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([
          {
            name: "priv",
            chart: "e2e-web",
            repo: PRIVATE_REPO,
            version: "0.1.0",
            values: { message: "private-repo" },
            auth: { username: E2E_CHARTS_USER, passwordEnvVar: "CHARTS_PASSWORD" },
          },
          { name: "crd", chart: "e2e-crd", repo: PUBLIC_REPO, version: "0.1.0", namespace: "e2e-operator" },
        ]),
      );
      const result = await runCLI(["deploy", ENV, "1.0.8", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      const [operatorNs] = await getJson<Namespace>("namespaces", { name: "e2e-operator" });
      expect(operatorNs).toBeDefined();
      expect(operatorNs?.metadata.labels?.[LABELS.managedBy]).not.toBe(K8S_MANAGED_BY);

      const crd = await getJson("customresourcedefinitions.apiextensions.k8s.io", { name: "e2ewidgets.e2e.dockflow.test" });
      expect(crd.length).toBe(1);
      const widgets = await getJson("e2ewidgets.e2e.dockflow.test", { ns: "e2e-operator" });
      expect(widgets.length).toBe(1);
    });
  }, 200_000);

  test("E-51-12: `helm list`/`status`/`history` work and never leak a manifest or values payload", async () => {
    await withDump("E-51-12", async () => {
      const list = await runCLI(["helm", "list", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("priv");

      const status = await runCLI(["helm", "status", ENV, "priv"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(status.exitCode).toBe(0);

      const history = await runCLI(["helm", "history", ENV, "priv"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(history.exitCode).toBe(0);

      const values = await runCLI(["helm", "values", ENV, "priv"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(values.exitCode).toBe(0);
      expect(values.stdout).not.toContain(E2E_CHARTS_PASSWORD);

      // --reveal needs an interactive terminal; a piped child process has none.
      const reveal = await runCLI(["helm", "values", ENV, "priv", "--reveal"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(reveal.exitCode).not.toBe(0);
      expect(reveal.stderr).toContain("--reveal");
    });
  }, 90_000);

  test("E-51-13: `stop e2e` uninstalls app releases without volumes, keeps the CRD accessory", async () => {
    await withDump("E-51-13", async () => {
      const result = await runCLI(["stop", ENV, "--yes"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(result.exitCode).toBe(0);
      expect(await findRelease("priv")).toBeUndefined();

      const [operatorNs] = await getJson<Namespace>("namespaces", { name: "e2e-operator" });
      expect(operatorNs?.status?.phase).not.toBe("Terminating");
    });
  }, 150_000);

  describe("E-51-14: chart bytes are pinned", () => {
    function tgzPath(): string {
      return `${CHARTS_DIR}/public/e2e-web-0.1.0.tgz`;
    }

    function driftBytes(original: Buffer): Buffer {
      // Same tar content, forced through a different gzip compression level, so the decompressed
      // chart is still perfectly valid but the archive's own bytes (and sha256) differ (16.2 note:
      // package-charts.ts always repackages the real source, so this stays inside this file only).
      const tar = gunzipSync(original);
      return gzipSync(tar, { level: 1 });
    }

    test("a corrupted archive refuses the rollback that needs it, and restoring it succeeds", async () => {
      await withDump("E-51-14", async () => {
        fixture.write(
          ".dockflow/config.yml",
          configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "pinned-v1" } }]),
        );
        const first = await runCLI(["deploy", ENV, "1.0.9", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(first.exitCode).toBe(0);
        fixture.write(
          ".dockflow/config.yml",
          configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "pinned-v2" } }]),
        );
        const second = await runCLI(["deploy", ENV, "1.0.10", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
        expect(second.exitCode).toBe(0);

        const original = readFileSync(tgzPath());
        try {
          writeFileSync(tgzPath(), driftBytes(original));

          const refused = await runCLI(["rollback", ENV], { cwd: fixture.dir, timeoutMs: 120_000 });
          expect(refused.exitCode).not.toBe(0);
          expect(refused.stderr).toContain("no longer matches the bytes it was pinned to");

          writeFileSync(tgzPath(), original);
          const succeeded = await runCLI(["rollback", ENV], { cwd: fixture.dir, timeoutMs: 180_000 });
          expect(succeeded.exitCode).toBe(0);
          await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
          expect(await configMapMessage("web")).toBe("pinned-v1");
        } finally {
          writeFileSync(tgzPath(), original);
        }
      });
    }, 260_000);

    // Beyond the literal E-51-14 row: WORK-PACKAGES also asks for the override half of design-04's
    // `helm-chart-drift` (`--allow-chart-drift`), which only `dockflow rollback` exposes (deploy.ts
    // has no such flag — a normal deploy never accepts drifted bytes).
    test("`--allow-chart-drift` re-pins the release to the drifted bytes", async () => {
      await withDump("E-51-14 override", async () => {
        const original = readFileSync(tgzPath());
        try {
          writeFileSync(tgzPath(), driftBytes(original));
          const overridden = await runCLI(["rollback", ENV, "--allow-chart-drift"], { cwd: fixture.dir, timeoutMs: 180_000 });
          expect(overridden.exitCode).toBe(0);
          expect(`${overridden.stdout}${overridden.stderr}`).toContain("--allow-chart-drift");
          await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);
        } finally {
          writeFileSync(tgzPath(), original);
        }
      });
    }, 220_000);
  });

  test("E-51-15: the history budget survives a failed revision", async () => {
    await withDump("E-51-15", async () => {
      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "budget-0" } }], [
          "stack_management:",
          "  keep_releases: 3",
        ]),
      );
      // history-max = max(5, keep_releases + 2) = 5 (PD-9): five ordinary changes plus one deliberate
      // failure must still leave the release rollback-able within that budget.
      for (let i = 1; i <= 4; i++) {
        const step = await runCLI(["deploy", ENV, `2.0.${i}`, "--force"], {
          cwd: fixture.dir,
          timeoutMs: 180_000,
        });
        fixture.write(
          ".dockflow/config.yml",
          configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: `budget-${i}` } }], [
            "stack_management:",
            "  keep_releases: 3",
          ]),
        );
        expect(step.exitCode).toBe(0);
      }

      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-broken", repo: PUBLIC_REPO, version: "0.1.0", timeout: "60s" }], [
          "stack_management:",
          "  keep_releases: 3",
        ]),
      );
      const failing = await runCLI(["deploy", ENV, "2.0.5", "--force"], { cwd: fixture.dir, timeoutMs: 150_000 });
      expect(failing.exitCode).not.toBe(0);

      fixture.write(
        ".dockflow/config.yml",
        configYml([{ name: "web", chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "budget-final" } }], [
          "stack_management:",
          "  keep_releases: 3",
        ]),
      );
      const last = await runCLI(["deploy", ENV, "2.0.6", "--force"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(last.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web-e2e-web", 1);

      const history: Array<{ status: string }> = JSON.parse(await helm(["history", "web", "-n", NS, "-o", "json"]));
      expect(history.length).toBeLessThanOrEqual(5);
      expect(history.some((entry) => entry.status === "failed")).toBe(true);

      const rollback = await runCLI(["rollback", ENV], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(rollback.exitCode).toBe(0);
    });
  }, 900_000);

  describe("beyond the literal rows: `--adopt` (design-04 4.3 `helm-adopt`)", () => {
    const ADOPTED = "adopted";

    test("a foreign release is refused, then taken over with --adopt", async () => {
      await withDump("adopt", async () => {
        await helm(["install", ADOPTED, "e2e-web", "--repo", PUBLIC_REPO, "--version", "0.1.0", "-n", NS, "--set", "message=hand-installed"]);

        fixture.write(
          ".dockflow/config.yml",
          configYml([{ name: ADOPTED, chart: "e2e-web", repo: PUBLIC_REPO, version: "0.1.0", values: { message: "hand-installed" } }], [
            "stack_management:",
            "  keep_releases: 3",
          ]),
        );
        const refused = await runCLI(["deploy", ENV, "3.0.0", "--force"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("was not installed by Dockflow");
        expect((await findRelease(ADOPTED))?.revision).toBe(1);

        const dryRun = await runCLI(["deploy", ENV, "3.0.0", "--dry-run", "--adopt", ADOPTED, "--force"], {
          cwd: fixture.dir,
          timeoutMs: 60_000,
        });
        expect(dryRun.exitCode).toBe(0);

        const adopted = await runCLI(["deploy", ENV, "3.0.0", "--adopt", ADOPTED, "--yes", "--force"], {
          cwd: fixture.dir,
          timeoutMs: 180_000,
        });
        expect(adopted.exitCode).toBe(0);
        await waitWorkloadReady(NS, "deployment", `${ADOPTED}-e2e-web`, 1);
        expect((await findRelease(ADOPTED))?.revision).toBe(2);
      });
    }, 260_000);
  });
});
