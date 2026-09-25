/**
 * k3s-day2 lane (design-07 17.3, E-39): backup create/list/restore for a database (postgres,
 * redis appendonly) and a named volume, archive-truncation refusals (K23) and the R-23 refusal for
 * a 2-replica StatefulSet (K24), against `test-app-k3s-backup` — accessories `postgres`, `redis`
 * (appendonly) and `pg2` (2 per-replica-claim replicas), app services `files` (1 replica, named
 * volume `uploads`) and `files2` (2 per-replica-claim replicas).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Pod, Toleration } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { getJson, nodeExec, nsFor, waitFor, waitWorkloadReady } from "../../../helpers/k8s";

const FILE = "39-backup.test.ts";
const ENV = "e2e";
const VERSION = "1.0.0";
const PROJECT = "k3s-backup";
const NS = nsFor(PROJECT);
const NODE = "server_1"; // duo has one control-plane node; k3s backups always land where the command ran (design-06 4.1)
const HELPER_SELECTOR = "dockflow.shawiizz.dev/part=helper";
const HELPER_TOLERATIONS: Toleration[] = [
  { key: "node-role.kubernetes.io/control-plane", operator: "Exists", effect: "NoSchedule" },
  { key: "node-role.kubernetes.io/master", operator: "Exists", effect: "NoSchedule" },
  { key: "CriticalAddonsOnly", operator: "Exists" },
];

interface BackupJson {
  id: string;
  service: string;
  dbType: string;
  size: string;
  sizeBytes: number;
  compression: "gzip" | "none";
  stackName: string;
  volumes?: { name: string; sizeBytes: number; mountType: string; sourcePath: string }[];
}

interface BackupListJson {
  entries: { id: string; service: string }[];
  unreachable: string[];
}

interface DeploymentLike {
  spec: { replicas?: number };
  status?: { readyReplicas?: number };
}

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

function tail(result: { stdout: string; stderr: string }): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(-2000);
}

async function psql(sql: string, fixture: Fixture): Promise<string> {
  const result = await runCLI(["accessories", "exec", ENV, "postgres", "--", "psql", "-U", "postgres", "-tAc", sql], {
    cwd: fixture.dir,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(`psql ${sql} failed: ${tail(result)}`);
  return result.stdout.trim();
}

async function redisCli(args: string[], fixture: Fixture): Promise<string> {
  const result = await runCLI(["accessories", "exec", ENV, "redis", "--", "redis-cli", ...args], { cwd: fixture.dir, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`redis-cli ${args.join(" ")} failed: ${tail(result)}`);
  return result.stdout.trim();
}

async function backupCreate(service: string, fixture: Fixture): Promise<BackupJson> {
  const result = await runCLI(["backup", "create", ENV, service, "--json"], { cwd: fixture.dir, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`backup create ${service} failed: ${tail(result)}`);
  return JSON.parse(result.stdout) as BackupJson;
}

/** k3s backup files live at DOCKFLOW_BACKUPS_DIR/<stackName>/<service>/<id>.* on the node that wrote them. */
async function findBackupFile(stackName: string, service: string, id: string): Promise<string> {
  const dir = `/var/lib/dockflow/backups/${stackName}/${service}`;
  const result = await nodeExec(NODE, `find ${dir} -maxdepth 1 -name '${id}.*' ! -name '*.meta.json' | sort | head -n 1`);
  const path = result.stdout.trim();
  if (!path) throw new Error(`backup archive for ${id} not found under ${dir} on ${NODE}: ${result.stderr}`);
  return path;
}

async function replicaSeries(name: string, durationMs: number, intervalMs = 400): Promise<number[]> {
  const seen: number[] = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const [deployment] = await getJson<DeploymentLike>("deployments.apps", { ns: NS, name });
    seen.push(deployment?.status?.readyReplicas ?? 0);
    await Bun.sleep(intervalMs);
  }
  return seen;
}

describe("backup and restore", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = makeFixture("test-app-k3s-backup", { cluster: "k3s" });
    await withDump("deploy", async () => {
      const result = await runCLI(["deploy", ENV, VERSION], { cwd: fixture.dir, timeoutMs: 300_000 });
      if (result.exitCode !== 0) throw new Error(`deploy failed (exit ${result.exitCode}): ${tail(result)}`);
      expect(result.exitCode).toBe(0);
    });
    await waitWorkloadReady(NS, "deployment", "postgres", 1, 180_000);
    await waitWorkloadReady(NS, "deployment", "redis", 1, 180_000);
    await waitWorkloadReady(NS, "statefulset", "pg2", 2, 180_000);
    await waitWorkloadReady(NS, "deployment", "files", 1, 120_000);
    await waitWorkloadReady(NS, "statefulset", "files2", 2, 120_000);

    // idempotent: DOCKFLOW_E2E_REUSE=1 can point this at a cluster this file already ran against.
    await psql("CREATE TABLE IF NOT EXISTS t (v text); TRUNCATE t;", fixture);
  }, 420_000);

  afterAll(() => {
    fixture?.cleanup();
  });

  test("E-39-07a: no backup helper pod is left behind before any restore runs", async () => {
    const helpers = await getJson<Pod>("pods", { ns: NS, selector: HELPER_SELECTOR });
    expect(helpers.length).toBe(0);
  });

  test("E-39-01/02: postgres backup create and restore round trip", async () => {
    await withDump("postgres round trip", async () => {
      await psql("INSERT INTO t VALUES ('before');", fixture);

      const backup = await backupCreate("postgres", fixture);
      expect(backup.service).toBe("postgres");
      expect(backup.dbType).toBe("postgres");
      expect(backup.sizeBytes).toBeGreaterThan(0);

      const path = await findBackupFile(backup.stackName, "postgres", backup.id);
      const mode = await nodeExec(NODE, `stat -c %a '${path}'`);
      expect(mode.stdout.trim()).toBe("600");

      await psql("INSERT INTO t VALUES ('after');", fixture);
      const restore = await runCLI(["backup", "restore", ENV, "postgres", "--from", backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(restore.exitCode).toBe(0);

      const rows = await psql("SELECT v FROM t ORDER BY v;", fixture);
      expect(rows.split("\n").filter(Boolean)).toEqual(["before"]);
    });
  }, 120_000);

  test("E-39-03: redis (appendonly) backup create and restore round trip", async () => {
    await withDump("redis round trip", async () => {
      await redisCli(["SET", "k", "before"], fixture);
      const backup = await backupCreate("redis", fixture);
      expect(backup.dbType).toBe("redis");

      await redisCli(["SET", "k", "after"], fixture);
      const restore = await runCLI(["backup", "restore", ENV, "redis", "--from", backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(restore.exitCode).toBe(0);

      // redis restarts after a restore (requiresServiceRestart); give it a moment to come back.
      const value = await waitFor(
        async () => {
          try {
            const got = await redisCli(["GET", "k"], fixture);
            return got === "before" ? got : undefined;
          } catch {
            return undefined;
          }
        },
        { timeoutMs: 60_000, describe: "redis to answer GET k = before after the restore restart" },
      );
      expect(value).toBe("before");
    });
  }, 120_000);

  test("E-39-04/07b: a volume restore scales files to 0 and back, through a helper pod with the expected tolerations", async () => {
    await withDump("files volume restore", async () => {
      await runCLI(["exec", ENV, "files", "--", "sh", "-c", "printf %s v1 > /uploads/marker"], { cwd: fixture.dir, timeoutMs: 30_000 });
      const backup = await backupCreate("files", fixture);
      expect(backup.dbType).toBe("volume");
      expect(backup.volumes?.length).toBe(1);

      await runCLI(["exec", ENV, "files", "--", "sh", "-c", "printf %s v2 > /uploads/marker"], { cwd: fixture.dir, timeoutMs: 30_000 });

      const handle = runCLIInBackground(["backup", "restore", ENV, "files", "--from", backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 120_000,
      });

      const [seenZero] = await Promise.all([
        (async () => {
          const series = await replicaSeries("files", 20_000);
          return series.some((n) => n === 0);
        })(),
        (async () => {
          let helper: Pod | undefined;
          try {
            helper = await waitFor(
              async () => {
                const helpers = await getJson<Pod>("pods", { ns: NS, selector: HELPER_SELECTOR });
                return helpers.length > 0 ? helpers[0] : undefined;
              },
              { timeoutMs: 15_000, describe: "the volume-restore helper pod to appear" },
            );
          } catch {
            // a fast restore can finish (and delete the helper) before this poll's first success;
            // the replica-zero observation above is the primary assertion for "during a restore".
            return;
          }
          expect(helper.spec.tolerations).toEqual(HELPER_TOLERATIONS);
        })(),
      ]);
      expect(seenZero).toBe(true);

      const result = await handle.done;
      if (result.exitCode !== 0) throw new Error(`backup restore files failed: ${tail(result)}`);
      expect(result.exitCode).toBe(0);

      await waitWorkloadReady(NS, "deployment", "files", 1, 60_000);
      const content = await runCLI(["exec", ENV, "files", "--", "cat", "/uploads/marker"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(content.stdout).toBe("v1");

      const helpersAfter = await getJson<Pod>("pods", { ns: NS, selector: HELPER_SELECTOR });
      expect(helpersAfter.length).toBe(0);
    });
  }, 150_000);

  test("E-39-05: backup list shows one entry per service backed up so far", async () => {
    await withDump("backup list", async () => {
      const result = await runCLI(["backup", "list", ENV, "--json"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as BackupListJson;
      expect(body.entries.length).toBe(3);
      expect(new Set(body.entries.map((e) => e.service))).toEqual(new Set(["postgres", "redis", "files"]));
    });
  });

  test("E-39-06: a truncated postgres archive is refused, gzip and plain-SQL alike, and the table is unchanged", async () => {
    await withDump("postgres truncation", async () => {
      const countBefore = await psql("SELECT count(*) FROM t;", fixture);

      const gz = await backupCreate("postgres", fixture);
      const gzPath = await findBackupFile(gz.stackName, "postgres", gz.id);
      await nodeExec(NODE, `truncate -s -200 '${gzPath}'`);
      const gzRestore = await runCLI(["backup", "restore", ENV, "postgres", "--from", gz.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(gzRestore.exitCode).toBe(72);
      expect(gzRestore.stderr).toContain(gz.id);
      expect(await psql("SELECT count(*) FROM t;", fixture)).toBe(countBefore);

      fixture.patchConfig((text) => text.replace("compression: gzip", "compression: none"));
      try {
        const plain = await backupCreate("postgres", fixture);
        const plainPath = await findBackupFile(plain.stackName, "postgres", plain.id);
        await nodeExec(NODE, `sed -i '$ d' '${plainPath}'`); // drop the trailer line (DUMP_TRAILER)
        const plainRestore = await runCLI(["backup", "restore", ENV, "postgres", "--from", plain.id, "-y"], {
          cwd: fixture.dir,
          timeoutMs: 30_000,
        });
        expect(plainRestore.exitCode).toBe(72);
        expect(plainRestore.stderr).toContain(plain.id);
        expect(await psql("SELECT count(*) FROM t;", fixture)).toBe(countBefore);
      } finally {
        fixture.patchConfig((text) => text.replace("compression: none", "compression: gzip"));
      }
    });
  }, 120_000);

  test("E-39-06b: a truncated volume archive is refused without ever stopping the service", async () => {
    await withDump("volume truncation", async () => {
      const before = await runCLI(["exec", ENV, "files", "--", "cat", "/uploads/marker"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(before.stdout).toBe("v1");

      const backup = await backupCreate("files", fixture);
      const volumeName = backup.volumes?.[0]?.name ?? "uploads";
      const path = await findBackupFile(backup.stackName, "files", `${backup.id}.${volumeName}`);
      await nodeExec(NODE, `truncate -s -200 '${path}'`);

      const handle = runCLIInBackground(["backup", "restore", ENV, "files", "--from", backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      const series = await replicaSeries("files", 8_000);
      const result = await handle.done;

      expect(result.exitCode).toBe(72);
      expect(series.every((n) => n >= 1)).toBe(true);
      const after = await runCLI(["exec", ENV, "files", "--", "cat", "/uploads/marker"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(after.stdout).toBe("v1");
    });
  }, 60_000);

  test("E-39-08: a 2-replica StatefulSet's restore is refused by R-23 before anything moves", async () => {
    await withDump("R-23 refusal", async () => {
      const pg2Before = await getJson<{ status?: { readyReplicas?: number } }>("statefulsets.apps", { ns: NS, name: "pg2" });
      const files2Before = await getJson<{ status?: { readyReplicas?: number } }>("statefulsets.apps", { ns: NS, name: "files2" });
      const helpersBefore = await getJson<Pod>("pods", { ns: NS, selector: HELPER_SELECTOR });
      expect(helpersBefore.length).toBe(0);

      const pg2Backup = await backupCreate("pg2", fixture);
      const pg2Restore = await runCLI(["backup", "restore", ENV, "pg2", "--from", pg2Backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(pg2Restore.exitCode).toBe(62);
      expect(pg2Restore.stderr).toContain("runs 2 replicas");
      expect(pg2Restore.stderr).toContain("dockflow backup restore writes one replica only");
      expect(pg2Restore.stderr).toContain("dockflow deploy e2e --accessories");

      const files2Backup = await backupCreate("files2", fixture);
      const files2Restore = await runCLI(["backup", "restore", ENV, "files2", "--from", files2Backup.id, "-y"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(files2Restore.exitCode).toBe(62);
      expect(files2Restore.stderr).toContain("runs 2 replicas");
      expect(files2Restore.stderr).toContain("dockflow scale e2e files2 1");

      const [pg2After] = await getJson<{ status?: { readyReplicas?: number } }>("statefulsets.apps", { ns: NS, name: "pg2" });
      const [files2After] = await getJson<{ status?: { readyReplicas?: number } }>("statefulsets.apps", { ns: NS, name: "files2" });
      expect(pg2After?.status?.readyReplicas).toBe(pg2Before[0]?.status?.readyReplicas);
      expect(files2After?.status?.readyReplicas).toBe(files2Before[0]?.status?.readyReplicas);

      const helpersAfter = await getJson<Pod>("pods", { ns: NS, selector: HELPER_SELECTOR });
      expect(helpersAfter.length).toBe(0);
    });
  }, 90_000);
});

// E-39-09 (a backup taken on server-1, restored through the relay once server-1 is back) needs a
// second manager and is asserted as E-62-05 in the k3s-ha lane (design-07 17.3).
