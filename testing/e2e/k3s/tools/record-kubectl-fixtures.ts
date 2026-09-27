#!/usr/bin/env bun
/**
 * Recorder for the kubectl and metrics fixtures of design-07 3.11 (PD-12). Run by hand against a
 * running lane cluster, never inside a package:
 *
 *   bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane k3s-core (--scenario <name>[,<name>...] | --all)
 *
 * Each scenario renders its compose file with Dockflow's own normalizer and translator, into
 * namespace `fixture-<scenario>` of project `shop` release `1.4.2`, and applies the objects the
 * way a deploy does (server-side, field manager `dockflow`). A few scenarios then change what no
 * compose file can express (an init container, a quota); their steps say so. Once the condition
 * holds, the namespaced and cluster resources of 3.11 are read in one kubectl call per scope, once
 * per capture. All the captures of a scenario are scrubbed with one set of maps, checked with the
 * `scrubViolations` of `cli/src/__tests__/kubernetes/support/kubectl-fixtures.ts` (the rules
 * `fixtures-meta.test.ts` enforces), and only then written.
 */

import { createHash } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  CAPTURED_RESOURCES,
  type CapturedResource,
  CLUSTER_RESOURCES,
  DESIGN_SCENARIOS,
  FIXTURE_PROJECT,
  FIXTURE_RELEASE,
  FIXTURE_SERVERS,
  FIXTURES_ROOT,
  type FixtureFile,
  fixtureNamespace,
  formatCompactJson,
  formatKubectlJson,
  NAMESPACED_RESOURCES,
  RESOURCE_KINDS,
  scrubViolations,
} from "../../../../cli/src/__tests__/kubernetes/support/kubectl-fixtures";
import { loadFromString } from "../../../../cli/src/services/compose";
import { DiagnosticSink } from "../../../../cli/src/services/orchestrator/diagnostics";
import { createFileResolver } from "../../../../cli/src/services/orchestrator/file-resolver";
import type { StackRole } from "../../../../cli/src/services/orchestrator/interfaces";
import { buildHelperPod } from "../../../../cli/src/services/orchestrator/kubernetes/backends/backup";
import { K8S_PROGRESS_DEADLINE_S, LABELS } from "../../../../cli/src/services/orchestrator/kubernetes/constants";
import type { DistributionTraits } from "../../../../cli/src/services/orchestrator/kubernetes/distribution";
import { k3sDistribution } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/distribution";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { namespaceLabels } from "../../../../cli/src/services/orchestrator/kubernetes/labels";
import type { StackIdentity } from "../../../../cli/src/services/orchestrator/kubernetes/model/types";
import { normalizeStack } from "../../../../cli/src/services/orchestrator/kubernetes/normalize";
import { revisionHistoryLimitFor } from "../../../../cli/src/services/orchestrator/kubernetes/render";
import type { DaemonSet, Deployment, StatefulSet } from "../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { Job } from "../../../../cli/src/services/orchestrator/kubernetes/resources/batch";
import type { Container, PersistentVolumeClaim } from "../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import type { ManifestObject } from "../../../../cli/src/services/orchestrator/kubernetes/resources/registry";
import { translateStack } from "../../../../cli/src/services/orchestrator/kubernetes/translate";
import { HELM_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/versions";
import { getJson, kubectl, waitFor, withNodeDown } from "../../helpers/k8s";
import { TOPOLOGIES } from "../../helpers/topology";
import { isLaneName, LANES, type LaneName } from "../lanes";

// NOTE: the three helm scenarios (helm-list, helm-status-failed, helm-history-rollback) and the
// kubectl-stderr samples are not recorded yet; `cli/src/__tests__/kubernetes/fixtures/helm/**`
// keeps its synthetic content until this tool records them too.

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataOf(item: Json): Json {
  return isRecord(item.metadata) ? item.metadata : {};
}

function stringField(record: Json, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── rendering with Dockflow's own normalizer and translator ─────────

/** servers.yml keys of the recording lane; `node.hostname == agent_1` pins a pod to node agent-1 */
const SERVER_NAMES = Object.values(FIXTURE_SERVERS);

function identityOf(ns: string): StackIdentity {
  return { project: FIXTURE_PROJECT, env: "production", stackName: `${FIXTURE_PROJECT}-production`, namespace: ns, version: FIXTURE_RELEASE };
}

interface RenderOptions {
  role?: StackRole;
  traits?: Partial<DistributionTraits>;
}

/** The objects a deploy of `compose` applies for `role`, rendered into `ns`: render.ts without the artifact. */
function render(ns: string, compose: string, options: RenderOptions = {}): ManifestObject[] {
  const role = options.role ?? "app";
  const file = role === "app" ? "docker-compose.yml" : "accessories.yml";
  const traits: DistributionTraits = { ...structuredClone(k3sDistribution.traits), ...options.traits };
  const sink = new DiagnosticSink();
  const refuse = (): never => {
    const errors = sink.list().filter((d) => d.severity === "error");
    throw new Error(`The ${file} of ${ns} does not render:\n${errors.map((d) => `  - ${d.path}: ${d.message}`).join("\n")}`);
  };
  const { stack } = normalizeStack({
    compose: loadFromString(compose, file),
    role,
    identity: identityOf(ns),
    proxy: undefined,
    sibling: { services: [], volumes: [], middlewares: [] },
    serverNames: [...SERVER_NAMES],
    imageDelivery: "import",
    files: createFileResolver(new Map(), tmpdir()),
    traits,
    sink,
  });
  if (sink.hasErrors()) refuse();
  const { objects } = translateStack(stack, {
    pullSecretName: null,
    revisionHistoryLimit: revisionHistoryLimitFor(undefined),
    progressDeadlineS: K8S_PROGRESS_DEADLINE_S,
    traits,
    extraReservedHostPorts: [{ port: 22, protocol: "TCP", reason: "SSH" }],
    traefikOnCluster: false,
    serverNames: [...SERVER_NAMES],
    sink,
  });
  if (sink.hasErrors()) refuse();
  return objects;
}

type Workload = Deployment | StatefulSet | DaemonSet | Job;

function isWorkload(object: ManifestObject): object is Workload {
  return object.kind === "Deployment" || object.kind === "StatefulSet" || object.kind === "DaemonSet" || object.kind === "Job";
}

function workloadOf(objects: readonly ManifestObject[], name?: string): Workload {
  const found = objects.filter(isWorkload).find((object) => name === undefined || object.metadata.name === name);
  if (!found) throw new Error(`The render has no workload${name ? ` ${name}` : ""}`);
  return found;
}

function containerOf(workload: Workload): Container {
  const [container] = workload.spec.template.spec.containers;
  if (!container) throw new Error(`Workload ${workload.metadata.name} has no container`);
  return container;
}

function deploymentOf(objects: readonly ManifestObject[], name: string): Deployment {
  const workload = workloadOf(objects, name);
  if (workload.kind !== "Deployment") throw new Error(`Workload ${name} is a ${workload.kind}, not a Deployment`);
  return workload;
}

/** Applied as a deploy applies (runtime/kubectl.ts): server-side, field manager dockflow. */
async function apply(objects: readonly object[]): Promise<void> {
  const list = { apiVersion: "v1", kind: "List", items: objects };
  await kubectl(["apply", "--server-side", "--field-manager=dockflow", "--force-conflicts", "-f", "-"], { stdin: JSON.stringify(list) });
}

async function rolloutStatus(ns: string, target: string, timeoutS: number): Promise<void> {
  await kubectl(["rollout", "status", target, "-n", ns, `--timeout=${timeoutS}s`]);
}

// ─── capture ────────────────────────────────────────────────────────

interface RawCapture {
  /** '' for the scenario directory, else its subdirectory (`completed`) */
  name: string;
  lists: Record<CapturedResource, Json[]>;
}

const RESOURCE_OF_KIND = new Map<string, CapturedResource>(CAPTURED_RESOURCES.map((resource) => [RESOURCE_KINDS[resource].kind, resource]));

/** PersistentVolumes claimed from `ns`: the only ones a scenario keeps of the cluster-wide list. */
function claimedFrom(ns: string, pv: unknown): boolean {
  return isRecord(pv) && isRecord(pv.spec) && isRecord(pv.spec.claimRef) && pv.spec.claimRef.namespace === ns;
}

/** One `kubectl get <r1>,<r2>,... -o json`: every resource of a scope read at the same moment. */
async function readItems(ns: string | null, resources: readonly string[]): Promise<Json[]> {
  const args = ["get", resources.join(","), ...(ns ? ["-n", ns] : []), "-o", "json"];
  const parsed: unknown = JSON.parse(await kubectl(args));
  return isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items.filter(isRecord) : [];
}

async function readCapture(ns: string, name: string): Promise<RawCapture> {
  const items = [...(await readItems(ns, NAMESPACED_RESOURCES)), ...(await readItems(null, CLUSTER_RESOURCES))];
  const lists = Object.fromEntries(CAPTURED_RESOURCES.map((resource) => [resource, [] as Json[]])) as Record<CapturedResource, Json[]>;
  for (const item of items) {
    const resource = typeof item.kind === "string" ? RESOURCE_OF_KIND.get(item.kind) : undefined;
    if (!resource) throw new Error(`Unexpected ${String(item.kind)} in the capture of ${ns}`);
    // the cluster-wide list also holds the volumes of every other scenario
    if (resource === "persistentvolumes" && !claimedFrom(ns, item)) continue;
    lists[resource].push(item);
  }
  return { name, lists };
}

// ─── scrub (writes what support/kubectl-fixtures.ts's scrubViolations verifies) ────────────────

interface ScrubMaps {
  scenario: string;
  uid: Map<string, string>;
  resourceVersion: Map<string, string>;
  hostIp: Map<string, string>;
  /** generated object name -> its stable replacement */
  names: Map<string, string>;
  /** stable names handed out per generateName prefix */
  generated: Map<string, number>;
  /** a known prefix followed by the 5 random characters of a generated name, anywhere in a text */
  namePattern: RegExp | null;
  shiftMs: number;
}

const RFC3339_RE = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const SCRUBBED_START = new Date("2026-01-01T00:00:00Z");

function scrubUid(maps: ScrubMaps, value: string): string {
  const existing = maps.uid.get(value);
  if (existing) return existing;
  const assigned = `00000000-0000-4000-8000-${String(maps.uid.size + 1).padStart(12, "0")}`;
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
function mapNodeIps(nodes: readonly Json[], maps: ScrubMaps): void {
  const rank = (item: Json): string => {
    const name = stringField(metadataOf(item), "name");
    return `${name.startsWith("server") ? 0 : 1}${name}`;
  };
  for (const item of [...nodes].sort((a, b) => compareStrings(rank(a), rank(b)))) {
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

/** The alphabet of the random suffix the API server appends to a generateName (apimachinery utilrand). */
const GENERATED_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";
const GENERATED_SUFFIX = `[${GENERATED_ALPHABET}]{5}`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The same stable replacement for a generated name every time it appears, so a new recording of
 * an unchanged scenario names its pods as the previous one did: the n-th name handed out for a
 * prefix gets 5 characters derived from the scenario, the prefix and n.
 */
function stableName(maps: ScrubMaps, prefix: string, original: string): string {
  const existing = maps.names.get(original);
  if (existing) return existing;
  const taken = new Set(maps.names.values());
  for (let attempt = 0; ; attempt++) {
    const index = maps.generated.get(prefix) ?? 0;
    maps.generated.set(prefix, index + 1);
    const digest = createHash("sha256").update(`${maps.scenario}/${prefix}/${index}/${attempt}`).digest();
    const suffix = Array.from(digest.subarray(0, 5), (byte) => GENERATED_ALPHABET[byte % GENERATED_ALPHABET.length]).join("");
    const name = `${prefix}${suffix}`;
    if (taken.has(name)) continue;
    maps.names.set(original, name);
    return name;
  }
}

function replaceGeneratedNames(value: string, maps: ScrubMaps): string {
  if (!maps.namePattern) return value;
  return value.replace(maps.namePattern, (match: string, prefix: string) => stableName(maps, prefix, match));
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
    return replaceGeneratedNames(replaceUuids(replaceHostIps(shiftTimestamps(value, maps.shiftMs), maps), maps), maps);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key, parentKey, maps));
  if (isRecord(value)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "managedFields") continue; // dropped entirely (3.11)
      out[k] = scrubValue(v, k, key, maps);
    }
    return out;
  }
  return value;
}

/** Kinds whose objects prefix the generated names of others: pods of a ReplicaSet, Job or DaemonSet, slices of a Service. */
const PREFIXING_KINDS = new Set(["ReplicaSet", "Job", "DaemonSet", "Service"]);

/**
 * One set of maps for every capture of a scenario and its metrics read: the uids, the host
 * addresses, the time shift and the generated names are the same wherever an object reappears.
 * Uids are handed out in resource order and by stable name, so they do not depend on the random
 * names the cluster chose or on how many events it kept.
 */
function scrubMapsFor(scenario: string, captures: readonly RawCapture[], metrics: unknown): ScrubMaps {
  const earliest: { date: Date | null } = { date: null };
  for (const capture of captures) collectEarliest(capture.lists, earliest);
  collectEarliest(metrics, earliest);
  const maps: ScrubMaps = {
    scenario,
    uid: new Map(),
    resourceVersion: new Map(),
    hostIp: new Map(),
    names: new Map(),
    generated: new Map(),
    namePattern: null,
    shiftMs: earliest.date ? SCRUBBED_START.getTime() - earliest.date.getTime() : 0,
  };

  const prefixes = new Set<string>();
  for (const capture of captures) {
    const generatedItems: Json[] = [];
    for (const resource of CAPTURED_RESOURCES) {
      for (const item of capture.lists[resource]) {
        const meta = metadataOf(item);
        const name = stringField(meta, "name");
        const generateName = stringField(meta, "generateName");
        if (generateName !== "") {
          prefixes.add(generateName);
          if (new RegExp(`^${escapeRegExp(generateName)}${GENERATED_SUFFIX}$`).test(name)) generatedItems.push(item);
        }
        if (typeof item.kind === "string" && PREFIXING_KINDS.has(item.kind) && name !== "") prefixes.add(`${name}-`);
      }
    }
    // creation order, then node: the order a rerun of the scenario reproduces
    const orderKey = (item: Json): string => {
      const meta = metadataOf(item);
      const node = isRecord(item.spec) ? stringField(item.spec, "nodeName") : "";
      return `${stringField(meta, "creationTimestamp")}\u0000${node}\u0000${stringField(meta, "name")}`;
    };
    for (const item of generatedItems.sort((a, b) => compareStrings(orderKey(a), orderKey(b)))) {
      const meta = metadataOf(item);
      stableName(maps, stringField(meta, "generateName"), stringField(meta, "name"));
    }
  }
  if (prefixes.size > 0) {
    const alternatives = [...prefixes].sort((a, b) => b.length - a.length || compareStrings(a, b)).map(escapeRegExp);
    maps.namePattern = new RegExp(`(?<![A-Za-z0-9-])(${alternatives.join("|")})${GENERATED_SUFFIX}(?![A-Za-z0-9-])`, "g");
  }

  for (const capture of captures) {
    for (const resource of CAPTURED_RESOURCES) {
      if (resource === "events") continue;
      for (const item of sortedByStableName(capture.lists[resource], maps)) {
        const uid = stringField(metadataOf(item), "uid");
        if (uid !== "") scrubUid(maps, uid);
      }
    }
  }
  const [first] = captures;
  if (first) mapNodeIps(first.lists.nodes, maps);
  return maps;
}

function stableNameOf(item: Json, maps: ScrubMaps): string {
  const name = stringField(metadataOf(item), "name");
  return maps.names.get(name) ?? name;
}

function sortedByStableName(items: readonly Json[], maps: ScrubMaps): Json[] {
  return [...items].sort((a, b) => compareStrings(stableNameOf(a, maps), stableNameOf(b, maps)));
}

const CLUSTER_SCOPED_KINDS = new Set(["Node", "PersistentVolume", "Namespace", "StorageClass"]);

/**
 * Drops the events of an earlier incarnation of an object the capture holds under the same name (a
 * StatefulSet pod recreated as db-1 again): their involvedObject uid is the old pod's, which the
 * fixture rules read as an inconsistent scrub. Event lists are representative subsets anyway.
 */
function dropStaleEvents(lists: Record<CapturedResource, Json[]>): void {
  const uids = new Map<string, string>();
  for (const items of Object.values(lists)) {
    for (const item of items) {
      const meta = metadataOf(item);
      if (typeof item.kind === "string" && typeof meta.name === "string" && typeof meta.uid === "string") {
        uids.set(`${item.kind}/${stringField(meta, "namespace")}/${meta.name}`, meta.uid);
      }
    }
  }
  lists.events = lists.events.filter((event) => {
    const target = isRecord(event.involvedObject) ? event.involvedObject : null;
    if (!target || typeof target.kind !== "string") return true;
    const namespace = CLUSTER_SCOPED_KINDS.has(target.kind) ? "" : stringField(target, "namespace");
    const current = uids.get(`${target.kind}/${namespace}/${String(target.name)}`);
    return current === undefined || current === target.uid;
  });
}

function scrubCapture(capture: RawCapture, maps: ScrubMaps): Record<CapturedResource, Json[]> {
  const out = {} as Record<CapturedResource, Json[]>;
  for (const resource of CAPTURED_RESOURCES) {
    const scrubbed = sortedByStableName(capture.lists[resource], maps).map((item) => scrubValue(item, null, null, maps) as Json);
    // kubectl lists a namespace in name order; the stable names keep that order
    out[resource] = scrubbed.sort((a, b) => compareStrings(stringField(metadataOf(a), "name"), stringField(metadataOf(b), "name")));
  }
  dropStaleEvents(out);
  return out;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Scrubs every capture and the metrics read with one set of maps, checks the file set, then writes it. */
function writeRecording(scenario: Scenario, captures: readonly RawCapture[], metrics: unknown): void {
  const maps = scrubMapsFor(scenario.name, captures, metrics);
  const files: FixtureFile[] = [];
  for (const capture of captures) {
    const lists = scrubCapture(capture, maps);
    for (const resource of CAPTURED_RESOURCES) {
      const list = { apiVersion: "v1", items: lists[resource], kind: "List", metadata: { resourceVersion: "" } };
      files.push({ path: `${capture.name ? `${capture.name}/` : ""}${resource}.json`, text: formatKubectlJson(list), json: list });
    }
  }
  const metricsPath = `metrics/${scenario.name}.json`;
  if (metrics !== null) {
    const scrubbed = scrubValue(metrics, null, null, maps);
    files.push({ path: metricsPath, text: formatCompactJson(scrubbed), json: scrubbed });
  }
  const violations = scrubViolations(files);
  if (violations.length > 0) {
    throw new Error(`Recording of ${scenario.name} did not scrub cleanly:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  }

  const dir = join(FIXTURES_ROOT, "kubectl", scenario.name);
  rmSync(dir, { recursive: true, force: true });
  for (const file of files) {
    const path = file.path === metricsPath ? join(FIXTURES_ROOT, file.path) : join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  const meta = { recordedOn: today(), k3sVersion: K3S_PIN.version, steps: [...scenario.steps] };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const pods = captures.map((c) => c.lists.pods.length).join("+");
  log(`[record] kubectl/${scenario.name}: ${captures.length} capture(s), ${pods} pod(s), written to ${dir}`);
}

// ─── waits over the condition each scenario creates ────────────────

interface ContainerStatusLike {
  restartCount: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string } };
}

interface PodLike {
  metadata: { name: string; deletionTimestamp?: string };
  spec?: { nodeName?: string };
  status?: {
    conditions?: { type: string; status: string }[];
    containerStatuses?: ContainerStatusLike[];
    initContainerStatuses?: ContainerStatusLike[];
    phase?: string;
    reason?: string;
  };
}

function serviceSelector(service: string): string {
  return `${LABELS.service}=${service}`;
}

async function waitPods(ns: string, service: string, describe: string, test: (pods: PodLike[]) => boolean, timeoutMs = 180_000): Promise<void> {
  await waitFor(async () => (test(await getJson<PodLike>("pods", { ns, selector: serviceSelector(service) })) ? true : undefined), {
    timeoutMs,
    describe: `${describe} (${ns})`,
  });
}

function waitingReason(reason: string): (pods: PodLike[]) => boolean {
  return (pods) => pods.some((pod) => (pod.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === reason));
}

/**
 * A container restarted `restarts` times and back-off pending: kubelet 1.36 mostly keeps it
 * `terminated` between restarts, sometimes `waiting` in CrashLoopBackOff; either is recorded as seen.
 */
function crashLooping(restarts: number, init = false): (pods: PodLike[]) => boolean {
  return (pods) =>
    pods.some((pod) =>
      ((init ? pod.status?.initContainerStatuses : pod.status?.containerStatuses) ?? []).some(
        (c) => c.restartCount >= restarts && (c.state?.waiting?.reason === "CrashLoopBackOff" || c.state?.terminated !== undefined),
      ),
    );
}

function podReady(pod: PodLike): boolean {
  return (pod.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

interface ConditionLike {
  status?: { conditions?: { type: string; status: string }[] };
}

async function waitCondition(resource: string, ns: string, name: string, type: string, status: "True" | "False", timeoutMs = 180_000): Promise<void> {
  await waitFor(
    async () => {
      const [obj] = await getJson<ConditionLike>(resource, { ns, name });
      return obj?.status?.conditions?.find((c) => c.type === type)?.status === status ? true : undefined;
    },
    { timeoutMs, describe: `${resource} ${ns}/${name} to report condition ${type}=${status}` },
  );
}

/**
 * A fresh namespace per recording, labelled as Dockflow labels a stack namespace: a re-run never
 * captures the objects or events of an earlier attempt, nor its volumes, which dockflow-local
 * retains after their claims are gone.
 */
async function ensureNamespace(ns: string): Promise<void> {
  await kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=true", "--timeout=180s"], { allowFailure: true });
  const stale = (await getJson<Json>("persistentvolumes")).filter((pv) => claimedFrom(ns, pv)).map((pv) => stringField(metadataOf(pv), "name"));
  if (stale.length > 0) await kubectl(["delete", "persistentvolume", ...stale, "--wait=true", "--timeout=120s"], { allowFailure: true });
  await apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels: namespaceLabels(identityOf(ns)) } }]);
}

// ─── scenarios ──────────────────────────────────────────────────────

interface ScenarioContext {
  ns: string;
  /** reads the namespace and the cluster resources now, as capture `name` ('' = the scenario directory) */
  capture(name?: string): Promise<void>;
  /** `kubectl get --raw` of the metrics API for the namespace: `metrics/<scenario>.json` */
  captureMetrics(): Promise<void>;
}

interface Scenario {
  name: string;
  /** how the recording reproduces the condition: meta.json `steps` */
  steps: string[];
  /** creates the condition; captures once at the end unless it captured itself */
  run(ctx: ScenarioContext): Promise<void>;
}

const RENDER_STEP = "Dockflow renders the compose file into namespace fixture-<scenario> (project shop, release 1.4.2, servers server_1 and agent_1) and applies it server-side as a deploy does";

function placedOn(server: string): string {
  return `      placement:\n        constraints: ["node.hostname == ${server}"]\n`;
}

const SCENARIOS: Scenario[] = [
  {
    name: "rollout-progressing",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, nginx:1.27-alpine, expose 80, deploy.replicas 3, x-dockflow.probes use readiness with http / on port 80",
      "patch: the readiness probe waits initialDelaySeconds 60, so a new pod stays Running and not Ready for a minute",
      "kubectl rollout status deployment/web, then render and apply the same service with nginx:1.28-alpine",
      "capture once the new ReplicaSet has one pod Running with Ready=False",
    ],
    async run({ ns }) {
      const revision = (tag: string): ManifestObject[] => {
        const objects = render(
          ns,
          `services:\n  web:\n    image: nginx:${tag}\n    expose: ["80"]\n    deploy:\n      replicas: 3\n    x-dockflow:\n      probes:\n        use: readiness\n        http:\n          path: /\n          port: 80\n`,
        );
        const probe = containerOf(deploymentOf(objects, "web")).readinessProbe;
        if (!probe) throw new Error("web renders without a readiness probe");
        probe.initialDelaySeconds = 60;
        return objects;
      };
      await apply(revision("1.27-alpine"));
      await rolloutStatus(ns, "deployment/web", 300);
      await apply(revision("1.28-alpine"));
      await waitPods(ns, "web", "a new web pod Running with Ready=False", (pods) =>
        pods.some((pod) => pod.status?.phase === "Running" && !podReady(pod)),
      );
    },
  },
  {
    name: "rollout-complete",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web, nginx:1.27-alpine, ports "8080:80", deploy.replicas 3, x-dockflow.probes use readiness with http / on port 80',
      "kubectl rollout status deployment/web, then render and apply the same service with nginx:1.28-alpine",
      "kubectl rollout status deployment/web, apply the same objects again (generation stays 2)",
      "capture once the pods of revision 1 are gone",
    ],
    async run({ ns }) {
      const revision = (tag: string): ManifestObject[] =>
        render(
          ns,
          `services:\n  web:\n    image: nginx:${tag}\n    ports: ["8080:80"]\n    deploy:\n      replicas: 3\n    x-dockflow:\n      probes:\n        use: readiness\n        http:\n          path: /\n          port: 80\n`,
        );
      await apply(revision("1.27-alpine"));
      await rolloutStatus(ns, "deployment/web", 300);
      await apply(revision("1.28-alpine"));
      await rolloutStatus(ns, "deployment/web", 600);
      await apply(revision("1.28-alpine"));
      await waitPods(ns, "web", "the pods of revision 1 gone", (pods) => pods.length === 3 && pods.every((pod) => !pod.metadata.deletionTimestamp));
    },
  },
  {
    name: "crashloop",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web_app (object web-app), busybox:1.37, command sh -c "exit 1", placed on server_1',
      "capture once the container restarted 3 times",
    ],
    async run({ ns }) {
      await apply(render(ns, `services:\n  web_app:\n    image: busybox:1.37\n    command: ["sh", "-c", "exit 1"]\n    deploy:\n${placedOn("server_1")}`));
      await waitPods(ns, "web-app", "web-app restarted 3 times", crashLooping(3), 240_000);
    },
  },
  {
    name: "image-pull-backoff",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, image localhost:35010/e2e/missing:1 (a tag the e2e registry does not serve), placed on server_1",
      "capture once the container waits with reason ImagePullBackOff",
    ],
    async run({ ns }) {
      await apply(render(ns, `services:\n  web:\n    image: localhost:35010/e2e/missing:1\n    deploy:\n${placedOn("server_1")}`));
      await waitPods(ns, "web", "web waiting in ImagePullBackOff", waitingReason("ImagePullBackOff"));
    },
  },
  {
    name: "err-image-never-pull",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web built by Dockflow (build ., image shop-web:1.4.2, pull_policy never), never imported on the nodes, placed on server_1",
      "capture once the container waits with reason ErrImageNeverPull",
    ],
    async run({ ns }) {
      await apply(render(ns, `services:\n  web:\n    build: .\n    image: shop-web:1.4.2\n    pull_policy: never\n    deploy:\n${placedOn("server_1")}`));
      await waitPods(ns, "web", "web waiting in ErrImageNeverPull", waitingReason("ErrImageNeverPull"), 60_000);
    },
  },
  {
    name: "invalid-image-name",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web, busybox:1.37, command sleep 36000, placed on server_1; patch: image "UPPER/Case:bad tag", which the normalizer would refuse',
      "capture once the container waits with reason InvalidImageName",
    ],
    async run({ ns }) {
      const objects = render(ns, `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n${placedOn("server_1")}`);
      containerOf(deploymentOf(objects, "web")).image = "UPPER/Case:bad tag";
      await apply(objects);
      await waitPods(ns, "web", "web waiting in InvalidImageName", waitingReason("InvalidImageName"), 60_000);
    },
  },
  {
    name: "create-container-config-error",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, environment APP_ENV=production, placed on server_1",
      "everything is applied except the env Secret the pod reads",
      "capture once the container waits with reason CreateContainerConfigError",
    ],
    async run({ ns }) {
      const objects = render(
        ns,
        `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    environment:\n      APP_ENV: production\n    deploy:\n${placedOn("server_1")}`,
      );
      await apply(objects.filter((object) => object.kind !== "Secret"));
      await waitPods(ns, "web", "web waiting in CreateContainerConfigError", waitingReason("CreateContainerConfigError"), 60_000);
    },
  },
  {
    name: "oom-killed",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web, busybox:1.37, command sh -c "head -c 64m /dev/zero | tail", deploy.resources.limits.memory 16M, placed on agent_1',
      "capture once the container restarted twice after being OOMKilled",
    ],
    async run({ ns }) {
      await apply(
        render(
          ns,
          `services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "head -c 64m /dev/zero | tail"]\n    deploy:\n      resources:\n        limits:\n          memory: 16M\n${placedOn("agent_1")}`,
        ),
      );
      await waitPods(
        ns,
        "web",
        "web OOMKilled twice",
        (pods) =>
          pods.some((pod) =>
            (pod.status?.containerStatuses ?? []).some(
              (c) => c.restartCount >= 2 && (c.lastState?.terminated?.reason === "OOMKilled" || c.state?.terminated?.reason === "OOMKilled"),
            ),
          ),
        240_000,
      );
    },
  },
  {
    name: "unschedulable-resources",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, deploy.resources.reservations.memory 64G",
      "capture after 70 seconds with the pod Pending and PodScheduled=False",
    ],
    async run({ ns }) {
      await apply(
        render(ns, `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n      resources:\n        reservations:\n          memory: 64G\n`),
      );
      await Bun.sleep(70_000);
    },
  },
  {
    name: "unschedulable-node-selector",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, x-dockflow.node_selector zone=nowhere",
      "capture after 70 seconds with the pod Pending and PodScheduled=False",
    ],
    async run({ ns }) {
      await apply(
        render(ns, `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    x-dockflow:\n      node_selector:\n        zone: nowhere\n`),
      );
      await Bun.sleep(70_000);
    },
  },
  {
    name: "pvc-pending-rwx",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, mounting volume shared at /data; volume shared with x-dockflow.access_mode ReadWriteMany",
      "rendered with a storage-class trait that lists ReadWriteMany, which the k3s trait does not: the claim reaches dockflow-local, which cannot provision it",
      "capture 60 seconds after the claim got its ProvisioningFailed event",
    ],
    async run({ ns }) {
      await apply(
        render(
          ns,
          `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    volumes:\n      - shared:/data\nvolumes:\n  shared:\n    x-dockflow:\n      access_mode: ReadWriteMany\n`,
          { traits: { defaultStorageClassAccessModes: ["ReadWriteOnce", "ReadWriteOncePod", "ReadWriteMany"] } },
        ),
      );
      await waitFor(
        async () => {
          const events = await getJson<{ reason?: string; involvedObject?: { name?: string } }>("events", { ns });
          return events.some((event) => event.reason === "ProvisioningFailed" && event.involvedObject?.name === "shared") ? true : undefined;
        },
        { timeoutMs: 90_000, describe: "a ProvisioningFailed event on PVC shared" },
      );
      await Bun.sleep(60_000);
    },
  },
  {
    name: "progress-deadline-exceeded",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web, busybox:1.37, command sleep 36000, healthcheck CMD-SHELL "exit 1" every 5s used as readiness only (x-dockflow.probes.use readiness), placed on server_1',
      "patch: progressDeadlineSeconds 45 (the API wants it above the minReadySeconds 30 Dockflow renders)",
      "capture once the Deployment reports Progressing=False (ProgressDeadlineExceeded)",
    ],
    async run({ ns }) {
      const objects = render(
        ns,
        `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    healthcheck:\n      test: ["CMD-SHELL", "exit 1"]\n      interval: 5s\n    deploy:\n${placedOn("server_1")}    x-dockflow:\n      probes:\n        use: readiness\n`,
      );
      deploymentOf(objects, "web").spec.progressDeadlineSeconds = 45;
      await apply(objects);
      await waitCondition("deployments.apps", ns, "web", "Progressing", "False", 180_000);
    },
  },
  {
    name: "replica-failure-quota",
    steps: [
      RENDER_STEP,
      "kubectl create quota pods --hard=pods=1 in the namespace",
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, deploy.replicas 3, placed on agent_1",
      "capture once the Deployment reports ReplicaFailure=True",
    ],
    async run({ ns }) {
      await kubectl(["create", "quota", "pods", "--hard=pods=1", "-n", ns]);
      await apply(render(ns, `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n      replicas: 3\n${placedOn("agent_1")}`));
      await waitCondition("deployments.apps", ns, "web", "ReplicaFailure", "True", 90_000);
    },
  },
  {
    name: "statefulset-stuck",
    steps: [
      RENDER_STEP,
      'accessories.yml: service db, busybox:1.37, command sleep 36000, deploy.replicas 2, x-dockflow.kind statefulset, volume data (x-dockflow.per_replica) at /data',
      "the claims data-db-0 and data-db-1 are created first from the claim template, with the selected-node annotation the scheduler would set (server-1, agent-1), which pins each ordinal to a node",
      "kubectl rollout status statefulset/db, then render and apply the same service with busybox:1.36 and command sh -c \"exit 1\"",
      "capture once db-1, on the update revision, restarted 3 times (db-0 stays on the current revision)",
    ],
    async run({ ns }) {
      const compose = (image: string, command: string): string =>
        `services:\n  db:\n    image: ${image}\n    command: ${command}\n    volumes:\n      - data:/data\n    deploy:\n      replicas: 2\n    x-dockflow:\n      kind: statefulset\nvolumes:\n  data:\n    x-dockflow:\n      per_replica: true\n`;
      const first = render(ns, compose("busybox:1.37", '["sleep", "36000"]'), { role: "accessory" });
      const db = workloadOf(first, "db");
      if (db.kind !== "StatefulSet") throw new Error(`db renders as a ${db.kind}`);
      const [template] = db.spec.volumeClaimTemplates ?? [];
      if (!template) throw new Error("db renders without a claim template");
      const claims: PersistentVolumeClaim[] = [
        ["db-0", "server-1"],
        ["db-1", "agent-1"],
      ].map(([pod, node]) => ({
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: `${template.metadata.name}-${pod}`,
          namespace: ns,
          // the StatefulSet controller adds the selector labels to the template's own
          labels: { ...template.metadata.labels, ...db.spec.selector.matchLabels },
          annotations: { ...template.metadata.annotations, "volume.kubernetes.io/selected-node": node },
        },
        spec: structuredClone(template.spec),
      }));
      await apply(claims);
      await apply(first);
      await rolloutStatus(ns, "statefulset/db", 180);
      await apply(render(ns, compose("busybox:1.36", '["sh", "-c", "exit 1"]'), { role: "accessory" }));
      await waitFor(
        async () => {
          const [db1] = await getJson<PodLike>("pods", { ns, name: "db-1" });
          return db1 && crashLooping(3)([db1]) ? true : undefined;
        },
        { timeoutMs: 300_000, describe: "db-1 restarted 3 times on the update revision" },
      );
    },
  },
  {
    name: "daemonset-rolling",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service agent, busybox:1.37, command sleep 3600, deploy.mode global, update_config parallelism 1 order stop-first (one pod on server-1, one on agent-1)",
      "kubectl rollout status daemonset/agent, then render and apply the same service with command sleep 7200",
      "capture into the scenario directory once updatedNumberScheduled is 1 and numberUnavailable is 1 (the new pod inside its minReadySeconds)",
      "kubectl rollout status daemonset/agent, then capture into completed/",
    ],
    async run({ ns, capture }) {
      const revision = (seconds: number): ManifestObject[] =>
        render(
          ns,
          `services:\n  agent:\n    image: busybox:1.37\n    command: ["sleep", "${seconds}"]\n    deploy:\n      mode: global\n      update_config:\n        parallelism: 1\n        order: stop-first\n`,
        );
      await apply(revision(3600));
      await rolloutStatus(ns, "daemonset/agent", 180);
      await apply(revision(7200));
      await waitFor(
        async () => {
          const [ds] = await getJson<{ status?: { updatedNumberScheduled?: number; numberUnavailable?: number } }>("daemonsets.apps", { ns, name: "agent" });
          return ds?.status?.updatedNumberScheduled === 1 && (ds.status.numberUnavailable ?? 0) >= 1 ? true : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 1000, describe: "daemonset/agent mid-rollout (1 updated, 1 unavailable)" },
      );
      await capture();
      await rolloutStatus(ns, "daemonset/agent", 300);
      await capture("completed");
    },
  },
  {
    name: "job-complete",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service migrate, busybox:1.37, command sh -c "exit 0", restart "no", deploy.mode replicated-job, placed on agent_1',
      "capture once the Job reports Complete=True",
    ],
    async run({ ns }) {
      const objects = render(
        ns,
        `services:\n  migrate:\n    image: busybox:1.37\n    command: ["sh", "-c", "exit 0"]\n    restart: "no"\n    deploy:\n      mode: replicated-job\n${placedOn("agent_1")}`,
      );
      await apply(objects);
      await waitCondition("jobs.batch", ns, workloadOf(objects).metadata.name, "Complete", "True", 120_000);
    },
  },
  {
    name: "job-failed",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service migrate, busybox:1.37, command sh -c "exit 1", restart "no" (backoffLimit 0), deploy.mode replicated-job, placed on agent_1',
      "capture once the Job reports Failed=True",
    ],
    async run({ ns }) {
      const objects = render(
        ns,
        `services:\n  migrate:\n    image: busybox:1.37\n    command: ["sh", "-c", "exit 1"]\n    restart: "no"\n    deploy:\n      mode: replicated-job\n${placedOn("agent_1")}`,
      );
      await apply(objects);
      await waitCondition("jobs.batch", ns, workloadOf(objects).metadata.name, "Failed", "True", 120_000);
    },
  },
  {
    name: "init-container-crash",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, nginx:1.27-alpine, placed on server_1",
      'patch: init container init, busybox:1.37, command sh -c "exit 1"',
      "capture once the init container restarted 3 times",
    ],
    async run({ ns }) {
      const objects = render(ns, `services:\n  web:\n    image: nginx:1.27-alpine\n    deploy:\n${placedOn("server_1")}`);
      deploymentOf(objects, "web").spec.template.spec.initContainers = [
        { name: "init", image: "busybox:1.37", imagePullPolicy: "IfNotPresent", command: ["sh", "-c", "exit 1"] },
      ];
      await apply(objects);
      await waitPods(ns, "web", "the init container restarted 3 times", crashLooping(3, true), 240_000);
    },
  },
  {
    name: "multi-container",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service api, nginx:1.27-alpine, expose 80, placed on agent_1 (Dockflow sets kubectl.kubernetes.io/default-container: api)",
      "patch: a second container log-shipper, busybox:1.37, command sleep 36000",
      "kubectl rollout status deployment/api, then capture",
    ],
    async run({ ns }) {
      const objects = render(ns, `services:\n  api:\n    image: nginx:1.27-alpine\n    expose: ["80"]\n    deploy:\n${placedOn("agent_1")}`);
      deploymentOf(objects, "api").spec.template.spec.containers.push({
        name: "log-shipper",
        image: "busybox:1.37",
        imagePullPolicy: "IfNotPresent",
        command: ["sleep", "36000"],
      });
      await apply(objects);
      await rolloutStatus(ns, "deployment/api", 180);
    },
  },
  {
    name: "terminating-pods",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sh -c \"trap '' TERM; sleep 3600\", stop_grace_period 300s, deploy.replicas 2",
      "kubectl rollout status deployment/web, then kubectl delete pod <the pod on server-1> --wait=false",
      "capture once the replacement pod is Ready while the deleted pod is still Terminating",
    ],
    async run({ ns }) {
      await apply(
        render(ns, `services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "trap '' TERM; sleep 3600"]\n    stop_grace_period: 300s\n    deploy:\n      replicas: 2\n`),
      );
      await rolloutStatus(ns, "deployment/web", 180);
      const pods = await getJson<PodLike>("pods", { ns, selector: serviceSelector("web") });
      const victim = pods.find((pod) => pod.spec?.nodeName === "server-1") ?? pods[0];
      if (!victim) throw new Error(`terminating-pods: no web pod in ${ns}`);
      await kubectl(["delete", "pod", victim.metadata.name, "-n", ns, "--wait=false"]);
      await waitPods(
        ns,
        "web",
        "a replacement pod Ready while the deleted one is Terminating",
        (current) =>
          current.some((pod) => pod.metadata.name === victim.metadata.name && pod.metadata.deletionTimestamp) &&
          current.some((pod) => pod.metadata.name !== victim.metadata.name && !pod.metadata.deletionTimestamp && podReady(pod)) &&
          current.length === 3,
        120_000,
      );
    },
  },
  {
    name: "evicted-pod",
    steps: [
      RENDER_STEP,
      'docker-compose.yml: service web, busybox:1.37, command sh -c "dd if=/dev/zero of=/tmp/fill bs=1M count=64; sleep 3600", placed on server_1',
      "patch: resources.limits.ephemeral-storage 16Mi, which no compose key sets",
      "capture once the first pod is Failed with reason Evicted and its replacement is Running",
    ],
    async run({ ns }) {
      const objects = render(
        ns,
        `services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=64; sleep 3600"]\n    deploy:\n${placedOn("server_1")}`,
      );
      Object.assign(containerOf(deploymentOf(objects, "web")), { resources: { limits: { "ephemeral-storage": "16Mi" } } });
      await apply(objects);
      await waitPods(
        ns,
        "web",
        "the first pod Evicted with a Running replacement",
        (pods) => pods.some((pod) => pod.status?.phase === "Failed" && pod.status.reason === "Evicted") && pods.some((pod) => pod.status?.phase === "Running"),
        300_000,
      );
    },
  },
  {
    name: "node-not-ready",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, busybox:1.37, command sleep 36000, deploy.replicas 2, deploy.placement.max_replicas_per_node 1 (one pod on each node)",
      "kubectl rollout status deployment/web, then systemctl stop k3s-agent on agent-1",
      "capture once node agent-1 reports Ready=Unknown (node-monitor-grace-period, about 50 seconds), then systemctl start k3s-agent",
    ],
    async run({ ns, capture }) {
      await apply(
        render(
          ns,
          `services:\n  web:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n      replicas: 2\n      placement:\n        max_replicas_per_node: 1\n`,
        ),
      );
      await rolloutStatus(ns, "deployment/web", 180);
      // withNodeDown (helpers/k8s.ts) restores agent-1 in `finally`, even when the capture throws
      await withNodeDown("agent_1", "stop-k3s", async () => {
        await waitFor(
          async () => {
            const [node] = await getJson<{ status?: { conditions?: { type: string; status: string }[] } }>("nodes", { name: "agent-1" });
            return node?.status?.conditions?.find((c) => c.type === "Ready")?.status === "Unknown" ? true : undefined;
          },
          { timeoutMs: 120_000, describe: "node agent-1 to report Ready=Unknown" },
        );
        await capture();
      });
    },
  },
  {
    name: "headless-no-ports",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service worker, busybox:1.37, command sleep 36000, deploy.replicas 2, no ports, rendered with traits.headlessServiceNeedsPort false: headless Service worker without any port",
      "docker-compose.yml: service cache, busybox:1.37, command sleep 36000, no ports, placed on agent_1, rendered with the k3s traits: headless Service cache with the placeholder port",
      "kubectl rollout status for both Deployments, then capture once both Services have EndpointSlices with ready endpoints",
    ],
    async run({ ns }) {
      await apply(
        render(ns, `services:\n  worker:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n      replicas: 2\n`, {
          traits: { headlessServiceNeedsPort: false },
        }),
      );
      await apply(render(ns, `services:\n  cache:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n${placedOn("agent_1")}`));
      await rolloutStatus(ns, "deployment/worker", 180);
      await rolloutStatus(ns, "deployment/cache", 180);
      await waitFor(
        async () => {
          const slices = await getJson<{ metadata: { labels?: Record<string, string> }; endpoints?: { conditions?: { ready?: boolean } }[] }>("endpointslices", { ns });
          const ready = (svc: string) =>
            slices.some((slice) => slice.metadata.labels?.["kubernetes.io/service-name"] === svc && (slice.endpoints ?? []).some((e) => e.conditions?.ready));
          return ready("worker") && ready("cache") ? true : undefined;
        },
        { timeoutMs: 60_000, describe: "the Services worker and cache to have ready EndpointSlices" },
      );
    },
  },
  {
    name: "metrics-top",
    steps: [
      RENDER_STEP,
      "docker-compose.yml: service web, nginx:1.27-alpine, deploy.replicas 2, deploy.resources.limits.memory 128M",
      "accessories.yml: service db, busybox:1.37, command sleep 36000, deploy.resources.limits.memory 256M, x-dockflow.kind statefulset, placed on server_1",
      "the backup helper pod dockflow-helper-backup-3f9a2c1b of service db, as backups create it (backends/backup.ts buildHelperPod), on server-1",
      "capture once every pod is Ready and kubectl top pods lists all four",
      "kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/fixture-metrics-top/pods > metrics/metrics-top.json",
    ],
    async run({ ns, capture, captureMetrics }) {
      await apply(
        render(ns, `services:\n  web:\n    image: nginx:1.27-alpine\n    deploy:\n      replicas: 2\n      resources:\n        limits:\n          memory: 128M\n`),
      );
      await apply(
        render(
          ns,
          `services:\n  db:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    deploy:\n      resources:\n        limits:\n          memory: 256M\n${placedOn("server_1")}    x-dockflow:\n      kind: statefulset\n`,
          { role: "accessory" },
        ),
      );
      await apply([
        buildHelperPod({
          name: "dockflow-helper-backup-3f9a2c1b",
          namespace: ns,
          identity: { project: FIXTURE_PROJECT, namespace: ns },
          composeService: "db",
          helperImage: k3sDistribution.traits.helperImage,
          mounts: [],
          readOnly: true,
          nodeName: "server-1",
        }),
      ]);
      await rolloutStatus(ns, "deployment/web", 180);
      await rolloutStatus(ns, "statefulset/db", 180);
      await waitFor(
        async () => {
          const pods = await getJson<PodLike>("pods", { ns });
          return pods.length === 4 && pods.every(podReady) ? true : undefined;
        },
        { timeoutMs: 120_000, describe: "the four pods of fixture-metrics-top to be Ready" },
      );
      await waitFor(
        async () => {
          const top = await kubectl(["top", "pods", "-n", ns, "--no-headers"], { allowFailure: true });
          return top.trim().split("\n").filter(Boolean).length === 4 ? true : undefined;
        },
        { timeoutMs: 180_000, intervalMs: 5000, describe: "metrics-server to have scraped the four pods of fixture-metrics-top" },
      );
      await capture();
      await captureMetrics();
    },
  },
];

const SCENARIO_NAMES = new Set(SCENARIOS.map((s) => s.name));

async function record(scenario: Scenario): Promise<void> {
  const ns = fixtureNamespace(scenario.name);
  log(`[record] ${scenario.name}: creating the condition in ${ns}...`);
  await ensureNamespace(ns);
  const captures: RawCapture[] = [];
  let metrics: unknown = null;
  const ctx: ScenarioContext = {
    ns,
    async capture(name = "") {
      if (captures.some((c) => c.name === name)) throw new Error(`${scenario.name} captured ${name || "its directory"} twice`);
      captures.push(await readCapture(ns, name));
      log(`[record] ${scenario.name}: captured ${name || "the scenario directory"}`);
    },
    async captureMetrics() {
      metrics = JSON.parse(await kubectl(["get", "--raw", `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`]));
    },
  };
  await scenario.run(ctx);
  if (captures.length === 0) await ctx.capture();
  writeRecording(scenario, captures, metrics);
}

// ─── entry point ────────────────────────────────────────────────────

const USAGE = "Usage: bun run testing/e2e/k3s/tools/record-kubectl-fixtures.ts --lane <lane> (--scenario <name>[,<name>...] | --all)";

interface Args {
  lane: LaneName;
  scenarios: string[];
}

function parseArgs(argv: string[]): Args {
  let lane: string | undefined;
  let scenarios: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lane") lane = argv[++i];
    else if (argv[i] === "--scenario") scenarios.push(...(argv[++i] ?? "").split(",").filter(Boolean));
    else if (argv[i] === "--all") scenarios = SCENARIOS.map((s) => s.name);
    else throw new Error(`Unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!lane || !isLaneName(lane)) throw new Error(`--lane must be one of ${Object.keys(LANES).join(", ")}\n${USAGE}`);
  if (scenarios.length === 0) throw new Error(`Pass --scenario <name> or --all\n${USAGE}`);
  const unknown = scenarios.filter((name) => !SCENARIO_NAMES.has(name));
  if (unknown.length > 0) throw new Error(`Unknown scenario ${unknown.join(", ")}; known: ${DESIGN_SCENARIOS.kubectl.join(", ")}`);
  return { lane, scenarios };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lane = LANES[args.lane];
  if (!lane.topology) throw new Error(`Lane ${args.lane} has no shared topology to record against`);
  process.env.DOCKFLOW_E2E_TOPOLOGY = lane.topology;
  const topo = TOPOLOGIES[lane.topology];
  log(`[record] recording against the ${topo.name} topology of lane ${args.lane} (helm ${HELM_PIN.version}, k3s ${K3S_PIN.version})`);
  for (const name of args.scenarios) {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (scenario) await record(scenario);
  }
  log(`[record] done: ${args.scenarios.length} scenario(s).`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
