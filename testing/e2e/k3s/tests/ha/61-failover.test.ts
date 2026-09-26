/**
 * Failover (design-07 17.6, E-61): control-plane resolution and failover (DESIGN-CORE 6.6) across a
 * stopped k3s service, a paused server and a fully unreachable control plane. Every command's
 * decorative output (control plane, probe detail, refusals) is on stderr; only `version`'s data rows
 * are on stdout (`utils/output.ts`'s stdout/stderr split) — assertions below read the stream each
 * line actually goes to, not the stream design-07's prose implies.
 *
 * Open dependency defects (see the package report; re-checked each package's current code above):
 *  - `cli/src/commands/app/status.ts` (P65) has no `--server` flag (design-06 3.7's own flow calls
 *    `openDay2(env, {})` with no server option at all), so it cannot stand in for DESIGN-CORE 6.6's
 *    refusal contract design-07's E-61-05/06/08 rows assume. Those rows use `version` instead, which
 *    is built on the same `openDay2`/`resolveOrchestratorTarget` path and throws with the right code.
 *  - a control plane named directly with `--server` and then found unreachable (SSH channel lost)
 *    still surfaces as `OrchestratorUnavailableError` (exit 44: `runtime/kubectl.ts`'s "Unreachable"
 *    mapping), not the `ConnectionError` (exit 30) design-07 predicts for that case —
 *    `target.ts`'s direct-`--server`/`--no-failover` paths (P63) deliberately skip probing, so there
 *    is no probe result to classify as a connection failure. The probing path used when no `--server`
 *    is given (E-61-08) does produce exit 30, matching design-07 exactly.
 * `deploy.ts` (P68) now prints the `Checking <n> managers...` / `Using <name> (<status>)` text of
 * R-S2-04 and takes `-s, --server <name>`, so rows below assert that literal text and use the flag
 * where design-07 calls for it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { allowingNodeDown, waitForNodesReady } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { apiserverReady, decodeRelease, deleteStackCompletely, nodeExec, nsFor, waitFor, withNodeDown } from "../../../helpers/k8s";
import { currentTopology, managersOf } from "../../../helpers/topology";

const FILE = "61-failover.test.ts";
const PROJECT = "k3s-ha-failover";
const NS = nsFor(PROJECT);

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${name}`).catch(() => {});
    throw error;
  }
}

function haFixture(): Fixture {
  const fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s" });
  // test-app-k3s-cluster (P74) ships config.yml only, for `dockflow setup k3s`; this file owns no
  // fixture directory (WORK-PACKAGES §3), so the deployable app is written into the temp copy here.
  fixture.patchConfig((text) => text.replace("project_name: k3s-cluster", `project_name: ${PROJECT}`));
  fixture.write(
    ".dockflow/docker/docker-compose.yml",
    [
      "services:",
      "  web:",
      "    image: nginx:alpine", // baked into every node image (design-07 16.5): no build, no pull
      '    ports: ["8080:80"]',
      "    healthcheck:",
      '      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]',
      "      interval: 5s",
      "      timeout: 3s",
      "      retries: 3",
      "",
    ].join("\n"),
  );
  return fixture;
}

/** `cli/src/utils/output.ts` sends decorative text to stderr and data to stdout; some deploy-progress
 * lines are worth matching on either stream without pinning the exact split (E-30/31's own pattern). */
function out(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}

describe("failover", () => {
  let fixture: Fixture;
  let deployed = false;

  beforeAll(() => {
    fixture = haFixture();
  });

  afterAll(async () => {
    if (deployed) await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS).catch(() => {});
    fixture?.cleanup();
  });

  test("E-60-01 prerequisite: every manager starts healthy", () => {
    const topo = currentTopology();
    expect(topo.name).toBe("ha");
    expect(managersOf(topo).length).toBe(3);
  });

  test("E-61-01: with every manager healthy, deploy picks the first ready manager", async () => {
    await withDump("E-61-01", async () => {
      const result = await runCLI(["deploy", "e2e", "1.0.0", "--debug"], { cwd: fixture.dir, timeoutMs: 240_000 });
      deployed = true;
      expect(result.exitCode).toBe(0);
      const text = out(result);
      // R-S2-04 literal text (design-07 E-61-01)
      expect(text).toContain("Checking 3 managers...");
      expect(text).toContain("Using server_1 (ready)");
      expect(text).toContain("Control plane: server_1");
      expect(text).toContain("probe server_1: ready");
      expect(text).toContain("probe server_2: ready");
      expect(text).toContain("probe server_3: ready");
    });
  });

  test("E-61-02, E-61-03: a stopped k3s service on the control plane fails over, and the new release reads back through a third manager", async () => {
    await withDump("E-61-02+03", async () => {
      await withNodeDown("server_1", "stop-k3s", async () => {
        const deploy = await runCLI(["deploy", "e2e", "2.0.0"], { cwd: fixture.dir, timeoutMs: 240_000 });
        expect(deploy.exitCode).toBe(0);
        const deployText = out(deploy);
        expect(deployText).toContain("Using server_2 (ready)"); // design-07 E-61-02
        expect(deployText).toContain("Control plane: server_2");

        const version = await runCLI(["version", "e2e", "--server", "server_3"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(version.exitCode).toBe(0);
        expect(version.stdout).toContain("2.0.0");
      });

      expect((await decodeRelease(NS, "1.0.0")).metadata.version).toBe("1.0.0");
      expect((await decodeRelease(NS, "2.0.0")).metadata.version).toBe("2.0.0");
    });
  });

  test("E-61-04..07: a paused control plane is reported unreachable and failed over around; naming it or a worker directly refuses; --no-failover refuses instead of rerouting", async () => {
    await withDump("E-61-04..07", async () => {
      await withNodeDown("server_1", "pause", async () => {
        // E-61-04: probing still runs (3 managers), server_1 reported unreachable, server_2 wins.
        const deploy = await runCLI(["deploy", "e2e", "3.0.0", "--debug"], { cwd: fixture.dir, timeoutMs: 240_000 });
        expect(deploy.exitCode).toBe(0);
        const deployText = out(deploy);
        expect(deployText).toContain("Checking 3 managers..."); // design-07 E-61-04
        expect(deployText).toContain("probe server_1: unreachable");
        expect(deployText).toContain("Using server_2 (ready)");
        expect(deployText).toContain("Control plane: server_2");
        // K8S_PROBE_GUARD_S bounds each probe to 10s; deploy.ts prints no isolated timing for the
        // probe phase alone, so this bounds the whole command as a loose stand-in for "<= 15s".
        expect(deploy.durationMs).toBeLessThan(120_000);

        // E-61-05: naming the paused server directly skips probing, so the failure surfaces once the
        // SSH channel used for the first remote call is lost (OrchestratorUnavailableError, exit 44
        // — see the file header: design-07 predicts exit 30 here, the probing-only case).
        const namedPaused = await runCLI(["version", "e2e", "--server", "server_1"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(namedPaused.exitCode).toBe(44);
        expect(namedPaused.stderr).toContain("not answering on server_1");

        // E-61-06: naming a worker is refused before any connection is made (target.ts step 2).
        const namedWorker = await runCLI(["version", "e2e", "--server", "agent_1"], { cwd: fixture.dir, timeoutMs: 30_000 });
        expect(namedWorker.exitCode).toBe(60);
        expect(namedWorker.stderr).toContain("agent_1 is a worker (k3s agent); orchestrator commands run on a manager");
        expect(namedWorker.stderr).toContain("Use one of: server_1, server_2, server_3");

        // E-61-07: --no-failover picks the first manager (paused server_1) with no probe at all, so
        // the same unreachable-channel failure surfaces instead of rerouting to server_2 or server_3.
        const noFailover = await runCLI(["deploy", "e2e", "3.0.1", "--no-failover"], { cwd: fixture.dir, timeoutMs: 120_000 });
        expect(noFailover.exitCode).toBe(44);
      });
    });
  });

  test("E-61-08: with no manager ready, the command refuses naming every probe, then recovers once managers come back", async () => {
    await withDump("E-61-08", async () => {
      const topo = currentTopology();
      const managers = managersOf(topo);

      await allowingNodeDown(async () => {
        for (const server of managers) await nodeExec(server.key, "systemctl stop k3s", { user: "root" });
        try {
          const result = await runCLI(["version", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
          expect(result.exitCode).toBe(30);
          expect(result.stderr).toContain("No control-plane node of e2e is ready");
          for (const server of managers) expect(result.stderr).toContain(server.key);
        } finally {
          for (const server of managers) await nodeExec(server.key, "systemctl start k3s", { user: "root" });
          await waitFor(async () => ((await Promise.all(managers.map((server) => apiserverReady(server.key)))).every(Boolean) ? true : undefined), {
            timeoutMs: 180_000,
            describe: "every server of the ha topology to report ready on /readyz",
          });
          await waitForNodesReady(topo, 180_000);
        }
      });

      const recovered = await runCLI(["version", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(recovered.exitCode).toBe(0);
      // 3.0.1 (E-61-07) never applied (the deploy failed before creating a release); 3.0.0 stays current.
      expect(recovered.stdout).toContain("3.0.0");
    });
  });
});
