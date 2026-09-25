/**
 * Concurrency (design-07 17.6, E-62): exactly one of two concurrent deploys wins the cluster-wide
 * Lease (DESIGN-CORE 6.7); locks and releases are visible from any manager; an operator release from
 * a different manager is unconditional (K31); a deploy whose lock is force-taken over mid-flight
 * finishes but cannot release the new holder's Lease (K03); and the per-manager day-2 limitations of
 * C19 (backup index, audit/metrics history) hold and recover after a failover.
 *
 * Every assertion reads the stream `cli/src/utils/output.ts` actually sends it to (stdout:
 * `printRaw`/`printJSON` data only; stderr: everything decorative, including thrown-error messages).
 *
 * `history`/`audit` (`cli/src/commands/app/history.ts`) has no owner in WORK-PACKAGES.md §3 (unlike
 * its sibling `metrics.ts`, owned by P69) and still reads a local audit-log file over raw SSH instead
 * of going through `resolveOrchestratorTarget`/`openDay2` — it never prints R-S4-04's "read from
 * another manager" note. E-62-05 below only asserts its exit code for that reason; `metrics` (P69,
 * already on the fallback path) carries the literal note assertion instead.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { decodeRelease, deleteStackCompletely, leaseFor, nsFor, waitFor, withNodeDown } from "../../../helpers/k8s";

const FILE = "62-concurrency.test.ts";
const PROJECT = "k3s-ha-concurrency";
const NS = nsFor(PROJECT);
const STACK_ID = `${PROJECT}-e2e`; // target.ts: stackName = `${project}-${env}`

interface BackupJson {
  id: string;
  service: string;
}

interface BackupListJson {
  entries: { id: string; service: string }[];
  unreachable: string[];
}

/** Matches 61-failover.test.ts's `out()`: some deploy-progress lines are worth matching on either
 * stream without pinning the exact stdout/stderr split (E-30/31's own pattern). */
function out(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}

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
  fixture.patchConfig((text) =>
    text.replace(
      "project_name: k3s-cluster",
      [
        `project_name: ${PROJECT}`,
        "backup:",
        "  retention_count: 5",
        "  compression: gzip",
        "  accessories:",
        "    redis:",
        "      type: redis",
        "hooks:",
        "  pre-deploy:",
        "    - script: .dockflow/hooks/pre-deploy.sh",
      ].join("\n"),
    ),
  );
  fixture.write(
    ".dockflow/docker/docker-compose.yml",
    ["services:", "  web:", "    image: nginx:alpine", '    ports: ["8080:80"]', ""].join("\n"),
  );
  fixture.write(
    ".dockflow/docker/accessories.yml",
    [
      "services:",
      "  redis:",
      "    image: redis:8-alpine",
      '    command: ["redis-server", "--appendonly", "yes"]',
      "    volumes:",
      "      - redis_data:/data",
      "volumes:",
      "  redis_data:",
      "",
    ].join("\n"),
  );
  // E-62-04 needs one deploy that stays inside the lock long enough for a forced takeover to land;
  // every other version deploys instantly (no build, a baked image), so only the sentinel sleeps.
  fixture.write(
    ".dockflow/hooks/pre-deploy.sh",
    ['#!/bin/bash', 'if [ "{{ version }}" = "9.9.9-slow" ]; then', "  sleep 25", "fi", ""].join("\n"),
  );
  return fixture;
}

describe("concurrency", () => {
  let fixture: Fixture;
  let deployed = false;
  let accessoriesDeployed = false;
  let firstVersion: string;

  beforeAll(() => {
    fixture = haFixture();
  });

  afterAll(async () => {
    if (accessoriesDeployed) await runCLI(["accessories", "remove", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    if (deployed) await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS).catch(() => {});
    fixture?.cleanup();
  });

  test("E-62-01: of two concurrent deploys pinned to different managers, exactly one wins the lock", async () => {
    await withDump("E-62-01", async () => {
      const a = runCLIInBackground(["deploy", "e2e", "1.0.0", "--server", "server_1"], { cwd: fixture.dir, timeoutMs: 240_000 });
      const b = runCLIInBackground(["deploy", "e2e", "1.0.1", "--server", "server_2"], { cwd: fixture.dir, timeoutMs: 240_000 });
      const [resultA, resultB] = await Promise.all([a.done, b.done]);
      deployed = true;

      const results = [
        { version: "1.0.0", result: resultA },
        { version: "1.0.1", result: resultB },
      ];
      const winners = results.filter((entry) => entry.result.exitCode === 0);
      const losers = results.filter((entry) => entry.result.exitCode !== 0);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0]?.result.exitCode).toBe(51);
      expect(losers[0]?.result.stderr).toContain("Already locked by");

      firstVersion = winners[0]?.version ?? "1.0.0";
      expect((await decodeRelease(NS, firstVersion)).metadata.version).toBe(firstVersion);
    });
  });

  test("setup: deploy the redis accessory used by E-62-05", async () => {
    await withDump("accessories-setup", async () => {
      const result = await runCLI(["deploy", "e2e", "1.0.0", "--accessories"], { cwd: fixture.dir, timeoutMs: 180_000 });
      accessoriesDeployed = true;
      expect(result.exitCode).toBe(0);
    });
  });

  test("E-62-02: a lock acquired through one manager is visible through another", async () => {
    await withDump("E-62-02", async () => {
      const acquire = await runCLI(["lock", "acquire", "e2e", "--server", "server_3"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(acquire.exitCode).toBe(0);

      const status = await runCLI(["lock", "status", "e2e", "--server", "server_1"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(status.exitCode).toBe(0);
      expect(status.stderr).toContain("LOCKED");

      const release = await runCLI(["lock", "release", "e2e", "--server", "server_1"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(release.exitCode).toBe(0);
    });
  });

  test("E-62-03: releases created through different managers are all visible, newest current", async () => {
    await withDump("E-62-03", async () => {
      await withNodeDown("server_1", "stop-k3s", async () => {
        const deploy = await runCLI(["deploy", "e2e", "1.0.2"], { cwd: fixture.dir, timeoutMs: 240_000 });
        expect(deploy.exitCode).toBe(0);
        expect(out(deploy)).toContain("Control plane: server_2");
      });

      expect((await decodeRelease(NS, firstVersion)).metadata.version).toBe(firstVersion);
      expect((await decodeRelease(NS, "1.0.2")).metadata.version).toBe("1.0.2");

      const version = await runCLI(["version", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(version.exitCode).toBe(0);
      expect(version.stdout).toContain("1.0.2");
    });
  });

  test("E-62-04: an operator release from another manager is unconditional; a deploy whose lock is force-taken over finishes without deleting the new holder's Lease", async () => {
    await withDump("E-62-04", async () => {
      const deploy = runCLIInBackground(["deploy", "e2e", "9.9.9-slow"], { cwd: fixture.dir, timeoutMs: 180_000 });

      await waitFor(async () => ((await leaseFor(STACK_ID)) ? true : undefined), {
        timeoutMs: 30_000,
        describe: "the background deploy to hold the deploy Lease",
      });

      const takeover = await runCLI(["lock", "acquire", "e2e", "--server", "server_2", "--force"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(takeover.exitCode).toBe(0);

      const finished = await deploy.done;
      expect(finished.exitCode).toBe(0); // the deploy itself still completes
      expect(finished.stderr).toContain("Lock release failed:");
      expect(finished.stderr).toContain("is now held by");

      const lease = await leaseFor(STACK_ID);
      expect(lease).not.toBeNull(); // the new holder's Lease was not deleted by the losing release

      const release = await runCLI(["lock", "release", "e2e", "--server", "server_2"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(release.exitCode).toBe(0);
    });
  });

  test("E-62-05: per-manager day-2 state after a failover — backup index, and the audit/metrics fallback note", async () => {
    await withDump("E-62-05", async () => {
      const createB = await runCLI(["backup", "create", "e2e", "redis", "--server", "server_2", "--json"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(createB.exitCode).toBe(0);
      const backupB = JSON.parse(createB.stdout) as BackupJson;

      // A is created after B, so it is the newest — and stored on server_1, about to go unreachable.
      const createA = await runCLI(["backup", "create", "e2e", "redis", "--server", "server_1", "--json"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(createA.exitCode).toBe(0);

      await withNodeDown("server_1", "pause", async () => {
        const list = await runCLI(["backup", "list", "e2e", "redis", "--json"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(list.exitCode).toBe(0);
        const listed = JSON.parse(list.stdout) as BackupListJson;
        expect(listed.entries.map((entry) => entry.id)).toEqual([backupB.id]); // A's node did not answer
        expect(listed.unreachable).toContain("server_1");

        // K64 (b): the newest backup (A, on the unreachable server_1) cannot be known, so an implicit
        // or explicit `latest` refuses instead of silently restoring the older, reachable one (B).
        const implicitLatest = await runCLI(["backup", "restore", "e2e", "redis", "-y"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(implicitLatest.exitCode).toBe(71); // BACKUP_NOT_FOUND
        expect(implicitLatest.stderr).toContain("cannot be determined");
        expect(implicitLatest.stderr).toContain("server_1");
        expect(implicitLatest.stderr).toContain("--from <id>");

        const explicitLatest = await runCLI(["backup", "restore", "e2e", "redis", "--from", "latest", "-y"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(explicitLatest.exitCode).toBe(71);

        // B (reachable, on server_2) restores fine even while server_1 stays unreachable.
        const namedRestore = await runCLI(["backup", "restore", "e2e", "redis", "--from", backupB.id, "-y"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(namedRestore.exitCode).toBe(0);

        // C19: audit/metrics history is per-manager on k3s; with server_1 unreachable, `metrics`
        // falls back to another manager and names the one it read from (R-S4-04); `history`/`audit`
        // (see file header) has no owner to add the same fallback yet, so only its exit code is
        // asserted here — it still succeeds because deploy's own best-effort history-sync (K78)
        // already replicated the log to every other node.
        const history = await runCLI(["history", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(history.exitCode).toBe(0);

        const audit = await runCLI(["audit", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 }); // alias of `history`
        expect(audit.exitCode).toBe(0);

        const metrics = await runCLI(["metrics", "e2e"], { cwd: fixture.dir, timeoutMs: 60_000 });
        expect(metrics.exitCode).toBe(0);
        expect(metrics.stderr).toContain("Read from server_2");
      });
    });
  });
});
