/**
 * k3s-multinode / 42-servicelb (design-07 17.4 E-42, WORK-PACKAGES PD-2, DESIGN-CORE C2): ServiceLB
 * reaches every node on a published port, `lb_source_ranges` is enforced, the SSH host port is
 * refused at render time, an unmanaged port with no proxy works, changing a published port frees the
 * old one, a same-port collision between two projects is caught only at convergence
 * (LoadBalancerPending), and the same collision against a Dockflow-owned Traefik is caught at render
 * time instead.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { runCLI } from "../../../helpers/cli";
import { curlFrom, deleteStackCompletely, nsFor } from "../../../helpers/k8s";
import { dumpDebug } from "../../../helpers/debug-dump";
import type { Fixture } from "../../../helpers/fixtures";
import { multinodeFixture } from "./fixture";
import { currentTopology, nodeFor } from "../../../helpers/topology";

const ENV = "e2e";

async function withDump<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`42-servicelb.test.ts:${name}`).catch(() => {});
    throw error;
  }
}

describe("ServiceLB", () => {
  let fixture: Fixture;

  afterAll(() => {
    fixture?.cleanup();
  });

  test("a published port reaches every node through ServiceLB", async () => {
    await withDump("reaches every node", async () => {
      fixture = await multinodeFixture();
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "lb1", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      const topo = currentTopology();
      for (const node of topo.nodes) {
        const res = await curlFrom("outsider", `http://${node.ip}:18090/`);
        expect(res.code, `${node.key} (${node.ip}) should answer 200`).toBe(200);
      }
    });
  }, 180_000);

  test("lb_source_ranges restricts the load balancer to the allowed source", async () => {
    await withDump("lb_source_ranges", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "lb2", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      const topo = currentTopology();
      const agent2 = nodeFor(topo, "agent_2");

      const blocked = await curlFrom("outsider", `http://${agent2.ip}:18091/`, { timeoutS: 3 });
      expect(blocked.code).not.toBe(200);

      const allowed = await curlFrom("server_1", `http://${agent2.ip}:18091/`);
      expect(allowed.code).toBe(200);
    });
  }, 180_000);

  test("publishing the SSH host port is refused at render time", async () => {
    await withDump("22:80 refused", async () => {
      const bad = await multinodeFixture();
      try {
        bad.patchCompose((text) =>
          text.replace(
            "volumes:\n  pinned-data: {}\n",
            '  sshport:\n    image: k3s-multi-sshport\n    build:\n      context: ../..\n      dockerfile: Dockerfile.web\n    ports:\n      - "22:80"\n    deploy:\n      replicas: 1\n\nvolumes:\n  pinned-data: {}\n',
          ),
        );
        const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "sshport", "--yes"], { cwd: bad.dir, timeoutMs: 120_000 });
        expect(result.exitCode).toBe(60);
        const combined = `${result.stdout}${result.stderr}`;
        expect(combined).toContain("22/tcp");
        expect(combined).toMatch(/reserved/i);
      } finally {
        bad.cleanup();
      }
    });
  }, 120_000);

  test("an unmanaged port on 80 works with no proxy on the cluster", async () => {
    await withDump("plain 80, no proxy", async () => {
      const result = await runCLI(["deploy", ENV, "1.0.0", "--only", "plain80", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      const topo = currentTopology();
      for (const node of topo.nodes) {
        const res = await curlFrom("outsider", `http://${node.ip}:80/`);
        expect(res.code, `${node.key} port 80`).toBe(200);
      }
    });
  }, 180_000);

  test("changing a published port frees the old one and binds the new one", async () => {
    await withDump("port change", async () => {
      fixture.patchCompose((text) => text.replace('"18090:80"', '"18092:80"'));
      const result = await runCLI(["deploy", ENV, "1.0.1", "--only", "lb1", "--yes"], { cwd: fixture.dir, timeoutMs: 180_000 });
      expect(result.exitCode).toBe(0);

      const topo = currentTopology();
      const server1 = nodeFor(topo, "server_1");
      const old = await curlFrom("outsider", `http://${server1.ip}:18090/`, { timeoutS: 3 });
      expect(old.code).not.toBe(200);
      const fresh = await curlFrom("outsider", `http://${server1.ip}:18092/`);
      expect(fresh.code).toBe(200);
    });
  }, 180_000);

  test("two projects publishing the same port collide only at convergence (LoadBalancerPending)", async () => {
    await withDump("cross-project port collision", async () => {
      const second = await multinodeFixture();
      try {
        second.write(
          ".dockflow/config.yml",
          'project_name: "k3s-multi-collide"\n\nstack_management:\n  keep_releases: 2\n  cleanup_on_failure: true\n',
        );
        // collides with lb1's current port (moved to 18092 by the previous test)
        second.write(
          ".dockflow/docker/docker-compose.yml",
          'services:\n  collider:\n    image: k3s-multi-collider\n    build:\n      context: ../..\n      dockerfile: Dockerfile.web\n    ports:\n      - "18092:80"\n    deploy:\n      replicas: 1\n',
        );
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: second.dir, timeoutMs: 180_000 });
        expect(result.exitCode).not.toBe(0);
        const combined = `${result.stdout}${result.stderr}`;
        expect(combined).toContain("LoadBalancerPending");
        expect(combined).toContain(nsFor("k3s-multi", ENV));

        const topo = currentTopology();
        const server1 = nodeFor(topo, "server_1");
        const stillServing = await curlFrom("outsider", `http://${server1.ip}:18092/`);
        expect(stillServing.code).toBe(200);
      } finally {
        await deleteStackCompletely(nsFor("k3s-multi-collide", ENV)).catch(() => {});
        second.cleanup();
      }
    });
  }, 240_000);

  test("the same collision against a Dockflow-owned Traefik is refused at render time", async () => {
    await withDump("traefik port collision", async () => {
      const owner = await multinodeFixture();
      try {
        owner.write(
          ".dockflow/config.yml",
          [
            'project_name: "k3s-proxy-owner"',
            "",
            "stack_management:",
            "  keep_releases: 1",
            "  cleanup_on_failure: true",
            "",
            "proxy:",
            "  enabled: true",
            "  acme: false",
            "  domains:",
            "    e2e: proxy-owner.e2e.test",
            "",
          ].join("\n"),
        );
        owner.write(
          ".dockflow/docker/docker-compose.yml",
          'services:\n  proxied:\n    image: k3s-multi-proxied\n    build:\n      context: ../..\n      dockerfile: Dockerfile.web\n    deploy:\n      replicas: 1\n',
        );
        const install = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: owner.dir, timeoutMs: 300_000 });
        expect(install.exitCode).toBe(0);

        const collide = await runCLI(["deploy", ENV, "1.0.2", "--only", "plain80", "--yes"], { cwd: fixture.dir, timeoutMs: 120_000 });
        expect(collide.exitCode).toBe(60);
        const combined = `${collide.stdout}${collide.stderr}`;
        expect(combined).toContain("80/tcp");
        expect(combined).toContain("Dockflow Traefik");
      } finally {
        await runCLI(["helm", "uninstall", ENV, "--system", "--volumes", "--force", "--yes"], { cwd: owner.dir, timeoutMs: 180_000 }).catch(() => {});
        await deleteStackCompletely(nsFor("k3s-proxy-owner", ENV)).catch(() => {});
        owner.cleanup();
      }
    });
  }, 420_000);
});
