/**
 * E-31 (design-07 17.1 31-deploy-basic.test.ts): the k3s-core lane's single-project deploy chain —
 * one fixture (test-app-k3s-basic), a sequence of versions that exercise the render/apply/convergence
 * contract end to end (build, image dedupe, env delivery, probes, SSA, release records, retention,
 * stop, and the namespace-ownership refusal).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ANNOTATIONS,
  K8S_MANAGED_BY,
  K8S_RELEASE_SECRET_TYPE,
  LABELS,
} from "../../../../../cli/src/services/orchestrator/kubernetes/constants";
import { loadBalancerServiceName, namespaceFor, releaseSlug } from "../../../../../cli/src/services/orchestrator/kubernetes/naming";
import type { Deployment } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { Pod, Secret, Service } from "../../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import { type CLIResult, runCLI } from "../../../helpers/cli";
import { dumpDebug } from "../../../helpers/debug-dump";
import { type Fixture, makeFixture } from "../../../helpers/fixtures";
import {
  assertLiveMatchesRender,
  curlFrom,
  decodeRelease,
  deleteStackCompletely,
  getJson,
  imagesOnNode,
  kubectl,
  leaseFor,
  nsFor,
  podsForService,
  podUids,
  releaseSecrets,
  stateConfigMap,
  waitFor,
  waitWorkloadReady,
} from "../../../helpers/k8s";
import { currentTopology } from "../../../helpers/topology";

const FILE = "31-deploy-basic.test.ts";
const NS = nsFor("k3s-basic");
const IMAGE = (version: string) => `dockflow.invalid/k3s-basic-web:${version}`;

async function withDump<T>(testName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await dumpDebug(`${FILE}:${testName}`).catch(() => {});
    throw error;
  }
}

async function deploy(fixture: Fixture, version: string, extraArgs: readonly string[] = []): Promise<CLIResult> {
  return runCLI(["deploy", "e2e", version, ...extraArgs], { cwd: fixture.dir, timeoutMs: 260_000 });
}

describe("E-31 deploy-basic chain", () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture("test-app-k3s-basic", { cluster: "k3s", topology: currentTopology() });
  });

  afterAll(async () => {
    await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 }).catch(() => {});
    await deleteStackCompletely(NS);
    fixture.cleanup();
  });

  test("E-31-01: deploy e2e 1.0.0 succeeds within 240s and names both nodes", async () => {
    await withDump("E-31-01", async () => {
      const result = await deploy(fixture, "1.0.0");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeLessThan(240_000);
      const out = result.stdout + result.stderr;
      expect(out).toContain("server_1");
      expect(out).toContain("agent_1");
    });
  });

  test("E-31-02: the namespace carries the stack identity", async () => {
    await withDump("E-31-02", async () => {
      const [ns] = await getJson<{ metadata: { labels?: Record<string, string>; annotations?: Record<string, string> } }>(
        "namespaces",
        { name: NS },
      );
      expect(ns).toBeDefined();
      expect(ns?.metadata.labels?.["app.kubernetes.io/managed-by"]).toBe(K8S_MANAGED_BY);
      expect(ns?.metadata.labels?.[LABELS.stack]).toBe(NS);
      expect(ns?.metadata.annotations?.[ANNOTATIONS.stackName]).toBe("k3s-basic-e2e");
    });
  });

  test("E-31-03: Deployment web is ready with T-WORK-01 labels/annotations", async () => {
    await withDump("E-31-03", async () => {
      await waitWorkloadReady(NS, "deployment", "web", 2, 240_000);
      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      expect(web).toBeDefined();
      expect(web?.status?.readyReplicas).toBe(2);
      const labels = web?.metadata.labels ?? {};
      expect(labels["app.kubernetes.io/managed-by"]).toBe("dockflow");
      expect(labels["app.kubernetes.io/part-of"]).toBe("k3s-basic");
      expect(labels["app.kubernetes.io/instance"]).toBe(NS);
      expect(labels["app.kubernetes.io/name"]).toBe("web");
      expect(labels[LABELS.stack]).toBe(NS);
      expect(labels[LABELS.role]).toBe("app");
      expect(labels[LABELS.service]).toBe("web");
      expect(labels[LABELS.part]).toBe("stack");
      const annotations = web?.metadata.annotations ?? {};
      expect(annotations[ANNOTATIONS.composeService]).toBe("web");
      expect(annotations[ANNOTATIONS.release]).toBe("1.0.0");
      expect(Object.keys(web?.spec.selector.matchLabels ?? {}).sort()).toEqual([LABELS.service, LABELS.stack].sort());
    });
  });

  test("E-31-04: every stack object carries P/role and app.kubernetes.io/instance", async () => {
    await withDump("E-31-04", async () => {
      const pods = await getJson<Pod>("pods", { ns: NS, selector: `${LABELS.stack}=${NS}` });
      expect(pods.length).toBeGreaterThan(0);
      for (const pod of pods) {
        expect(pod.metadata.labels?.[LABELS.role]).toBeDefined();
        expect(pod.metadata.labels?.["app.kubernetes.io/instance"]).toBe(NS);
      }
    });
  });

  test("E-31-05: the built image is imported and pinned on both nodes", async () => {
    await withDump("E-31-05", async () => {
      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      const container = web?.spec.template.spec.containers[0];
      expect(container?.image).toBe(IMAGE("1.0.0"));
      expect(container?.imagePullPolicy).toBe("IfNotPresent");
      for (const node of ["server_1", "agent_1"] as const) {
        const images = await imagesOnNode(node);
        const found = images.find((image) => image.ref === IMAGE("1.0.0"));
        expect(found?.pinned).toBe(true);
      }
    });
  });

  test("E-31-06: Services web and web-lb are shaped correctly", async () => {
    await withDump("E-31-06", async () => {
      const [web] = await getJson<Service>("services", { ns: NS, name: "web" });
      expect(web?.spec.ports?.[0]).toMatchObject({ name: "tcp-80", port: 80 });

      const lbName = loadBalancerServiceName("web");
      const [lb] = await getJson<Service>("services", { ns: NS, name: lbName });
      expect(lb?.spec.ports?.[0]).toMatchObject({ name: "tcp-80", port: 8081, targetPort: 80 });
      const ingress = lb?.status?.loadBalancer?.ingress?.map((entry) => entry.ip) ?? [];
      for (const node of currentTopology().nodes) expect(ingress).toContain(node.ip);
    });
  });

  test("E-31-07: the published port answers from both nodes and from outside", async () => {
    await withDump("E-31-07", async () => {
      for (const node of ["server_1", "agent_1"] as const) {
        const response = await curlFrom(node, "http://127.0.0.1:8081/");
        expect(response.code).toBe(200);
        expect(response.body).toContain("K3S_BASIC_V1");
      }
      const agentIp = currentTopology().nodes.find((node) => node.key === "agent_1")?.ip;
      const outside = await curlFrom("outsider", `http://${agentIp}:8081/`);
      expect(outside.code).toBe(200);
      expect(outside.body).toContain("K3S_BASIC_V1");
    });
  });

  test("E-31-08: port-less same-namespace DNS resolves the worker service", async () => {
    await withDump("E-31-08", async () => {
      const result = await runCLI(["exec", "e2e", "web", "--", "getent", "hosts", "worker"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().split(/\s+/).length).toBeGreaterThanOrEqual(1);
    });
  });

  test("E-31-09: env delivery through a content-hashed, immutable Secret", async () => {
    await withDump("E-31-09", async () => {
      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      const container = web?.spec.template.spec.containers[0];
      const secretName = container?.envFrom?.[0]?.secretRef?.name ?? "";
      expect(secretName).toMatch(/^web-env-[0-9a-f]{8}$/);
      const [secret] = await getJson<Secret>("secrets", { ns: NS, name: secretName });
      expect(secret?.immutable).toBe(true);
      const literalValues = (container?.env ?? []).map((entry) => entry.value).filter((v): v is string => v !== undefined);
      expect(literalValues).not.toContain("hello $USER $(literal)");
      expect(literalValues).not.toContain("E2E_SECRET_TOKEN_7f3a9c");

      const greeting = await runCLI(["exec", "e2e", "web", "--", "printenv", "GREETING"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(greeting.stdout.trim()).toBe("hello $USER $(literal)");
      const portText = await runCLI(["exec", "e2e", "web", "--", "printenv", "PORT_TEXT"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(portText.stdout.trim()).toBe("010");
      const fromFile = await runCLI(["exec", "e2e", "web", "--", "printenv", "EXTRA_FROM_FILE"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(fromFile.stdout.trim()).toBe("from-env-file");
    });
  });

  test("E-31-10: every object was applied server-side, never client-side", async () => {
    await withDump("E-31-10", async () => {
      const raw = await kubectl(["get", "deployment", "web", "-n", NS, "-o", "json", "--show-managed-fields"]);
      const parsed = JSON.parse(raw) as { metadata: { annotations?: Record<string, string>; managedFields?: { manager?: string; operation?: string }[] } };
      expect(parsed.metadata.annotations?.["kubectl.kubernetes.io/last-applied-configuration"]).toBeUndefined();
      const managers = parsed.metadata.managedFields ?? [];
      expect(managers.some((entry) => entry.manager === "dockflow" && entry.operation === "Apply")).toBe(true);
    });
  });

  test("E-31-11: the compose secret is mounted with its declared mode", async () => {
    await withDump("E-31-11", async () => {
      const result = await runCLI(["exec", "e2e", "web", "--", "cat", "/run/secrets/api_key"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(result.stdout).toBe(fixture.read(".dockflow/docker/api_key.txt"));
      const mode = await runCLI(["exec", "e2e", "web", "--", "stat", "-L", "-c", "%a", "/run/secrets/api_key"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(mode.stdout.trim()).toBe("440");
    });
  });

  test("E-31-12: readiness/liveness probes match the compose healthcheck", async () => {
    await withDump("E-31-12", async () => {
      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      const container = web?.spec.template.spec.containers[0];
      expect(container?.readinessProbe).toMatchObject({ periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3, successThreshold: 1 });
      expect(container?.livenessProbe).toMatchObject({ initialDelaySeconds: 5 });
    });
  });

  test("E-31-13: pod defaults (grace period, service links, token mount)", async () => {
    await withDump("E-31-13", async () => {
      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      expect(web?.spec.template.spec.terminationGracePeriodSeconds).toBe(10);
      expect(web?.spec.template.spec.enableServiceLinks).toBe(false);
      expect(web?.spec.template.spec.automountServiceAccountToken).toBe(false);
      const count = await runCLI(["exec", "e2e", "web", "--", "sh", "-c", "env | grep -c _SERVICE_HOST"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(count.stdout.trim()).toBe("1");
      const mount = await runCLI(["exec", "e2e", "web", "--", "sh", "-c", "test -e /var/run/secrets/kubernetes.io && echo present || echo absent"], {
        cwd: fixture.dir,
        timeoutMs: 30_000,
      });
      expect(mount.stdout.trim()).toBe("absent");
    });
  });

  test("E-31-14: the release record of 1.0.0 is complete and no Lease is left", async () => {
    await withDump("E-31-14", async () => {
      const [secret] = await getJson<Secret>("secrets", { ns: NS, name: `dockflow-release-${releaseSlug("1.0.0")}` });
      expect(secret?.type).toBe(K8S_RELEASE_SECRET_TYPE);
      expect(secret?.immutable).toBe(true);
      expect(secret?.metadata.labels?.["app.kubernetes.io/managed-by"]).toBe("dockflow");
      expect(secret?.metadata.labels?.[LABELS.stack]).toBe(NS);
      expect(secret?.metadata.labels?.[LABELS.part]).toBe("release");
      expect(secret?.metadata.labels?.[LABELS.releaseVersion]).toBe("1.0.0");

      const state = await stateConfigMap(NS);
      expect(state.current).toBe("1.0.0");

      const release = await decodeRelease(NS, "1.0.0");
      expect(release.stack.split(/\r?\n/)[0]).toBe("# dockflow-artifact: k8s-manifests/1");
      expect(release.metadata.orchestrator).toBe("k3s");

      expect(await leaseFor(NS)).toBeNull();
    });
  });

  test("E-31-15: status and version answer for e2e", async () => {
    await withDump("E-31-15", async () => {
      const status = await runCLI(["status", "e2e"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("1.0.0");

      const version = await runCLI(["version", "e2e"], { cwd: fixture.dir, timeoutMs: 30_000 });
      expect(version.exitCode).toBe(0);
      const out = version.stdout + version.stderr;
      expect(out).toContain("1.0.0");
      expect(out).toContain("2/2");
    });
  });

  test("E-31-16: the live objects match a fresh render of 1.0.0", async () => {
    await withDump("E-31-16", async () => {
      await assertLiveMatchesRender(fixture, "1.0.0");
    });
  });

  test("E-31-17: deploy e2e 1.0.1 (no file change) rolls web once, not worker, with no image transfer", async () => {
    await withDump("E-31-17", async () => {
      const workerUidsBefore = await podUids(NS, "worker");
      const [beforeDeploy] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "worker" });

      const result = await deploy(fixture, "1.0.1");
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 2, 180_000);

      const workerUidsAfter = await podUids(NS, "worker");
      expect(workerUidsAfter.sort()).toEqual(workerUidsBefore.sort());
      const [afterDeploy] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "worker" });
      expect(afterDeploy?.metadata.generation).toBe(beforeDeploy?.metadata.generation);

      const [web] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      expect(web?.spec.template.spec.containers[0]?.image).toBe(IMAGE("1.0.1"));

      const out = result.stdout + result.stderr;
      expect(out.toLowerCase()).not.toMatch(/transferring|uploading .*k3s-basic-web/);
    });
  });

  test("E-31-18: deploy e2e 1.0.2 with GREETING changed rotates the env Secret, keeping the old one", async () => {
    await withDump("E-31-18", async () => {
      const [before] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      const oldSecretName = before?.spec.template.spec.containers[0]?.envFrom?.[0]?.secretRef?.name ?? "";

      fixture.patchCompose((text) => text.replace('GREETING: "hello $$USER $$(literal)"', 'GREETING: "hello again $$USER"'));
      const result = await deploy(fixture, "1.0.2");
      expect(result.exitCode).toBe(0);
      await waitWorkloadReady(NS, "deployment", "web", 2, 180_000);

      const [after] = await getJson<Deployment>("deployments.apps", { ns: NS, name: "web" });
      const newSecretName = after?.spec.template.spec.containers[0]?.envFrom?.[0]?.secretRef?.name ?? "";
      expect(newSecretName).not.toBe(oldSecretName);

      const [oldSecretStillThere] = await getJson<Secret>("secrets", { ns: NS, name: oldSecretName });
      expect(oldSecretStillThere).toBeDefined();
      const replicaSets = await getJson<{ spec?: { template?: { spec?: { containers?: { envFrom?: { secretRef?: { name?: string } }[] }[] } } } }>(
        "replicasets.apps",
        { ns: NS, selector: `${LABELS.service}=web` },
      );
      const references = replicaSets.some((rs) =>
        (rs.spec?.template?.spec?.containers ?? []).some((c) => (c.envFrom ?? []).some((e) => e.secretRef?.name === oldSecretName)),
      );
      expect(references).toBe(true);
    });
  });

  test("E-31-19: deploy e2e 1.0.3 with worker removed deletes it and prunes no volume", async () => {
    await withDump("E-31-19", async () => {
      fixture.patchCompose((text) =>
        text.replace(/\n {2}worker:\n(?:.*\n)*?(?=secrets:)/, "\n"),
      );
      const result = await deploy(fixture, "1.0.3");
      expect(result.exitCode).toBe(0);
      const workerDeployment = await getJson<Deployment>("deployments.apps", { ns: NS, name: "worker" });
      expect(workerDeployment).toEqual([]);
      const workerService = await getJson<Service>("services", { ns: NS, name: "worker" });
      expect(workerService).toEqual([]);
      const pvcs = await getJson("persistentvolumeclaims", { ns: NS });
      expect(pvcs).toEqual([]);
    });
  });

  test("E-31-20: deploy e2e 1.0.4 --only web re-adds worker in the file but not on the cluster", async () => {
    await withDump("E-31-20", async () => {
      fixture.patchCompose(
        (text) =>
          `${text.replace(/^secrets:/m, ["  worker:", '    image: busybox:1.37', '    command: ["sh", "-c", "sleep 36000"]', "secrets:"].join("\n"))}`,
      );
      fixture.patchCompose((text) => text.replace("MARKER: K3S_BASIC_V1", "MARKER: K3S_BASIC_V2"));

      const result = await deploy(fixture, "1.0.4", ["--only", "web"]);
      expect(result.exitCode).toBe(0);

      const workerDeployment = await getJson<Deployment>("deployments.apps", { ns: NS, name: "worker" });
      expect(workerDeployment).toEqual([]);

      for (const node of ["server_1", "agent_1"] as const) {
        await waitFor(
          async () => {
            const response = await curlFrom(node, "http://127.0.0.1:8081/");
            return response.body.includes("K3S_BASIC_V2") ? true : undefined;
          },
          { timeoutMs: 120_000, describe: `${node} to serve K3S_BASIC_V2` },
        );
      }

      const release = await decodeRelease(NS, "1.0.4");
      expect(release.stack).toContain("kind: Deployment");
      expect(release.stack).toContain("name: worker");
    });
  });

  test("E-31-21: retention keeps only the three newest releases and their images", async () => {
    await withDump("E-31-21", async () => {
      const secrets = await releaseSecrets(NS);
      const versions = secrets.map((s) => s.metadata.labels?.[LABELS.releaseVersion]).sort();
      expect(versions).toEqual(["1.0.2", "1.0.3", "1.0.4"]);

      for (const node of ["server_1", "agent_1"] as const) {
        const images = await imagesOnNode(node);
        const refs = images.map((image) => image.ref);
        expect(refs).not.toContain(IMAGE("1.0.0"));
        expect(refs).not.toContain(IMAGE("1.0.1"));
        for (const version of ["1.0.2", "1.0.3", "1.0.4"]) expect(refs).toContain(IMAGE(version));
      }
    });
  });

  test("E-31-22: stop e2e -y is idempotent and keeps volumes, release history and the namespace", async () => {
    await withDump("E-31-22", async () => {
      const first = await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(first.exitCode).toBe(0);
      const second = await runCLI(["stop", "e2e", "-y"], { cwd: fixture.dir, timeoutMs: 120_000 });
      expect(second.exitCode).toBe(0);

      const pods = await podsForService(NS, "web");
      expect(pods).toEqual([]);
      const services = await getJson<Service>("services", { ns: NS, name: "web" });
      expect(services).toEqual([]);
      const hashedSecrets = await getJson<Secret>("secrets", { ns: NS, selector: `${LABELS.hashed}=true` });
      expect(hashedSecrets).toEqual([]);

      const [ns] = await getJson("namespaces", { name: NS });
      expect(ns).toBeDefined();
      const releases = await releaseSecrets(NS);
      expect(releases.length).toBeGreaterThan(0);
      const state = await stateConfigMap(NS);
      expect(state.current).toBeTruthy();
    });
  });

  test("E-31-23: a namespace of another stack refuses the deploy and creates nothing in it", async () => {
    await withDump("E-31-23", async () => {
      const adoptNs = namespaceFor("k3s-adopt", "e2e");
      await kubectl(["create", "namespace", adoptNs]);
      try {
        const adopt = makeFixture("test-app-k3s-basic", { cluster: "k3s", topology: currentTopology() });
        try {
          adopt.patchConfig((text) => text.replace("project_name: k3s-basic", "project_name: k3s-adopt"));
          const result = await runCLI(["deploy", "e2e", "1.0.0"], { cwd: adopt.dir, timeoutMs: 60_000 });
          expect(result.exitCode).not.toBe(0);
          expect(result.stdout + result.stderr).toContain(
            `Namespace ${adoptNs} exists and belongs to no Dockflow stack; rename project_name or env`,
          );
          const objects = await getJson("deployments.apps", { ns: adoptNs });
          expect(objects).toEqual([]);
        } finally {
          adopt.cleanup();
        }
      } finally {
        await kubectl(["delete", "namespace", adoptNs, "--ignore-not-found", "--wait=false"], { allowFailure: true });
      }
    });
  });
});
