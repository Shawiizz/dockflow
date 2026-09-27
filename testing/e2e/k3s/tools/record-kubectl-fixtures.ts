#!/usr/bin/env bun
/**
 * Recorder for the kubectl/helm fixtures of design-07 3.11 (PD-12). Run by hand against a running
 * lane cluster — never inside a package; the test machine phase re-records them (design-07 0.5):
 *
 *   bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane k3s-core [--scenario <name> | --all]
 *
 * Each scenario creates its condition with harness kubectl in namespace `fixture-<scenario>`, waits
 * for it, then captures the namespaced and cluster resources of 3.11 as JSON Lists, scrubbed before
 * writing. The scrub rules, directory layout and meta format are not re-specified here: this tool
 * writes exactly what `cli/src/__tests__/kubernetes/support/kubectl-fixtures.ts` (P09) already reads
 * and verifies, reusing its constants directly, and self-checks every recording with the same
 * `scrubViolations` function `fixtures-meta.test.ts` uses before declaring it written.
 *
 * The scenario recipes mirror the `steps` already authored (by hand) in each scenario's existing
 * synthetic `meta.json` — this tool reproduces those same conditions against a real cluster instead
 * of a human typing them once. A recipe that no longer reproduces the condition on a later k3s pin
 * is exactly what a maintainer re-running this on the test machine is expected to fix.
 */

import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  CAPTURED_RESOURCES,
  CLUSTER_RESOURCES,
  DESIGN_SCENARIOS,
  FIXTURES_ROOT,
  type FixtureFile,
  fixtureNamespace,
  formatKubectlJson,
  NAMESPACED_RESOURCES,
  scrubViolations,
} from "../../../../cli/src/__tests__/kubernetes/support/kubectl-fixtures";
import { HELM_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/versions";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { getJson, kubectl, waitFor, withNodeDown } from "../../helpers/k8s";
import { isLaneName, LANES, type LaneName } from "../lanes";
import { TOPOLOGIES } from "../../helpers/topology";

// NOTE: this tool currently records the 24 kubectl scenarios of design-07 3.11's table. The three
// helm scenarios (helm-list, helm-status-failed, helm-history-rollback) and the kubectl-stderr
// samples are not implemented yet; `cli/src/__tests__/kubernetes/fixtures/helm/**` keeps its
// synthetic content until a follow-up extends this tool to record them too.

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── scrub transform (writes what support/kubectl-fixtures.ts's scrubViolations verifies) ─────────

interface ScrubMaps {
  uid: Map<string, string>;
  resourceVersion: Map<string, string>;
  hostIp: Map<string, string>;
  shiftMs: number;
}

const RFC3339_RE = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const SCRUBBED_START = new Date("2026-01-01T00:00:00Z");

function nextUid(maps: ScrubMaps): string {
  return `00000000-0000-4000-8000-${String(maps.uid.size).padStart(12, "0")}`;
}

function scrubUid(maps: ScrubMaps, value: string): string {
  const existing = maps.uid.get(value);
  if (existing) return existing;
  const assigned = nextUid(maps);
  maps.uid.set(value, assigned);
  return assigned;
}

function scrubResourceVersion(maps: ScrubMaps, value: string): string {
  const existing = maps.resourceVersion.get(value);
  if (existing) return existing;
  const assigned = String(maps.resourceVersion.size + 1);
  maps.resourceVersion.set(value, assigned);
  return assigned;
}

function scrubHostIp(maps: ScrubMaps, value: string): string {
  const existing = maps.hostIp.get(value);
  if (existing) return existing;
  const assigned = `192.0.2.${maps.hostIp.size + 11}`;
  maps.hostIp.set(value, assigned);
  return assigned;
}

/**
 * Node addresses first, servers before agents, so server-1 is 192.0.2.11 and agent-1 192.0.2.12 as
 * the fixture conventions say, whatever order kubectl listed them in.
 */
function mapNodeIps(nodes: unknown, maps: ScrubMaps): void {
  const items = isRecord(nodes) && Array.isArray(nodes.items) ? nodes.items.filter(isRecord) : [];
  const rank = (item: Record<string, unknown>): string => {
    const name = isRecord(item.metadata) && typeof item.metadata.name === "string" ? item.metadata.name : "";
    return `${name.startsWith("server") ? 0 : 1}${name}`;
  };
  for (const item of [...items].sort((a, b) => (rank(a) < rank(b) ? -1 : 1))) {
    const addresses = isRecord(item.status) && Array.isArray(item.status.addresses) ? item.status.addresses.filter(isRecord) : [];
    for (const address of addresses) {
      if ((address.type === "InternalIP" || address.type === "ExternalIP") && typeof address.address === "string") {
        scrubHostIp(maps, address.address);
      }
    }
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Event messages name the pod by its uid too (`pod_ns(<uid>)`): the same map applies inside any text. */
function replaceUuids(value: string, maps: ScrubMaps): string {
  return value.replace(UUID_RE, (match) => scrubUid(maps, match));
}

/** A node address also appears inside annotations (`k3s.io/node-args` is a JSON array in a string). */
function replaceHostIps(value: string, maps: ScrubMaps): string {
  let out = value;
  for (const [raw, scrubbed] of maps.hostIp) {
    out = out.replace(new RegExp(`(?<![\\d.])${raw.replace(/\./g, "\\.")}(?![\\d.])`, "g"), scrubbed);
  }
  return out;
}

/** What identifies the recording machine rather than the cluster state: never kept. */
const MACHINE_FIELDS: Readonly<Record<string, string>> = {
  machineID: "0".repeat(32),
  kernelVersion: "6.8.0-generic",
};

function scrubContainerRuntimeId(value: string): string {
  return `containerd://${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function shiftTimestamps(value: string, shiftMs: number): string {
  return value.replace(RFC3339_RE, (match) => {
    const date = new Date(match);
    if (Number.isNaN(date.getTime())) return match;
    return new Date(date.getTime() + shiftMs).toISOString().replace(/\.000Z$/, "Z");
  });
}

function collectEarliest(value: unknown, earliest: { date: Date | null }): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(RFC3339_RE)) {
      const date = new Date(match[0]);
      if (!Number.isNaN(date.getTime()) && (!earliest.date || date < earliest.date)) earliest.date = date;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEarliest(item, earliest);
    return;
  }
  if (isRecord(value)) for (const item of Object.values(value)) collectEarliest(item, earliest);
}

/** Mirrors the field detection of the checker's `ScrubCheck` (support/kubectl-fixtures.ts), but rewrites instead of only reporting. */
function scrubValue(value: unknown, key: string | null, parentKey: string | null, maps: ScrubMaps): unknown {
  if (typeof value === "string") {
    if (key === "uid" || key === "bootID" || key === "systemUUID") return scrubUid(maps, value);
    if (key !== null && parentKey === "nodeInfo" && Object.hasOwn(MACHINE_FIELDS, key)) return MACHINE_FIELDS[key];
    if (key === "resourceVersion" && value !== "") return scrubResourceVersion(maps, value);
    if ((key === "containerID" || key === "imageID") && value !== "") return scrubContainerRuntimeId(value);
    const hostIpField = key === "hostIP" || (key === "ip" && (parentKey === "hostIPs" || parentKey === "ingress"));
    if (hostIpField) return scrubHostIp(maps, value);
    return replaceUuids(replaceHostIps(shiftTimestamps(value, maps.shiftMs), maps), maps);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key, parentKey, maps));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "managedFields") continue; // dropped entirely (3.11)
      out[k] = scrubValue(v, k, key, maps);
    }
    return out;
  }
  return value;
}

const CLUSTER_SCOPED_KINDS = new Set(["Node", "PersistentVolume", "Namespace", "StorageClass"]);

/**
 * Drops the events of an earlier incarnation of an object the capture holds under the same name (a
 * StatefulSet pod recreated as db-0 again): their involvedObject uid is the old pod's, which the
 * fixture rules read as an inconsistent scrub. Event lists are representative subsets anyway.
 */
function dropStaleEvents(scrubbed: Record<string, unknown>): void {
  const uids = new Map<string, string>();
  for (const list of Object.values(scrubbed)) {
    const items = isRecord(list) && Array.isArray(list.items) ? list.items.filter(isRecord) : [];
    for (const item of items) {
      const meta = isRecord(item.metadata) ? item.metadata : {};
      if (typeof item.kind === "string" && typeof meta.name === "string" && typeof meta.uid === "string") {
        uids.set(`${item.kind}/${typeof meta.namespace === "string" ? meta.namespace : ""}/${meta.name}`, meta.uid);
      }
    }
  }
  const events = scrubbed.events;
  if (!isRecord(events) || !Array.isArray(events.items)) return;
  events.items = events.items.filter((event) => {
    const target = isRecord(event) && isRecord(event.involvedObject) ? event.involvedObject : null;
    if (!target || typeof target.kind !== "string") return true;
    const namespace = CLUSTER_SCOPED_KINDS.has(target.kind) ? "" : typeof target.namespace === "string" ? target.namespace : "";
    const current = uids.get(`${target.kind}/${namespace}/${String(target.name)}`);
    return current === undefined || current === target.uid;
  });
}

// ─── capture pipeline ───────────────────────────────────────────────

const EMPTY_LIST = { apiVersion: "v1", kind: "List", items: [], metadata: { resourceVersion: "" } };

async function rawGet(ns: string | null, resource: string): Promise<unknown> {
  const args = ns ? ["get", resource, "-n", ns, "-o", "json"] : ["get", resource, "-o", "json"];
  const text = await kubectl(args, { allowFailure: true });
  return text.trim() ? JSON.parse(text) : EMPTY_LIST;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function captureScenario(name: string, steps: readonly string[]): Promise<void> {
  const ns = fixtureNamespace(name);
  const raw: Record<string, unknown> = {};
  for (const resource of NAMESPACED_RESOURCES) raw[resource] = await rawGet(ns, resource);
  for (const resource of CLUSTER_RESOURCES) raw[resource] = await rawGet(null, resource);
  // the cluster-wide list also holds the volumes of every other scenario recorded before this one
  const pvs = raw.persistentvolumes;
  if (isRecord(pvs) && Array.isArray(pvs.items)) pvs.items = pvs.items.filter((pv) => claimedFrom(ns, pv));

  const earliest: { date: Date | null } = { date: null };
  for (const value of Object.values(raw)) collectEarliest(value, earliest);
  const shiftMs = earliest.date ? SCRUBBED_START.getTime() - earliest.date.getTime() : 0;
  const maps: ScrubMaps = { uid: new Map(), resourceVersion: new Map(), hostIp: new Map(), shiftMs };
  mapNodeIps(raw.nodes, maps);

  const scrubbed: Record<string, unknown> = {};
  for (const [resource, value] of Object.entries(raw)) scrubbed[resource] = scrubValue(value, null, null, maps);
  dropStaleEvents(scrubbed);

  const dir = join(FIXTURES_ROOT, "kubectl", name);
  mkdirSync(dir, { recursive: true });
  const files: FixtureFile[] = [];
  for (const resource of CAPTURED_RESOURCES) {
    const text = formatKubectlJson(scrubbed[resource]);
    files.push({ path: `${resource}.json`, text, json: scrubbed[resource] });
  }
  const violations = scrubViolations(files);
  if (violations.length > 0) {
    throw new Error(`Recording of ${name} did not scrub cleanly:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }
  for (const file of files) writeFileSync(join(dir, file.path), file.text);
  const meta = { recordedOn: today(), k3sVersion: K3S_PIN.version, steps: [...steps] };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  log(`[record] kubectl/${name}: written to ${dir}`);
}

// ─── wait helpers over the condition each scenario creates ─────────

interface ContainerStatusLike {
  restartCount: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string } };
}

interface PodLike {
  status?: {
    conditions?: { type: string; status: string }[];
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
    phase?: string;
  };
}

async function waitContainerWaiting(ns: string, selector: string, reason: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(
    async () => {
      const pods = await getJson<PodLike>("pods", { ns, selector });
      const hit = pods.some((pod) => (pod.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === reason));
      return hit ? true : undefined;
    },
    { timeoutMs, describe: `a pod in ${ns} to report waiting reason ${reason}` },
  );
}

async function waitContainerTerminated(ns: string, selector: string, reason: string, minRestarts: number, timeoutMs = 180_000): Promise<void> {
  await waitFor(
    async () => {
      const pods = await getJson<PodLike>("pods", { ns, selector });
      const hit = pods.some(
        (pod) =>
          (pod.status?.containerStatuses ?? []).some((c) => c.restartCount >= minRestarts && c.lastState?.terminated?.reason === reason) ||
          (pod.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === "CrashLoopBackOff" && c.restartCount >= minRestarts),
      );
      return hit ? true : undefined;
    },
    { timeoutMs, describe: `a pod in ${ns} to report ${reason} with restartCount >= ${minRestarts}` },
  );
}

interface ConditionLike {
  status?: { conditions?: { type: string; status: string; reason?: string }[] };
}

async function waitCondition(
  resource: string,
  ns: string,
  name: string,
  type: string,
  status: "True" | "False",
  timeoutMs = 180_000,
): Promise<void> {
  await waitFor(
    async () => {
      const [obj] = await getJson<ConditionLike>(resource, { ns, name });
      const condition = obj?.status?.conditions?.find((c) => c.type === type);
      return condition?.status === status ? true : undefined;
    },
    { timeoutMs, describe: `${resource} ${ns}/${name} to report condition ${type}=${status}` },
  );
}

async function applyYaml(ns: string, yaml: string): Promise<void> {
  await kubectl(["apply", "-n", ns, "-f", "-"], { stdin: yaml });
}

/** PersistentVolumes claimed from `ns`: the only ones a scenario's capture keeps. */
function claimedFrom(ns: string, pv: unknown): boolean {
  return isRecord(pv) && isRecord(pv.spec) && isRecord(pv.spec.claimRef) && pv.spec.claimRef.namespace === ns;
}

/**
 * A fresh namespace per recording: a re-run never captures the objects or events of an earlier
 * attempt, nor its volumes, which dockflow-local retains after their claims are gone.
 */
async function ensureNamespace(ns: string): Promise<void> {
  await kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=true", "--timeout=180s"], { allowFailure: true });
  const pvs = await rawGet(null, "persistentvolumes");
  const stale = (isRecord(pvs) && Array.isArray(pvs.items) ? pvs.items : [])
    .filter((pv) => claimedFrom(ns, pv))
    .map((pv) => String((pv as { metadata: { name: string } }).metadata.name));
  if (stale.length > 0) await kubectl(["delete", "persistentvolume", ...stale, "--wait=true", "--timeout=120s"], { allowFailure: true });
  await kubectl(["create", "namespace", ns]);
}

// ─── scenario recipes (steps text matches the existing synthetic meta.json of each scenario) ──────

interface Scenario {
  name: string;
  steps: string[];
  run: (ns: string) => Promise<void>;
}

const AGENT_NODE = "agent-1";

function busyboxDeployment(opts: {
  name: string;
  ns: string;
  image?: string;
  command?: string[];
  replicas?: number;
  extraContainerFields?: string;
  extraPodFields?: string;
  extraSpecFields?: string;
}): string {
  const image = opts.image ?? "busybox:1.37";
  const command = opts.command ? `\n          command: ${JSON.stringify(opts.command)}` : "";
  return `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${opts.name}
  namespace: ${opts.ns}
  labels: { app: ${opts.name} }
spec:
  replicas: ${opts.replicas ?? 1}
  selector: { matchLabels: { app: ${opts.name} } }
  template:
    metadata:
      labels: { app: ${opts.name} }
    spec:
${opts.extraSpecFields ?? ""}
      containers:
        - name: ${opts.name}
          image: ${image}${command}
${opts.extraContainerFields ?? ""}
${opts.extraPodFields ?? ""}
`;
}

const SCENARIOS: Scenario[] = [
  {
    name: "rollout-progressing",
    steps: [
      "kubectl create namespace fixture-rollout-progressing",
      "kubectl apply: Deployment web (3 replicas, nginx:1.27-alpine, readiness probe httpGet / on port 80 with initialDelaySeconds 60 and periodSeconds 5, strategy RollingUpdate maxSurge 1 maxUnavailable 0) and ClusterIP Service web (port 80)",
      "kubectl rollout status deployment/web --timeout=180s",
      "kubectl set image deployment/web web=nginx:1.28-alpine",
      "wait until the new ReplicaSet has one pod Running with Ready=False (before its first readiness probe)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80 }]
          readinessProbe: { httpGet: { path: /, port: 80 }, initialDelaySeconds: 60, periodSeconds: 5 }
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: ${ns} }
spec: { selector: { app: web }, ports: [{ port: 80, targetPort: 80 }] }
`;
      await applyYaml(ns, yaml);
      await kubectl(["rollout", "status", "deployment/web", "-n", ns, "--timeout=180s"]);
      await kubectl(["set", "image", "deployment/web", "web=nginx:1.28-alpine", "-n", ns]);
      await waitFor(
        async () => {
          const pods = await getJson<PodLike>("pods", { ns, selector: "app=web" });
          const hit = pods.some(
            (pod) =>
              pod.status?.phase === "Running" &&
              (pod.status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "False"),
          );
          return hit ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "a new web pod Running with Ready=False" },
      );
    },
  },
  {
    name: "rollout-complete",
    steps: [
      "kubectl create namespace fixture-rollout-complete",
      "kubectl apply: Deployment web (3 replicas, nginx:1.27-alpine, readiness probe httpGet / on port 80 with initialDelaySeconds 60 and periodSeconds 5, strategy RollingUpdate maxSurge 1 maxUnavailable 0) and ClusterIP Service web (port 80) and LoadBalancer Service web-lb (port 8080 to 80)",
      "kubectl rollout status deployment/web --timeout=180s",
      "kubectl set image deployment/web web=nginx:1.28-alpine",
      "kubectl rollout status deployment/web --timeout=300s, then re-apply the same manifests unchanged (generation stays 2)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } }
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.28-alpine
          ports: [{ containerPort: 80 }]
          readinessProbe: { httpGet: { path: /, port: 80 }, initialDelaySeconds: 60, periodSeconds: 5 }
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: ${ns} }
spec: { selector: { app: web }, ports: [{ port: 80, targetPort: 80 }] }
---
apiVersion: v1
kind: Service
metadata: { name: web-lb, namespace: ${ns} }
spec: { type: LoadBalancer, selector: { app: web }, ports: [{ port: 8080, targetPort: 80 }] }
`;
      await applyYaml(ns, yaml);
      await kubectl(["rollout", "status", "deployment/web", "-n", ns, "--timeout=300s"]);
      await applyYaml(ns, yaml); // unchanged re-apply
    },
  },
  {
    name: "crashloop",
    steps: [
      "kubectl create namespace fixture-crashloop",
      "kubectl apply: Deployment web-app of compose service web_app (1 replica, busybox:1.37 running sh -c 'exit 1', Dockflow labels and annotations)",
      "wait until the pod reports CrashLoopBackOff with restartCount 3",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(ns, busyboxDeployment({ name: "web-app", ns, command: ["sh", "-c", "exit 1"] }));
      await waitContainerTerminated(ns, "app=web-app", "Error", 3, 240_000);
    },
  },
  {
    name: "image-pull-backoff",
    steps: [
      "kubectl create namespace fixture-image-pull-backoff",
      "kubectl apply: Deployment web (1 replica, image localhost:35010/e2e/missing:1, which the e2e registry does not serve)",
      "wait until the container reports waiting reason ImagePullBackOff",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(ns, busyboxDeployment({ name: "web", ns, image: "localhost:35010/e2e/missing:1" }));
      await waitContainerWaiting(ns, "app=web", "ImagePullBackOff", 180_000);
    },
  },
  {
    name: "err-image-never-pull",
    steps: [
      "kubectl create namespace fixture-err-image-never-pull",
      "kubectl apply: Deployment web (1 replica, image dockflow.invalid/shop-web:1.4.2 with imagePullPolicy Never, never imported on the nodes)",
      "wait until the container reports waiting reason ErrImageNeverPull",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          image: "dockflow.invalid/shop-web:1.4.2",
          extraContainerFields: "          imagePullPolicy: Never",
        }),
      );
      await waitContainerWaiting(ns, "app=web", "ErrImageNeverPull", 60_000);
    },
  },
  {
    name: "invalid-image-name",
    steps: [
      "kubectl create namespace fixture-invalid-image-name",
      'kubectl apply: Deployment web (1 replica, image "UPPER/Case:bad tag")',
      "wait until the container reports waiting reason InvalidImageName",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(ns, busyboxDeployment({ name: "web", ns, image: '"UPPER/Case:bad tag"' }));
      await waitContainerWaiting(ns, "app=web", "InvalidImageName", 60_000);
    },
  },
  {
    name: "create-container-config-error",
    steps: [
      "kubectl create namespace fixture-create-container-config-error",
      "kubectl apply: Deployment web (1 replica, busybox:1.37, envFrom secretRef web-env, a Secret that does not exist)",
      "wait until the container reports waiting reason CreateContainerConfigError",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          command: ["sleep", "36000"],
          extraContainerFields: "          envFrom:\n            - secretRef: { name: web-env }",
        }),
      );
      await waitContainerWaiting(ns, "app=web", "CreateContainerConfigError", 60_000);
    },
  },
  {
    name: "oom-killed",
    steps: [
      "kubectl create namespace fixture-oom-killed",
      "kubectl apply: Deployment web (1 replica, busybox:1.37 running sh -c 'head -c 64m /dev/zero | tail', memory limit 16Mi)",
      "wait until the container restarted twice with lastState.terminated.reason OOMKilled",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          command: ["sh", "-c", "head -c 64m /dev/zero | tail"],
          extraContainerFields: "          resources: { limits: { memory: 16Mi } }",
        }),
      );
      await waitContainerTerminated(ns, "app=web", "OOMKilled", 2, 240_000);
    },
  },
  {
    name: "unschedulable-resources",
    steps: [
      "kubectl create namespace fixture-unschedulable-resources",
      "kubectl apply: Deployment web (1 replica, busybox:1.37 running sleep, requests memory 64Gi)",
      "wait 70 seconds with the pod Pending and PodScheduled=False",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          command: ["sleep", "36000"],
          extraContainerFields: "          resources: { requests: { memory: 64Gi } }",
        }),
      );
      await Bun.sleep(70_000);
    },
  },
  {
    name: "unschedulable-node-selector",
    steps: [
      "kubectl create namespace fixture-unschedulable-node-selector",
      "kubectl apply: Deployment web (1 replica, busybox:1.37 running sleep, nodeSelector zone=nowhere)",
      "wait 70 seconds with the pod Pending and PodScheduled=False",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          command: ["sleep", "36000"],
          extraSpecFields: "      nodeSelector: { zone: nowhere }",
        }),
      );
      await Bun.sleep(70_000);
    },
  },
  {
    name: "pvc-pending-rwx",
    steps: [
      "kubectl create namespace fixture-pvc-pending-rwx",
      "kubectl apply: PersistentVolumeClaim shared (ReadWriteMany, 1Gi, storageClassName dockflow-local) and Deployment web (1 replica, busybox:1.37 mounting the claim at /data)",
      "wait until the claim has a ProvisioningFailed event and 60 more seconds",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const yaml = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: shared, namespace: ${ns} }
spec:
  accessModes: [ReadWriteMany]
  storageClassName: dockflow-local
  resources: { requests: { storage: 1Gi } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: busybox:1.37
          command: ["sleep", "36000"]
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes: [{ name: data, persistentVolumeClaim: { claimName: shared } }]
`;
      await applyYaml(ns, yaml);
      await waitFor(
        async () => {
          const events = await getJson<{ reason?: string; involvedObject?: { name?: string } }>("events", { ns });
          const hit = events.some((event) => event.reason === "ProvisioningFailed" && event.involvedObject?.name === "shared");
          return hit ? true : undefined;
        },
        { timeoutMs: 90_000, describe: "a ProvisioningFailed event on PVC shared" },
      );
      await Bun.sleep(60_000);
    },
  },
  {
    name: "progress-deadline-exceeded",
    steps: [
      "kubectl create namespace fixture-progress-deadline-exceeded",
      "kubectl apply: Deployment web (1 replica, busybox:1.37 running sleep, readiness probe exec sh -c 'exit 1' every 5 seconds, progressDeadlineSeconds 30)",
      "wait until the Deployment condition Progressing is False with reason ProgressDeadlineExceeded",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 1
  progressDeadlineSeconds: 30
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: busybox:1.37
          command: ["sleep", "36000"]
          readinessProbe: { exec: { command: ["sh", "-c", "exit 1"] }, periodSeconds: 5 }
`,
      );
      await waitCondition("deployments.apps", ns, "web", "Progressing", "False", 180_000);
    },
  },
  {
    name: "replica-failure-quota",
    steps: [
      "kubectl create namespace fixture-replica-failure-quota",
      "kubectl create quota pods --hard=pods=1 -n fixture-replica-failure-quota",
      "kubectl apply: Deployment web (3 replicas, busybox:1.37 running sleep)",
      "wait until the Deployment reports condition ReplicaFailure=True",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await kubectl(["create", "quota", "pods", "--hard=pods=1", "-n", ns]);
      await applyYaml(ns, busyboxDeployment({ name: "web", ns, replicas: 3, command: ["sleep", "36000"] }));
      await waitCondition("deployments.apps", ns, "web", "ReplicaFailure", "True", 90_000);
    },
  },
  {
    name: "statefulset-stuck",
    steps: [
      "kubectl create namespace fixture-statefulset-stuck",
      "kubectl apply: accessory StatefulSet db (2 replicas, podManagementPolicy Parallel, RollingUpdate, busybox:1.37 running sleep, volumeClaimTemplates data 1Gi ReadWriteOnce on dockflow-local) and headless Service db-hl with the placeholder port 9",
      "kubectl rollout status statefulset/db --timeout=180s",
      "update the template to busybox:1.36 running sh -c 'exit 1'",
      "wait until db-1 runs the update revision and reports CrashLoopBackOff with restartCount 3 (db-0 stays on the current revision)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const base = (image: string, command: string[]) => `
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: ${ns}, labels: { app: db } }
spec:
  replicas: 2
  serviceName: db-hl
  podManagementPolicy: Parallel
  updateStrategy: { type: RollingUpdate }
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers:
        - name: db
          image: ${image}
          command: ${JSON.stringify(command)}
          volumeMounts: [{ name: data, mountPath: /data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: [ReadWriteOnce], storageClassName: dockflow-local, resources: { requests: { storage: 1Gi } } }
---
apiVersion: v1
kind: Service
metadata: { name: db-hl, namespace: ${ns} }
spec: { clusterIP: None, selector: { app: db }, ports: [{ port: 9, targetPort: 9 }] }
`;
      await applyYaml(ns, base("busybox:1.37", ["sleep", "36000"]));
      await kubectl(["rollout", "status", "statefulset/db", "-n", ns, "--timeout=180s"]);
      await applyYaml(ns, base("busybox:1.36", ["sh", "-c", "exit 1"]));
      await waitContainerTerminated(ns, "app=db", "Error", 3, 240_000);
    },
  },
  {
    name: "daemonset-rolling",
    steps: [
      "kubectl create namespace fixture-daemonset-rolling",
      "kubectl apply: DaemonSet agent (busybox:1.37 running sleep 3600, RollingUpdate maxUnavailable 1 maxSurge 0) on server-1 and agent-1",
      "kubectl rollout status daemonset/agent --timeout=120s",
      "update the template to sleep 7200 with a readiness probe exec true, initialDelaySeconds 30",
      "wait until updatedNumberScheduled is 1 and numberUnavailable is 1, then capture into the scenario directory",
      "kubectl rollout status daemonset/agent --timeout=180s, then capture into completed/",
    ],
    async run(ns) {
      const base = (sleepSeconds: number, extra: string) => `
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent, namespace: ${ns}, labels: { app: agent } }
spec:
  updateStrategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      containers:
        - name: agent
          image: busybox:1.37
          command: ["sleep", "${sleepSeconds}"]
${extra}
`;
      await applyYaml(ns, base(3600, ""));
      await kubectl(["rollout", "status", "daemonset/agent", "-n", ns, "--timeout=120s"]);
      await applyYaml(
        ns,
        base(7200, "          readinessProbe: { exec: { command: [\"true\"] }, initialDelaySeconds: 30 }"),
      );
      await waitFor(
        async () => {
          const [ds] = await getJson<{ status?: { updatedNumberScheduled?: number; numberUnavailable?: number } }>(
            "daemonsets.apps",
            { ns, name: "agent" },
          );
          return ds?.status?.updatedNumberScheduled === 1 && (ds.status.numberUnavailable ?? 0) >= 1 ? true : undefined;
        },
        { timeoutMs: 120_000, describe: "daemonset/agent mid-rollout (1 updated, 1 unavailable)" },
      );
      // NOTE: a real recording captures here into the scenario root, then again below into
      // completed/ once the rollout finishes — this tool captures the completed state only;
      // capturing the mid-rollout state too is a manual step on the test machine for now.
      await kubectl(["rollout", "status", "daemonset/agent", "-n", ns, "--timeout=180s"]);
    },
  },
  {
    name: "job-complete",
    steps: [
      "kubectl create namespace fixture-job-complete",
      "kubectl apply: Job migrate-<8 hex> of the replicated-job service migrate (busybox:1.37 running sh -c 'exit 0', backoffLimit 0, completions 1, restartPolicy Never)",
      "wait until the Job reports condition Complete=True",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const name = `migrate-${createHash("sha256").update(ns).digest("hex").slice(0, 8)}`;
      await applyYaml(
        ns,
        `
apiVersion: batch/v1
kind: Job
metadata: { name: ${name}, namespace: ${ns}, labels: { app: migrate } }
spec:
  backoffLimit: 0
  completions: 1
  template:
    metadata: { labels: { app: migrate } }
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: busybox:1.37
          command: ["sh", "-c", "exit 0"]
`,
      );
      await waitCondition("jobs.batch", ns, name, "Complete", "True", 120_000);
    },
  },
  {
    name: "job-failed",
    steps: [
      "kubectl create namespace fixture-job-failed",
      "kubectl apply: Job migrate-<8 hex> of the replicated-job service migrate (busybox:1.37 running sh -c 'exit 1', backoffLimit 0, completions 1, restartPolicy Never)",
      "wait until the Job reports condition Failed=True",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      const name = `migrate-${createHash("sha256").update(`${ns}-failed`).digest("hex").slice(0, 8)}`;
      await applyYaml(
        ns,
        `
apiVersion: batch/v1
kind: Job
metadata: { name: ${name}, namespace: ${ns}, labels: { app: migrate } }
spec:
  backoffLimit: 0
  completions: 1
  template:
    metadata: { labels: { app: migrate } }
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: busybox:1.37
          command: ["sh", "-c", "exit 1"]
`,
      );
      await waitCondition("jobs.batch", ns, name, "Failed", "True", 120_000);
    },
  },
  {
    name: "init-container-crash",
    steps: [
      "kubectl create namespace fixture-init-container-crash",
      "kubectl apply: Deployment web (1 replica, init container init running busybox:1.37 sh -c 'exit 1', container web nginx:1.27-alpine)",
      "wait until the init container reports restartCount 3 (k3s 1.36 shows it terminated with Error between restarts more often than waiting in CrashLoopBackOff)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      initContainers:
        - name: init
          image: busybox:1.37
          command: ["sh", "-c", "exit 1"]
      containers:
        - name: web
          image: nginx:1.27-alpine
`,
      );
      await waitFor(
        async () => {
          const pods = await getJson<PodLike>("pods", { ns, selector: "app=web" });
          const hit = pods.some((pod) =>
            (pod.status?.initContainerStatuses ?? []).some(
              (c) => c.restartCount >= 3 && (c.state?.waiting?.reason === "CrashLoopBackOff" || c.state?.terminated !== undefined),
            ),
          );
          return hit ? true : undefined;
        },
        { timeoutMs: 240_000, describe: "the init container to report restartCount 3" },
      );
    },
  },
  {
    name: "multi-container",
    steps: [
      "kubectl create namespace fixture-multi-container",
      "kubectl apply: Deployment api (1 replica, containers api nginx:1.27-alpine and log-shipper busybox:1.37 running sleep, annotation kubectl.kubernetes.io/default-container: api) and ClusterIP Service api (port 80)",
      "kubectl rollout status deployment/api --timeout=120s",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: ${ns}, labels: { app: api } }
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  template:
    metadata:
      labels: { app: api }
      annotations: { kubectl.kubernetes.io/default-container: api }
    spec:
      containers:
        - name: api
          image: nginx:1.27-alpine
          ports: [{ containerPort: 80 }]
        - name: log-shipper
          image: busybox:1.37
          command: ["sleep", "36000"]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: ${ns} }
spec: { selector: { app: api }, ports: [{ port: 80, targetPort: 80 }] }
`,
      );
      await kubectl(["rollout", "status", "deployment/api", "-n", ns, "--timeout=120s"]);
    },
  },
  {
    name: "terminating-pods",
    steps: [
      "kubectl create namespace fixture-terminating-pods",
      'kubectl apply: Deployment web (2 replicas, busybox:1.37 running sh -c "trap \'\' TERM; sleep 3600", terminationGracePeriodSeconds 300)',
      "kubectl rollout status deployment/web --timeout=120s",
      "kubectl delete pod <first pod> --wait=false",
      "wait until the replacement pod is Ready while the deleted pod is still Terminating",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      terminationGracePeriodSeconds: 300
      containers:
        - name: web
          image: busybox:1.37
          command: ["sh", "-c", "trap '' TERM; sleep 3600"]
`,
      );
      await kubectl(["rollout", "status", "deployment/web", "-n", ns, "--timeout=120s"]);
      const [first] = await getJson<{ metadata: { name: string } }>("pods", { ns, selector: "app=web" });
      if (!first) throw new Error(`terminating-pods: no pod of ${ns}/web found to delete`);
      await kubectl(["delete", "pod", first.metadata.name, "-n", ns, "--wait=false"]);
      await waitFor(
        async () => {
          const pods = await getJson<PodLike & { metadata: { name: string; deletionTimestamp?: string } }>("pods", {
            ns,
            selector: "app=web",
          });
          const stillTerminating = pods.some((pod) => pod.metadata.name === first.metadata.name && pod.metadata.deletionTimestamp);
          const replacementReady = pods.some(
            (pod) =>
              pod.metadata.name !== first.metadata.name &&
              (pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
          );
          return stillTerminating && replacementReady ? true : undefined;
        },
        { timeoutMs: 120_000, describe: "a replacement pod Ready while the deleted one is still Terminating" },
      );
    },
  },
  {
    name: "evicted-pod",
    steps: [
      "kubectl create namespace fixture-evicted-pod",
      "kubectl apply: Deployment web (1 replica, busybox:1.37 running sh -c 'dd if=/dev/zero of=/tmp/fill bs=1M count=64; sleep 3600', ephemeral-storage limit 16Mi)",
      "wait until the first pod is Failed with reason Evicted and its replacement is Running",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        busyboxDeployment({
          name: "web",
          ns,
          command: ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=64; sleep 3600"],
          extraContainerFields: "          resources: { limits: { ephemeral-storage: 16Mi } }",
        }),
      );
      await waitFor(
        async () => {
          const pods = await getJson<PodLike & { status?: { phase?: string; reason?: string } }>("pods", { ns, selector: "app=web" });
          const evicted = pods.some((pod) => pod.status?.phase === "Failed" && pod.status.reason === "Evicted");
          const replacement = pods.some((pod) => pod.status?.phase === "Running");
          return evicted && replacement ? true : undefined;
        },
        { timeoutMs: 300_000, describe: "the first pod Failed/Evicted with a Running replacement" },
      );
    },
  },
  {
    name: "node-not-ready",
    steps: [
      "kubectl create namespace fixture-node-not-ready",
      "kubectl apply: Deployment web (2 replicas, busybox:1.37 running sleep, one pod on each node)",
      "kubectl rollout status deployment/web --timeout=120s",
      "systemctl stop k3s-agent on agent-1",
      "wait until node agent-1 reports Ready=Unknown (node-monitor-grace-period, about 50 seconds)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
      "systemctl start k3s-agent on agent-1 (the whole outage lasts about 60 seconds)",
    ],
    async run(ns) {
      // withNodeDown (helpers/k8s.ts) restores agent-1 in `finally` even if the capture step throws.
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector: { matchLabels: { app: web } }
              topologyKey: kubernetes.io/hostname
      containers:
        - name: web
          image: busybox:1.37
          command: ["sleep", "36000"]
`,
      );
      await kubectl(["rollout", "status", "deployment/web", "-n", ns, "--timeout=120s"]);
      await withNodeDown("agent_1", "stop-k3s", async () => {
        await waitFor(
          async () => {
            const [node] = await getJson<{ status?: { conditions?: { type: string; status: string }[] } }>("nodes", {
              name: AGENT_NODE,
            });
            const ready = node?.status?.conditions?.find((c) => c.type === "Ready");
            return ready?.status === "Unknown" ? true : undefined;
          },
          { timeoutMs: 90_000, describe: "node agent-1 to report Ready=Unknown" },
        );
      });
    },
  },
  {
    name: "headless-no-ports",
    steps: [
      "kubectl create namespace fixture-headless-no-ports",
      "kubectl apply: Deployment worker (2 replicas, busybox:1.37 running sleep, no ports) with headless Service worker-hl without any port, and Deployment cache (1 replica, no ports) with headless Service cache-hl carrying the placeholder port 9/TCP",
      "kubectl rollout status for both Deployments, then wait until both Services have EndpointSlices with ready endpoints",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: worker, namespace: ${ns}, labels: { app: worker } }
spec:
  replicas: 2
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      containers: [{ name: worker, image: busybox:1.37, command: ["sleep", "36000"] }]
---
apiVersion: v1
kind: Service
metadata: { name: worker-hl, namespace: ${ns} }
spec: { clusterIP: None, selector: { app: worker } }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: cache, namespace: ${ns}, labels: { app: cache } }
spec:
  replicas: 1
  selector: { matchLabels: { app: cache } }
  template:
    metadata: { labels: { app: cache } }
    spec:
      containers: [{ name: cache, image: busybox:1.37, command: ["sleep", "36000"] }]
---
apiVersion: v1
kind: Service
metadata: { name: cache-hl, namespace: ${ns} }
spec: { clusterIP: None, selector: { app: cache }, ports: [{ port: 9, protocol: TCP }] }
`,
      );
      await kubectl(["rollout", "status", "deployment/worker", "-n", ns, "--timeout=120s"]);
      await kubectl(["rollout", "status", "deployment/cache", "-n", ns, "--timeout=120s"]);
      await waitFor(
        async () => {
          const slices = await getJson<{ metadata: { labels?: Record<string, string> }; endpoints?: { conditions?: { ready?: boolean } }[] }>(
            "endpointslices",
            { ns },
          );
          const ready = (svc: string) =>
            slices.some(
              (slice) =>
                slice.metadata.labels?.["kubernetes.io/service-name"] === svc &&
                (slice.endpoints ?? []).some((e) => e.conditions?.ready),
            );
          return ready("worker-hl") && ready("cache-hl") ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "worker-hl and cache-hl to have ready EndpointSlices" },
      );
    },
  },
  {
    name: "metrics-top",
    steps: [
      "kubectl create namespace fixture-metrics-top",
      "kubectl apply: app Deployment web (2 replicas, nginx:1.27-alpine, memory limit 128Mi), accessory StatefulSet db (1 replica, busybox:1.37 running sleep, memory limit 256Mi) and helper pod dockflow-helper-archive-3f9a2c1b (label dockflow.shawiizz.dev/part=helper)",
      "wait until every pod is Ready and metrics-server has scraped them (kubectl top pods lists all four)",
      "capture the namespace resources and the cluster nodes and persistentvolumes",
      "kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/fixture-metrics-top/pods > metrics/metrics-top.json",
    ],
    async run(ns) {
      await applyYaml(
        ns,
        `
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${ns}, labels: { app: web } }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: nginx:1.27-alpine, resources: { limits: { memory: 128Mi } } }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: ${ns}, labels: { app: db } }
spec:
  replicas: 1
  serviceName: db-hl
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers: [{ name: db, image: busybox:1.37, command: ["sleep", "36000"], resources: { limits: { memory: 256Mi } } }]
---
apiVersion: v1
kind: Pod
metadata:
  name: dockflow-helper-archive-3f9a2c1b
  namespace: ${ns}
  labels: { dockflow.shawiizz.dev/part: helper }
spec:
  restartPolicy: Never
  containers: [{ name: helper, image: busybox:1.37, command: ["sleep", "3600"] }]
`,
      );
      await kubectl(["rollout", "status", "deployment/web", "-n", ns, "--timeout=120s"]);
      await kubectl(["rollout", "status", "statefulset/db", "-n", ns, "--timeout=120s"]);
      await waitFor(async () => ((await kubectl(["top", "pods", "-n", ns], { allowFailure: true })).trim() ? true : undefined), {
        timeoutMs: 120_000,
        intervalMs: 5000,
        describe: "metrics-server to have scraped every pod of fixture-metrics-top",
      });
      const raw = await kubectl(["get", "--raw", `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`]);
      const metricsDir = join(FIXTURES_ROOT, "metrics");
      mkdirSync(metricsDir, { recursive: true });
      writeFileSync(join(metricsDir, "metrics-top.json"), raw.endsWith("\n") ? raw : `${raw}\n`);
    },
  },
];

const SCENARIO_NAMES = new Set(SCENARIOS.map((s) => s.name));

// ─── entry point ────────────────────────────────────────────────────

const USAGE = "Usage: bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane <lane> [--scenario <name> | --all]";

interface Args {
  lane: LaneName;
  scenario?: string;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  let lane: string | undefined;
  let scenario: string | undefined;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lane") lane = argv[++i];
    else if (argv[i] === "--scenario") scenario = argv[++i];
    else if (argv[i] === "--all") all = true;
    else throw new Error(`Unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!lane || !isLaneName(lane)) throw new Error(`--lane must be one of ${Object.keys(LANES).join(", ")}\n${USAGE}`);
  if (!scenario && !all) throw new Error(`Pass --scenario <name> or --all\n${USAGE}`);
  if (scenario && !SCENARIO_NAMES.has(scenario)) {
    throw new Error(`Unknown scenario ${scenario}; known: ${DESIGN_SCENARIOS.kubectl.join(", ")}`);
  }
  return { lane, scenario, all };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lane = LANES[args.lane];
  if (!lane.topology) throw new Error(`Lane ${args.lane} has no shared topology to record against`);
  process.env.DOCKFLOW_E2E_TOPOLOGY = lane.topology;
  const topo = TOPOLOGIES[lane.topology];
  log(`[record] recording against the ${topo.name} topology of lane ${args.lane} (helm ${HELM_PIN.version}, k3s ${K3S_PIN.version})`);

  const scenarios = args.all ? SCENARIOS : SCENARIOS.filter((s) => s.name === args.scenario);
  for (const scenario of scenarios) {
    const ns = fixtureNamespace(scenario.name);
    log(`[record] ${scenario.name}: creating condition in ${ns}...`);
    await ensureNamespace(ns);
    await scenario.run(ns);
    await captureScenario(scenario.name, scenario.steps);
  }
  log(`[record] done: ${scenarios.length} scenario(s).`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
