/**
 * Kubernetes/Helm assertion helpers for k3s e2e tests (design-07 16.10).
 *
 * "Harness kubectl/helm" (17's convention) always runs as root on a node through `docker exec`,
 * using k3s's own bundled admin kubeconfig (`/etc/rancher/k3s/k3s.yaml`, the "root kubeconfig") —
 * never Dockflow's own `dockflow-deployer` identity at `/var/lib/dockflow/kube/config`, whose RBAC
 * the harness must not be limited by when it asserts or cleans up cluster state.
 *
 * Pure naming/label helpers are imported from `cli/src` (comment at design-07 2731: "P = imported
 * from cli constants") instead of being redefined here, so the harness and the product agree on
 * names by construction.
 */

import { gunzipSync } from "zlib";
import { DOCKFLOW_K8S_PREFIX, LABELS, K8S_STATE_CONFIGMAP, K8S_SYSTEM_NAMESPACE } from "../../../cli/src/services/orchestrator/kubernetes/constants";
import { RELEASE_KEYS, decodeReleaseMetadata } from "../../../cli/src/services/orchestrator/kubernetes/backends/release-store";
import { leaseNameFor, namespaceFor, releaseSecretName, serviceNameFor } from "../../../cli/src/services/orchestrator/kubernetes/naming";
import { SEL_RELEASE } from "../../../cli/src/services/orchestrator/kubernetes/labels";
import { ARTIFACT_FORMAT_LINE_PREFIX, parseManifests } from "../../../cli/src/services/orchestrator/kubernetes/yaml";
import { isManifestKind, KIND_REGISTRY } from "../../../cli/src/services/orchestrator/kubernetes/resources/registry";
import type { ReleaseMetadata } from "../../../cli/src/services/orchestrator/interfaces";
import type { ConfigMap, PersistentVolume, Pod, Secret } from "../../../cli/src/services/orchestrator/kubernetes/resources/core";
import type { Lease } from "../../../cli/src/services/orchestrator/kubernetes/resources/coordination";
import { runCLI } from "./cli";
import { allowingNodeDown, exec, guardKubectl, guardNodeCommand, tryExec, waitForNodesReady } from "./cluster";
import type { Fixture } from "./fixtures";
import { auxContainer, currentTopology, managersOf, nodeFor, type NodeKey, type Topology } from "./topology";

export const P = DOCKFLOW_K8S_PREFIX;

/** `namespaceFor` from cli naming.ts. */
export function nsFor(project: string, env = "e2e"): string {
  return namespaceFor(project, env);
}

// ─── docker exec plumbing ──────────────────────────────────────────

/** the k3s binary itself: `k3s kubectl`/`k3s crictl` transparently use its bundled admin kubeconfig */
const K3S_BIN = "/usr/local/bin/k3s";
const K3S_ADMIN_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";
/** harness-only helm baked into the node image (design-07 16.4); setup installs its own copy elsewhere */
const HARNESS_HELM = "/opt/e2e/bin/helm";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeContainer(node?: NodeKey): string {
  const topo = currentTopology();
  if (node) return nodeFor(topo, node).container;
  const manager = managersOf(topo)[0];
  if (!manager) throw new Error(`Topology ${topo.name} has no manager node`);
  return manager.container;
}

// ─── harness kubectl ───────────────────────────────────────────────

export interface KubectlOptions {
  node?: NodeKey;
  stdin?: string;
  allowFailure?: boolean;
}

/** Harness kubectl (root, `k3s kubectl`), guarded against damaging cluster-level state in a shared lane. */
export async function kubectl(args: readonly string[], opts: KubectlOptions = {}): Promise<string> {
  guardKubectl(args);
  const container = nodeContainer(opts.node);
  const command = ["docker", "exec", ...(opts.stdin !== undefined ? ["-i"] : []), container, K3S_BIN, "kubectl", ...args];
  const result = await tryExec(command, opts.stdin === undefined ? undefined : { input: opts.stdin });
  if (result.exitCode !== 0 && !opts.allowFailure) {
    throw new Error(`harness kubectl ${args.join(" ")} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export interface GetJsonOptions {
  ns?: string;
  name?: string;
  selector?: string;
  node?: NodeKey;
}

/** `kubectl get <resource> [name] [-n ns | -A] [-l selector] -o json`, normalized to an array; NotFound -> []. */
export async function getJson<T>(resource: string, opts: GetJsonOptions = {}): Promise<T[]> {
  const args = ["get", resource];
  if (opts.name) args.push(opts.name);
  if (opts.ns) args.push("-n", opts.ns);
  // "-A" lists across every namespace; combined with a specific name it either errors (namespaced
  // resources) or is meaningless (cluster-scoped ones), so it is added only for a plain list.
  else if (!opts.name) args.push("-A");
  if (opts.selector) args.push("-l", opts.selector);
  args.push("-o", "json");
  const container = nodeContainer(opts.node);
  const result = await tryExec(["docker", "exec", container, K3S_BIN, "kubectl", ...args]);
  if (result.exitCode !== 0) {
    if (/NotFound/i.test(result.stderr)) return [];
    throw new Error(`harness kubectl ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (isRecord(parsed) && parsed.kind === "List" && Array.isArray(parsed.items)) return parsed.items as T[];
  return [parsed as T];
}

export async function podsForService(ns: string, composeService: string): Promise<Pod[]> {
  const name = serviceNameFor(composeService).value;
  return getJson<Pod>("pods", { ns, selector: `${LABELS.service}=${name}` });
}

export async function podUids(ns: string, composeService: string): Promise<string[]> {
  const pods = await podsForService(ns, composeService);
  return pods.map((pod) => pod.metadata.uid).filter((uid): uid is string => typeof uid === "string");
}

// ─── polling ────────────────────────────────────────────────────────

export interface WaitForOptions {
  timeoutMs: number;
  intervalMs?: number;
  describe: string;
}

/** No fixed sleeps: polls `probe` until it resolves to a value (not undefined), or throws describing what never happened. */
export async function waitFor<T>(probe: () => Promise<T | undefined>, opts: WaitForOptions): Promise<T> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: string | undefined;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${opts.describe} after ${opts.timeoutMs}ms${lastError ? ` (last error: ${lastError})` : ""}`);
    }
    await Bun.sleep(interval);
  }
}

type WorkloadKind = "deployment" | "statefulset" | "daemonset";

const WORKLOAD_RESOURCE: Readonly<Record<WorkloadKind, string>> = {
  deployment: "deployments.apps",
  statefulset: "statefulsets.apps",
  daemonset: "daemonsets.apps",
};

interface WorkloadStatus {
  status?: { readyReplicas?: number; numberReady?: number };
}

export async function waitWorkloadReady(
  ns: string,
  kind: WorkloadKind,
  name: string,
  ready: number,
  timeoutMs = 120_000,
): Promise<void> {
  await waitFor(
    async () => {
      const [workload] = await getJson<WorkloadStatus>(WORKLOAD_RESOURCE[kind], { ns, name });
      if (!workload) return undefined;
      const current = kind === "daemonset" ? (workload.status?.numberReady ?? 0) : (workload.status?.readyReplicas ?? 0);
      return current >= ready ? current : undefined;
    },
    { timeoutMs, describe: `${kind} ${ns}/${name} to have ${ready} ready replica(s)` },
  );
}

// ─── nodes ──────────────────────────────────────────────────────────

export interface NodeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** `docker exec --user <user> <container> sh -c '<command>'`, guarded against breaking a shared lane. */
export async function nodeExec(node: NodeKey, command: string, opts: { user?: "root" | "deploytest" } = {}): Promise<NodeExecResult> {
  const user = opts.user ?? "root";
  guardNodeCommand(command, user);
  const container = nodeFor(currentTopology(), node).container;
  const result = await tryExec(["docker", "exec", "--user", user, container, "sh", "-c", command]);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function serviceForNode(node: NodeKey): "k3s" | "k3s-agent" {
  return nodeFor(currentTopology(), node).role === "manager" ? "k3s" : "k3s-agent";
}

async function readyz(server: NodeKey): Promise<boolean> {
  const result = await nodeExec(server, "curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:6443/readyz", { user: "root" });
  return result.exitCode === 0 && result.stdout.trim() === "200";
}

/**
 * ha lane only (16.9): the one way to take a node down in a shared-cluster lane. Restores it and
 * waits until every server answers /readyz and every node is Ready before returning; a failure to
 * recover within 3 minutes fails the file instead of leaving the cluster half-broken for later files.
 */
export async function withNodeDown<T>(node: NodeKey, how: "stop-k3s" | "pause", fn: () => Promise<T>): Promise<T> {
  const topo = currentTopology();
  const target = nodeFor(topo, node);
  return allowingNodeDown(async () => {
    const service = serviceForNode(node);
    if (how === "stop-k3s") await nodeExec(node, `systemctl stop ${service}`, { user: "root" });
    else await exec(["docker", "pause", target.container]);
    try {
      return await fn();
    } finally {
      if (how === "stop-k3s") await nodeExec(node, `systemctl start ${service}`, { user: "root" });
      else await exec(["docker", "unpause", target.container]);
      await waitFor(async () => (await allServersReady(topo)) ? true : undefined, {
        timeoutMs: 180_000,
        describe: `every server of ${topo.name} to answer 200 on /readyz after restoring ${node}`,
      });
      await waitForNodesReady(topo, 180_000);
    }
  });
}

async function allServersReady(topo: Topology): Promise<boolean> {
  const results = await Promise.all(managersOf(topo).map((server) => readyz(server.key)));
  return results.every(Boolean);
}

// ─── HTTP from a node's point of view ──────────────────────────────

export interface CurlResult {
  code: number;
  body: string;
}

/** curl from inside a node container (or the `outsider` auxiliary container, outside the cluster). */
export async function curlFrom(node: NodeKey | "outsider", url: string, opts: { host?: string; timeoutS?: number } = {}): Promise<CurlResult> {
  const topo = currentTopology();
  const container = node === "outsider" ? auxContainer(topo.project, "outsider") : nodeFor(topo, node).container;
  const marker = "__DOCKFLOW_E2E_HTTP_CODE__";
  const command = ["docker", "exec", container, "curl", "-4", "-s", "--max-time", String(opts.timeoutS ?? 10)];
  if (opts.host) command.push("-H", `Host: ${opts.host}`);
  command.push(url, "-w", `${marker}%{http_code}`);
  const result = await tryExec(command);
  const idx = result.stdout.lastIndexOf(marker);
  if (idx === -1) return { code: 0, body: result.stdout };
  return { code: Number.parseInt(result.stdout.slice(idx + marker.length).trim(), 10) || 0, body: result.stdout.slice(0, idx) };
}

// ─── images ─────────────────────────────────────────────────────────

export interface NodeImage {
  ref: string;
  id: string;
  /** carries `io.cri-containerd.pinned=pinned` (the baked, never-garbage-collected images, 16.5) */
  pinned: boolean;
}

/** `crictl images -o json` (refs and ids) joined with `ctr images ls` labels (which ones are pinned). */
export async function imagesOnNode(node: NodeKey): Promise<NodeImage[]> {
  const container = nodeFor(currentTopology(), node).container;
  const crictlOut = await exec(["docker", "exec", container, K3S_BIN, "crictl", "images", "-o", "json"]);
  const parsed: unknown = JSON.parse(crictlOut);
  const images = isRecord(parsed) && Array.isArray(parsed.images) ? parsed.images.filter(isRecord) : [];
  const ctrOut = await exec([
    "docker", "exec", container, K3S_BIN, "ctr", "-n", "k8s.io", "images", "ls",
    "-q", "labels.io.cri-containerd.pinned==pinned",
  ]);
  const pinnedRefs = new Set(ctrOut.split("\n").map((line) => line.trim()).filter(Boolean));
  const result: NodeImage[] = [];
  for (const image of images) {
    const id = typeof image.id === "string" ? image.id : "";
    const tags = Array.isArray(image.repoTags) ? image.repoTags.filter((tag): tag is string => typeof tag === "string") : [];
    for (const ref of tags.length > 0 ? tags : [id]) result.push({ ref, id, pinned: pinnedRefs.has(ref) });
  }
  return result;
}

// ─── releases and cluster state ────────────────────────────────────

export async function releaseSecrets(ns: string): Promise<Secret[]> {
  return getJson<Secret>("secrets", { ns, selector: SEL_RELEASE(ns) });
}

function gunzipField(secret: Secret, key: string): string {
  const raw = secret.data?.[key];
  return raw ? gunzipSync(Buffer.from(raw, "base64")).toString("utf-8") : "";
}

export async function decodeRelease(
  ns: string,
  version: string,
): Promise<{ metadata: ReleaseMetadata; compose: string; stack: string; helm: unknown }> {
  const name = releaseSecretName(version);
  const [secret] = await getJson<Secret>("secrets", { ns, name });
  if (!secret) throw new Error(`Release secret ${name} not found in ${ns}`);
  const metadata = decodeReleaseMetadata(secret);
  if (!metadata) throw new Error(`Release secret ${name} in ${ns} has no valid metadata.json`);
  const helmText = gunzipField(secret, RELEASE_KEYS.helm);
  return {
    metadata,
    compose: gunzipField(secret, RELEASE_KEYS.compose),
    stack: gunzipField(secret, RELEASE_KEYS.stack),
    helm: JSON.parse(helmText || "[]"),
  };
}

export async function stateConfigMap(ns: string): Promise<Record<string, string>> {
  const [cm] = await getJson<ConfigMap>("configmaps", { ns, name: K8S_STATE_CONFIGMAP });
  return cm?.data ?? {};
}

export async function leaseFor(stackId: string): Promise<Lease | null> {
  const [lease] = await getJson<Lease>("leases.coordination.k8s.io", { ns: K8S_SYSTEM_NAMESPACE, name: leaseNameFor(stackId) });
  return lease ?? null;
}

// ─── helm ───────────────────────────────────────────────────────────

/** Harness helm (`/opt/e2e/bin/helm`) against the root kubeconfig — assertions only (setup installs its own copy). */
export async function helm(args: string[], node?: NodeKey): Promise<string> {
  const container = nodeContainer(node);
  const result = await tryExec(["docker", "exec", container, HARNESS_HELM, "--kubeconfig", K3S_ADMIN_KUBECONFIG, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`harness helm ${args.join(" ")} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

// ─── render vs live ─────────────────────────────────────────────────

/**
 * Extracts the multi-doc YAML block right after the first `# dockflow-artifact:` header line
 * (`--dry-run --render` prints it framed by other CLI output — the image-delivery summary before it,
 * a blank line then the live plan after it).
 */
export function extractRenderedManifest(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(ARTIFACT_FORMAT_LINE_PREFIX));
  if (start === -1) throw new Error(`--dry-run --render produced no ${ARTIFACT_FORMAT_LINE_PREFIX.trim()} header`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

const QUANTITY_RE = /^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;
const BINARY_UNITS: Readonly<Record<string, number>> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DECIMAL_UNITS: Readonly<Record<string, number>> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Kubernetes resource quantities in canonical units (milli for `m`, bytes/count otherwise), so "1" and "1000m" agree. */
function quantityValue(value: string): number | null {
  const match = QUANTITY_RE.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = match[2];
  if (unit === "m") return amount;
  if (unit && unit in BINARY_UNITS) return amount * (BINARY_UNITS[unit] as number) * 1000;
  if (unit && unit in DECIMAL_UNITS) return amount * (DECIMAL_UNITS[unit] as number) * 1000;
  return amount * 1000;
}

function leavesEqual(rendered: unknown, live: unknown): boolean {
  if (rendered === live) return true;
  // The API server encodes omitempty integers without their zero (probe initialDelaySeconds); the
  // apply still owns the field, which is why the renderer emits it (DESIGN-CORE 4.2 rule 8).
  if (rendered === 0 && live === undefined) return true;
  if (typeof rendered === "string" && typeof live === "string") {
    const [a, b] = [quantityValue(rendered), quantityValue(live)];
    if (a !== null && b !== null) return a === b;
  }
  return false;
}

function diffLeaves(rendered: unknown, live: unknown, path: string, skip: ReadonlySet<string>, out: string[]): void {
  if (skip.has(path)) return;
  if (Array.isArray(rendered)) {
    if (!Array.isArray(live)) {
      out.push(`${path}: rendered is an array, live is not`);
      return;
    }
    rendered.forEach((entry, index) => diffLeaves(entry, live[index], `${path}/${index}`, skip, out));
    return;
  }
  if (isRecord(rendered)) {
    if (!isRecord(live)) {
      out.push(`${path}: rendered is an object, live is not`);
      return;
    }
    for (const key of Object.keys(rendered)) diffLeaves(rendered[key], live[key], `${path}/${key}`, skip, out);
    return;
  }
  if (!leavesEqual(rendered, live)) out.push(`${path}: rendered ${JSON.stringify(rendered)} != live ${JSON.stringify(live)}`);
}

/**
 * Every JSON-pointer leaf of the rendered object `rendered` that differs from (or is missing in)
 * `live`, prefixed with `Kind/name` (quantities compared by value). `secretDataMasked` skips
 * `Secret.data`, which `--dry-run --render` prints as `***`.
 */
export function renderedLeafMismatches(
  rendered: { kind: string; metadata: { name: string } },
  live: unknown,
  opts: { secretDataMasked: boolean },
): string[] {
  const skip = new Set(opts.secretDataMasked && rendered.kind === "Secret" ? ["/data"] : []);
  const out: string[] = [];
  diffLeaves(rendered, live, "", skip, out);
  return out.map((line) => `${rendered.kind}/${rendered.metadata.name}${line}`);
}

/**
 * Runs `deploy <env> <version> --dry-run --render`, then compares every emitted leaf of every
 * rendered object with the live object of the same kind/name/namespace (quantities compared by
 * value; `Secret.data` skipped, since it is printed masked). Throws listing every mismatch.
 */
export async function assertLiveMatchesRender(fixture: Fixture, version: string, env = "e2e"): Promise<void> {
  const result = await runCLI(["deploy", env, version, "--dry-run", "--render"], { cwd: fixture.dir });
  if (result.exitCode !== 0) {
    throw new Error(`deploy --dry-run --render exited ${result.exitCode}: ${result.stderr.slice(-2000) || result.stdout.slice(-2000)}`);
  }
  const objects = parseManifests(extractRenderedManifest(result.stdout));
  const mismatches: string[] = [];
  for (const rendered of objects) {
    const { kind, metadata } = rendered;
    if (!isManifestKind(kind)) {
      mismatches.push(`(no live comparison available for kind ${kind} ${metadata.name})`);
      continue;
    }
    const resource = KIND_REGISTRY[kind].resource;
    const { name, namespace } = metadata;
    const [live] = await getJson<Record<string, unknown>>(resource, namespace ? { ns: namespace, name } : { name });
    if (!live) {
      mismatches.push(`${kind}/${name}${namespace ? ` in ${namespace}` : ""}: no live object`);
      continue;
    }
    mismatches.push(...renderedLeafMismatches(rendered, live, { secretDataMasked: true }));
  }
  if (mismatches.length > 0) throw new Error(`assertLiveMatchesRender(${version}): ${mismatches.length} mismatch(es):\n${mismatches.join("\n")}`);
}

// ─── teardown ───────────────────────────────────────────────────────

function hostnameToNodeKey(topo: Topology, hostname: string): NodeKey | null {
  return topo.nodes.find((node) => node.service === hostname)?.key ?? null;
}

function localVolumeHostPath(pv: PersistentVolume): { path: string; hostname: string } | null {
  const path = pv.spec?.local?.path ?? pv.spec?.hostPath?.path;
  if (!path) return null;
  const hostname = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms
    ?.flatMap((term) => term.matchExpressions ?? [])
    .find((expr) => expr.key === "kubernetes.io/hostname")?.values?.[0];
  return hostname ? { path, hostname } : null;
}

/**
 * Deletes the namespace and every Retain PV whose `claimRef.namespace` was it (Dockflow itself never
 * deletes namespaces, so the harness does it to keep e2e disk usage flat), including the PV's host
 * directory on the node that held its data.
 */
export async function deleteStackCompletely(ns: string): Promise<void> {
  const topo = currentTopology();
  const pvs = await getJson<PersistentVolume>("persistentvolumes");
  const retained = pvs.filter((pv) => pv.spec?.persistentVolumeReclaimPolicy === "Retain" && pv.spec?.claimRef?.namespace === ns);
  await kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=true"], { allowFailure: true });
  for (const pv of retained) {
    const local = localVolumeHostPath(pv);
    if (local) {
      const key = hostnameToNodeKey(topo, local.hostname);
      if (key) await nodeExec(key, `rm -rf '${local.path}'`, { user: "root" });
    }
    await kubectl(["delete", "pv", pv.metadata.name, "--ignore-not-found"], { allowFailure: true });
  }
}
