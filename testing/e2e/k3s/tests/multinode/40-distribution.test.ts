/**
 * k3s-multinode / 40-distribution (design-07 17.4 E-40): a built image reaches every node that runs
 * it, an identical rebuild under a new version transfers nothing, a node missing the image fails
 * fast and only that node re-imports on the next deploy, and a failed deploy with
 * `cleanup_on_failure: true` leaves no orphaned image tag behind.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { importedImageRef } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import type { Event } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";
import { getJson, imagesOnNode, nodeExec, nsFor, podsForService, waitWorkloadReady } from "../../../helpers/k8s";
import { currentTopology } from "../../../helpers/topology";

const ENV = "e2e";
const NS = nsFor("k3s-multi", ENV);

function refFor(image: string, version: string): string {
  return importedImageRef(`${image}-${ENV}:${version}`);
}

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`40-distribution.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

describe("image distribution", () => {
  let fixture: Fixture;

  afterAll(() => {
    fixture?.cleanup();
  });

  test("a built image reaches every trio node, pinned", async () => {
    await withDump("distributes to every node", async () => {
      fixture = await multinodeFixture();
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "web", "--yes"], { cwd: fixture.dir, timeoutMs: 240_000 });
      expect(result.exitCode).toBe(0);

      await waitWorkloadReady(NS, "deployment", "web", 3, 180_000);

      const expected = refFor("k3s-multi-web", "1.0.0");
      const topo = currentTopology();
      for (const node of topo.nodes) {
        const images = await imagesOnNode(node.key);
        const match = images.find((img) => img.ref === expected);
        expect(match, `${node.key} should have imported ${expected}`).toBeDefined();
        expect(match?.pinned).toBe(true);
      }
    });
  }, 240_000);

  test("an identical rebuild under a new version transfers nothing", async () => {
    await withDump("no-transfer redeploy", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.1", "--only", "web", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      // every node holds the 1.0.0 image under its old name: the new one is tagged there, nothing travels
      for (const node of currentTopology().nodes) expect(result.stdout).toMatch(new RegExp(`already present on ${node.key} under another name, tagged`));
      expect(result.stdout).not.toContain("imported on");
      await waitWorkloadReady(NS, "deployment", "web", 3, 120_000);
    });
  }, 180_000);

  test("a node missing the image fails fast, naming the node and never a docker.io reference", async () => {
    await withDump("missing image on agent-2", async () => {
      const onAgent2Ref = refFor("k3s-multi-onagent2", "1.0.0");
      const deployed = await runCLI(["deploy", ENV, "1.0.0", "--only", "on-agent2", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(deployed.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "on-agent2", 1, 120_000);

      const removal = await nodeExec("agent_2", `/usr/local/bin/k3s ctr -n k8s.io images rm '${onAgent2Ref}'`, { user: "root" });
      expect(removal.exitCode).toBe(0);

      const restart = await runCLI(["restart", ENV, "on-agent2"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(restart.exitCode).not.toBe(0);
      const combined = `${restart.stdout}${restart.stderr}`;
      // design-03 F3's wording for an imported image a node lacks, seen at once rather than timed out
      expect(combined).toContain(`cannot start: image ${onAgent2Ref} was not imported on node agent_2`);
      expect(combined).not.toContain("did not complete within");

      const pods = await podsForService(NS, "on-agent2");
      const events = await getJson<Event>("events", { ns: NS });
      const podUids = new Set(pods.map((p) => p.metadata.uid).filter((uid): uid is string => typeof uid === "string"));
      const relevant = events.filter((e) => e.involvedObject?.uid !== undefined && podUids.has(e.involvedObject.uid));
      const texts = relevant.map((e) => e.message ?? "").join("\n");
      expect(texts).toContain("dockflow.invalid/");
      expect(texts).not.toContain("docker.io/");
    });
  }, 180_000);

  test("the next deploy re-imports only on agent-2", async () => {
    await withDump("reimport on agent-2 only", async () => {
      const onAgent2Ref = refFor("k3s-multi-onagent2", "1.0.1");
      const result = await runCLI(["deploy", ENV, "1.0.1", "--only", "on-agent2", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "on-agent2", 1, 120_000);

      // agent-2 lost the name, not the content: every image of this fixture is one build of
      // Dockerfile.web, still held there under the web names, so it too is tagged and nothing travels
      expect(result.stdout).toMatch(/already present on agent_2 under another name, tagged/);
      expect(result.stdout).not.toContain("imported on");
      for (const node of currentTopology().nodes) {
        const images = await imagesOnNode(node.key);
        expect(images.some((img) => img.ref === onAgent2Ref && img.pinned), `${node.key} holds ${onAgent2Ref}, pinned`).toBe(true);
      }
    });
  }, 180_000);

  test("a failed deploy with cleanup_on_failure leaves no orphaned image tag", async () => {
    await withDump("cleanup on failure", async () => {
      const healthy = await runCLI(["deploy", ENV, "1.0.0", "--only", "crasher", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(healthy.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "crasher", 1, 120_000);

      fixture.patchFile(".dockflow/docker/Dockerfile.crasher", (text) => text.replace(/CMD \[.*\]/, 'CMD ["sh", "-c", "exit 1"]'));
      const broken = await runCLI(["deploy", ENV, "1.0.1-broken", "--only", "crasher", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(broken.exitCode).not.toBe(0);

      const brokenRef = refFor("k3s-multi-crasher", "1.0.1-broken");
      const topo = currentTopology();
      for (const node of topo.nodes) {
        const images = await imagesOnNode(node.key);
        expect(images.some((img) => img.ref === brokenRef), `${node.key} must not keep ${brokenRef}`).toBe(false);
      }
    });
  }, 240_000);
});
