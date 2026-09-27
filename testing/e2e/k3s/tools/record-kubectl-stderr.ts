/**
 * Recorder of the kubectl stderr samples of design-07 3.11 (fixtures/kubectl-stderr), run by
 * record-kubectl-fixtures.ts (`--scenario kubectl-stderr`). Each sample is the stderr of a command
 * Dockflow runs, built with runtime/kubectl.ts's own builders and run by bash on the node as over
 * SSH, once the condition that makes it fail holds on the duo cluster: a missing ClusterRoleBinding,
 * a swapped kubeconfig, an admission webhook this process serves, a namespace being deleted, a
 * container without a shell. Every condition is undone afterwards. The samples are scrubbed, checked
 * with scrubViolations, and listed in meta.json with the command that printed them.
 */

import { createHash, randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { FIXTURE_PROJECT, FIXTURES_ROOT, type FixtureFile, scrubViolations } from "../../../../cli/src/__tests__/kubernetes/support/kubectl-fixtures";
import { deployerClusterRoleBinding } from "../../../../cli/src/commands/setup/k3s/identity";
import { containerTarArgs } from "../../../../cli/src/services/orchestrator/copy";
import type { LockData, ReleaseInput } from "../../../../cli/src/services/orchestrator/interfaces";
import { buildHelperPod } from "../../../../cli/src/services/orchestrator/kubernetes/backends/backup";
import { wrapExecArgv } from "../../../../cli/src/services/orchestrator/kubernetes/backends/containers";
import { podMetricsPath } from "../../../../cli/src/services/orchestrator/kubernetes/backends/inventory";
import { leaseYaml } from "../../../../cli/src/services/orchestrator/kubernetes/backends/lock-store";
import { buildReleaseSecret } from "../../../../cli/src/services/orchestrator/kubernetes/backends/release-store";
import { HELM_BIN_PATH, K8S_DEPLOYER_CLUSTER_ROLE_BINDING, K8S_KUBECONFIG_PATH, K8S_SYSTEM_NAMESPACE, LABELS } from "../../../../cli/src/services/orchestrator/kubernetes/constants";
import { k3sDistribution } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/distribution";
import { K3S_PIN } from "../../../../cli/src/services/orchestrator/kubernetes/k3s/versions";
import { leaseNameFor, namespaceFor } from "../../../../cli/src/services/orchestrator/kubernetes/naming";
import type { Deployment, StatefulSet } from "../../../../cli/src/services/orchestrator/kubernetes/resources/apps";
import type { Lease } from "../../../../cli/src/services/orchestrator/kubernetes/resources/coordination";
import type { PersistentVolumeClaim, Pod, Service } from "../../../../cli/src/services/orchestrator/kubernetes/resources/core";
import type { ManifestObject } from "../../../../cli/src/services/orchestrator/kubernetes/resources/registry";
import { classifyKubectlFailure } from "../../../../cli/src/services/orchestrator/kubernetes/runtime/errors";
import { helmCommand } from "../../../../cli/src/services/orchestrator/kubernetes/runtime/helm";
import {
  applyCall,
  createCall,
  deleteCall,
  getJsonCall,
  type KubectlCall,
  kubectlCommand,
  replaceCall,
} from "../../../../cli/src/services/orchestrator/kubernetes/runtime/kubectl";
import { namespaceObject } from "../../../../cli/src/services/orchestrator/kubernetes/translate/namespace";
import { emitManifests, emitObject } from "../../../../cli/src/services/orchestrator/kubernetes/yaml";
import { sha256Hex } from "../../../../cli/src/utils/hash";
import { exec, tryExec } from "../../helpers/cluster";
import { getJson, kubectl, waitFor } from "../../helpers/k8s";
import { currentTopology, managersOf, nodeFor, type Topology } from "../../helpers/topology";
import { apply, render } from "./fixture-render";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

const STDERR_ROOT = join(FIXTURES_ROOT, "kubectl-stderr");
/** the stack namespace of project shop, environment production */
const NS = namespaceFor(FIXTURE_PROJECT, "production");
/** where admission policies and webhooks apply, so they never touch the other samples */
const POLICY_NS = namespaceFor(FIXTURE_PROJECT, "staging");
/** a namespace kept terminating by a finalizer */
const TERMINATING_NS = namespaceFor(FIXTURE_PROJECT, "preview");
const HOLD_FINALIZER = "example.com/hold";
const DENIAL = "images from registry.example.com/untrusted are not allowed";
const WEBHOOK_PORT = 9443;
const UNTRUSTED_IMAGE = "registry.example.com/untrusted/web:1";
const HEADER = { format: "k8s-manifests/1", stackName: `${FIXTURE_PROJECT}-production`, role: "app", version: "1.4.2" } as const;

// ─── running what Dockflow runs ───────────────────────────────────

interface Run {
  /** as the node's shell received it */
  command: string;
  exitCode: number;
  stderr: string;
}

interface Nodes {
  server: string;
  agent: string;
  /** the host address the nodes reach this process on */
  host: string;
  net: string;
}

async function onNode(container: string, command: string, options: { stdin?: string; user?: string; timeoutMs?: number } = {}): Promise<Run> {
  const args = ["docker", "exec", ...(options.stdin === undefined ? [] : ["-i"]), ...(options.user ? ["--user", options.user] : []), container, "bash", "-c", command];
  const result = await tryExec(args, { ...(options.stdin === undefined ? {} : { input: options.stdin }), timeoutMs: options.timeoutMs ?? 300_000 });
  return { command, exitCode: result.exitCode, stderr: result.stderr };
}

/** the kubectl command Dockflow sends for `call`, run where `container` is */
function dockflow(container: string, call: KubectlCall, options: { user?: string } = {}): Promise<Run> {
  const stdin = call.stdin === undefined ? undefined : typeof call.stdin === "string" ? call.stdin : Buffer.from(call.stdin).toString("utf8");
  return onNode(container, kubectlCommand(k3sDistribution, call), { ...options, ...(stdin === undefined ? {} : { stdin }) });
}

async function shell(container: string, script: string, stdin?: string): Promise<void> {
  const run = await onNode(container, script, stdin === undefined ? {} : { stdin });
  if (run.exitCode !== 0) throw new Error(`${script} failed on ${container} (exit ${run.exitCode}): ${run.stderr.trim()}`);
}

async function readOnNode(container: string, path: string): Promise<string> {
  return exec(["docker", "exec", container, "cat", path]);
}

function stackManifests(objects: ManifestObject[]): string {
  return emitManifests(objects, HEADER);
}

// ─── samples ──────────────────────────────────────────────────────

interface Sample {
  file: string;
  /** the condition, for meta.json */
  how: string;
  run: Run;
}

class Samples {
  readonly kept: Sample[] = [];

  keep(file: string, how: string, run: Run): void {
    if (run.exitCode === 0 || run.stderr.trim() === "") {
      throw new Error(`${file}: ${run.command} did not fail (exit ${run.exitCode}): ${run.stderr.trim()}`);
    }
    this.kept.push({ file, how, run });
    log(`[stderr] ${file}: exit ${run.exitCode}, classified ${classifyKubectlFailure(run.exitCode, run.stderr)}`);
  }
}

/** kubeconfig swapped in at Dockflow's path for `fn`, the original put back (or none, as before) */
async function withKubeconfig<T>(container: string, content: string, fn: () => Promise<T>): Promise<T> {
  const saved = `${K8S_KUBECONFIG_PATH}.recorder-original`;
  await shell(container, `if [ -f ${K8S_KUBECONFIG_PATH} ]; then cp -p ${K8S_KUBECONFIG_PATH} ${saved}; fi; mkdir -p ${dirname(K8S_KUBECONFIG_PATH)}`);
  try {
    await shell(container, `umask 077 && cat > ${K8S_KUBECONFIG_PATH}`, content);
    return await fn();
  } finally {
    await shell(container, `if [ -f ${saved} ]; then mv -f ${saved} ${K8S_KUBECONFIG_PATH}; else rm -f ${K8S_KUBECONFIG_PATH}; fi`);
  }
}

function replaceField(kubeconfig: string, field: string, value: string): string {
  const pattern = new RegExp(`^(\\s*${field}: ).*$`, "m");
  if (!pattern.test(kubeconfig)) throw new Error(`The Dockflow kubeconfig has no ${field}`);
  return kubeconfig.replace(pattern, `$1${value}`);
}

async function deleteNamespace(ns: string): Promise<void> {
  // a finalizer this recorder left would keep the namespace terminating forever
  const held = await getJson<{ metadata: { name: string; finalizers?: string[] } }>("configmaps", { ns }).catch(() => []);
  for (const cm of held.filter((c) => c.metadata.finalizers?.includes(HOLD_FINALIZER))) {
    await kubectl(["patch", "configmap", cm.metadata.name, "-n", ns, "--type=merge", "-p", '{"metadata":{"finalizers":null}}'], { allowFailure: true });
  }
  await kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=true", "--timeout=180s"], { allowFailure: true });
}

async function holdConfigMap(ns: string, name: string): Promise<void> {
  await kubectl(["apply", "-f", "-"], {
    stdin: JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace: ns, finalizers: [HOLD_FINALIZER] } }),
  });
}

async function releaseConfigMap(ns: string, name: string): Promise<void> {
  await kubectl(["patch", "configmap", name, "-n", ns, "--type=merge", "-p", '{"metadata":{"finalizers":null}}'], { allowFailure: true });
}

function lockData(): LockData {
  return { performer: "ci", started_at: new Date().toISOString(), timestamp: Date.now(), version: "1.4.2", stack: NS, message: "Deploy 1.4.2" };
}

function releaseInput(): ReleaseInput {
  const content = "# dockflow-artifact: k8s-manifests/1\n";
  return {
    version: "1.4.2",
    compose: "services:\n  web:\n    image: nginx:alpine\n",
    artifact: { format: "k8s-manifests/1", role: "app", content, helm: [], diagnostics: [], digest: sha256Hex(content) },
    metadata: {
      project_name: FIXTURE_PROJECT,
      version: "1.4.2",
      env: "production",
      timestamp: new Date().toISOString(),
      epoch: Math.floor(Date.now() / 1000),
      performer: "ci",
      branch: "main",
      orchestrator: "k3s",
      artifact_format: "k8s-manifests/1",
      helm: [],
      accessories_digest: null,
    },
  };
}

async function readLease(): Promise<Lease & { metadata: { uid: string; resourceVersion: string } }> {
  const [lease] = await getJson<Lease>("leases.coordination.k8s.io", { ns: K8S_SYSTEM_NAMESPACE, name: leaseNameFor(NS) });
  if (!lease?.metadata.uid || !lease.metadata.resourceVersion) throw new Error(`Lease ${leaseNameFor(NS)} is missing`);
  return lease as Lease & { metadata: { uid: string; resourceVersion: string } };
}

function deletePreconditions(uid: string, resourceVersion: string): KubectlCall {
  // the lock release of lock-store.ts
  return {
    args: ["delete", `--raw=/apis/coordination.k8s.io/v1/namespaces/${K8S_SYSTEM_NAMESPACE}/leases/${leaseNameFor(NS)}`, "-f", "-"],
    stdin: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid, resourceVersion } }),
    mutating: true,
  };
}

function webService(image = "nginx:alpine"): string {
  return `services:\n  web:\n    image: ${image}\n    deploy:\n      placement:\n        constraints: ["node.hostname == server_1"]\n`;
}

function objectOf<T extends ManifestObject>(objects: ManifestObject[], kind: string, name: string): T {
  const found = objects.find((object) => object.kind === kind && object.metadata.name === name);
  if (!found) throw new Error(`The render has no ${kind} ${name}`);
  return found as T;
}

// ─── the admission webhook this process serves ────────────────────

interface Webhook {
  url(path: string): string;
  caBundle: string;
  stop(): void;
}

async function startWebhook(host: string): Promise<Webhook> {
  const dir = mkdtempSync(join(tmpdir(), "dockflow-webhook-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  await exec(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=policy.example.com", "-addext", `subjectAltName=IP:${host}`]);
  const server = Bun.serve({
    hostname: "0.0.0.0",
    // a fixed port: the URL is part of the error text of a slow webhook
    port: WEBHOOK_PORT,
    tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") },
    async fetch(request) {
      const review = (await request.json().catch(() => ({}))) as { request?: { uid?: string } };
      const path = new URL(request.url).pathname;
      if (path === "/slow") await Bun.sleep(20_000);
      const allowed = path !== "/deny";
      return Response.json({
        apiVersion: "admission.k8s.io/v1",
        kind: "AdmissionReview",
        response: { uid: review.request?.uid ?? "", allowed, ...(allowed ? {} : { status: { code: 403, message: DENIAL } }) },
      });
    },
  });
  const caBundle = Buffer.from(readFileSync(cert)).toString("base64");
  rmSync(dir, { recursive: true, force: true });
  return {
    url: (path) => `https://${host}:${server.port}${path}`,
    caBundle,
    stop: () => server.stop(true),
  };
}

function webhookConfiguration(url: string, caBundle: string, timeoutSeconds: number): object {
  return {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingWebhookConfiguration",
    metadata: { name: "policy.example.com" },
    webhooks: [
      {
        name: "images.policy.example.com",
        clientConfig: { url, caBundle },
        rules: [{ apiGroups: ["apps"], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["deployments"] }],
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": POLICY_NS } },
        sideEffects: "None",
        admissionReviewVersions: ["v1"],
        failurePolicy: "Fail",
        timeoutSeconds,
      },
    ],
  };
}

async function withWebhook<T>(url: string, caBundle: string, timeoutSeconds: number, fn: () => Promise<T>): Promise<T> {
  await kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(webhookConfiguration(url, caBundle, timeoutSeconds)) });
  try {
    return await fn();
  } finally {
    await kubectl(["delete", "validatingwebhookconfiguration", "policy.example.com", "--ignore-not-found"], { allowFailure: true });
  }
}

// ─── recording ────────────────────────────────────────────────────

async function recordNotFoundAndWrites(nodes: Nodes, samples: Samples): Promise<void> {
  const { server } = nodes;
  samples.keep("NotFound/2.txt", "the stack namespace was never created", await dockflow(server, getJsonCall(["namespaces"], { name: NS })));
  await apply([namespaceObject({ project: FIXTURE_PROJECT, env: "production" })]);
  samples.keep("NotFound/1.txt", "no Deployment web in the stack namespace", await dockflow(server, getJsonCall(["deployments"], { namespace: NS, name: "web" })));
  samples.keep(
    "NotFound/3.txt",
    "no deploy lock is held",
    await dockflow(server, getJsonCall(["leases.coordination.k8s.io"], { namespace: K8S_SYSTEM_NAMESPACE, name: leaseNameFor(NS) })),
  );

  // the lock Lease and the release Secret, created twice as a concurrent deploy would
  const lease = createCall(leaseYaml(NS, lockData(), new Date(), 30), { namespace: K8S_SYSTEM_NAMESPACE, json: true });
  const first = await dockflow(server, lease);
  if (first.exitCode !== 0) throw new Error(`Creating the lock Lease failed: ${first.stderr}`);
  samples.keep("AlreadyExists/1.txt", "another deploy holds the lock Lease", await dockflow(server, lease));
  const secret = createCall(buildReleaseSecret({ project: FIXTURE_PROJECT, env: "production" }, releaseInput()).yaml, { namespace: NS });
  if ((await dockflow(server, secret)).exitCode !== 0) throw new Error("Creating the release Secret failed");
  samples.keep("AlreadyExists/2.txt", "release 1.4.2 was written concurrently", await dockflow(server, secret));

  // a takeover and two releases of the lock, all behind a renewal made elsewhere
  const read = await readLease();
  await kubectl(["annotate", "lease", leaseNameFor(NS), "-n", K8S_SYSTEM_NAMESPACE, "example.com/renewed=1", "--overwrite"]);
  samples.keep(
    "Conflict/1.txt",
    "the lock Lease was renewed after it was read (takeover of a stale lock)",
    await dockflow(server, replaceCall(leaseYaml(NS, lockData(), new Date(), 30, { existing: read }), { namespace: K8S_SYSTEM_NAMESPACE })),
  );
  const current = await readLease();
  samples.keep("Conflict/2.txt", "the lock Lease was deleted and taken by another deploy (lock release)", await dockflow(server, deletePreconditions(randomUUID(), current.metadata.resourceVersion)));
  samples.keep("Conflict/3.txt", "a renewal moved the lock Lease after it was held (lock release)", await dockflow(server, deletePreconditions(current.metadata.uid, read.metadata.resourceVersion)));
}

async function recordInvalidAndImmutable(nodes: Nodes, samples: Samples): Promise<void> {
  const { server } = nodes;
  const web = render(NS, webService());
  const noImage = structuredClone(objectOf<Deployment>(web, "Deployment", "web"));
  noImage.spec.template.spec.containers[0].image = "";
  samples.keep("Invalid/1.txt", "a Deployment without an image", await dockflow(server, applyCall(stackManifests([noImage]), { namespace: NS, dryRun: false })));
  const exposed = render(NS, `${webService()}    expose: ["80"]\n`);
  const badPort = structuredClone(objectOf<Service>(exposed, "Service", "web"));
  for (const port of badPort.spec?.ports ?? []) {
    port.port = 70000;
    port.targetPort = 70000;
  }
  samples.keep("Invalid/2.txt", "a Service port and target port out of range", await dockflow(server, applyCall(stackManifests([badPort]), { namespace: NS, dryRun: false })));

  await apply(web);
  const reselected = structuredClone(objectOf<Deployment>(web, "Deployment", "web"));
  reselected.spec.selector.matchLabels = { ...reselected.spec.selector.matchLabels, [LABELS.role]: "app" };
  reselected.spec.template.metadata = { ...reselected.spec.template.metadata, labels: { ...reselected.spec.template.metadata?.labels, [LABELS.role]: "app" } };
  samples.keep(
    "Immutable/1.txt",
    "the selector of Deployment web gained a label (an earlier labelling of the same service)",
    await dockflow(server, applyCall(stackManifests([reselected]), { namespace: NS, dryRun: false })),
  );

  const db = (ports: string): string => `services:\n  db:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n${ports}`;
  await apply(render(NS, db('    expose: ["5432"]\n'), { role: "accessory" }));
  samples.keep(
    "Immutable/2.txt",
    "accessory db lost its port: its Service, which has a cluster IP, would become headless",
    await dockflow(server, applyCall(stackManifests([objectOf(render(NS, db(""), { role: "accessory" }), "Service", "db")]), { namespace: NS, dryRun: false })),
  );

  const perReplica = render(
    NS,
    'services:\n  cache:\n    image: busybox:1.37\n    command: ["sleep", "36000"]\n    volumes:\n      - data:/data\n    x-dockflow:\n      kind: statefulset\nvolumes:\n  data:\n    x-dockflow:\n      per_replica: true\n',
    { role: "accessory" },
  );
  await apply(perReplica);
  const statefulSet = structuredClone(objectOf<StatefulSet>(perReplica, "StatefulSet", "cache"));
  if (!statefulSet.spec.volumeClaimTemplates?.length) throw new Error("StatefulSet cache has no volume claim template");
  for (const template of statefulSet.spec.volumeClaimTemplates) {
    template.spec = { ...template.spec, resources: { requests: { storage: "2Gi" } } };
  }
  samples.keep("Immutable/4.txt", "the per-replica volume of StatefulSet cache changed size", await dockflow(server, applyCall(stackManifests([statefulSet]), { namespace: NS, dryRun: false })));

  const shared = render(NS, "services:\n  web:\n    image: nginx:alpine\n    volumes:\n      - uploads:/data\nvolumes:\n  uploads: {}\n");
  await apply(shared.filter((object) => object.kind === "PersistentVolumeClaim"));
  const claim = structuredClone(shared.find((object): object is PersistentVolumeClaim => object.kind === "PersistentVolumeClaim") as PersistentVolumeClaim);
  claim.spec = { ...claim.spec, accessModes: ["ReadWriteMany"] };
  samples.keep("Immutable/3.txt", "the access mode of a top-level volume changed", await dockflow(server, applyCall(stackManifests([claim]), { namespace: NS, dryRun: false })));
}

async function recordNoKindMatch(nodes: Nodes, samples: Samples): Promise<void> {
  const labels = { "app.kubernetes.io/managed-by": "dockflow" };
  const route = {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: { name: "web", namespace: NS, labels },
    spec: { entryPoints: ["web"], routes: [{ match: "Host(`shop.example.com`)", kind: "Rule", services: [{ name: "web", port: 80 }] }] },
  };
  const middleware = {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: { name: "web-strip", namespace: NS, labels },
    spec: { stripPrefix: { prefixes: ["/shop"] } },
  };
  samples.keep(
    "NoKindMatch/1.txt",
    "Traefik routes on a cluster without the Traefik CRDs",
    await dockflow(nodes.server, applyCall(stackManifests([route as unknown as ManifestObject]), { namespace: NS, dryRun: false })),
  );
  samples.keep(
    "NoKindMatch/2.txt",
    "the server dry run of a route and a middleware on a cluster without the Traefik CRDs",
    await dockflow(nodes.server, applyCall(stackManifests([middleware, route] as unknown as ManifestObject[]), { namespace: NS, dryRun: true })),
  );
}

async function recordTimeoutAndUnknown(nodes: Nodes, samples: Samples): Promise<void> {
  const { server } = nodes;
  const web = objectOf<Deployment>(render(NS, webService()), "Deployment", "web");
  const selector = Object.entries(web.spec.selector.matchLabels ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const pods = await waitFor(async () => {
    const found = await getJson<Pod>("pods", { ns: NS, selector });
    return found.length > 0 ? found : undefined;
  }, { timeoutMs: 120_000, describe: "a pod of web" });
  const pod = pods[0].metadata.name;
  samples.keep(
    "Timeout/1.txt",
    "the pods of web are still running when a kind switch waits for them to go",
    await dockflow(server, { args: ["wait", "--for=delete", "pods", "-l", selector, "--timeout=2s"], namespace: NS, mutating: false, requestTimeoutS: null }),
  );
  await holdConfigMap(NS, "held");
  try {
    samples.keep(
      "Timeout/2.txt",
      "a finalizer keeps an object a waited delete removes",
      await dockflow(server, deleteCall(["configmaps/held"], { namespace: NS, wait: true, timeoutS: 2, ignoreNotFound: true })),
    );
  } finally {
    await releaseConfigMap(NS, "held");
  }
  samples.keep("Unknown/1.txt", "logs of a container the pod does not have", await dockflow(server, { args: ["logs", pod, "-c", "sidecar", "--tail=50"], namespace: NS, mutating: false }));

  // metrics-server down: the metrics API answers 503 until it is back
  await kubectl(["scale", "deployment/metrics-server", "-n", "kube-system", "--replicas=0"]);
  try {
    let unavailable: Run | undefined;
    await waitFor(
      async () => {
        const run = await dockflow(server, { args: ["get", "--raw", podMetricsPath(NS)], mutating: false });
        if (run.exitCode !== 0 && run.stderr.includes("ServiceUnavailable")) unavailable = run;
        return unavailable;
      },
      { timeoutMs: 180_000, intervalMs: 5000, describe: "the metrics API to be unavailable" },
    );
    if (unavailable) samples.keep("Unknown/2.txt", "metrics-server is down", unavailable);
  } finally {
    await kubectl(["scale", "deployment/metrics-server", "-n", "kube-system", "--replicas=1"]);
    await kubectl(["rollout", "status", "deployment/metrics-server", "-n", "kube-system", "--timeout=180s"]);
  }
}

async function recordExec(nodes: Nodes, samples: Samples): Promise<void> {
  const images = JSON.parse(await exec(["docker", "exec", nodes.server, "/usr/local/bin/k3s", "crictl", "images", "-o", "json"])) as { images: { repoTags?: string[] }[] };
  const pause = images.images.flatMap((image) => image.repoTags ?? []).find((tag) => tag.includes("/mirrored-pause:"));
  if (!pause) throw new Error("The node has no pause image");
  await kubectl(["apply", "-f", "-"], {
    stdin: JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "noshell", namespace: NS },
      spec: { nodeName: "server-1", containers: [{ name: "app", image: pause, imagePullPolicy: "Never" }] },
    }),
  });
  await kubectl(["wait", "--for=condition=Ready", "pod/noshell", "-n", NS, "--timeout=120s"]);
  const execIn = (argv: string[]): KubectlCall => ({ args: ["exec", "noshell", "-c", "app", "--", ...argv], namespace: NS, mutating: false });
  samples.keep("exec/sh-not-found.txt", "exec --workdir in an image without a shell", await dockflow(nodes.server, execIn(wrapExecArgv(["ls"], "/tmp", undefined))));
  samples.keep("exec/named-shell-stat.txt", "shell /bin/bash in an image without bash", await dockflow(nodes.server, execIn(["/bin/bash", "-c", "exit 0"])));
  samples.keep("exec/tar-not-found.txt", "cp from an image without tar", await dockflow(nodes.server, execIn(["tar", "cf", "-", ...containerTarArgs("/etc/hostname")])));
}

async function recordAdmission(nodes: Nodes, samples: Samples, webhook: Webhook): Promise<void> {
  const { server } = nodes;
  await apply([namespaceObject({ project: FIXTURE_PROJECT, env: "staging" })]);
  const untrusted = stackManifests([objectOf(render(POLICY_NS, webService(UNTRUSTED_IMAGE)), "Deployment", "web")]);
  const deploy = (): Promise<Run> => dockflow(server, applyCall(untrusted, { namespace: POLICY_NS, dryRun: false }));

  samples.keep("AdmissionDenied/1.txt", "an admission webhook denies the image", await withWebhook(webhook.url("/deny"), webhook.caBundle, 10, deploy));

  await kubectl(["label", "namespace", POLICY_NS, "pod-security.kubernetes.io/enforce=restricted", "--overwrite"]);
  try {
    const helper = buildHelperPod({
      name: "dockflow-helper-backup-3f9a2c1b",
      namespace: POLICY_NS,
      identity: { project: FIXTURE_PROJECT, namespace: POLICY_NS },
      composeService: "db",
      helperImage: k3sDistribution.traits.helperImage,
      mounts: [],
      readOnly: true,
      nodeName: "server-1",
    });
    samples.keep("AdmissionDenied/2.txt", "PodSecurity restricted rejects the backup helper pod", await dockflow(server, createCall(emitObject(helper), { namespace: POLICY_NS })));
  } finally {
    await kubectl(["label", "namespace", POLICY_NS, "pod-security.kubernetes.io/enforce-"]);
  }

  const policy = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicy",
    metadata: { name: "untrusted-images" },
    spec: {
      failurePolicy: "Fail",
      matchConstraints: { resourceRules: [{ apiGroups: ["apps"], apiVersions: ["v1"], operations: ["CREATE", "UPDATE"], resources: ["deployments"] }] },
      validations: [{ expression: "object.spec.template.spec.containers.all(c, !c.image.startsWith('registry.example.com/untrusted/'))", message: DENIAL }],
    },
  };
  const binding = {
    apiVersion: "admissionregistration.k8s.io/v1",
    kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name: "untrusted-images" },
    spec: { policyName: "untrusted-images", validationActions: ["Deny"], matchResources: { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": POLICY_NS } } } },
  };
  await kubectl(["apply", "-f", "-"], { stdin: JSON.stringify({ apiVersion: "v1", kind: "List", items: [policy, binding] }) });
  try {
    let denied: Run | undefined;
    // a new policy takes a moment to be enforced
    await waitFor(
      async () => {
        const run = await deploy();
        if (run.exitCode !== 0) denied = run;
        return denied;
      },
      { timeoutMs: 60_000, intervalMs: 2000, describe: "the ValidatingAdmissionPolicy to be enforced" },
    );
    if (denied) samples.keep("AdmissionDenied/3.txt", "a ValidatingAdmissionPolicy denies the image", denied);
  } finally {
    await kubectl(["delete", "validatingadmissionpolicybinding", "untrusted-images", "--ignore-not-found"], { allowFailure: true });
    await kubectl(["delete", "validatingadmissionpolicy", "untrusted-images", "--ignore-not-found"], { allowFailure: true });
  }
  await kubectl(["delete", "deployment", "web", "-n", POLICY_NS, "--ignore-not-found"], { allowFailure: true });

  samples.keep(
    "AdmissionDenied/4.txt",
    "the admission webhook of the cluster does not answer",
    await withWebhook(`https://${nodes.host}:9/deny`, webhook.caBundle, 10, deploy),
  );
  samples.keep("AdmissionDenied/5.txt", "the admission webhook of the cluster answers after its timeout", await withWebhook(webhook.url("/slow"), webhook.caBundle, 3, deploy));
}

async function recordTerminating(nodes: Nodes, samples: Samples): Promise<void> {
  await apply([namespaceObject({ project: FIXTURE_PROJECT, env: "preview" })]);
  await holdConfigMap(TERMINATING_NS, "held");
  await kubectl(["delete", "namespace", TERMINATING_NS, "--wait=false"]);
  await waitFor(
    async () => {
      const [ns] = await getJson<{ status?: { phase?: string } }>("namespaces", { name: TERMINATING_NS });
      return ns?.status?.phase === "Terminating" ? true : undefined;
    },
    { timeoutMs: 60_000, describe: `namespace ${TERMINATING_NS} to be terminating` },
  );
  const web = render(TERMINATING_NS, webService());
  samples.keep(
    "NamespaceTerminating/1.txt",
    "a deploy right after the stack namespace was deleted",
    await dockflow(nodes.server, applyCall(stackManifests(web), { namespace: TERMINATING_NS, dryRun: false })),
  );
  samples.keep(
    "NamespaceTerminating/2.txt",
    "a release written right after the stack namespace was deleted",
    await dockflow(nodes.server, createCall(buildReleaseSecret({ project: FIXTURE_PROJECT, env: "preview" }, releaseInput()).yaml, { namespace: TERMINATING_NS })),
  );
}

async function recordIdentity(nodes: Nodes, samples: Samples): Promise<void> {
  const { server, agent } = nodes;
  const configMap = emitObject({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "dockflow-state", namespace: NS }, data: { schema: "1" } });
  const read = (container: string): Promise<Run> => dockflow(container, getJsonCall(["deployments"], { namespace: NS }));
  const write = (container: string): Promise<Run> => dockflow(container, applyCall(configMap, { namespace: NS, dryRun: false, fieldManager: "dockflow-release-state" }));

  // the ClusterRoleBinding of the deploy identity removed, then restored
  await kubectl(["delete", "clusterrolebinding", K8S_DEPLOYER_CLUSTER_ROLE_BINDING], { allowFailure: true });
  try {
    let forbidden: Run | undefined;
    await waitFor(
      async () => {
        const run = await read(server);
        if (run.stderr.includes("(Forbidden)")) forbidden = run;
        return forbidden;
      },
      { timeoutMs: 60_000, describe: "the deploy identity to lose its rights" },
    );
    if (forbidden) samples.keep("Forbidden/1.txt", `ClusterRoleBinding ${K8S_DEPLOYER_CLUSTER_ROLE_BINDING} is missing`, forbidden);
    samples.keep(
      "Forbidden/2.txt",
      `ClusterRoleBinding ${K8S_DEPLOYER_CLUSTER_ROLE_BINDING} is missing (namespace of a first deploy)`,
      await dockflow(server, applyCall(emitObject(namespaceObject({ project: FIXTURE_PROJECT, env: "demo" })), { dryRun: false })),
    );
  } finally {
    await kubectl(["apply", "-f", "-"], { stdin: JSON.stringify(deployerClusterRoleBinding()) });
  }
  await waitFor(async () => ((await read(server)).exitCode === 0 ? true : undefined), { timeoutMs: 60_000, describe: "the deploy identity to get its rights back" });

  const kubeconfig = await readOnNode(server, K8S_KUBECONFIG_PATH);
  await withKubeconfig(server, replaceField(kubeconfig, "token", Buffer.from("not-a-valid-token").toString("base64")), async () => {
    samples.keep("Unauthorized/1.txt", "the token of the deploy identity is no longer valid", await read(server));
    samples.keep("Unauthorized/2.txt", "the token of the deploy identity is no longer valid (apply)", await write(server));
  });
  const otherCa = Buffer.from(await readOnNode(server, "/var/lib/rancher/k3s/server/tls/client-ca.crt")).toString("base64");
  await withKubeconfig(server, replaceField(kubeconfig, "certificate-authority-data", otherCa), async () => {
    samples.keep("CertificateMismatch/1.txt", "the kubeconfig trusts another certificate authority (cluster reinstalled)", await read(server));
    samples.keep("CertificateMismatch/2.txt", "the kubeconfig trusts another certificate authority (apply)", await write(server));
  });

  await withKubeconfig(agent, kubeconfig, async () => {
    samples.keep("Unreachable/1.txt", "no API server answers on the node (k3s stopped)", await read(agent));
    samples.keep("Unreachable/2.txt", "no API server answers on the node (apply)", await write(agent));
  });
  await withKubeconfig(server, replaceField(kubeconfig, "server", "https://192.0.2.1:6443"), async () => {
    samples.keep("Unreachable/3.txt", "the API server address does not answer at all", await read(server));
  });

  samples.keep("KubeconfigMissing/1.txt", "the node has no Dockflow kubeconfig", await read(agent));
  samples.keep("KubeconfigMissing/2.txt", "the SSH user cannot read the Dockflow kubeconfig", await dockflow(server, getJsonCall(["deployments"], { namespace: NS }), { user: "ubuntu" }));
}

async function recordToolMissing(nodes: Nodes, samples: Samples): Promise<void> {
  // a node before `dockflow setup`: the image the e2e nodes start from
  const image = (await exec(["docker", "inspect", "-f", "{{.Config.Image}}", nodes.server])).trim();
  const kubectlLine = kubectlCommand(k3sDistribution, getJsonCall(["namespaces"], { name: NS }));
  const helmLine = helmCommand({ args: ["list", "-n", NS, "-o", "json"] });
  // sshd starts the login shell by its bare name, and so does this
  const inFreshNode = async (shellName: "sh" | "bash", command: string): Promise<Run> => {
    const result = await tryExec(["docker", "run", "--rm", "--entrypoint", shellName, image, "-c", command]);
    return { command: `${shellName} -c '${command}'`, exitCode: result.exitCode, stderr: result.stderr };
  };
  samples.keep("ToolMissing/1.txt", "k3s is not installed (a shell that is dash)", await inFreshNode("sh", kubectlLine));
  samples.keep("ToolMissing/2.txt", "k3s is not installed (a shell that is bash)", await inFreshNode("bash", kubectlLine));
  samples.keep("ToolMissing/3.txt", `helm is not installed at ${HELM_BIN_PATH}`, await inFreshNode("bash", helmLine));
}

// ─── scrub and write ──────────────────────────────────────────────

const KLOG_HEADER = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d{6}\s+\d+ /gm;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const EXEC_ID = /failed to start exec "[0-9a-f]{64}"/g;
const RESOURCE_VERSION = /(ResourceVersion in (?:the precondition|record) \()(\d+)\)/g;
/** the alphabet of generated names (apimachinery utilrand), for a Deployment pod `<name>-<hash>-<suffix>` */
const GENERATED_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";
const POD_NAME = new RegExp(`\\b(web|db)-([${GENERATED_ALPHABET}]{8,10})-([${GENERATED_ALPHABET}]{5})\\b`, "g");

function stableChars(seed: string, length: number): string {
  const digest = createHash("sha256").update(seed).digest();
  return Array.from({ length }, (_, i) => GENERATED_ALPHABET[digest[i] % GENERATED_ALPHABET.length]).join("");
}

function numbered(map: Map<string, string>, key: string, make: (n: number) => string): string {
  const known = map.get(key);
  if (known) return known;
  const value = make(map.size + 1);
  map.set(key, value);
  return value;
}

function scrubber(topo: Topology): (file: string, text: string) => string {
  const uids = new Map<string, string>();
  const versions = new Map<string, string>();
  // node addresses as the kubectl fixtures write them, the host (the webhook's address) as .1
  const octets = new Map<string, string>([["1", "1"]]);
  for (const node of topo.nodes) octets.set(node.ip.split(".")[3], node.key === "server_1" ? "11" : node.key === "agent_1" ? "12" : String(20 + octets.size));
  const lane = new RegExp(`(?<![\\d.])${topo.net.replace(/\./g, "\\.")}\\.(\\d{1,3})(?![\\d.])`, "g");
  return (file, text) =>
    text
      .replace(/\r\n/g, "\n")
      .replace(KLOG_HEADER, (_match, level: string) => `${level}0101 00:00:00.000000       1 `)
      .replace(UUID, (uid) => numbered(uids, uid, (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`))
      .replace(EXEC_ID, () => `failed to start exec "${sha256Hex(`${file}:exec`)}"`)
      .replace(RESOURCE_VERSION, (_match, head: string, version: string) => `${head}${numbered(versions, version, String)})`)
      .replace(POD_NAME, (_match, base: string, hash: string) => `${base}-${stableChars(`${file}:${base}:hash`, hash.length)}-${stableChars(`${file}:${base}:pod`, 5)}`)
      .replace(lane, (_match, octet: string) => `192.0.2.${octets.get(octet) ?? octet}`);
}

function writeSamples(samples: readonly Sample[], topo: Topology): void {
  const scrub = scrubber(topo);
  const files: FixtureFile[] = samples.map(({ file, run }) => ({ path: file, text: scrub(file, run.stderr) }));
  const violations = scrubViolations(files);
  if (violations.length > 0) throw new Error(`The kubectl stderr samples did not scrub cleanly:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  rmSync(STDERR_ROOT, { recursive: true, force: true });
  for (const file of files) {
    const path = join(STDERR_ROOT, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  const steps = [...samples]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ file, how, run }) => `${file}: ${how}; stderr of ${scrub(file, run.command)}`);
  const meta = { recordedOn: new Date().toISOString().slice(0, 10), k3sVersion: K3S_PIN.version, steps };
  writeFileSync(join(STDERR_ROOT, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  log(`[stderr] ${files.length} sample(s) written to ${STDERR_ROOT}`);
}

export async function recordKubectlStderr(): Promise<void> {
  const topo = currentTopology();
  const server = managersOf(topo)[0];
  if (!server) throw new Error(`Topology ${topo.name} has no server node`);
  const nodes: Nodes = { server: server.container, agent: nodeFor(topo, "agent_1").container, host: `${topo.net}.1`, net: topo.net };
  for (const ns of [NS, POLICY_NS, TERMINATING_NS]) await deleteNamespace(ns);
  await kubectl(["delete", "lease", leaseNameFor(NS), "-n", K8S_SYSTEM_NAMESPACE, "--ignore-not-found"], { allowFailure: true });

  const samples = new Samples();
  const webhook = await startWebhook(nodes.host);
  try {
    await recordNotFoundAndWrites(nodes, samples);
    await recordInvalidAndImmutable(nodes, samples);
    await recordNoKindMatch(nodes, samples);
    await recordTimeoutAndUnknown(nodes, samples);
    await recordExec(nodes, samples);
    await recordAdmission(nodes, samples, webhook);
    await recordTerminating(nodes, samples);
    await recordIdentity(nodes, samples);
    await recordToolMissing(nodes, samples);
  } finally {
    webhook.stop();
    for (const ns of [NS, POLICY_NS, TERMINATING_NS]) await deleteNamespace(ns);
    await kubectl(["delete", "lease", leaseNameFor(NS), "-n", K8S_SYSTEM_NAMESPACE, "--ignore-not-found"], { allowFailure: true });
  }
  writeSamples(samples.kept, topo);
}
