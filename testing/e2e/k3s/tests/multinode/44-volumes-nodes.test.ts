/**
 * k3s-multinode / 44-volumes-nodes (design-07 17.4 E-44, D8): a pod with a named volume always
 * returns to the PV's node, a ReadWriteOnce volume refuses more than one replica at render time, a
 * ReadWriteMany request the storage class cannot provision fails at convergence with PvcPending, a
 * bind mount of an `uploads:`-copied file is readable on every node, and `volumes list` shows each
 * PVC's node.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";
import { deleteStackCompletely, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";

const ENV = "e2e";
const NS = nsFor("k3s-multi", ENV);

interface VolumeListEntry {
  name: string;
  node: string | null;
}
interface VolumeListJson {
  items: VolumeListEntry[];
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

  test("a ReadWriteMany request the storage class cannot provision fails with PvcPending", async () => {
    await withDump("rwx PvcPending", async () => {
      const rwx = await multinodeFixture();
      try {
        rwx.write(
          ".dockflow/config.yml",
          'project_name: "k3s-multi-rwx"\n\nstack_management:\n  keep_releases: 1\n  cleanup_on_failure: true\n',
        );
        rwx.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  shared:",
            "    image: k3s-multi-rwx",
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
            "      access_mode: ReadWriteMany",
            "",
          ].join("\n"),
        );
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: rwx.dir, timeoutMs: 180_000 });
        expect(result.exitCode).toBe(50);
        const combined = `${result.stdout}${result.stderr}`;
        expect(combined).toContain("PvcPending");
      } finally {
        await deleteStackCompletely(nsFor("k3s-multi-rwx", ENV)).catch(() => {});
        rwx.cleanup();
      }
    });
  }, 180_000);

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
