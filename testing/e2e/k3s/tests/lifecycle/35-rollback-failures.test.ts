/**
 * Lane k3s-lifecycle, design-07 17.2 E-35-*: automatic revert on a failed deploy, the release-record
 * invariant (K08/PD-8) across every failure shape, the deploy lock (stale takeover, contention),
 * workload-kind switches (K15) and the accessories-not-rolled-back warning (D7).
 *
 * Main chain fixture `test-app-k3s-rollback`: service `web` built from `Dockerfile.web` (`MODE`:
 * ok/crash/port3000, `MARKER`), `ports: ["8085:8080"]`, `health_checks.on_failure: rollback` against
 * `http://127.0.0.1:8085/`, `keep_releases: 3`, `cleanup_on_failure: true`. `writeWebCompose` rewrites
 * the whole compose file for each step instead of patching it in place, so every version's file is
 * self-contained and easy to audit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { LockData } from "../../../../../cli/src/services/orchestrator/interfaces";
import { leaseYaml } from "../../../../../cli/src/services/orchestrator/kubernetes/backends/lock-store";
import { buildReleaseSecret } from "../../../../../cli/src/services/orchestrator/kubernetes/backends/release-store";
import { ANNOTATIONS } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import type { Deployment, StatefulSet } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { Job } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/batch";
import type { Service } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { type CLIResult, GRACEFUL_INTERRUPTS, runCLI, runCLIInBackground } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import {
  curlFrom,
  deleteStackCompletely,
  getJson,
  imagesOnNode,
  kubectl,
  leaseFor,
  nsFor,
  podsForService,
  releaseSecrets,
  stateConfigMap,
  waitFor,
  waitWorkloadReady,
} from "../../../helpers/k8s";

const FILE = "35-rollback-failures.test.ts";
const PROJECT = "k3s-rollback";
const ENV = "e2e";
const NS = nsFor(PROJECT, ENV);
const WEB_URL = "http://127.0.0.1:8085/";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Compose templating: every step writes the whole file, so there is nothing to patch in place.
// ---------------------------------------------------------------------------

interface WebSpec {
  /** overrides the built image entirely (no `build:` block) — the missing-image row */
  image?: string;
  mode?: "ok" | "crash" | "port3000";
  marker?: string;
  containerPort?: string;
  memoryReservation?: string;
  extraServices?: string;
}

function webBlock(spec: WebSpec): string {
  const mode = spec.mode ?? "ok";
  const marker = spec.marker ?? "V1";
  const containerPort = spec.containerPort ?? (mode === "port3000" ? "3000" : "8080");
  const imageLines = spec.image
    ? [`    image: ${spec.image}`]
    : [
        "    image: k3s-rollback-web",
        "    build:",
        "      context: ../..",
        "      dockerfile: .dockflow/docker/Dockerfile.web",
        "      args:",
        `        MODE: ${mode}`,
        `        MARKER: ${marker}`,
      ];
  const resourceLines = spec.memoryReservation
    ? ["      resources:", "        reservations:", `          memory: ${spec.memoryReservation}`]
    : [];
  return [
    "  web:",
    ...imageLines,
    "    ports:",
    `      - "8085:${containerPort}"`,
    "    deploy:",
    "      replicas: 1",
    ...resourceLines,
    "      update_config:",
    "        parallelism: 1",
    "        delay: 2s",
    "        monitor: 5s",
    "      restart_policy:",
    "        condition: on-failure",
  ].join("\n");
}

function writeWebCompose(f: Fixture, spec: WebSpec): void {
  const parts = ["services:", webBlock(spec)];
  if (spec.extraServices) parts.push(spec.extraServices);
  f.write(".dockflow/docker/docker-compose.yml", `${parts.join("\n")}\n`);
}

/** An HTTP check nothing answers, so a deploy of a variant fails it and `on_failure: rollback` applies. */
const FAILING_CHECK = [
  "health_checks:",
  "  on_failure: rollback",
  "  endpoints:",
  "    - name: nothing",
  '      url: "http://127.0.0.1:18095/"',
  "      remote: true",
  "      expected_status: 200",
  "      retries: 2",
  "      retry_delay: 1",
  "",
].join("\n");

/** A copy of the fixture under another project; its services serve no :8085, so the chain's health check goes. */
function variantOf(project: string): Fixture {
  const f = makeFixture("test-app-k3s-rollback", { cluster: "k3s" });
  f.patchConfig((text) => text.replace(`project_name: ${PROJECT}`, `project_name: ${project}`).replace(/\nhealth_checks:[\s\S]*$/, "\n"));
  return f;
}

let fixture: Fixture;
function dir(): string {
  return fixture.dir;
}

const CONFIG = ".dockflow/config.yml";

function missingEndpoint(text: string): string {
  return text.replace(`url: "http://127.0.0.1:8085/"`, `url: "http://127.0.0.1:8085/missing"`);
}

/** Runs `body` with a patched config.yml and puts the file back whatever happens, so one failure does not leak into the chain. */
async function withConfig<T>(patch: (text: string) => string, body: () => Promise<T>): Promise<T> {
  const original = fixture.read(CONFIG);
  fixture.patchConfig(patch);
  try {
    return await body();
  } finally {
    fixture.write(CONFIG, original);
  }
}

async function curlWeb(marker: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      const res = await curlFrom("server_1", WEB_URL).catch(() => ({ code: 0, body: "" }));
      return res.code === 200 && res.body.includes(marker) ? true : undefined;
    },
    { timeoutMs, describe: `:8085/ to serve ${marker}` },
  );
}

async function getService(name: string): Promise<Service | undefined> {
  const [s] = await getJson<Service>("services", { ns: NS, name });
  return s;
}

interface EndpointSliceLike {
  endpoints: { conditions?: { ready?: boolean } }[];
}

async function readyEndpoints(ns: string, serviceName: string): Promise<number> {
  const slices = await getJson<EndpointSliceLike>("endpointslices", { ns, selector: `kubernetes.io/service-name=${serviceName}` });
  return slices.reduce((n, slice) => n + slice.endpoints.filter((e) => e.conditions?.ready).length, 0);
}

async function webImage(ns = NS): Promise<string | undefined> {
  const [dep] = await getJson<Deployment>("deployments.apps", { ns, name: "web" });
  return dep?.spec.template.spec.containers[0]?.image;
}

describe("rollback and failure handling (E-35)", () => {
  afterAll(async () => {
    await runCLI(["stop", ENV, "-y"], { cwd: dir(), timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS).catch(() => {});
    fixture?.cleanup();
  });

  test("setup", async () => {
    fixture = makeFixture("test-app-k3s-rollback", { cluster: "k3s" });
  });

  test("E-35-01 a healthy first deploy serves its marker", async () => {
    await withDump("E-35-01", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V1" });
      const result = await runCLI(["deploy", ENV, "1.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 240_000 });
      expect(result.exitCode, result.stdout.slice(-3000) + result.stderr.slice(-2000)).toBe(0);
      await curlWeb("V1");
    });
  }, 300_000);

  test("E-35-02 a crashing deploy reverts to the previous version", async () => {
    await withDump("E-35-02", async () => {
      writeWebCompose(fixture, { mode: "crash", marker: "V2" });
      const started = Date.now();
      const result = await runCLI(["deploy", ENV, "2.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      const elapsedS = (Date.now() - started) / 1000;

      expect(result.exitCode).toBe(53); // HEALTH_CHECK_FAILED
      const out = result.stdout + result.stderr;
      // design-03 F7's wording; the kubelet reason itself is not printed
      expect(out).toMatch(/Service web keeps crashing: container web restarted \d+ time\(s\), last exit code 1/);
      expect(out).toMatch(/reverted web to 1\.0\.0-rb/);
      expect(elapsedS).toBeLessThan(150);

      expect(await webImage()).toContain(":1.0.0-rb");
      const releases = await releaseSecrets(NS);
      expect(releases.map((s) => s.metadata.annotations?.[ANNOTATIONS.release])).not.toContain("2.0.0-rb");
      expect((await stateConfigMap(NS)).current).toBe("1.0.0-rb");
      await curlWeb("V1");

      const nodeImages = await imagesOnNode("server_1");
      expect(nodeImages.some((img) => img.ref.includes(":2.0.0-rb"))).toBe(false);
    });
  }, 300_000);

  test("E-35-03 revert restores the Service port (DV2)", async () => {
    await withDump("E-35-03", async () => {
      writeWebCompose(fixture, { mode: "crash", marker: "V3", containerPort: "3000" });
      const result = await runCLI(["deploy", ENV, "3.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(result.exitCode).toBe(53);

      const web = await getService("web");
      const webLb = await getService("web-lb");
      expect(String(web?.spec.ports?.[0]?.targetPort)).toBe("8080");
      expect(String(webLb?.spec.ports?.[0]?.targetPort)).toBe("8080");
      await waitFor(async () => ((await readyEndpoints(NS, "web-lb")) > 0 ? true : undefined), {
        timeoutMs: 60_000,
        describe: "web-lb to have a ready endpoint after revert",
      });
      writeWebCompose(fixture, { mode: "ok", marker: "V1" });
      await curlWeb("V1");
    });
  }, 300_000);

  test("E-35-04 a missing image fails and reverts", async () => {
    await withDump("E-35-04", async () => {
      writeWebCompose(fixture, { image: "localhost:35010/e2e/missing:4" });
      const result = await runCLI(["deploy", ENV, "4.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(result.exitCode).toBe(53);
      expect(result.stdout + result.stderr).toMatch(/ImagePullBackOff|ErrImagePull/);
      writeWebCompose(fixture, { mode: "ok", marker: "V1" });
      await curlWeb("V1");
    });
  }, 240_000);

  test("E-35-05 an unschedulable reservation fails and reverts", async () => {
    await withDump("E-35-05", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V5", memoryReservation: "64G" });
      const result = await runCLI(["deploy", ENV, "5.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(result.exitCode).toBe(53);
      // design-03 F9's wording, carrying the scheduler's own message
      expect(result.stdout + result.stderr).toMatch(/Service web cannot be scheduled: .*Insufficient memory/);
      writeWebCompose(fixture, { mode: "ok", marker: "V1" });
      await curlWeb("V1");
    });
  }, 240_000);

  test("E-35-06 a failing HTTP endpoint path rolls the release back through rollbackRelease", async () => {
    await withDump("E-35-06", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V6" });
      const result = await withConfig(missingEndpoint, () => runCLI(["deploy", ENV, "6.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 }));

      expect(result.exitCode).toBe(53); // HEALTH_CHECK_FAILED, kept through the rollback
      expect(result.stdout + result.stderr).toMatch(/; rolled back to 1\.0\.0-rb/);
      expect((await stateConfigMap(NS)).current).toBe("1.0.0-rb");
      const releases = await releaseSecrets(NS);
      expect(releases.map((s) => s.metadata.annotations?.[ANNOTATIONS.release])).not.toContain("6.0.0-rb");
      expect(await webImage()).toContain(":1.0.0-rb");
      await curlWeb("V1");
    });
  }, 300_000);

  test("E-35-07 on_failure: fail keeps the failed version deployed and recorded", async () => {
    await withDump("E-35-07", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V7" });
      const result = await withConfig(
        (text) => missingEndpoint(text.replace("on_failure: rollback", "on_failure: fail")),
        () => runCLI(["deploy", ENV, "7.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 }),
      );
      expect(result.exitCode).toBe(53);

      expect(await webImage()).toContain(":7.0.0-rb");
      const releases = await releaseSecrets(NS);
      expect(releases.map((s) => s.metadata.annotations?.[ANNOTATIONS.release])).toContain("7.0.0-rb");
      expect((await stateConfigMap(NS)).current).toBe("7.0.0-rb");
      expect(result.stdout + result.stderr).toMatch(
        /Release 7\.0\.0-rb is deployed but the deploy reported a failure; current stays 7\.0\.0-rb/,
      );

      const rollback = await runCLI(["rollback", ENV], { cwd: dir(), timeoutMs: 200_000 });
      expect(rollback.exitCode).toBe(0);
      expect(rollback.stdout + rollback.stderr).toMatch(/Rolled back to 1\.0\.0-rb/);
      await curlWeb("V1");
    });
  }, 400_000);

  test.skipIf(!GRACEFUL_INTERRUPTS)("E-35-07b SIGINT during apply leaves the record's state-unknown message and releases the lock", async () => {
    await withDump("E-35-07b", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V7B" });
      const handle = runCLIInBackground(["deploy", ENV, "7.1.0-rb", "--yes"], { cwd: dir(), timeoutMs: 120_000 });

      await waitFor(
        async () => {
          const [dep] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
          return dep?.spec.template.spec.containers[0]?.image?.includes(":7.1.0-rb") ? true : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 300, describe: "the apply of 7.1.0-rb to start" },
      );
      handle.kill();
      const result = await handle.done;

      expect(result.exitCode).toBe(130);
      expect(result.stdout + result.stderr).toMatch(
        /Version 7\.1\.0-rb was applied but its state is unknown; run dockflow status e2e/,
      );
      const releases = await releaseSecrets(NS);
      expect(releases.map((s) => s.metadata.annotations?.[ANNOTATIONS.release])).toContain("7.1.0-rb");
      expect((await stateConfigMap(NS)).current).toBe("7.1.0-rb");
      expect(await leaseFor(NS)).toBeNull();
    });
  }, 300_000);

  test("E-35-07c a known-good 7.2.0-rb for the rest of the chain", async () => {
    await withDump("E-35-07c", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V7C" });
      const fix = await runCLI(["deploy", ENV, "7.2.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(fix.exitCode).toBe(0);
    });
  }, 300_000);

  test("E-35-08 rollback after a deploy that added a service prunes it", async () => {
    await withDump("E-35-08", async () => {
      writeWebCompose(fixture, {
        mode: "ok",
        marker: "V8",
        extraServices: '  extra:\n    image: busybox:1.37\n    command: ["sh", "-c", "sleep 36000"]',
      });
      const deployed = await runCLI(["deploy", ENV, "8.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(deployed.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "extra", 1);

      const rollback = await runCLI(["rollback", ENV], { cwd: dir(), timeoutMs: 200_000 });
      expect(rollback.exitCode).toBe(0);
      expect((await stateConfigMap(NS)).current).toBe("7.2.0-rb");
      expect((await getJson<Deployment>("deployments.apps", { ns: NS, name: "extra" })).length).toBe(0);
      await curlWeb("V7C");
      writeWebCompose(fixture, { mode: "ok", marker: "V7C" });
    });
  }, 300_000);

  test("E-35-09 rollback of a single service targets the newest release with a different closure", async () => {
    await withDump("E-35-09", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V9" });
      const deployed = await runCLI(["deploy", ENV, "9.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(deployed.exitCode).toBe(0);

      const result = await runCLI(["rollback", ENV, "web"], { cwd: dir(), timeoutMs: 200_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/rolled back.*to its definition in release/i);

      await waitFor(
        async () => {
          const pods = await podsForService(NS, "web");
          return pods.length > 0 && pods.every((p) => p.status?.phase === "Running") ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "web pods Ready right after the service rollback" },
      );
      expect((await stateConfigMap(NS)).current).toBe("9.0.0-rb");
      // the newest OLDER stored release whose `web` closure differs from 9.0.0-rb is 8.0.0-rb (K20)
      await curlWeb("V8");
    });
  }, 300_000);

  test("E-35-10 keep_releases retains exactly 3 release Secrets", async () => {
    await withDump("E-35-10", async () => {
      for (const [i, marker] of ["V10", "V11", "V12", "V13"].entries()) {
        writeWebCompose(fixture, { mode: "ok", marker });
        const version = `10.${i}.0-rb`;
        const result = await runCLI(["deploy", ENV, version, "--yes"], { cwd: dir(), timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
      }
      const releases = await releaseSecrets(NS);
      expect(releases.length).toBe(3);
      const current = (await stateConfigMap(NS)).current;
      expect(releases.map((s) => s.metadata.annotations?.[ANNOTATIONS.release])).toContain(current);
    });
  }, 500_000);

  test("E-35-11 a release of the wrong artifact format is refused before any mutation", async () => {
    await withDump("E-35-11", async () => {
      const before = (await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" }))[0]?.metadata.generation;

      const { yaml } = buildReleaseSecret(
        { project: PROJECT, env: ENV },
        {
          version: "0.0.1-legacy",
          compose: "services:\n  web:\n    image: nginx:alpine\n",
          artifact: {
            format: "swarm-compose/1",
            role: "app",
            content: "services:\n  web:\n    image: nginx:alpine\n",
            helm: [],
            diagnostics: [],
            digest: "legacy",
          },
          metadata: {
            project_name: PROJECT,
            version: "0.0.1-legacy",
            env: ENV,
            timestamp: new Date().toISOString(),
            epoch: Date.now(),
            performer: "e2e-harness",
            branch: "main",
          },
        },
      );
      await kubectl(["create", "-f", "-"], { stdin: yaml });

      const result = await runCLI(["rollback", ENV], { cwd: dir(), timeoutMs: 60_000 });
      expect(result.exitCode).toBe(52); // ROLLBACK_FAILED
      expect(result.stdout + result.stderr).toContain(
        "Release 0.0.1-legacy was produced for swarm-compose/1 and cannot be applied with orchestrator: k3s",
      );

      const after = (await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" }))[0]?.metadata.generation;
      expect(after).toBe(before);

      await kubectl(["delete", "secret", "dockflow-release-0.0.1-legacy", "-n", NS, "--ignore-not-found"]);
    });
  }, 90_000);

  test("E-35-12 a deploy holding the lock blocks a concurrent one", async () => {
    await withDump("E-35-12", async () => {
      writeWebCompose(fixture, { mode: "ok", marker: "V14" });
      const first = runCLIInBackground(["deploy", ENV, "14.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      await waitFor(async () => ((await leaseFor(NS)) ? true : undefined), { timeoutMs: 30_000, describe: "the deploy Lease to appear" });

      const status = await runCLI(["lock", "status", ENV], { cwd: dir(), timeoutMs: 30_000 });
      expect(status.stdout).toMatch(/Holder/);

      const second = await runCLI(["deploy", ENV, "14.1.0-rb", "--yes"], { cwd: dir(), timeoutMs: 30_000 });
      expect(second.exitCode).toBe(51); // DEPLOY_LOCKED
      expect(second.stdout + second.stderr).toContain("Already locked by");

      const firstResult = await first.done;
      expect(firstResult.exitCode).toBe(0);
      expect(await leaseFor(NS)).toBeNull();
    });
  }, 300_000);

  test("E-35-13 a stale lease is taken over through replace, not delete-then-create", async () => {
    await withDump("E-35-13", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleData: LockData = {
        performer: "stale-holder",
        started_at: twoHoursAgo.toISOString(),
        timestamp: Math.floor(twoHoursAgo.getTime() / 1000),
        version: "stale",
        stack: `${PROJECT}-${ENV}`,
        message: "harness-planted stale lock",
      };
      await kubectl(["create", "-f", "-"], { stdin: leaseYaml(NS, staleData, twoHoursAgo, 30) });
      const before = await leaseFor(NS);
      expect(before?.spec?.leaseTransitions ?? 0).toBe(0);
      const beforeUid = before?.metadata.uid;

      writeWebCompose(fixture, { mode: "ok", marker: "V15" });
      const handle = runCLIInBackground(["deploy", ENV, "15.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });

      const midDeploy = await waitFor(
        async () => {
          const lease = await leaseFor(NS);
          return lease && (lease.spec?.leaseTransitions ?? 0) > 0 ? lease : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 300, describe: "the stale lease to be taken over" },
      );
      // `replace` (not delete-then-create) keeps the object's identity: same uid, transitions +1
      expect(midDeploy.metadata.uid).toBe(beforeUid);
      expect(midDeploy.spec?.leaseTransitions).toBe(1);

      const result = await handle.done;
      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/stale/i);
    });
  }, 240_000);

  test("E-35-13b two deploys racing a stale lease: exactly one wins", async () => {
    await withDump("E-35-13b", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const staleData: LockData = {
        performer: "stale-holder-2",
        started_at: twoHoursAgo.toISOString(),
        timestamp: Math.floor(twoHoursAgo.getTime() / 1000),
        version: "stale",
        stack: `${PROJECT}-${ENV}`,
        message: "harness-planted stale lock",
      };
      await kubectl(["create", "-f", "-"], { stdin: leaseYaml(NS, staleData, twoHoursAgo, 30) });

      writeWebCompose(fixture, { mode: "ok", marker: "V16" });
      const a = runCLIInBackground(["deploy", ENV, "16.1.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      await Bun.sleep(150);
      const b = runCLIInBackground(["deploy", ENV, "16.2.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });

      const [ra, rb] = await Promise.all([a.done, b.done]);
      const codes = [ra.exitCode, rb.exitCode].sort((x, y) => x - y);
      expect(codes).toEqual([0, 51]);
      const loser = ra.exitCode === 51 ? ra : rb;
      expect(loser.stdout + loser.stderr).toContain("Lock was stale but another deploy acquired it first");
      expect(await leaseFor(NS)).toBeNull();
    });
  }, 300_000);

  test("E-35-14 manual lock acquire blocks a deploy until released", async () => {
    await withDump("E-35-14", async () => {
      const acquired = await runCLI(["lock", "acquire", ENV, "-m", "maintenance"], { cwd: dir(), timeoutMs: 30_000 });
      expect(acquired.exitCode).toBe(0);

      writeWebCompose(fixture, { mode: "ok", marker: "V17" });
      const blocked = await runCLI(["deploy", ENV, "17.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 30_000 });
      expect(blocked.exitCode).toBe(51);

      const released = await runCLI(["lock", "release", ENV], { cwd: dir(), timeoutMs: 30_000 });
      expect(released.exitCode).toBe(0);

      const deployed = await runCLI(["deploy", ENV, "17.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(deployed.exitCode).toBe(0);
    });
  }, 300_000);

  test("E-35-17 a StatefulSet forced back keeps its pre-deploy revision", async () => {
    await withDump("E-35-17", async () => {
      writeWebCompose(fixture, {
        mode: "ok",
        marker: "V18",
        extraServices: '  ss:\n    image: redis:8-alpine\n    command: ["sleep", "36000"]\n    x-dockflow:\n      kind: statefulset',
      });
      const healthy = await runCLI(["deploy", ENV, "18.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(healthy.exitCode).toBe(0);
      await waitWorkloadReady(NS, "statefulset", "ss", 1);
      const before = (await getJson<StatefulSet>("statefulsets.apps", { ns: NS, name: "ss" }))[0]?.status?.currentRevision;

      writeWebCompose(fixture, {
        mode: "ok",
        marker: "V18",
        extraServices: '  ss:\n    image: redis:8-alpine\n    command: ["sh", "-c", "exit 1"]\n    x-dockflow:\n      kind: statefulset',
      });
      const crashed = await runCLI(["deploy", ENV, "18.1.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(crashed.exitCode).toBe(53);

      await waitFor(
        async () => {
          const pods = await podsForService(NS, "ss");
          const pod = pods.find((p) => p.metadata.name === "ss-0");
          return pod?.status?.phase === "Running" ? pod : undefined;
        },
        { timeoutMs: 90_000, describe: "ss-0 Ready again after the forced revert" },
      );
      const pods = await podsForService(NS, "ss");
      const ss0 = pods.find((p) => p.metadata.name === "ss-0");
      expect(ss0?.metadata.labels?.["controller-revision-hash"]).toBe(before);

      // drop `ss`: the next deploy prunes it
      writeWebCompose(fixture, { mode: "ok", marker: "V18" });
    });
  }, 400_000);

  test("E-35-18 a fix deployed right after a crash-looping predecessor is not reverted", async () => {
    await withDump("E-35-18", async () => {
      writeWebCompose(fixture, { mode: "crash", marker: "VCRASH" });
      const crashed = await runCLI(["deploy", ENV, "19.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      expect(crashed.exitCode).toBe(53);

      writeWebCompose(fixture, { mode: "ok", marker: "V20" });
      const started = Date.now();
      const fixed = await runCLI(["deploy", ENV, "20.0.0-rb", "--yes"], { cwd: dir(), timeoutMs: 200_000 });
      const elapsedS = (Date.now() - started) / 1000;

      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout + fixed.stderr).not.toMatch(/reverted/);
      expect((await stateConfigMap(NS)).current).toBe("20.0.0-rb");
      expect(elapsedS).toBeGreaterThan(2);
      await curlWeb("V20");
    });
  }, 400_000);
});

describe("workload-kind switches (E-35-19)", () => {
  test("E-35-19a Deployment -> StatefulSet replaces in place, mounting the same claim", async () => {
    await withDump("E-35-19a", async () => {
      const ns2 = nsFor("k3s-rb-kind-a", ENV);
      const f = variantOf("k3s-rb-kind-a");
      try {
        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  web:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            "    volumes:",
            "      - web_data:/data",
            "",
            "volumes:",
            "  web_data:",
            "",
          ].join("\n"),
        );
        let result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        await waitWorkloadReady(ns2, "deployment", "web", 1);

        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  web:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            "    volumes:",
            "      - web_data:/data",
            "    x-dockflow:",
            "      kind: statefulset",
            "",
            "volumes:",
            "  web_data:",
            "",
          ].join("\n"),
        );
        result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toMatch(/Replacing Deployment\/web with StatefulSet\/web for service web; its pods restart/);
        await waitWorkloadReady(ns2, "statefulset", "web", 1);
        expect((await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" })).length).toBe(0);
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 400_000);

  test("E-35-19b a per-replica switch that would strand the old shared claim is refused before mutation", async () => {
    await withDump("E-35-19b", async () => {
      const ns2 = nsFor("k3s-rb-kind-b", ENV);
      const f = variantOf("k3s-rb-kind-b");
      try {
        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  web:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            "    volumes:",
            "      - shared_data:/data",
            "",
            "volumes:",
            "  shared_data:",
            "",
          ].join("\n"),
        );
        let result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        await waitWorkloadReady(ns2, "deployment", "web", 1);
        const generationBefore = (await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" }))[0]?.metadata.generation;

        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  web:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            "    x-dockflow:",
            "      kind: statefulset",
            "",
          ].join("\n"),
        );
        result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(50); // DEPLOY_FAILED
        expect(result.stdout + result.stderr).toMatch(/changes from Deployment to StatefulSet/);
        // the claim's name, the one `volumes list` shows and the suggested `volumes rm` takes
        expect(result.stdout + result.stderr).toContain("would stop using volume shared-data");

        const stillDeployment = await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" });
        expect(stillDeployment[0]?.metadata.generation).toBe(generationBefore);
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 300_000);

  test("E-35-19c a DaemonSet-to-replicated switch overlaps, then prunes the DaemonSet", async () => {
    await withDump("E-35-19c", async () => {
      const ns2 = nsFor("k3s-rb-kind-c", ENV);
      const f = variantOf("k3s-rb-kind-c");
      try {
        f.write(
          ".dockflow/docker/docker-compose.yml",
          ["services:", "  daemon:", "    image: busybox:1.37", '    command: ["sh", "-c", "sleep 36000"]', "    deploy:", "      mode: global", ""].join(
            "\n",
          ),
        );
        let result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        await waitWorkloadReady(ns2, "daemonset", "daemon", 2);

        f.write(
          ".dockflow/docker/docker-compose.yml",
          ["services:", "  daemon:", "    image: busybox:1.37", '    command: ["sh", "-c", "sleep 36000"]', "    deploy:", "      replicas: 2", ""].join(
            "\n",
          ),
        );
        result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        await waitWorkloadReady(ns2, "deployment", "daemon", 2);
        expect((await getJson<{ metadata: { name: string } }>("daemonsets.apps", { ns: ns2, name: "daemon" })).length).toBe(0);
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 400_000);

  test("E-35-19d a Deployment-to-replicated-job switch replaces cleanly", async () => {
    await withDump("E-35-19d", async () => {
      const ns2 = nsFor("k3s-rb-kind-d", ENV);
      const f = variantOf("k3s-rb-kind-d");
      try {
        f.write(".dockflow/docker/docker-compose.yml", 'services:\n  once:\n    image: busybox:1.37\n    command: ["sh", "-c", "sleep 36000"]\n');
        let result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);

        f.write(
          ".dockflow/docker/docker-compose.yml",
          ["services:", "  once:", "    image: busybox:1.37", '    command: ["sh", "-c", "echo done"]', "    deploy:", "      mode: replicated-job", ""].join(
            "\n",
          ),
        );
        result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toMatch(/Replacing Deployment\/once with Job\/\S+ for service once; its pods restart/);
        expect((await getJson<Job>("jobs.batch", { ns: ns2 })).length).toBe(1);
        expect((await getJson<Deployment>("deployments.apps", { ns: ns2, name: "once" })).length).toBe(0);
      } finally {
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 300_000);

  test("E-35-19e a host-port Deployment switching to deploy.mode: global replaces without an Unschedulable wait", async () => {
    await withDump("E-35-19e", async () => {
      const ns2 = nsFor("k3s-rb-kind-e", ENV);
      const f = variantOf("k3s-rb-kind-e");
      try {
        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  edge:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            '    ports: ["18089:80"]',
            "    x-dockflow:",
            "      publish: hostport",
            "",
          ].join("\n"),
        );
        let result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(0);
        await waitWorkloadReady(ns2, "deployment", "edge", 1);

        f.write(
          ".dockflow/docker/docker-compose.yml",
          [
            "services:",
            "  edge:",
            "    image: busybox:1.37",
            '    command: ["sh", "-c", "sleep 36000"]',
            '    ports: ["18089:80"]',
            "    x-dockflow:",
            "      publish: hostport",
            "    deploy:",
            "      mode: global",
            "",
          ].join("\n"),
        );
        const started = Date.now();
        result = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        const elapsedS = (Date.now() - started) / 1000;
        expect(result.exitCode).toBe(0);
        expect(elapsedS).toBeLessThan(60); // never spends the 60s Unschedulable grace (F9)
        expect(result.stdout + result.stderr).toMatch(/Replacing Deployment\/edge with DaemonSet\/edge for service edge; its pods restart/);
        await waitWorkloadReady(ns2, "daemonset", "edge", 2);
        expect((await getJson<Deployment>("deployments.apps", { ns: ns2, name: "edge" })).length).toBe(0);
      } finally {
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 300_000);
});

describe("accessories are not rolled back (E-35-20)", () => {
  test("E-35-20 a rollback after an accessories change warns instead of touching them", async () => {
    await withDump("E-35-20", async () => {
      const ns2 = nsFor("k3s-rb-accwarn", ENV);
      const f = variantOf("k3s-rb-accwarn");
      try {
        f.write(".dockflow/docker/docker-compose.yml", 'services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "sleep 36000"]\n');
        f.write(".dockflow/docker/accessories.yml", "services:\n  cache:\n    image: redis:8-alpine\n    environment:\n      MARK: v1\n");
        const v1 = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(v1.exitCode).toBe(0);

        const warnPattern = /Accessories were not rolled back; 1 accessory service\(s\) still run the definition deployed after 1\.0\.0/;
        const restoreLine = "Restore them by checking out the accessories.yml of 1.0.0 and running `dockflow deploy e2e --accessories`";
        const mark = async (): Promise<string> =>
          (await runCLI(["accessories", "exec", ENV, "cache", "--", "printenv", "MARK"], { cwd: f.dir, timeoutMs: 30_000 })).stdout.trim();

        // accessories change and the HTTP check fails: rollbackRelease takes the app back, says the accessories stay
        f.write(".dockflow/docker/accessories.yml", "services:\n  cache:\n    image: redis:8-alpine\n    environment:\n      MARK: v2\n");
        const original = f.read(".dockflow/config.yml");
        f.write(".dockflow/config.yml", `${original}${FAILING_CHECK}`);
        let v2: CLIResult;
        try {
          v2 = await runCLI(["deploy", ENV, "1.0.1", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        } finally {
          f.write(".dockflow/config.yml", original);
        }
        expect(v2.exitCode).toBe(53);
        expect(v2.stdout + v2.stderr).toMatch(warnPattern);
        expect(v2.stdout + v2.stderr).toContain(restoreLine);
        expect(await mark()).toBe("v2");

        // a later healthy deploy, then a manual rollback to 1.0.0: the same warning, the accessories untouched
        const v3 = await runCLI(["deploy", ENV, "1.0.2", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(v3.exitCode).toBe(0);
        expect(v3.stdout + v3.stderr).not.toMatch(warnPattern);
        const rollback = await runCLI(["rollback", ENV], { cwd: f.dir, timeoutMs: 200_000 });
        expect(rollback.exitCode).toBe(0);
        expect(rollback.stdout + rollback.stderr).toMatch(warnPattern);
        expect(await mark()).toBe("v2");
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await runCLI(["accessories", "remove", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 400_000);
});

describe("single-release rollback refusal (E-35-09b)", () => {
  test("E-35-09b rollback of a service with one stored release is refused", async () => {
    await withDump("E-35-09b", async () => {
      const ns2 = nsFor("k3s-rb-single", ENV);
      const single = makeFixture("test-app-k3s-rollback", { cluster: "k3s" });
      try {
        single.patchConfig((text) => text.replace(`project_name: ${PROJECT}`, "project_name: k3s-rb-single"));
        writeWebCompose(single, { mode: "ok", marker: "ONLY" });

        const deployed = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: single.dir, timeoutMs: 200_000 });
        expect(deployed.exitCode).toBe(0);

        const before = (await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" }))[0]?.metadata.generation;
        const result = await runCLI(["rollback", ENV, "web"], { cwd: single.dir, timeoutMs: 60_000 });
        expect(result.exitCode).toBe(52); // ROLLBACK_FAILED
        expect(result.stdout + result.stderr).toContain(
          "Service web has the same definition in every stored release; there is nothing to roll back to",
        );
        expect(result.stdout + result.stderr).toContain(`dockflow rollback ${ENV}`);
        const after = (await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" }))[0]?.metadata.generation;
        expect(after).toBe(before);
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: single.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        single.cleanup();
      }
    });
  }, 300_000);
});

describe("first-deploy failures (E-35-15, E-35-16)", () => {
  test("E-35-15 a crash on the first deploy leaves workloads in place and writes no release", async () => {
    await withDump("E-35-15", async () => {
      const ns2 = nsFor("k3s-firstfail", ENV);
      const f = makeFixture("test-app-k3s-firstfail", { cluster: "k3s" });
      try {
        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(50); // DEPLOY_FAILED
        expect(result.stdout + result.stderr).toMatch(
          /nothing to roll back to \(first deployment of this stack\); workloads were left in place for debugging/,
        );
        expect((await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" })).length).toBe(1);
        expect((await releaseSecrets(ns2)).length).toBe(0);
        expect((await stateConfigMap(ns2)).current).toBeUndefined();
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 300_000);

  test("E-35-16 a missing accessory image fails the deploy before the app role is touched", async () => {
    await withDump("E-35-16", async () => {
      const ns2 = nsFor("k3s-firstfail2", ENV);
      const f = makeFixture("test-app-k3s-firstfail", { cluster: "k3s" });
      try {
        f.patchConfig((text) => text.replace("project_name: k3s-firstfail", "project_name: k3s-firstfail2"));
        f.write(".dockflow/docker/docker-compose.yml", 'services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "sleep 36000"]\n');
        f.write(".dockflow/docker/accessories.yml", "services:\n  cache:\n    image: localhost:35010/e2e/missing:acc\n");

        const result = await runCLI(["deploy", ENV, "1.0.0", "--yes"], { cwd: f.dir, timeoutMs: 200_000 });
        expect(result.exitCode).toBe(50); // DEPLOY_FAILED

        expect((await getJson<Deployment>("deployments.apps", { ns: ns2, name: "web" })).length).toBe(0);
        expect((await releaseSecrets(ns2)).length).toBe(0);
      } finally {
        await runCLI(["stop", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await runCLI(["accessories", "remove", ENV, "-y"], { cwd: f.dir, timeoutMs: 60_000 }).catch(() => {});
        await deleteStackCompletely(ns2).catch(() => {});
        f.cleanup();
      }
    });
  }, 300_000);
});
