/**
 * N-BACKUP-01 (design-07 17.8): mysql 8.4 and mongodb 8.0 accessory create/restore round trips, the
 * same shape as E-39-01/02 (design-07 17.3) but for the two database types the gated k3s-day2 lane
 * does not cover. Reuses the shared lanes' `duo` topology/project like every other nightly file that
 * needs a full cluster (81, 82, 85): nightly itself provisions nothing (k3s/lanes.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { runSetupK3s, startTopology, stopTopology, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, nsFor, waitWorkloadReady } from "../../../helpers/k8s";
import { TOPOLOGIES } from "../../../helpers/topology";

const FILE = "83-backup-extended.test.ts";
const PROJECT = "nightly-backup";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const TOPO = TOPOLOGIES.duo;
const MYSQL_PASSWORD = "nightly-e2e-mysql-pw";
const MONGO_PASSWORD = "nightly-e2e-mongo-pw";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

function configYml(): string {
  return [
    `project_name: ${PROJECT}`,
    "orchestrator: k3s",
    "backup:",
    "  retention_count: 3",
    "  compression: gzip",
    "  accessories:",
    "    mysql:",
    "      type: mysql",
    "    mongo:",
    "      type: mongodb",
    "",
  ].join("\n");
}

/** A trivial app service: a project with only accessories.yml and no docker-compose.yml is a Helm-only-shaped project (E-53-04), not what this scenario means to exercise. */
function composeYml(): string {
  return ["services:", "  web:", "    image: docker.io/library/nginx:alpine", "    deploy:", "      replicas: 1", ""].join("\n");
}

function accessoriesYml(): string {
  return [
    "services:",
    "  mysql:",
    "    image: docker.io/library/mysql:8.4",
    "    environment:",
    `      MYSQL_ROOT_PASSWORD: ${MYSQL_PASSWORD}`,
    "      MYSQL_DATABASE: appdb",
    "    volumes:",
    "      - mysql_data:/var/lib/mysql",
    "  mongo:",
    "    image: docker.io/library/mongo:8.0",
    "    environment:",
    "      MONGO_INITDB_ROOT_USERNAME: root",
    `      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}`,
    "      MONGO_INITDB_DATABASE: appdb",
    "    volumes:",
    "      - mongo_data:/data/db",
    "volumes:",
    "  mysql_data:",
    "  mongo_data:",
    "",
  ].join("\n");
}

interface CreatedBackup {
  id: string;
}

function parseBackupId(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const id = (parsed as Partial<CreatedBackup>).id;
  if (!id) throw new Error(`backup create --json produced no id: ${stdout}`);
  return id;
}

/** `dockflow accessories exec` (not plain `exec`, which targets app services) runs a command in an accessory container. */
function accessoriesExec(service: string, command: string): string[] {
  return ["accessories", "exec", ENV, service, "--", "sh", "-c", command];
}

/**
 * Neither accessory declares a readiness probe (a password-bearing `healthcheck:` line risks the
 * compose `$`-escaping this fixture has no other reason to depend on), so a Deployment is "Ready" as
 * soon as its container starts — before mysqld/mongod has necessarily finished its own first-boot
 * init. Retries the first real command against each database instead of adding that probe back.
 */
async function untilAccepted(fixture: Fixture, service: string, command: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await runCLI(accessoriesExec(service, command), { cwd: fixture.dir, timeoutMs: 15_000 });
    if (result.exitCode === 0) return;
    if (Date.now() >= deadline) throw new Error(`${service} did not accept connections within ${timeoutMs}ms: ${result.stderr || result.stdout}`);
    await Bun.sleep(2000);
  }
}

describe("nightly: backup extended", () => {
  let fixture: Fixture | undefined;

  beforeAll(async () => {
    await stopTopology();
    await startTopology(TOPO, { timeoutMs: 600_000 });
    process.env.DOCKFLOW_E2E_TOPOLOGY = TOPO.name;

    const binary = resolveCliBinaryPath();
    fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: TOPO });
    fixture.write(".dockflow/config.yml", configYml());
    fixture.write(".dockflow/docker/docker-compose.yml", composeYml());
    fixture.write(".dockflow/docker/accessories.yml", accessoriesYml());

    const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
    if (setup.exitCode !== 0) {
      await dumpDebug(`${FILE}:setup`).catch(() => {});
      throw new Error(`dockflow setup k3s exited ${setup.exitCode}:\n${setup.stderr.slice(-4000)}`);
    }
    await waitForNodesReady(TOPO, 300_000);
    await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);

    const deploy = await runCLI(["deploy", ENV, "1.0.0"], { cwd: fixture.dir, timeoutMs: 300_000 });
    if (deploy.exitCode !== 0) {
      await dumpDebug(`${FILE}:deploy`).catch(() => {});
      throw new Error(`deploy exited ${deploy.exitCode}:\n${deploy.stderr.slice(-4000)}`);
    }
    await waitWorkloadReady(NS, "deployment", "mysql", 1, 180_000);
    await waitWorkloadReady(NS, "deployment", "mongo", 1, 180_000);
  });

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await runCLI(["accessories", "remove", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await deleteStackCompletely(NS).catch(() => {});
      fixture.cleanup();
    }
    await stopTopology();
    delete process.env.DOCKFLOW_E2E_TOPOLOGY;
  });

  test("N-BACKUP-01: mysql create/restore round trip", async () => {
    await withDump("mysql", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");
      await untilAccepted(fixture, "mysql", 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1"');
      const setupSql =
        "CREATE TABLE IF NOT EXISTS t (v VARCHAR(20)); DELETE FROM t; INSERT INTO t VALUES ('before');";
      const insert = await runCLI(accessoriesExec("mysql", `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" appdb -e "${setupSql}"`), {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(insert.exitCode).toBe(0);

      const create = await runCLI(["backup", "create", ENV, "mysql", "--json"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(create.exitCode).toBe(0);
      const id = parseBackupId(create.stdout);

      const after = await runCLI(
        accessoriesExec("mysql", 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" appdb -e "INSERT INTO t VALUES (\'after\')"'),
        { cwd: fixture.dir, timeoutMs: 60_000 },
      );
      expect(after.exitCode).toBe(0);

      const restore = await runCLI(["backup", "restore", ENV, "mysql", "--from", id, "-y"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(restore.exitCode).toBe(0);

      const select = await runCLI(accessoriesExec("mysql", 'mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" appdb -e "SELECT v FROM t"'), {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(select.exitCode).toBe(0);
      expect(select.stdout.trim()).toBe("before");
    });
  });

  test("N-BACKUP-01: mongodb create/restore round trip", async () => {
    await withDump("mongodb", async () => {
      if (!fixture) throw new Error("beforeAll did not provision a fixture");
      const mongoEval = (script: string) =>
        `mongosh --quiet --username root --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin appdb --eval "${script}"`;

      await untilAccepted(fixture, "mongo", mongoEval("db.runCommand({ping: 1})"));
      const insert = await runCLI(accessoriesExec("mongo", mongoEval("db.t.deleteMany({}); db.t.insertOne({v:'before'})")), {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(insert.exitCode).toBe(0);

      const create = await runCLI(["backup", "create", ENV, "mongo", "--json"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(create.exitCode).toBe(0);
      const id = parseBackupId(create.stdout);

      const after = await runCLI(accessoriesExec("mongo", mongoEval("db.t.insertOne({v:'after'})")), {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(after.exitCode).toBe(0);

      const restore = await runCLI(["backup", "restore", ENV, "mongo", "--from", id, "-y"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(restore.exitCode).toBe(0);

      const find = await runCLI(accessoriesExec("mongo", mongoEval("print(JSON.stringify(db.t.find().toArray()))")), {
        cwd: fixture.dir,
        timeoutMs: 60_000,
      });
      expect(find.exitCode).toBe(0);
      const docs = JSON.parse(find.stdout.trim()) as { v: string }[];
      expect(docs.map((d) => d.v)).toEqual(["before"]);
    });
  });
});
