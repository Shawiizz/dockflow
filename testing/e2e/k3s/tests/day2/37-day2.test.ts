/**
 * k3s-day2 lane (design-07 17.3, E-37): logs, exec, cp, scale/restart, inspection and prune day2
 * commands against one long-lived deploy — `web` (built nginx, 3 replicas), `ticker` (a busybox
 * printing one line a second, for log assertions that need distinguishable output over time),
 * `daemon` (global) and an accessory `cache` (redis). A Helm app release is patched into the
 * fixture's config before the deploy (E-37-06 needs both kinds of app service on one stack).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import type { Pod } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { getJson, kubectl, nsFor, podsForService, waitFor, waitWorkloadReady } from "../../../helpers/k8s";
import { chartRepoUrl, currentTopology } from "../../../helpers/topology";

const FILE = "37-day2.test.ts";
const ENV = "e2e";
const VERSION = "1.0.0";
const PROJECT = "k3s-day2";
const NS = nsFor(PROJECT);

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

function distinctPrefixes(stdout: string, service: string): Set<string> {
  const re = new RegExp(`^${service}\\.(\\S+) \\|`, "gm");
  const found = new Set<string>();
  for (const match of stdout.matchAll(re)) found.add(match[1]);
  return found;
}

describe("day2 inspect and operate", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = makeFixture("test-app-k3s-day2", { cluster: "k3s" });
    const repo = chartRepoUrl(currentTopology().net, "public");
    fixture.patchConfig(
      (text) =>
        `${text}\nhelm:\n  releases:\n    - name: helmapp\n      chart: e2e-web\n      repo: "${repo}"\n      version: "0.1.0"\n      values:\n        message: k3s-day2-helm\n`,
    );

    await withDump("deploy", async () => {
      const result = await runCLI(["deploy", ENV, VERSION], { cwd: fixture.dir, timeoutMs: 240_000 });
      if (result.exitCode !== 0) throw new Error(`deploy failed (exit ${result.exitCode}): ${tail(result)}`);
      expect(result.exitCode).toBe(0);
    });

    await waitWorkloadReady(NS, "deployment", "web", 3, 180_000);
    await waitWorkloadReady(NS, "deployment", "ticker", 1, 120_000);
    await waitWorkloadReady(NS, "daemonset", "daemon", currentTopology().nodes.length, 120_000);
    await waitFor(async () => ((await podsForService(NS, "ticker")).length > 0 ? true : undefined), {
      timeoutMs: 30_000,
      describe: "the ticker pod to exist",
    });
  }, 300_000);

  afterAll(() => {
    fixture?.cleanup();
  });

  // ─── E-37-01..08: logs ────────────────────────────────────────────

  test("E-37-01/03: tail and --tail all see the ticker's own output", async () => {
    await withDump("tail", async () => {
      await waitFor(
        async () => {
          const result = await runCLI(["logs", ENV, "ticker", "-n", "5"], { cwd: fixture.dir, timeoutMs: 30_000 });
          const lines = result.stdout.trim().split("\n").filter(Boolean);
          return lines.length >= 5 ? result : undefined;
        },
        { timeoutMs: 30_000, describe: "ticker to have printed at least 5 lines" },
      );
      const result = await runCLI(["logs", ENV, "ticker", "-n", "5"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split("\n").filter(Boolean).length).toBe(5);

      const all = await runCLI(["logs", ENV, "ticker", "--tail", "all"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(all.exitCode).toBe(0);
      const firstLine = all.stdout.trim().split("\n").find((line) => line.trim() !== "") ?? "";
      expect(firstLine).toContain("boot ");
    });
  });

  test("E-37-02: web logs show one prefix per instance after each pod served a request", async () => {
    await withDump("web prefixes", async () => {
      const pods = await podsForService(NS, "web");
      expect(pods.length).toBe(3);
      for (const pod of pods) {
        await kubectl(["exec", pod.metadata.name, "-c", "web", "-n", NS, "--", "wget", "-qO-", "http://127.0.0.1/"]);
      }
      const result = await runCLI(["logs", ENV, "web", "-n", "2"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(distinctPrefixes(result.stdout, "web").size).toBe(3);
    });
  });

  test("E-37-04: --since duration, RFC3339 and an unsupported form", async () => {
    await withDump("since", async () => {
      const byDuration = await runCLI(["logs", ENV, "ticker", "--since", "10s"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(byDuration.exitCode).toBe(0);

      const iso = new Date(Date.now() - 20_000).toISOString();
      const byIso = await runCLI(["logs", ENV, "ticker", "--since", iso], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(byIso.exitCode).toBe(0);

      const bad = await runCLI(["logs", ENV, "ticker", "--since", "yesterday"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect([60, 61]).toContain(bad.exitCode);
    });
  });

  test("E-37-05: -f sees new tick lines as they are produced", async () => {
    await withDump("follow", async () => {
      const handle = runCLIInBackground(["logs", ENV, "ticker", "-f"], { cwd: fixture.dir, timeoutMs: 20_000 });
      await Bun.sleep(6_000);
      handle.kill();
      const result = await handle.done;
      const ticks = result.stdout.split("\n").filter((line) => line.includes("tick "));
      expect(ticks.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("E-37-06: logs without a service covers app services (compose and Helm), never the accessory", async () => {
    await withDump("all services", async () => {
      const once = await runCLI(["logs", ENV], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(once.exitCode).toBe(0);
      expect(once.stdout).not.toContain("Ready to accept connections"); // redis accessory marker

      const handle = runCLIInBackground(["logs", ENV, "-f"], { cwd: fixture.dir, timeoutMs: 20_000 });
      await Bun.sleep(6_000);
      handle.kill();
      const followed = await handle.done;
      expect(followed.stdout).not.toContain("Ready to accept connections");
    });
  });

  test("E-37-07: -a includes the previous instance's boot marker and the new one", async () => {
    await withDump("all-tasks after restart", async () => {
      const before = await runCLI(["logs", ENV, "ticker", "--tail", "all"], { cwd: fixture.dir, timeoutMs: 30_000 });
      const firstBoot = before.stdout.split("\n").find((line) => line.includes("boot ")) ?? "";
      expect(firstBoot).not.toBe("");

      const [pod] = await podsForService(NS, "ticker");
      const before1 = pod.status?.containerStatuses?.find((c) => c.name === "ticker")?.restartCount ?? 0;
      await kubectl(["exec", pod.metadata.name, "-c", "ticker", "-n", NS, "--", "kill", "1"], { allowFailure: true });

      await waitFor(
        async () => {
          const [p] = await getJson<Pod>("pods", { ns: NS, name: pod.metadata.name });
          const count = p?.status?.containerStatuses?.find((c) => c.name === "ticker")?.restartCount ?? 0;
          return count > before1 ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "the ticker container to restart" },
      );

      const after = await runCLI(["logs", ENV, "ticker", "-a", "--tail", "all"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(after.exitCode).toBe(0);
      const bootLines = after.stdout.split("\n").filter((line) => line.includes("boot "));
      expect(bootLines.length).toBeGreaterThanOrEqual(2);
      expect(after.stdout).toContain(firstBoot.trim());
    });
  });

  test("E-37-08: --pick follows exactly one instance", async () => {
    await withDump("pick", async () => {
      const result = await runCLI(["logs", ENV, "web", "--pick", "--tail", "20"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(distinctPrefixes(result.stdout, "web").size).toBeLessThanOrEqual(1);
    });
  });

  // ─── E-37-09..14: exec and cp ─────────────────────────────────────

  test("E-37-09/10: argv with spaces, exit code passthrough", async () => {
    await withDump("exec argv", async () => {
      const argv = await runCLI(["exec", ENV, "web", "--", "sh", "-c", 'echo "$0 $1"', "a b", "c"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(argv.exitCode).toBe(0);
      expect(argv.stdout.trim()).toBe("a b c");

      const failed = await runCLI(["exec", ENV, "web", "--", "sh", "-c", "exit 7"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(failed.exitCode).toBe(7);
    });
  });

  test("E-37-11: --workdir and --env", async () => {
    await withDump("workdir env", async () => {
      const pwd = await runCLI(["exec", ENV, "web", "--workdir", "/etc", "--", "pwd"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(pwd.exitCode).toBe(0);
      expect(pwd.stdout.trim()).toBe("/etc");

      const env = await runCLI(["exec", ENV, "web", "--env", "FOO=bar", "--", "printenv", "FOO"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(env.exitCode).toBe(0);
      expect(env.stdout.trim()).toBe("bar");
    });
  });

  test("E-37-12: stdin is piped through", async () => {
    await withDump("stdin", async () => {
      const result = await runCLI(["exec", ENV, "web", "--", "cat"], { cwd: fixture.dir, timeoutMs: 30_000, stdin: "hello\n" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    });
  });

  test("E-37-13: --user is refused on k3s, on the cluster and on an unroutable host, both fast", async () => {
    await withDump("user refusal", async () => {
      const onCluster = await runCLI(["exec", ENV, "web", "--user", "root", "--", "id"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(onCluster.exitCode).toBe(62);
      expect(onCluster.stderr).toContain("is not supported with orchestrator: k3s");

      // no `topology` override: this fixture ships its own unroutable servers.yml (192.0.2.1),
      // which is the point of using it here (E-30-04/05).
      const invalid = makeFixture("test-app-k3s-invalid", { cluster: "k3s" });
      try {
        const started = Date.now();
        const unroutable = await runCLI(["exec", ENV, "web", "--user", "root", "--", "id"], { cwd: invalid.dir, timeoutMs: 30_000 });
        expect(unroutable.exitCode).toBe(62);
        expect(unroutable.stderr).toContain("is not supported with orchestrator: k3s");
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        invalid.cleanup();
      }
    });
  });

  test("E-37-14: cp copies out and in", async () => {
    await withDump("cp", async () => {
      const out = await runCLI(["cp", ENV, "web:/etc/nginx/nginx.conf", "./out.conf"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(out.exitCode).toBe(0);
      expect(fixture.read("out.conf").length).toBeGreaterThan(0);

      fixture.write("in.txt", "e2e-cp-in\n");
      const into = await runCLI(["cp", ENV, "./in.txt", "web:/tmp/in.txt"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(into.exitCode).toBe(0);
      const [pod] = await podsForService(NS, "web");
      const check = await kubectl(["exec", pod.metadata.name, "-c", "web", "-n", NS, "--", "cat", "/tmp/in.txt"]);
      expect(check).toBe(fixture.read("in.txt"));
    });
  });

  // ─── E-37-15..19: ps, list, scale, restart, inspect ───────────────

  test("E-37-15: ps and ps --json", async () => {
    await withDump("ps", async () => {
      const text = await runCLI(["ps", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(text.exitCode).toBe(0);

      interface PsItem {
        id: string;
        service: string;
        label: string;
        node: string | null;
        status: string;
        ready: boolean;
        restarts: number | null;
        startedAt: string | null;
      }
      const json = await runCLI(["ps", ENV, "--json"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(json.exitCode).toBe(0);
      const body = JSON.parse(json.stdout) as { stack: string; namespace: string | null; items: PsItem[] };
      expect(body.namespace).toBe(NS);
      expect(body.items.length).toBeGreaterThanOrEqual(5);
      for (const item of body.items) {
        expect(item.node).not.toBeNull();
        expect(["server_1", "agent_1"]).toContain(item.node ?? "");
        for (const key of ["id", "service", "label", "node", "status", "ready", "restarts", "startedAt"] as const) {
          expect(Object.hasOwn(item, key)).toBe(true);
        }
        expect(typeof item.restarts).toBe("number");
      }
    });
  });

  test("E-37-16: list services and list services -t", async () => {
    await withDump("list services", async () => {
      const plain = await runCLI(["list", "services", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toMatch(/web\s+3\/3/);
      expect(plain.stdout).toMatch(/daemon\s+\d\/\d/);

      const tasks = await runCLI(["list", "services", ENV, "-t"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(tasks.exitCode).toBe(0);
      expect(tasks.stdout).toContain("web");
    });
  });

  test("E-37-17: scale changes replicas; global and unknown services are refused", async () => {
    await withDump("scale", async () => {
      const down = await runCLI(["scale", ENV, "web", "1"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(down.exitCode).toBe(0);
      const [{ status }] = await getJson<{ status?: { readyReplicas?: number } }>("deployments.apps", { ns: NS, name: "web" });
      expect(status?.readyReplicas ?? 0).toBe(1);

      const up = await runCLI(["scale", ENV, "web", "3"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(up.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 3, 120_000);

      const globalRefused = await runCLI(["scale", ENV, "daemon", "3"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(globalRefused.exitCode).not.toBe(0);

      const unknown = await runCLI(["scale", ENV, "nope", "1"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(unknown.exitCode).toBe(42);
      expect(unknown.stderr).toMatch(/web|ticker|daemon/);
    });
  });

  test("E-37-18: restart replaces web's pods; an all-services restart leaves the accessory alone", async () => {
    await withDump("restart", async () => {
      const before = new Set((await podsForService(NS, "web")).map((p) => p.metadata.uid));
      const [cacheBefore] = await podsForService(NS, "cache");

      const web = await runCLI(["restart", ENV, "web"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(web.exitCode).toBe(0);
      const after = new Set((await podsForService(NS, "web")).map((p) => p.metadata.uid));
      expect([...after].every((uid) => !before.has(uid))).toBe(true);
      await waitWorkloadReady(NS, "deployment", "web", 3, 120_000);

      const all = await runCLI(["restart", ENV], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(all.exitCode).toBe(0);
      const [cacheAfter] = await podsForService(NS, "cache");
      expect(cacheAfter?.metadata.uid).toBe(cacheBefore?.metadata.uid);
    });
  }, 180_000);

  test("E-37-19: status, version and details (details retries for metrics-server)", async () => {
    await withDump("inspect", async () => {
      const status = await runCLI(["status", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(status.exitCode).toBe(0);

      const version = await runCLI(["version", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(version.exitCode).toBe(0);
      expect(version.stdout).toContain(VERSION);

      await waitFor(
        async () => {
          const details = await runCLI(["details", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
          if (details.exitCode !== 0) return undefined;
          return /\d+(\.\d+)? (B|KB|MB|GB)/.test(details.stdout) ? details : undefined;
        },
        { timeoutMs: 90_000, describe: "details to report CPU/memory once metrics-server has data" },
      );
    });
  }, 120_000);

  test("E-37-20: diagnose reports an image pull failure", async () => {
    await withDump("diagnose", async () => {
      const [original] = await getJson<{ spec: { template: { spec: { containers: { name: string; image: string }[] } } } }>(
        "deployments.apps",
        { ns: NS, name: "ticker" },
      );
      const originalImage = original.spec.template.spec.containers.find((c) => c.name === "ticker")?.image;
      expect(originalImage).toBeTruthy();

      try {
        await kubectl(["set", "image", "deployment/ticker", "ticker=localhost:35010/e2e/missing:1", "-n", NS]);
        const diagnose = await waitFor(
          async () => {
            const result = await runCLI(["diagnose", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
            return /ImagePullBackOff|ErrImagePull/.test(result.stdout) ? result : undefined;
          },
          { timeoutMs: 60_000, describe: "diagnose to report the broken ticker image" },
        );
        expect(diagnose.exitCode).toBe(0);
      } finally {
        await kubectl(["set", "image", `deployment/ticker`, `ticker=${originalImage}`, "-n", NS]);
        await waitWorkloadReady(NS, "deployment", "ticker", 1, 120_000);
      }
    });
  }, 120_000);

  test("E-37-21: list images shows the project's image, --all shows system images", async () => {
    await withDump("list images", async () => {
      const project = await runCLI(["list", "images", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(project.exitCode).toBe(0);
      expect(project.stdout).toContain("dockflow.invalid/k3s-day2-web");

      const all = await runCLI(["list", "images", ENV, "--all"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(all.exitCode).toBe(0);
      expect(all.stdout).toContain("rancher/mirrored-pause");
    });
  });

  test("E-37-22: prune images without --all is a no-op on k3s; --volumes and --networks are refused", async () => {
    await withDump("prune", async () => {
      const images = await runCLI(["prune", ENV, "--images", "-y"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(images.exitCode).toBe(0);
      const pinnedStill = await getJson<{ spec: { template: { spec: { containers: { image: string }[] } } } }>("deployments.apps", {
        ns: NS,
        name: "ticker",
      });
      expect(pinnedStill.length).toBe(1);

      const volumes = await runCLI(["prune", ENV, "--volumes", "-y"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(volumes.exitCode).toBe(62);
      expect(volumes.stderr).toContain("dockflow volumes rm");

      const networks = await runCLI(["prune", ENV, "--networks", "-y"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(networks.exitCode).toBe(62);
    });
  });

  test("E-37-23: history, audit, metrics and lock status all answer", async () => {
    await withDump("history audit metrics lock", async () => {
      const history = await runCLI(["history", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(history.exitCode).toBe(0);

      const audit = await runCLI(["audit", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(audit.exitCode).toBe(0);

      const metrics = await runCLI(["metrics", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(metrics.exitCode).toBe(0);

      const lock = await runCLI(["lock", "status", ENV], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(lock.exitCode).toBe(0);
    });
  });
});
