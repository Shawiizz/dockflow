/**
 * E-32 (design-07 17.1 32-compose-coverage.test.ts): one deploy, many services — every remaining
 * compose/x-dockflow translate feature (design-02 4-9) not already covered by 31-deploy-basic. The
 * `jobcrash` service (E-32-10b) is inserted after the baseline deploy so the baseline itself stays
 * green for every other row.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LABELS } from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import type { DaemonSet, Deployment, StatefulSet } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { Job } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/batch";
import type { PersistentVolumeClaim, Pod, Service } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import { curlFrom, deleteStackCompletely, getJson, kubectl, nodeExec, nsFor, podsForService, waitFor, waitWorkloadReady } from "../../../helpers/k8s";
import { currentTopology, nodeFor } from "../../../helpers/topology";

const FILE = "32-compose-coverage.test.ts";
const NS = nsFor("k3s-coverage");
const COVERAGE_FILE_CONTENT = "coverage-e2e-binder-content\n";

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function deploy(fixture: Fixture, version: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCLI(["deploy", "e2e", version], { cwd: fixture.dir, timeoutMs: 260_000 });
}

async function podNode(service: string): Promise<string | undefined> {
  const [pod] = await getJson<Pod>("pods", { ns: NS, selector: `${LABELS.service}=${service}` });
  return pod?.spec.nodeName;
}

describe("E-32 compose coverage", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    // E-32-18: the bind-mount source must exist on the node's own filesystem before the pod schedules.
    for (const node of ["server_1", "agent_1"] as const) {
      await nodeExec(node, `mkdir -p /srv/e2e-coverage && printf '${COVERAGE_FILE_CONTENT}' > /srv/e2e-coverage/coverage.txt`, { user: "root" });
    }
    fixture = makeFixture("test-app-k3s-coverage", { cluster: "k3s", topology: currentTopology() });
    const result = await deploy(fixture, "1.0.0");
    if (result.exitCode !== 0) throw new Error(`baseline deploy failed: ${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  });

  afterAll(async () => {
    await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS);
    fixture.cleanup();
    for (const node of ["server_1", "agent_1"] as const) {
      await nodeExec(node, "rm -rf /srv/e2e-coverage", { user: "root" }).catch(() => {});
    }
  });

  test("E-32-01: args, $$ literals and numeric strings survive to the container argv", async () => {
    await withDump("E-32-01", async () => {
      await waitWorkloadReady(NS, "deployment", "args", 1, 120_000);
      const logs = await runCLI(["logs", "e2e", "args", "-n", "1"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(logs.stdout).toContain("a b|$(HOME)|010|");
    });
  });

  test("E-32-02: user, group_add, cap_drop/cap_add, read_only, tmpfs", async () => {
    await withDump("E-32-02", async () => {
      await waitWorkloadReady(NS, "deployment", "secure", 1, 120_000);
      const uid = await runCLI(["exec", "e2e", "secure", "--", "id", "-u"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(uid.stdout.trim()).toBe("1000");
      const groups = await runCLI(["exec", "e2e", "secure", "--", "id", "-G"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(groups.stdout.trim().split(/\s+/)).toContain("2000");
      const capBnd = await runCLI(["exec", "e2e", "secure", "--", "sh", "-c", "grep CapBnd /proc/self/status"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(capBnd.stdout).toContain("0000000000000400");
      const roWrite = await runCLI(["exec", "e2e", "secure", "--", "touch", "/x"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(roWrite.exitCode).not.toBe(0);
      const tmpWrite = await runCLI(["exec", "e2e", "secure", "--", "touch", "/tmp/x"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(tmpWrite.exitCode).toBe(0);
    });
  });

  test("E-32-03: shm_size and sysctls", async () => {
    await withDump("E-32-03", async () => {
      const shm = await runCLI(["exec", "e2e", "secure", "--", "df", "-k", "/dev/shm"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(shm.stdout).toContain("32768");
      const sysctl = await runCLI(["exec", "e2e", "secure", "--", "cat", "/proc/sys/net/ipv4/ip_unprivileged_port_start"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(sysctl.stdout.trim()).toBe("0");
    });
  });

  test("E-32-04: init: true runs /pause as PID 1", async () => {
    await withDump("E-32-04", async () => {
      const cmdline = await runCLI(["exec", "e2e", "secure", "--", "cat", "/proc/1/cmdline"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(cmdline.stdout.replace(/\0/g, "")).toBe("/pause");
    });
  });

  test("E-32-05: stop_grace_period, hostname, extra_hosts, dns_search", async () => {
    await withDump("E-32-05", async () => {
      const [secure] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "secure" });
      expect(secure?.spec.template.spec.terminationGracePeriodSeconds).toBe(3);
      expect(secure?.spec.template.spec.hostname).toBe("coverage-host");
      const hosts = await runCLI(["exec", "e2e", "secure", "--", "cat", "/etc/hosts"], { cwd: fixture.dir, timeoutMs: 30_000 });
      // the kubelet separates hostAliases entries with a tab
      expect(hosts.stdout).toMatch(/^10\.9\.9\.9\s+legacy\.internal$/m);
      const resolv = await runCLI(["exec", "e2e", "secure", "--", "cat", "/etc/resolv.conf"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(resolv.stdout).toMatch(/search[^\n]*example\.internal/);
    });
  });

  test("E-32-06: cpu/memory limits and requests", async () => {
    await withDump("E-32-06", async () => {
      const [secure] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "secure" });
      const resources = secure?.spec.template.spec.containers[0]?.resources;
      expect(resources?.limits?.cpu).toBe("500m");
      expect(resources?.limits?.memory).toBe("64Mi");
      expect(resources?.requests?.memory).toBe("32Mi");
    });
  });

  test("E-32-07: healthcheck with start_period/start_interval becomes a matching startupProbe", async () => {
    await withDump("E-32-07", async () => {
      await waitWorkloadReady(NS, "deployment", "probe", 1, 120_000);
      const [probe] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "probe" });
      const container = probe?.spec.template.spec.containers[0];
      expect(container?.startupProbe).toBeDefined();
      const rendered = await runCLI(["deploy", "e2e", "1.0.0", "--dry-run", "--render"], { cwd: fixture.dir, timeoutMs: 60_000 });
      expect(rendered.stdout).toContain("startupProbe");
      const pods = await podsForService(NS, "probe");
      expect(pods[0]?.status?.phase).toBe("Running");
    });
  });

  test("E-32-08: x-dockflow.probes.http sets an HTTP readiness probe", async () => {
    await withDump("E-32-08", async () => {
      await waitWorkloadReady(NS, "deployment", "httpprobe", 1, 120_000);
      const [httpprobe] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "httpprobe" });
      const readiness = httpprobe?.spec.template.spec.containers[0]?.readinessProbe;
      expect(readiness?.httpGet).toMatchObject({ path: "/", port: 80 });
    });
  });

  test("E-32-09: deploy.mode global is a DaemonSet with one ready pod per node", async () => {
    await withDump("E-32-09", async () => {
      await waitWorkloadReady(NS, "daemonset", "daemon", currentTopology().nodes.length, 120_000);
      const [daemon] = await getJson<DaemonSet>("daemonsets.apps", { ns: NS, name: "daemon" });
      expect(daemon?.status?.numberReady).toBe(currentTopology().nodes.length);
    });
  });

  test("E-32-10: an unchanged replicated-job keeps its Job name across a version bump; a command change renames it", async () => {
    await withDump("E-32-10", async () => {
      await waitFor(
        async () => {
          const [job] = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=job` });
          return job?.status?.succeeded === 1 ? true : undefined;
        },
        { timeoutMs: 120_000, describe: "job's replicated-job to complete" },
      );
      const logs = await runCLI(["logs", "e2e", "job"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(logs.stdout).toContain("done");
      const [firstJob] = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=job` });
      const firstName = firstJob?.metadata.name;

      // 1.0.1: a pure version bump, no compose change. The Job's content-hash name must not change,
      // and the SSA re-apply of an already-completed Job must not hit "field is immutable" (K43).
      const bump = await deploy(fixture, "1.0.1");
      expect(bump.exitCode).toBe(0);
      expect(bump.stdout + bump.stderr).not.toContain("field is immutable");
      const [afterBump] = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=job` });
      expect(afterBump?.metadata.name).toBe(firstName);

      // 1.0.2: the job's own command changes, so its content-hash name must change too.
      fixture.patchCompose((text) => text.replace('command: ["echo", "done"]', 'command: ["echo", "done-v2"]'));
      const changed = await deploy(fixture, "1.0.2");
      expect(changed.exitCode).toBe(0);
      await waitFor(
        async () => {
          const [job] = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=job` });
          return job && job.metadata.name !== firstName && job.status?.succeeded === 1 ? true : undefined;
        },
        { timeoutMs: 120_000, describe: "job's Job to be renamed and complete after its command changed" },
      );
    });
  });

  test("E-32-10b: a failing replicated-job is re-run, not silently skipped, on the next unchanged deploy", async () => {
    await withDump("E-32-10b", async () => {
      // A Job new in a failed version is removed by the revert; a failed run of the changed Job of a
      // service the previous release had cannot be undone, so it stays in place for the next deploy.
      fixture.patchCompose((text) =>
        text.replace(
          "# JOBCRASH_INSERT_POINT",
          ['  jobcrash:', '    image: busybox:1.37', '    command: ["sh", "-c", "exit 0"]', '    restart: "no"', "    deploy:", "      mode: replicated-job"].join(
            "\n",
          ),
        ),
      );
      const passing = await deploy(fixture, "1.0.3");
      expect(passing.exitCode).toBe(0);

      fixture.patchCompose((text) => text.replace('command: ["sh", "-c", "exit 0"]', 'command: ["sh", "-c", "exit 1"]'));
      const first = await deploy(fixture, "1.0.4");
      expect(first.exitCode).not.toBe(0);
      const failed = await waitFor(
        async () => {
          const jobs = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=jobcrash` });
          return jobs.find((job) => (job.status?.failed ?? 0) > 0);
        },
        { timeoutMs: 60_000, describe: "jobcrash's failed Job to stay in place" },
      );

      // Same content: the redeploy must delete-and-recreate (not silently reuse) the failed Job.
      const second = await deploy(fixture, "1.0.5");
      expect(second.stdout + second.stderr).toContain("failed in a previous deploy and is run again");
      const jobs = await getJson<Job>("jobs.batch", { ns: NS, selector: `${LABELS.service}=jobcrash` });
      const rerun = jobs.find((job) => job.metadata.name === failed.metadata.name);
      expect(rerun).toBeDefined();
      expect(rerun?.metadata.uid).not.toBe(failed.metadata.uid);
    });
  });

  test("E-32-11: node.role/node.hostname placement constraints", async () => {
    await withDump("E-32-11", async () => {
      const manager = nodeFor(currentTopology(), "server_1");
      const agent = nodeFor(currentTopology(), "agent_1");
      expect(await podNode("on-manager")).toBe(manager.service);
      expect(await podNode("on-agent")).toBe(agent.service);
    });
  });

  test("E-32-12: x-dockflow.publish hostport binds only the node running the pod", async () => {
    await withDump("E-32-12", async () => {
      const node = await podNode("hostport");
      const onNode = node === nodeFor(currentTopology(), "server_1").service ? "server_1" : "agent_1";
      const offNode = onNode === "server_1" ? "agent_1" : "server_1";
      const hit = await curlFrom(onNode, "http://127.0.0.1:18082/");
      expect(hit.code).toBe(200);
      const miss = await curlFrom(offNode, "http://127.0.0.1:18082/");
      expect(miss.code).not.toBe(200);
      const lb = await getJson<Service>("services", { ns: NS, name: "hostport-lb" });
      expect(lb).toEqual([]);
    });
  });

  test("E-32-13: x-dockflow.publish none is reachable only inside the cluster", async () => {
    await withDump("E-32-13", async () => {
      const lb = await getJson<Service>("services", { ns: NS, name: "nolb-lb" });
      expect(lb).toEqual([]);
      const outsideIp = currentTopology().nodes.find((node) => node.key === "agent_1")?.ip;
      const outside = await curlFrom("outsider", `http://${outsideIp}:18083/`);
      expect(outside.code).not.toBe(200);
      const inside = await runCLI(["exec", "e2e", "args", "--", "wget", "-qO-", "http://nolb/"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(inside.exitCode).toBe(0);
    });
  });

  test("E-32-14: endpoint_mode dnsrr is a headless Service with one A record per replica", async () => {
    await withDump("E-32-14", async () => {
      await waitWorkloadReady(NS, "deployment", "dnsrr", 2, 120_000);
      const [dnsrr] = await getJson<Service>("services", { ns: NS, name: "dnsrr" });
      expect(dnsrr?.spec.clusterIP).toBe("None");
      const [pod] = await getJson<Pod>("pods", { ns: NS, selector: `${LABELS.service}=dnsrr` });
      const result = await kubectl(["exec", "-n", NS, pod?.metadata.name ?? "", "--", "getent", "ahosts", "dnsrr"], { allowFailure: true });
      const addresses = new Set(result.split(/\r?\n/).map((line) => line.split(/\s+/)[0]).filter(Boolean));
      expect(addresses.size).toBe(2);
    });
  });

  test("E-32-15: x-dockflow.kind statefulset with a per_replica claim", async () => {
    await withDump("E-32-15", async () => {
      await waitWorkloadReady(NS, "statefulset", "db", 1, 120_000);
      const [db] = await getJson<StatefulSet>("statefulsets.apps", { ns: NS, name: "db" });
      expect(db).toBeDefined();
      const [pvc] = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: NS, name: "data-db-0" });
      expect(pvc?.status?.phase).toBe("Bound");
      expect(pvc?.spec.storageClassName).toBe("dockflow-local");
    });
  });

  test("E-32-16: a network alias is a Service of its own in front of the aliased pods", async () => {
    await withDump("E-32-16", async () => {
      const [aliased] = await getJson<Service>("services", { ns: NS, name: "aliased" });
      const [alias] = await getJson<Service>("services", { ns: NS, name: "legacy-name" });
      expect(alias?.spec.selector).toEqual(aliased?.spec.selector);
      // busybox has no getent; its nslookup does not apply the search list
      const lookup = await runCLI(["exec", "e2e", "args", "--", "nslookup", `legacy-name.${NS}.svc.cluster.local`], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(lookup.stdout).toContain(alias?.spec.clusterIP ?? "\0no-cluster-ip\0");
      const page = await runCLI(["exec", "e2e", "args", "--", "wget", "-qO-", "http://legacy-name/"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(page.exitCode).toBe(0);
    });
  });

  test("E-32-17: UDP and a port range get target-derived Service names", async () => {
    await withDump("E-32-17", async () => {
      const [udpLb] = await getJson<Service>("services", { ns: NS, name: "udp-lb" });
      const ports = udpLb?.spec.ports ?? [];
      expect(ports.find((p) => p.name === "udp-53")).toMatchObject({ port: 15353, protocol: "UDP" });
      expect(ports.find((p) => p.name === "tcp-9000")).toMatchObject({ port: 19000 });
      expect(ports.find((p) => p.name === "tcp-9001")).toMatchObject({ port: 19001 });

      // k3s's ServiceLB names each DaemonSet pod `svclb-<lb-service>-<hash>` (no stable label to select
      // on across k3s minors), so the pod is found by its name prefix instead.
      const allKubeSystem = await getJson<Pod>("pods", { ns: "kube-system" });
      const svclb = allKubeSystem.filter((pod) => pod.metadata.name.startsWith("svclb-udp-lb-"));
      const containerNames = svclb.flatMap((pod) => pod.spec.containers.map((c) => c.name));
      expect(containerNames).toEqual(expect.arrayContaining(["lb-udp-15353", "lb-tcp-19000", "lb-tcp-19001"]));
    });
  });

  test("E-32-18: a read-only host bind mount serves the file placed on the node", async () => {
    await withDump("E-32-18", async () => {
      const cat = await runCLI(["exec", "e2e", "binder", "--", "cat", "/data/coverage.txt"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(cat.stdout).toBe(COVERAGE_FILE_CONTENT);
      const write = await runCLI(["exec", "e2e", "binder", "--", "touch", "/data/x"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(write.exitCode).not.toBe(0);
    });
  });

  test("E-32-19: a named volume is Bound with Recreate strategy and Retain PV", async () => {
    await withDump("E-32-19", async () => {
      const [pvc] = await getJson<PersistentVolumeClaim>("persistentvolumeclaims", { ns: NS, name: "cache" });
      expect(pvc?.status?.phase).toBe("Bound");
      const [named] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "named" });
      expect(named?.spec.strategy?.type).toBe("Recreate");
      const [pv] = await getJson<{ spec?: { persistentVolumeReclaimPolicy?: string } }>("persistentvolumes", {
        name: pvc?.spec.volumeName ?? "",
      });
      expect(pv?.spec?.persistentVolumeReclaimPolicy).toBe("Retain");
    });
  });

  test("E-32-20: an invalid label and a logging key each warn exactly once", async () => {
    await withDump("E-32-20", async () => {
      const rendered = await runCLI(["deploy", "e2e", "1.0.4", "--dry-run", "--render"], { cwd: fixture.dir, timeoutMs: 60_000 });
      const lines = `${rendered.stdout}\n${rendered.stderr}`.split(/\r?\n/);
      const labelWarnings = lines.filter((line) => line.includes("is not a valid Kubernetes annotation key")).length;
      const loggingWarnings = lines.filter((line) => line.includes("logging is ignored")).length;
      expect(labelWarnings).toBe(1);
      expect(loggingWarnings).toBe(1);
    });
  });
});
