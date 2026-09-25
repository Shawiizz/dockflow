/**
 * N-SOAK-01 (design-07 17.8): 25 deploy cycles alternating a healthy build with one that crashes on
 * start (triggering the automatic revert of DV2), plus periodic explicit rollbacks, on the shared
 * lanes' `duo` topology/project. The assertions are end-of-run invariants, not per-cycle exit codes
 * (the table names none): nothing the loop does should leak a Lease, let hashed content-addressed
 * Secrets grow past what `keep_releases` bounds, leave more release records than configured, grow the
 * node image set without bound, or leave an object stuck `Terminating`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCliBinaryPath, runCLI } from "../../../helpers/cli";
import { runSetupK3s, startTopology, stopTopology, waitForNodesReady, waitForSystemPods } from "../../../helpers/cluster";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { deleteStackCompletely, getJson, imagesOnNode, leaseFor, nsFor, releaseSecrets } from "../../../helpers/k8s";
import { TOPOLOGIES } from "../../../helpers/topology";

const FILE = "85-soak.test.ts";
const PROJECT = "nightly-soak";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const TOPO = TOPOLOGIES.duo;
const CYCLES = 25;
const KEEP_RELEASES = 5;
/** Loose leak-detection ceilings: the design row asks for "bounded", not an exact count. */
const MAX_HASHED_OBJECTS = 40;
const MAX_NODE_IMAGES = 60;

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

function configYml(): string {
  return [`project_name: ${PROJECT}`, "orchestrator: k3s", "stack_management:", `  keep_releases: ${KEEP_RELEASES}`, ""].join("\n");
}

function composeYml(healthy: boolean): string {
  const command = healthy ? "sleep 3600" : "exit 1";
  return [
    "services:",
    "  worker:",
    "    image: docker.io/library/busybox:1.37",
    `    command: ["sh", "-c", "${command}"]`,
    "    deploy:",
    "      replicas: 1",
    "      restart_policy:",
    "        condition: on-failure",
    "",
  ].join("\n");
}

interface ObjectLike {
  metadata?: { deletionTimestamp?: string };
}

async function terminatingCount(): Promise<number> {
  const pods = await getJson<ObjectLike>("pods", { ns: NS });
  return pods.filter((pod) => pod.metadata?.deletionTimestamp).length;
}

describe("nightly: soak", () => {
  let fixture: Fixture | undefined;

  beforeAll(async () => {
    await stopTopology();
    await startTopology(TOPO, { timeoutMs: 600_000 });
    process.env.DOCKFLOW_E2E_TOPOLOGY = TOPO.name;

    const binary = resolveCliBinaryPath();
    fixture = makeFixture("test-app-k3s-cluster", { cluster: "k3s", topology: TOPO });
    fixture.write(".dockflow/config.yml", configYml());
    fixture.write(".dockflow/docker/docker-compose.yml", composeYml(true));

    const setup = await runSetupK3s(fixture, { binary, env: ENV, timeoutMs: 900_000 });
    if (setup.exitCode !== 0) {
      await dumpDebug(`${FILE}:setup`).catch(() => {});
      throw new Error(`dockflow setup k3s exited ${setup.exitCode}:\n${setup.stderr.slice(-4000)}`);
    }
    await waitForNodesReady(TOPO, 300_000);
    await waitForSystemPods(TOPO, ["coredns", "local-path-provisioner", "metrics-server"], 300_000);
  });

  afterAll(async () => {
    if (fixture) {
      await runCLI(["stop", ENV, "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
      await deleteStackCompletely(NS).catch(() => {});
      fixture.cleanup();
    }
    await stopTopology();
    delete process.env.DOCKFLOW_E2E_TOPOLOGY;
  });

  test(
    "N-SOAK-01: 25 alternating deploy/rollback cycles leave no leak",
    async () => {
      await withDump("soak", async () => {
        if (!fixture) throw new Error("beforeAll did not provision a fixture");
        const active = fixture;

        for (let cycle = 1; cycle <= CYCLES; cycle++) {
          const healthy = cycle % 2 === 1;
          active.write(".dockflow/docker/docker-compose.yml", composeYml(healthy));
          const version = `1.0.${cycle}`;
          await runCLI(["deploy", ENV, version], { cwd: active.dir, timeoutMs: 120_000 });

          if (healthy && cycle % 5 === 0) {
            await runCLI(["rollback", ENV, "-y"], { cwd: active.dir, timeoutMs: 120_000 });
          }

          // No cycle may leave the deploy lock held: the next cycle's own deploy would otherwise
          // just report "already locked", masking whatever this loop is meant to stress.
          const lease = await leaseFor(NS);
          expect(lease).toBeNull();
        }

        const releases = await releaseSecrets(NS);
        expect(releases.length).toBeLessThanOrEqual(KEEP_RELEASES);

        const hashed = await getJson<ObjectLike>("secrets", { ns: NS });
        expect(hashed.length).toBeLessThanOrEqual(MAX_HASHED_OBJECTS);

        for (const node of TOPO.nodes) {
          const images = await imagesOnNode(node.key);
          expect(images.length).toBeLessThanOrEqual(MAX_NODE_IMAGES);
        }

        expect(await terminatingCount()).toBe(0);
      });
    },
    2_700_000,
  );
});
