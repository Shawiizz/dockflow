/**
 * k3s-multinode / 44-volumes-nodes (design-07 17.4 E-44, D8): a pod with a named volume always
 * returns to the PV's node, a ReadWriteOnce volume refuses more than one replica at render time, so
 * does a ReadWriteMany request the default storage class cannot provision, a claim no provisioner
 * serves fails at convergence (PvcPending), a bind mount of an `uploads:`-copied file is readable
 * on every node, and `volumes list` shows each PVC's node.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";
import { deleteStackCompletely, kubectl, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";

const ENV = "e2e";
const NS = nsFor("k3s-multi", ENV);

interface VolumeListEntry {
  name: string;
  node: string | null;
}
interface VolumeListJson {
  items: VolumeListEntry[];
}

/** A class whose provisioner nothing runs: its claims stay Pending, whatever the node. */
const UNPROVISIONED_CLASS = [
  "apiVersion: storage.k8s.io/v1",
  "kind: StorageClass",
  "metadata:",
  "  name: e2e-unprovisioned",
  "provisioner: e2e.dockflow.invalid/none",
  "volumeBindingMode: Immediate",
  "",
].join("\n");

function sharedVolumeConfig(project: string): string {
  return `project_name: "${project}"\norchestrator: k3s\n\nstack_management:\n  keep_releases: 1\n  cleanup_on_failure: true\n`;
}

/** one `shared` service mounting the `shared-data` volume, whose x-dockflow block is `volumeOption` */
function sharedVolumeCompose(volumeOption: string): string {
  return [
    "services:",
    "  shared:",
    "    image: k3s-multi-shared",
    "    build:",
    "      context: ../..",
    "      dockerfile: Dockerfile.web",
    "    volumes:",
    "      - shared-data:/data",
    "    deploy:",
    "      replicas: 1",
    "",
    "volumes:",
    "  shared-data:",
    "    x-dockflow:",
    `      ${volumeOption}`,
    "",
  ].join("\n");
}

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`44-volumes-nodes.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

describe("volumes and node pinning", () => {
  let fixture: Fixture;

  afterAll(() => {
    fixture?.cleanup();
  });

  test("a pod with a named volume always returns to the PV's node", async () => {
    await withDump("pinned to PV node", async () => {
      fixture = await multinodeFixture();
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "pinned", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "pinned", 1, 120_000);

      const [initial] = await podsForService(NS, "pinned");
      const pinnedNode = initial?.spec.nodeName;
      expect(pinnedNode).toBeTruthy();

      for (let i = 0; i < 3; i++) {
        const restart = await runCLI(["restart", ENV, "pinned"], { cwd: fixture.dir, timeoutMs: 120_000 });
        expect(restart.exitCode).toBe(0);
        await waitWorkloadReady(NS, "deployment", "pinned", 1, 120_000);
        const [pod] = await podsForService(NS, "pinned");
        expect(pod?.spec.nodeName).toBe(pinnedNode);
      }
    });
  }, 300_000);

  test("a ReadWriteOnce volume refuses more than one replica at render time (D8)", async () => {
    await withDump("rwo-replicas refusal", async () => {
      const bad = await multinodeFixture();
      try {
        bad.patchCompose((text) => text.replace("pinned-data:/data\n    deploy:\n      replicas: 1\n", "pinned-data:/data\n    deploy:\n      replicas: 2\n"));
        const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "pinned", "--yes"], { cwd: bad.dir, timeoutMs: 120_000 });
        expect(result.exitCode).toBe(60);
        const combined = `${result.stdout}${result.stderr}`;
        expect(combined).toMatch(/replicas|ReadWriteOnce/i);
      } finally {
        bad.cleanup();
      }
    });
  }, 120_000);

  test("a ReadWriteMany volume the default storage class cannot provision is refused at render time", async () => {
    await withDump("rwx refusal", async () => {
      const rwx = await multinodeFixture();
      try {
        rwx.write(".dockflow/config.yml", sharedVolumeConfig("k3s-multi-rwx"));
        rwx.write(".dockflow/docker/docker-compose.yml", sharedVolumeCompose("access_mode: ReadWriteMany"));
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: rwx.dir, timeoutMs: 180_000 });
        expect(result.exitCode).toBe(60);
        expect(`${result.stdout}${result.stderr}`).toMatch(/Volume \S+ asks for ReadWriteMany, which storage class dockflow-local cannot provision/);
      } finally {
        rwx.cleanup();
      }
    });
  }, 180_000);

  test("a claim no provisioner serves fails at convergence, naming the volume it waits for", async () => {
    await withDump("PvcPending", async () => {
      const pending = await multinodeFixture();
      await kubectl(["apply", "-f", "-"], { stdin: UNPROVISIONED_CLASS });
      try {
        pending.write(".dockflow/config.yml", sharedVolumeConfig("k3s-multi-pvc"));
        pending.write(".dockflow/docker/docker-compose.yml", sharedVolumeCompose("storage_class: e2e-unprovisioned"));
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: pending.dir, timeoutMs: 240_000 });
        expect(result.exitCode).toBe(50);
        expect(`${result.stdout}${result.stderr}`).toMatch(/Service shared is waiting for volume \S+/);
      } finally {
        await deleteStackCompletely(nsFor("k3s-multi-pvc", ENV)).catch(() => {});
        await kubectl(["delete", "storageclass", "e2e-unprovisioned", "--ignore-not-found"], { allowFailure: true });
        pending.cleanup();
      }
    });
  }, 240_000);

  test("every pod of a spread bind mount reads the uploaded file", async () => {
    await withDump("binder reads upload", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "binder", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "binder", 3, 120_000);

      const pods = await podsForService(NS, "binder");
      expect(pods.length).toBe(3);
      for (const pod of pods) {
        const uid = pod.metadata.name;
        if (uid === undefined) continue;
        const exec = await runCLI(["exec", ENV, "binder", "--pod", uid, "--", "cat", "/data/marker.txt"], { cwd: fixture.dir, timeoutMs: 30_000 });
        expect(exec.exitCode).toBe(0);
        expect(exec.stdout).toContain("MULTINODE_UPLOAD_MARKER");
      }
    });
  }, 180_000);

  test("volumes list shows each PVC's node", async () => {
    await withDump("volumes list", async () => {
      const result = await runCLI(["volumes", "list", ENV, "--json"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as VolumeListJson;
      const pinnedEntry = parsed.items.find((item) => item.name.includes("pinned"));
      expect(pinnedEntry?.node).toBeTruthy();
      for (const item of parsed.items) expect(item.node, `${item.name} should carry its node`).toBeTruthy();
    });
  }, 60_000);
});
