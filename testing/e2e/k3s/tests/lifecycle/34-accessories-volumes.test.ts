/**
 * Lane k3s-lifecycle, design-07 17.2 E-34-*: accessories (same-namespace DNS, change detection,
 * `--accessories`, stop/restart/remove) and their volumes (PVC/PV lifecycle, the C13 delete
 * protocol, `volumes rm` while mounted, role/volume-name collisions, claim-shape refusal).
 *
 * Fixture `test-app-k3s-accessories`: app service `client` (redis:8-alpine, sleeps), accessories
 * `redis` (appendonly, volume `redis_data`) and `postgres` (volume `pg_data`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  ANNOTATIONS,
  K8S_STORAGE_CLASS,
  LABELS,
} from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { releaseSecretName } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import type { VolumeInfo } from "../../../../../cli/src/services/orchestrator/interfaces";
import type { Deployment } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { PersistentVolume, PersistentVolumeClaim } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import {
  deleteStackCompletely,
  getJson,
  nodeExec,
  nsFor,
  podUids,
  podsForService,
  releaseSecrets,
  stateConfigMap,
  waitFor,
  waitWorkloadReady,
} from "../../../helpers/k8s";
import { currentTopology, type NodeKey } from "../../../helpers/topology";

const FILE = "34-accessories-volumes.test.ts";
const PROJECT = "k3s-accessories";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function getDeployment(name: string): Promise<Deployment | undefined> {
  const [d] = await getJson<Deployment>("deployments.apps", { ns: NS, name });
  return d;
}

async function getPvc(name: string): Promise<PersistentVolumeClaim | undefined> {
  const [p] = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: NS, name });
  return p;
}

async function getPv(name: string): Promise<PersistentVolume | undefined> {
  const [p] = await getJson<PersistentVolume>("persistentvolumes", { name });
  return p;
}

async function accessoriesGet(key: string): Promise<string> {
  const out = await runCLI(["accessories", "exec", ENV, "redis", "--", "redis-cli", "GET", key], {
    cwd: fixtureDir(),
    timeoutMs: 30_000,
  });
  return out.stdout.trim();
}

let fixture: Fixture;
function fixtureDir(): string {
  return fixture.dir;
}

describe("accessories volumes and protocol (E-34)", () => {
  afterAll(async () => {
    await runCLI(["stop", ENV, "-y"], { cwd: fixtureDir(), timeoutMs: 120_000 }).catch(() => {});
    await runCLI(["accessories", "remove", ENV, "--volumes", "-y"], { cwd: fixtureDir(), timeoutMs: 180_000 }).catch(() => {});
    await deleteStackCompletely(NS).catch(() => {});
    fixture?.cleanup();
  });

  test("setup", async () => {
    fixture = makeFixture("test-app-k3s-accessories", { cluster: "k3s" });
  });

  test("E-34-01 first deploy: accessories ready, PVCs Bound Retain, Deployments Recreate", async () => {
    await withDump("E-34-01", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: fixtureDir(), timeoutMs: 240_000 });
      expect(result.exitCode, result.stdout.slice(-3000) + result.stderr.slice(-2000)).toBe(0);

      await waitWorkloadReady(NS, "deployment", "redis", 1);
      await waitWorkloadReady(NS, "deployment", "postgres", 1);

      for (const service of ["redis", "postgres"]) {
        const pods = await podsForService(NS, service);
        expect(pods.length).toBeGreaterThan(0);
        expect(pods[0]?.metadata.labels?.[LABELS.role]).toBe("accessory");
        const dep = await getDeployment(service);
        expect(dep?.spec?.strategy?.type).toBe("Recreate");
      }

      for (const claim of ["redis-data", "pg-data"]) {
        const pvc = await getPvc(claim);
        expect(pvc?.status?.phase).toBe("Bound");
        expect(pvc?.spec?.storageClassName).toBe(K8S_STORAGE_CLASS);
        const pv = pvc?.spec?.volumeName ? await getPv(pvc.spec.volumeName) : undefined;
        expect(pv?.spec?.persistentVolumeReclaimPolicy).toBe("Retain");
      }
    });
  }, 300_000);

  test("E-34-02 same-namespace DNS: app service reaches redis by name", async () => {
    await withDump("E-34-02", async () => {
      const result = await runCLI(["exec", ENV, "client", "--", "redis-cli", "-h", "redis", "ping"], {
        cwd: fixtureDir(),
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PONG");
    });
  }, 60_000);

  test("E-34-03 accessories exec writes a key", async () => {
    await withDump("E-34-03", async () => {
      const result = await runCLI(["accessories", "exec", ENV, "redis", "--", "redis-cli", "SET", "e2e-key", "v1"], {
        cwd: fixtureDir(),
        timeoutMs: 30_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });
  }, 60_000);

  test("E-34-04 unchanged deploy skips accessories, no restart", async () => {
    await withDump("E-34-04", async () => {
      const uidsBefore = await podUids(NS, "redis");
      const digestBefore = (await stateConfigMap(NS))["accessories-digest"];

      const result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/accessories.*unchanged/i);

      expect(await podUids(NS, "redis")).toEqual(uidsBefore);
      expect((await stateConfigMap(NS))["accessories-digest"]).toBe(digestBefore);
    });
  }, 240_000);

  test("E-34-05 --accessories forces the apply but writes no app release", async () => {
    await withDump("E-34-05", async () => {
      const uidsBefore = await podUids(NS, "redis");

      const result = await runCLI(["deploy", ENV, "1.0.2", "--accessories", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      expect(await podUids(NS, "redis")).toEqual(uidsBefore);

      const secrets = await releaseSecrets(NS);
      expect(secrets.map((s) => s.metadata.name)).not.toContain(releaseSecretName("1.0.2"));
      expect((await stateConfigMap(NS)).current).toBe("1.0.1");
    });
  }, 240_000);

  test("E-34-06 accessories list shows both services and their volumes", async () => {
    await withDump("E-34-06", async () => {
      const result = await runCLI(["accessories", "list", ENV], { cwd: fixtureDir(), timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("postgres");
      expect(result.stdout).toContain("redis");
      expect(result.stdout).toMatch(/1\/1/);
      expect(result.stdout).toContain("redis-data");
      expect(result.stdout).toContain("pg-data");
    });
  }, 60_000);

  test("E-34-07 accessories logs", async () => {
    await withDump("E-34-07", async () => {
      const result = await runCLI(["accessories", "logs", ENV, "redis", "-n", "5"], { cwd: fixtureDir(), timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Ready to accept connections");
    });
  }, 60_000);

  test("E-34-08 accessories restart cycles the pod, data survives", async () => {
    await withDump("E-34-08", async () => {
      const before = await podUids(NS, "redis");
      const result = await runCLI(["accessories", "restart", ENV, "redis"], { cwd: fixtureDir(), timeoutMs: 60_000 });
      expect(result.exitCode).toBe(0);

      await waitFor(async () => {
        const after = await podUids(NS, "redis");
        return after.length > 0 && after[0] !== before[0] ? after : undefined;
      }, { timeoutMs: 60_000, describe: "redis pod UID to change after restart" });

      expect(await accessoriesGet("e2e-key")).toBe("v1");
    });
  }, 90_000);

  test("E-34-09 accessories stop scales to 0, keeps the PVC", async () => {
    await withDump("E-34-09", async () => {
      const result = await runCLI(["accessories", "stop", ENV, "redis", "-y"], { cwd: fixtureDir(), timeoutMs: 60_000 });
      expect(result.exitCode).toBe(0);

      const dep = await getDeployment("redis");
      expect(dep?.spec?.replicas).toBe(0);
      expect(dep?.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop]).toBe("1");

      const pvc = await getPvc("redis-data");
      expect(pvc?.status?.phase).toBe("Bound");
    });
  }, 60_000);

  test("E-34-10 unchanged accessories deploy leaves a stopped accessory stopped; --accessories resumes it", async () => {
    await withDump("E-34-10", async () => {
      const first = await runCLI(["deploy", ENV, "1.0.3", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(first.exitCode).toBe(0);

      let dep = await getDeployment("redis");
      expect(dep?.spec?.replicas).toBe(0);
      expect(dep?.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop]).toBe("1");

      const second = await runCLI(["deploy", ENV, "1.0.4", "--accessories", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(second.exitCode).toBe(0);

      await waitWorkloadReady(NS, "deployment", "redis", 1);
      dep = await getDeployment("redis");
      expect(dep?.spec?.replicas).toBe(1);
      expect(dep?.metadata.annotations?.[ANNOTATIONS.replicasBeforeStop]).toBeUndefined();
      expect(await accessoriesGet("e2e-key")).toBe("v1");
    });
  }, 300_000);

  test("E-34-11 stop removes the app role only", async () => {
    await withDump("E-34-11", async () => {
      const result = await runCLI(["stop", ENV, "-y"], { cwd: fixtureDir(), timeoutMs: 90_000 });
      expect(result.exitCode).toBe(0);

      expect(await getDeployment("client")).toBeUndefined();
      await waitWorkloadReady(NS, "deployment", "redis", 1);
      await waitWorkloadReady(NS, "deployment", "postgres", 1);

      expect(await getPvc("redis-data")).toBeDefined();
      expect(await getPvc("pg-data")).toBeDefined();
      expect((await releaseSecrets(NS)).length).toBeGreaterThan(0);
    });
  }, 120_000);

  test("E-34-12 a later deploy brings the app role back", async () => {
    await withDump("E-34-12", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.5", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "client", 1);
    });
  }, 240_000);

  let capturedPvName: string | undefined;
  const capturedHostPaths: { claim: string; path: string; node: NodeKey }[] = [];

  test("E-34-13 accessories remove keeps volumes", async () => {
    await withDump("E-34-13", async () => {
      const pvc = await getPvc("redis-data");
      capturedPvName = pvc?.spec?.volumeName;
      expect(capturedPvName).toBeDefined();

      const listed = await runCLI(["volumes", "list", ENV, "--json"], { cwd: fixtureDir(), timeoutMs: 30_000 });
      expect(listed.exitCode).toBe(0);
      const rows = (JSON.parse(listed.stdout) as { items: VolumeInfo[] }).items;
      for (const claim of ["redis-data", "pg-data"]) {
        const row = rows.find((r) => r.name === claim);
        expect(row?.hostPath).toBeTruthy();
        if (row?.hostPath && row.node) {
          const topo = currentTopology();
          const node = topo.nodes.find((n) => n.service === row.node || n.key === row.node);
          if (node) capturedHostPaths.push({ claim, path: row.hostPath, node: node.key });
        }
      }

      const result = await runCLI(["accessories", "remove", ENV, "-y"], { cwd: fixtureDir(), timeoutMs: 120_000 });
      expect(result.exitCode).toBe(0);

      expect(await getDeployment("redis")).toBeUndefined();
      expect(await getDeployment("postgres")).toBeUndefined();
      expect(await getPvc("redis-data")).toBeDefined();
      expect(await getPvc("pg-data")).toBeDefined();

      const rows2 = (
        JSON.parse((await runCLI(["volumes", "list", ENV, "--json"], { cwd: fixtureDir(), timeoutMs: 30_000 })).stdout) as {
          items: VolumeInfo[];
        }
      ).items;
      for (const claim of ["redis-data", "pg-data"]) {
        const row = rows2.find((r) => r.name === claim);
        expect(row?.role).toBe("accessory");
        expect(row?.usedBy).toEqual([]);
        expect(row?.reclaimPolicy).toBe("Retain");
        expect(row?.node).toBeTruthy();
      }
    });
  }, 180_000);

  test("E-34-14 --accessories rebinds the same PV by name", async () => {
    await withDump("E-34-14", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.6", "--accessories", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "redis", 1);

      const pvc = await getPvc("redis-data");
      expect(pvc?.spec?.volumeName).toBe(capturedPvName);
      expect(await accessoriesGet("e2e-key")).toBe("v1");
    });
  }, 240_000);

  test("E-34-20 accessories restart always lands on the volume's affinity node", async () => {
    await withDump("E-34-20", async () => {
      const pv = capturedPvName ? await getPv(capturedPvName) : undefined;
      const expectedNode = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms
        .flatMap((t) => t.matchExpressions ?? [])
        .find((e) => e.key === "kubernetes.io/hostname")?.values?.[0];
      expect(expectedNode).toBeTruthy();

      for (let i = 0; i < 3; i++) {
        const result = await runCLI(["accessories", "restart", ENV, "redis"], { cwd: fixtureDir(), timeoutMs: 60_000 });
        expect(result.exitCode).toBe(0);
        await waitFor(
          async () => {
            const pods = await podsForService(NS, "redis");
            const running = pods.find((p) => p.status?.phase === "Running");
            return running ?? undefined;
          },
          { timeoutMs: 60_000, describe: `redis pod ${i} to be Running again` },
        );
        const pods = await podsForService(NS, "redis");
        expect(pods[0]?.spec.nodeName).toBe(expectedNode);
      }
    });
  }, 240_000);

  test("E-34-15 volumes rm refuses a mounted claim", async () => {
    await withDump("E-34-15", async () => {
      const result = await runCLI(["volumes", "rm", ENV, "redis-data", "-y"], { cwd: fixtureDir(), timeoutMs: 30_000 });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("redis");
      expect(await getPvc("redis-data")).toBeDefined();
    });
  }, 60_000);

  test("E-34-16 accessories remove --volumes -y deletes data with -y skipping both prompts", async () => {
    await withDump("E-34-16", async () => {
      let sawTwoDeletePvs = false;
      let polling = true;
      const poll = (async () => {
        while (polling) {
          const pvs = await getJson<PersistentVolume>("persistentvolumes").catch(() => []);
          const deleteCount = pvs.filter((pv) => pv.spec?.persistentVolumeReclaimPolicy === "Delete").length;
          if (deleteCount > 1) sawTwoDeletePvs = true;
          await Bun.sleep(200);
        }
      })();

      const result = await runCLI(["accessories", "remove", ENV, "--volumes", "-y"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      polling = false;
      await poll;

      expect(result.exitCode).toBe(0);
      expect(sawTwoDeletePvs).toBe(false);
      expect(result.stdout).toMatch(/Deleted \d+ volume/);
      expect(result.stdout).toContain("Volume redis-data: deleted");
      expect(result.stdout).toContain("Volume pg-data: deleted");

      expect(await getPvc("redis-data")).toBeUndefined();
      expect(await getPvc("pg-data")).toBeUndefined();

      const survivingDelete = (await getJson<PersistentVolume>("persistentvolumes")).filter(
        (pv) => pv.spec?.persistentVolumeReclaimPolicy === "Delete" && pv.metadata.name === capturedPvName,
      );
      expect(survivingDelete).toEqual([]);

      for (const { path, node } of capturedHostPaths) {
        const out = await nodeExec(node, `test -d '${path}' && echo exists || echo gone`);
        expect(out.stdout.trim()).toBe("gone");
      }
    });
  }, 240_000);

  test("E-34-21 SIGINT mid-removal restores the untouched PV's policy; a second run completes", async () => {
    await withDump("E-34-21", async () => {
      const prepared = await runCLI(["deploy", ENV, "1.0.7", "--accessories", "--yes"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(prepared.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "redis", 1);
      await waitWorkloadReady(NS, "deployment", "postgres", 1);

      const handle = runCLIInBackground(["accessories", "remove", ENV, "--volumes", "-y"], {
        cwd: fixtureDir(),
        timeoutMs: 120_000,
      });

      // wait until at least one of the two claims is gone (its deletion has started), then interrupt
      await waitFor(
        async () => {
          const remaining = (await Promise.all(["redis-data", "pg-data"].map((c) => getPvc(c)))).filter(Boolean);
          return remaining.length < 2 ? true : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 200, describe: "one accessory claim's deletion to start" },
      );
      handle.kill();
      await handle.done.catch(() => {});

      // whichever claim is still there was never touched, so its PV is still Retain
      for (const claim of ["redis-data", "pg-data"]) {
        const pvc = await getPvc(claim);
        if (pvc?.spec?.volumeName) {
          const pv = await getPv(pvc.spec.volumeName);
          expect(pv?.spec?.persistentVolumeReclaimPolicy).toBe("Retain");
        }
      }

      const survivingClaim = (await getPvc("redis-data")) ? "redis-data" : "pg-data";

      const second = await runCLI(["accessories", "remove", ENV, "--volumes", "-y"], { cwd: fixtureDir(), timeoutMs: 180_000 });
      expect(second.exitCode).toBe(0);
      expect(await getPvc("redis-data")).toBeUndefined();
      expect(await getPvc("pg-data")).toBeUndefined();
      // the second run's last line names the one volume it still had left to remove
      expect(second.stdout).toContain(`Volume ${survivingClaim}: deleted`);
    });
  }, 300_000);

  test("E-34-17 variant: an app service named `redis` collides with the accessory", async () => {
    await withDump("E-34-17", async () => {
      const variant = makeFixture("test-app-k3s-accessories", { cluster: "k3s" });
      try {
        variant.patchConfig((text) => text.replace("project_name: k3s-accessories", "project_name: k3s-acc-collide"));
        variant.write(
          ".dockflow/docker/docker-compose.yml",
          "services:\n  redis:\n    image: redis:8-alpine\n    command: [\"sleep\", \"36000\"]\n",
        );
        const before = (await releaseSecrets(nsFor("k3s-acc-collide", ENV))).length;
        const result = await runCLI(["deploy", ENV, "1.0.0", "--debug", "--yes"], { cwd: variant.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(60);
        expect(result.stdout + result.stderr).toContain("redis");
        expect(result.stdout + result.stderr).toMatch(/role-collision/i);
        expect((await releaseSecrets(nsFor("k3s-acc-collide", ENV))).length).toBe(before);
      } finally {
        variant.cleanup();
      }
    });
  }, 90_000);

  test("E-34-18 variant: redis_data also declared in docker-compose.yml collides with the accessory volume", async () => {
    await withDump("E-34-18", async () => {
      const variant = makeFixture("test-app-k3s-accessories", { cluster: "k3s" });
      try {
        variant.patchConfig((text) => text.replace("project_name: k3s-accessories", "project_name: k3s-acc-volcollide"));
        variant.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  client:",
            "    image: redis:8-alpine",
            "    command: [\"sleep\", \"36000\"]",
            "    volumes:",
            "      - redis_data:/mnt/extra",
            "",
            "volumes:",
            "  redis_data:",
            "",
          ].join("\n"),
        );
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: variant.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(60);
      } finally {
        variant.cleanup();
      }
    });
  }, 90_000);

  test("E-34-19 variant: replicated service mounting a shared named volume is refused", async () => {
    await withDump("E-34-19", async () => {
      const variant = makeFixture("test-app-k3s-accessories", { cluster: "k3s" });
      try {
        variant.patchConfig((text) => text.replace("project_name: k3s-accessories", "project_name: k3s-acc-replicas"));
        variant.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  client:",
            "    image: redis:8-alpine",
            "    command: [\"sleep\", \"36000\"]",
            "    volumes:",
            "      - client_data:/data",
            "    deploy:",
            "      replicas: 2",
            "",
            "volumes:",
            "  client_data:",
            "",
          ].join("\n"),
        );
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: variant.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(60);
        expect(result.stdout + result.stderr).toContain("x-dockflow");
      } finally {
        variant.cleanup();
      }
    });
  }, 90_000);
});
