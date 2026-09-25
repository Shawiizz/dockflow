// Readiness verification (design-05 16): the pure node-readiness evaluator the coordinator polls
// with (16.1), the cluster verification `finalize` builds from the node's own admin kubeconfig
// (16.2), the deploy-identity check evaluator the coordinator's deploy-SSH probes feed (16.3), the
// network check DaemonSet and its ring procedure (16.4), and the exposure probe (16.5).

import { K8S_DEPLOYER_CLUSTER_ROLE_BINDING, K8S_DEPLOYER_SERVICE_ACCOUNT, K8S_DEPLOYER_TOKEN_SECRET, K8S_MANAGED_BY, K8S_STORAGE_CLASS, K8S_SYSTEM_NAMESPACE, KUBE_KEYS, LABELS, PARTS } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import type { DaemonSet, Deployment } from '../../../services/orchestrator/kubernetes/resources/apps';
import type { ClusterRoleBinding, Node, Pod, PodSecurityContext, SecurityContext, ServiceAccount, Secret } from '../../../services/orchestrator/kubernetes/resources/core';
import type { StorageClass } from '../../../services/orchestrator/kubernetes/resources/storage';
import type { KubeExecutor } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { emitObject } from '../../../services/orchestrator/kubernetes/yaml';
import {
  LOCAL_PATH_STORAGE_CLASS,
  NETCHECK_CLEANUP_TIMEOUT_S,
  NETCHECK_DAEMONSET,
  NETWORK_CHECK_RETRY_INTERVAL_MS,
  NETWORK_CHECK_RETRY_S,
  NETWORK_CHECK_TIMEOUT_S,
  REACHABILITY_PROBE_TIMEOUT_S,
  SYSTEM_COMPONENTS_TIMEOUT_S,
} from './constants';
import { SetupStepError } from './host-runner';
import type { SetupProblem } from './messages';
import type { FlannelBackend } from './plan';

const KUBE_SYSTEM_NAMESPACE = 'kube-system';
const NETWORK_CHECK_POLL_MS = 3000;
const COMPONENTS_POLL_MS = 3000;

export const verifyMessages = {
  netcheckTimeout: (timeoutS: number, notReady: readonly string[]): SetupProblem => ({
    message: `The network check DaemonSet did not become ready within ${timeoutS}s (${notReady.join(', ') || 'no pods reported'})`,
    suggestion: 'Check that every node can pull rancher/mirrored-library-busybox and schedule pods, then re-run setup.',
  }),
  podUnreachable: (from: string, to: string, ip: string, backend: FlannelBackend): SetupProblem => ({
    message: `Pod network check failed: a pod on ${from} cannot reach a pod on ${to} (${ip}:8080)`,
    suggestion: `Allow ${backend === 'wireguard-native' ? 'UDP 51820' : 'UDP 8472 (vxlan)'} between the two nodes, then re-run setup.`,
  }),
  dnsCheckFailed: (from: string): SetupProblem => ({
    message: `Cluster DNS does not answer from ${from}`,
    suggestion: 'Allow TCP/UDP from 10.42.0.0/16 on every node (host firewall), then re-run setup.',
  }),
  exposed: (label: string, key: string, addr: string, port: number, env: string): SetupProblem => ({
    message: `The ${label} of ${key} answers on ${addr}:${port} from outside the cluster`,
    suggestion: `Deny ${port} from every address except the other nodes in your provider firewall, then check again with \`dockflow setup k3s ${env} --dry-run\`.`,
  }),
} as const;

// ---------------------------------------------------------------------------
// 16.1 Node Ready (pure evaluator; the coordinator polls with it over its own connection)
// ---------------------------------------------------------------------------

export interface NodeReadinessExpectation {
  key: string;
  name: string;
  kubeletVersion: string;
  nodeIp: string | null;
  nodeExternalIp: string | null;
  controlPlane: boolean;
  etcdMember: boolean;
  timeoutS: number;
}

/** One row of 16.1: the first check that fails, or null when the node is fully registered. */
export function evaluateNodeReadiness(node: Node | undefined, expected: NodeReadinessExpectation): SetupProblem | null {
  if (node === undefined) {
    return {
      message: `${expected.key} did not register as node ${expected.name} within ${expected.timeoutS}s`,
      suggestion: `Check that ${expected.key} reaches its join URL (TCP 6443) and run journalctl -u k3s-agent -n 100 on ${expected.key}.`,
    };
  }
  const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') {
    return {
      message: `Node ${expected.name} is registered but not Ready: ${ready?.reason ?? 'Unknown'}: ${ready?.message ?? 'no condition reported'}`,
      suggestion: `Run journalctl -u k3s -n 100 on ${expected.key}.`,
    };
  }
  const version = node.status?.nodeInfo?.kubeletVersion;
  if (version !== expected.kubeletVersion) {
    return { message: `Node ${expected.name} runs ${version ?? 'an unknown version'}, expected ${expected.kubeletVersion}`, suggestion: `Run journalctl -u k3s -n 100 on ${expected.key}.` };
  }
  const addresses = node.status?.addresses ?? [];
  const internal = addresses.find((a) => a.type === 'InternalIP')?.address ?? null;
  if (expected.nodeIp !== null && internal !== expected.nodeIp) {
    return {
      message: `Node ${expected.name} registered with InternalIP ${internal ?? 'none'}, expected ${expected.nodeIp} (private_host)`,
      suggestion: `Reset ${expected.key} if its address changed: dockflow setup k3s <env> --reset --node ${expected.key}.`,
    };
  }
  const external = addresses.find((a) => a.type === 'ExternalIP')?.address ?? null;
  if (expected.nodeExternalIp !== null && external !== expected.nodeExternalIp) {
    return { message: `Node ${expected.name} has ExternalIP ${external ?? 'none'}, expected ${expected.nodeExternalIp}`, suggestion: 'Check the node public address, then re-run setup.' };
  }
  const roleLabel = expected.etcdMember ? 'node-role.kubernetes.io/etcd' : expected.controlPlane ? 'node-role.kubernetes.io/control-plane' : null;
  if (roleLabel !== null && node.metadata.labels?.[roleLabel] !== 'true') {
    return { message: `Node ${expected.name} is missing the ${roleLabel} label`, suggestion: `Run journalctl -u k3s -n 100 on ${expected.key}.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secrets encryption status (section 9)
// ---------------------------------------------------------------------------

export interface EncryptionStatus {
  enabled: boolean;
  activeKey: string;
  hashMatch: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `k3s secrets-encrypt status -o json` stdout -> the parsed status and the failure it names, if any. */
export function evaluateEncryptionStatus(stdout: string, key: string): { status: EncryptionStatus; problem: SetupProblem | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const text = stdout.trim() || 'no output';
    return { status: { enabled: false, activeKey: '', hashMatch: false }, problem: encryptionProblem(key, text) };
  }
  const obj = isRecord(parsed) ? parsed : {};
  const enabled = obj.enable === true;
  const activeKey = typeof obj.activekey === 'string' ? obj.activekey : '';
  const hashMatch = obj.hashmatch === true;
  const status: EncryptionStatus = { enabled, activeKey, hashMatch };
  if (enabled && activeKey.startsWith('XSalsa20-POLY1305 ') && hashMatch) return { status, problem: null };
  const detail = !enabled ? 'disabled' : !activeKey.startsWith('XSalsa20-POLY1305 ') ? `active key is ${activeKey || 'unset'}` : 'keys are out of sync across servers';
  return { status, problem: encryptionProblem(key, detail) };
}

function encryptionProblem(key: string, detail: string): SetupProblem {
  return { message: `Secrets encryption is not active on ${key} (${detail})`, suggestion: `Run k3s secrets-encrypt status on ${key}.` };
}

/** Section 9 across every server's `control-plane` report: the first one out of sync fails the run. */
export function evaluateEncryptionAcrossServers(reports: readonly { key: string; status: EncryptionStatus }[]): SetupProblem | null {
  const bad = reports.find((r) => !r.status.enabled || !r.status.activeKey.startsWith('XSalsa20-POLY1305 ') || !r.status.hashMatch);
  return bad === undefined ? null : encryptionProblem(bad.key, 'section 9');
}

// ---------------------------------------------------------------------------
// 16.4 Network check
// ---------------------------------------------------------------------------

/** The hardened, single-container DaemonSet of 16.4: one constant string served over plain HTTP. */
export function netcheckDaemonSet(): DaemonSet {
  const labels = { [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.name]: NETCHECK_DAEMONSET, [LABELS.part]: PARTS.helper };
  const podSecurityContext: PodSecurityContext = { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } };
  const containerSecurityContext: SecurityContext = {
    allowPrivilegeEscalation: false,
    runAsNonRoot: true,
    runAsUser: 65534,
    runAsGroup: 65534,
    readOnlyRootFilesystem: true,
    seccompProfile: { type: 'RuntimeDefault' },
    capabilities: { drop: ['ALL'] },
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: NETCHECK_DAEMONSET, namespace: K8S_SYSTEM_NAMESPACE, labels },
    spec: {
      selector: { matchLabels: { [LABELS.name]: NETCHECK_DAEMONSET } },
      template: {
        metadata: { labels },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 1,
          securityContext: podSecurityContext,
          tolerations: [{ operator: 'Exists' }],
          volumes: [{ name: 'www', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } }],
          containers: [
            {
              name: 'netcheck',
              image: 'rancher/mirrored-library-busybox:1.37.0',
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', 'echo dockflow-netcheck-ok > /www/index.html && exec httpd -f -p 8080 -h /www'],
              ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
              volumeMounts: [{ name: 'www', mountPath: '/www' }],
              securityContext: containerSecurityContext,
              resources: { requests: { cpu: '10m', memory: '8Mi' }, limits: { memory: '32Mi' } },
            },
          ],
        },
      },
    },
  };
}

export async function applyNetcheckDaemonSet(kube: KubeExecutor): Promise<void> {
  await kube.apply(`---\n${emitObject(netcheckDaemonSet())}`, { dryRun: false });
}

/** 4.7 step 1: removed *before* a fresh one is applied, so an interrupted run never leaves two. */
export async function removeNetcheckDaemonSet(kube: KubeExecutor): Promise<'removed' | 'absent'> {
  const existing = await kube.getJson<DaemonSet>(['daemonset'], { namespace: K8S_SYSTEM_NAMESPACE, name: NETCHECK_DAEMONSET, allowNotFound: true });
  if (existing.length === 0) return 'absent';
  await kube.delete([`daemonset/${NETCHECK_DAEMONSET}`], { namespace: K8S_SYSTEM_NAMESPACE, wait: true, timeoutS: NETCHECK_CLEANUP_TIMEOUT_S, ignoreNotFound: true });
  return 'removed';
}

/** The check's own cleanup (16.4 point 3): never blocks on the delete finishing. */
async function removeNetcheckDaemonSetNoWait(kube: KubeExecutor): Promise<void> {
  await kube.delete([`daemonset/${NETCHECK_DAEMONSET}`], { namespace: K8S_SYSTEM_NAMESPACE, wait: false, ignoreNotFound: true });
}

export type NetcheckStepKind = 'wget-ring' | 'wget-first' | 'nslookup';

export interface NetcheckStep {
  podIndex: number;
  kind: NetcheckStepKind;
  targetIndex?: number;
}

/**
 * The ring plus every pod's check on the first server (16.4): each pod wgets its ring neighbour and
 * (when that is not already the first server) the first server's pod, plus one DNS lookup. A
 * duplicate target for the same pod is issued once.
 */
export function netcheckPlan(nodeCount: number): NetcheckStep[] {
  const steps: NetcheckStep[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const ringTarget = (i + 1) % nodeCount;
    steps.push({ podIndex: i, kind: 'wget-ring', targetIndex: ringTarget });
    if (i !== 0 && ringTarget !== 0) steps.push({ podIndex: i, kind: 'wget-first', targetIndex: 0 });
    steps.push({ podIndex: i, kind: 'nslookup' });
  }
  return steps;
}

function waitingReasonOf(pod: Pod): string {
  const waiting = pod.status?.containerStatuses?.find((c) => c.state?.waiting !== undefined)?.state?.waiting;
  return waiting?.reason ?? pod.status?.phase ?? 'Unknown';
}

async function waitForNetcheckPods(kube: KubeExecutor, clock: Clock, nodeCount: number, timeoutS: number): Promise<Pod[]> {
  const deadline = clock.now().getTime() + timeoutS * 1000;
  for (;;) {
    const [ds] = await kube.getJson<DaemonSet>(['daemonset'], { namespace: K8S_SYSTEM_NAMESPACE, name: NETCHECK_DAEMONSET, allowNotFound: true });
    const pods = await kube.getJson<Pod>(['pods'], { namespace: K8S_SYSTEM_NAMESPACE, selector: `${LABELS.name}=${NETCHECK_DAEMONSET}` });
    if (ds !== undefined && ds.status?.numberReady === nodeCount && ds.status?.desiredNumberScheduled === nodeCount) {
      return [...pods].sort((a, b) => (a.spec.nodeName ?? '').localeCompare(b.spec.nodeName ?? ''));
    }
    if (clock.now().getTime() >= deadline) {
      const ready = new Set(pods.filter((p) => p.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True').map((p) => p.metadata.name));
      const notReady = pods.filter((p) => !ready.has(p.metadata.name)).map((p) => `${p.metadata.name} (${waitingReasonOf(p)})`);
      const problem = verifyMessages.netcheckTimeout(timeoutS, notReady);
      throw new SetupStepError(problem.message, problem.suggestion);
    }
    await clock.sleep(NETWORK_CHECK_POLL_MS);
  }
}

async function execIn(kube: KubeExecutor, pod: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await kube.run({ args: ['exec', pod, '--', ...args], namespace: K8S_SYSTEM_NAMESPACE, mutating: false, allowFailure: true });
  return { ok: result.exitCode === 0, stdout: result.stdout };
}

export interface NetworkCheckResult {
  ran: boolean;
  ok: boolean;
  failures: string[];
}

export interface NetworkCheckOptions {
  nodeCount: number;
  flannelBackend: FlannelBackend;
  timeoutS?: number;
  /** how long each probe retries before it counts as failed; default NETWORK_CHECK_RETRY_S */
  retryS?: number;
}

/** Runs `probe` until it succeeds or `retryS` elapsed; the last attempt's outcome decides. */
async function retryProbe(clock: Clock, retryS: number, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = clock.now().getTime() + retryS * 1000;
  for (;;) {
    if (await probe()) return true;
    if (clock.now().getTime() >= deadline) return false;
    await clock.sleep(NETWORK_CHECK_RETRY_INTERVAL_MS);
  }
}

/** The network check of 16.4: skipped on a single node (nothing cross-node to verify). */
export async function runNetworkCheck(kube: KubeExecutor, clock: Clock, options: NetworkCheckOptions): Promise<NetworkCheckResult> {
  if (options.nodeCount <= 1) return { ran: false, ok: true, failures: [] };
  try {
    const pods = await waitForNetcheckPods(kube, clock, options.nodeCount, options.timeoutS ?? NETWORK_CHECK_TIMEOUT_S);
    const retryS = options.retryS ?? NETWORK_CHECK_RETRY_S;
    const failures: string[] = [];
    for (const step of netcheckPlan(pods.length)) {
      const pod = pods[step.podIndex];
      const podLabel = pod.spec.nodeName ?? pod.metadata.name;
      if (step.kind === 'nslookup') {
        const answered = await retryProbe(clock, retryS, async () => (await execIn(kube, pod.metadata.name, ['nslookup', 'kubernetes.default.svc.cluster.local'])).ok);
        if (!answered) failures.push(verifyMessages.dnsCheckFailed(podLabel).message);
        continue;
      }
      const target = pods[step.targetIndex ?? 0];
      const ip = target.status?.podIP ?? '';
      const reached = await retryProbe(clock, retryS, async () => {
        const { ok, stdout } = await execIn(kube, pod.metadata.name, ['wget', '-q', '-T', '3', '-O', '-', `http://${ip}:8080/`]);
        return ok && stdout.trim() === 'dockflow-netcheck-ok';
      });
      if (!reached) {
        failures.push(verifyMessages.podUnreachable(podLabel, target.spec.nodeName ?? target.metadata.name, ip, options.flannelBackend).message);
      }
    }
    return { ran: true, ok: failures.length === 0, failures };
  } finally {
    await removeNetcheckDaemonSetNoWait(kube);
  }
}

// ---------------------------------------------------------------------------
// 16.2 Cluster verification
// ---------------------------------------------------------------------------

export interface ClusterVerification {
  nodes: { name: string; key: string | null; ready: boolean; version: string; internalIp: string | null; roles: string[] }[];
  expectedNodes: number;
  readyNodes: number;
  unknownNodes: string[];
  etcdMembers: number | null;
  components: { name: string; namespace: string; ready: boolean; required: boolean; detail: string }[];
  storageClass: StorageClassVerification;
  deployer: { serviceAccount: boolean; binding: boolean; token: boolean };
  networkCheck: NetworkCheckResult;
  problems: { severity: 'error' | 'warning'; message: string; suggestion?: string }[];
}

export interface StorageClassVerification {
  present: boolean;
  reclaimPolicy: string | null;
  isDefault: boolean;
  /** every class of the cluster carrying the default annotation, newest last (11.2) */
  defaults: { name: string; createdAt: string }[];
  /** true when dockflow-local is the only default AND the most recently created one */
  effectiveDefault: boolean;
}

function isDefaultClass(sc: StorageClass): boolean {
  return sc.metadata.annotations?.[KUBE_KEYS.defaultStorageClass] === 'true';
}

function defaultsOf(classes: readonly StorageClass[]): { name: string; createdAt: string }[] {
  return classes
    .filter(isDefaultClass)
    .map((sc) => ({ name: sc.metadata.name, createdAt: sc.metadata.creationTimestamp ?? '' }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** The read-only mirror of `system.ts`'s `assertSingleDefaultStorageClass` (16.2, V9). */
export function evaluateStorageClasses(classes: readonly StorageClass[], env: string): { storageClass: StorageClassVerification; problem: SetupProblem | null } {
  const byName = new Map(classes.map((sc) => [sc.metadata.name, sc]));
  const dockflowLocal = byName.get(K8S_STORAGE_CLASS);
  const localPath = byName.get(LOCAL_PATH_STORAGE_CLASS);
  const defaults = defaultsOf(classes);
  const present = dockflowLocal !== undefined;
  const reclaimPolicy = dockflowLocal?.reclaimPolicy ?? null;
  const isDockflowDefault = dockflowLocal !== undefined && isDefaultClass(dockflowLocal);

  const fail = (message: string, suggestion: string): { storageClass: StorageClassVerification; problem: SetupProblem } => ({
    storageClass: { present, reclaimPolicy, isDefault: isDockflowDefault, defaults, effectiveDefault: false },
    problem: { message, suggestion },
  });

  if (!present) return fail(`StorageClass ${K8S_STORAGE_CLASS} is missing on ${env}`, 'Run `dockflow setup k3s <env>` again.');
  if (reclaimPolicy !== 'Retain') {
    return fail(
      `StorageClass ${K8S_STORAGE_CLASS} on ${env} has reclaimPolicy ${reclaimPolicy}, and Dockflow needs Retain`,
      'Delete it after checking that no PersistentVolume uses it (`kubectl get pv`), then run setup again.',
    );
  }
  const competing = defaults.filter((entry) => entry.name !== K8S_STORAGE_CLASS);
  if (competing.length > 0) {
    const [name] = competing.map((entry) => entry.name).sort();
    const sc = byName.get(name);
    return fail(
      `StorageClass ${name} on ${env} is also marked default, so a chart volume without storageClass could bind to it instead of dockflow-local (${name} reclaimPolicy ${sc?.reclaimPolicy ?? 'Delete'})`,
      `Remove the annotation from ${name} (\`kubectl annotate storageclass ${name} storageclass.kubernetes.io/is-default-class=false --overwrite\`) and run setup again.`,
    );
  }
  if (!isDockflowDefault) return fail(`StorageClass ${K8S_STORAGE_CLASS} on ${env} does not carry the default annotation`, 'Run `dockflow setup k3s <env>` again.');
  if (localPath !== undefined && (localPath.metadata.creationTimestamp ?? '') > (dockflowLocal?.metadata.creationTimestamp ?? '')) {
    return fail(
      `StorageClass ${LOCAL_PATH_STORAGE_CLASS} on ${env} is also marked default and was created after dockflow-local`,
      '`storage-default` repairs this on the next setup run.',
    );
  }
  return { storageClass: { present, reclaimPolicy, isDefault: true, defaults, effectiveDefault: true }, problem: null };
}

/** HA row of 16.2 (V3): the etcd-labelled node count must equal the planned server count. `expected <= 0` is outside HA (no check). */
export function evaluateEtcdMembers(count: number, expected: number, env: string): SetupProblem | null {
  if (expected <= 0 || count === expected) return null;
  return {
    message: `${count} etcd members were found on ${env}, expected ${expected}`,
    suggestion: `Run \`k3s etcd-snapshot list\` on a server of ${env} and \`journalctl -u k3s -n 100\` on any server that never joined.`,
  };
}

const REQUIRED_COMPONENTS: readonly { name: string; required: boolean }[] = [
  { name: 'coredns', required: true },
  { name: 'local-path-provisioner', required: true },
  { name: 'metrics-server', required: false },
];

function isComponentReady(dep: Deployment | undefined): boolean {
  if (dep === undefined) return false;
  const wanted = dep.spec.replicas ?? 1;
  return (dep.status?.availableReplicas ?? 0) >= wanted && (dep.status?.observedGeneration ?? 0) >= (dep.metadata.generation ?? 0);
}

/** The row set of 16.2's component table (V4, table-driven over already-fetched fixtures). */
export function evaluateComponentsList(deployments: readonly Deployment[]): ClusterVerification['components'] {
  return REQUIRED_COMPONENTS.map((component) => {
    const dep = deployments.find((d) => d.metadata.name === component.name);
    const ready = isComponentReady(dep);
    return { name: component.name, namespace: KUBE_SYSTEM_NAMESPACE, ready, required: component.required, detail: dep === undefined ? 'not found' : ready ? 'available' : 'not available' };
  });
}

async function pollComponentsReady(kube: KubeExecutor, clock: Clock, timeoutS: number): Promise<Deployment[]> {
  const deadline = clock.now().getTime() + timeoutS * 1000;
  for (;;) {
    const deployments = await kube.getJson<Deployment>(['deployments.apps'], { namespace: KUBE_SYSTEM_NAMESPACE });
    const settled = REQUIRED_COMPONENTS.every((component) => !component.required || isComponentReady(deployments.find((d) => d.metadata.name === component.name)));
    if (settled || clock.now().getTime() >= deadline) return deployments;
    await clock.sleep(COMPONENTS_POLL_MS);
  }
}

interface NamedObject {
  metadata: { name: string };
}

/** 10.1: the bundled Traefik must be absent (both its HelmCharts and the Deployment it would create). */
export async function evaluateTraefikAbsence(kube: KubeExecutor, env: string): Promise<SetupProblem | null> {
  const charts = await kube.getJson<NamedObject>(['helmcharts.helm.cattle.io'], { namespace: KUBE_SYSTEM_NAMESPACE, allowNotFound: true });
  const deployments = await kube.getJson<Deployment>(['deployments.apps'], { namespace: KUBE_SYSTEM_NAMESPACE, name: 'traefik', allowNotFound: true });
  const present = charts.some((c) => c.metadata.name === 'traefik' || c.metadata.name === 'traefik-crd') || deployments.length > 0;
  if (!present) return null;
  return {
    message: `The bundled Traefik is present on ${env}`,
    suggestion: 'Dockflow installs its own Traefik (proxy.enabled); reset the cluster or remove the kube-system HelmCharts traefik and traefik-crd.',
  };
}

export interface DeployerObjectsResult {
  summary: ClusterVerification['deployer'];
  problems: { severity: 'error' | 'warning'; message: string; suggestion?: string }[];
}

/** The deployer ServiceAccount, ClusterRoleBinding and token Secret (12.1), plus the F37 warning. */
export async function evaluateDeployerObjects(kube: KubeExecutor): Promise<DeployerObjectsResult> {
  const [sa] = await kube.getJson<ServiceAccount>(['serviceaccounts'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_DEPLOYER_SERVICE_ACCOUNT, allowNotFound: true });
  const [secret] = await kube.getJson<Secret>(['secrets'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_DEPLOYER_TOKEN_SECRET, allowNotFound: true });
  const [crb] = await kube.getJson<ClusterRoleBinding>(['clusterrolebindings'], { name: K8S_DEPLOYER_CLUSTER_ROLE_BINDING, allowNotFound: true });
  const problems: DeployerObjectsResult['problems'] = [];
  if (sa === undefined) problems.push({ severity: 'error', message: `ServiceAccount ${K8S_DEPLOYER_SERVICE_ACCOUNT} is missing from ${K8S_SYSTEM_NAMESPACE}` });
  if (crb === undefined) problems.push({ severity: 'error', message: `ClusterRoleBinding ${K8S_DEPLOYER_CLUSTER_ROLE_BINDING} is missing` });
  const tokenPresent = typeof secret?.data?.token === 'string' && secret.data.token !== '';
  if (!tokenPresent) problems.push({ severity: 'error', message: `Secret ${K8S_DEPLOYER_TOKEN_SECRET} in ${K8S_SYSTEM_NAMESPACE} has no data.token` });
  if (sa?.secrets?.some((entry) => entry.name === K8S_DEPLOYER_TOKEN_SECRET)) {
    problems.push({
      severity: 'warning',
      message: `ServiceAccount ${K8S_DEPLOYER_SERVICE_ACCOUNT} lists ${K8S_DEPLOYER_TOKEN_SECRET} in its secrets, which makes it eligible for the one-year legacy-token cleanup`,
      suggestion: `Remove the secrets entry from ServiceAccount ${K8S_DEPLOYER_SERVICE_ACCOUNT} (\`kubectl edit serviceaccount -n ${K8S_SYSTEM_NAMESPACE} ${K8S_DEPLOYER_SERVICE_ACCOUNT}\`).`,
    });
  }
  return { summary: { serviceAccount: sa !== undefined, binding: crb !== undefined, token: tokenPresent }, problems };
}

export interface ExpectedNode {
  key: string;
  name: string;
  kubeletVersion: string;
  controlPlane: boolean;
  etcdMember: boolean;
}

export interface ClusterVerificationOptions {
  env: string;
  expected: readonly ExpectedNode[];
  /** 0 outside HA (no member count check) */
  etcdExpected: number;
  /** one status per server, from each server's `control-plane` report (section 9) */
  encryption: readonly { key: string; status: EncryptionStatus }[];
  networkCheck: NetworkCheckResult;
  clock: Clock;
  componentsTimeoutS?: number;
}

/**
 * The `finalize` step's cluster verification (16.2): everything is read through the node's own admin
 * kubeconfig (`kube`), so this runs on the first ready server, not over SSH.
 */
export async function buildClusterVerification(kube: KubeExecutor, options: ClusterVerificationOptions): Promise<ClusterVerification> {
  const problems: ClusterVerification['problems'] = [];
  const addError = (message: string, suggestion?: string): void => {
    problems.push({ severity: 'error', message, suggestion });
  };
  const addWarning = (message: string, suggestion?: string): void => {
    problems.push({ severity: 'warning', message, suggestion });
  };

  const nodesJson = await kube.getJson<Node>(['nodes'], {});
  const expectedByName = new Map(options.expected.map((n) => [n.name, n]));
  const nodeViews = nodesJson.map((node) => {
    const name = node.metadata.name;
    const ready = node.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True';
    const version = node.status?.nodeInfo?.kubeletVersion ?? '';
    const internalIp = node.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ?? null;
    const roles = ['control-plane', 'etcd'].filter((role) => node.metadata.labels?.[`node-role.kubernetes.io/${role}`] === 'true');
    return { name, key: expectedByName.get(name)?.key ?? null, ready, version, internalIp, roles };
  });
  const unknownNodes = nodeViews.filter((n) => n.key === null).map((n) => n.name);
  for (const name of unknownNodes) addWarning(`Node ${name} is in the cluster but not declared in servers.yml`);
  for (const expected of options.expected) {
    const node = nodesJson.find((candidate) => candidate.metadata.name === expected.name);
    const problem = evaluateNodeReadiness(node, { ...expected, nodeIp: null, nodeExternalIp: null, timeoutS: 0 });
    if (problem !== null) addError(problem.message, problem.suggestion);
  }
  const readyNodes = nodeViews.filter((n) => n.ready).length;
  const etcdMembers = nodeViews.filter((n) => n.roles.includes('etcd')).length;
  const etcdProblem = evaluateEtcdMembers(etcdMembers, options.etcdExpected, options.env);
  if (etcdProblem !== null) addError(etcdProblem.message, etcdProblem.suggestion);

  const deployments = await pollComponentsReady(kube, options.clock, options.componentsTimeoutS ?? SYSTEM_COMPONENTS_TIMEOUT_S);
  const components = evaluateComponentsList(deployments);
  for (const component of components) {
    if (component.ready) continue;
    const line = `${component.name} in ${component.namespace} is not available`;
    if (component.required) addError(line);
    else addWarning(line);
  }

  const traefikProblem = await evaluateTraefikAbsence(kube, options.env);
  if (traefikProblem !== null) addError(traefikProblem.message, traefikProblem.suggestion);

  const classes = await kube.getJson<StorageClass>(['storageclass'], {});
  const storage = evaluateStorageClasses(classes, options.env);
  if (storage.problem !== null) addError(storage.problem.message, storage.problem.suggestion);

  const deployer = await evaluateDeployerObjects(kube);
  for (const problem of deployer.problems) problems.push(problem);

  const encryptionProblem = evaluateEncryptionAcrossServers(options.encryption);
  if (encryptionProblem !== null) addError(encryptionProblem.message, encryptionProblem.suggestion);

  if (options.networkCheck.ran && !options.networkCheck.ok) {
    for (const failure of options.networkCheck.failures) addError(failure);
  }

  return {
    nodes: nodeViews,
    expectedNodes: options.expected.length,
    readyNodes,
    unknownNodes,
    etcdMembers,
    components,
    storageClass: storage.storageClass,
    deployer: deployer.summary,
    networkCheck: options.networkCheck,
    problems,
  };
}

// ---------------------------------------------------------------------------
// 16.3 Deploy identity checks (pure evaluator; the coordinator runs the probes over deploy SSH)
// ---------------------------------------------------------------------------

export interface StatResult {
  owner: string;
  group: string;
  mode: string;
}

export interface DeployIdentityProbe {
  key: string;
  deployUser: string;
  server: boolean;
  /** every node with a deploy user other than root */
  sudoUser: boolean;
  whoami: string;
  kubeconfigStat: StatResult | null;
  kubeconfigDirStat: StatResult | null;
  tokenDirStat: StatResult | null;
  /** trimmed stdout of `auth can-i '*' '*' --all-namespaces` (servers) */
  authCanI: string | null;
  /** trimmed stdout of `get --raw=/readyz` (servers) */
  readyz: string | null;
  /** `test ! -r /etc/rancher/k3s/k3s.yaml` exit code == 0 (servers) */
  adminKubeconfigUnreadable: boolean | null;
  helmVersion: string | null;
  expectedHelmVersion: string;
  /** `sudo -n -l` rows of 13.4 all succeeding (non-root deploy user) */
  sudoImagesOk: boolean | null;
  /** `test ! -r /etc/rancher/k3s/dockflow/token` exit code == 0 */
  tokenFileUnreadable: boolean | null;
}

/** Every row of 16.3 that `probe` failed, in table order. */
export function evaluateDeployIdentityChecks(probe: DeployIdentityProbe): SetupProblem[] {
  const problems: SetupProblem[] = [];
  if (probe.whoami !== probe.deployUser) {
    problems.push({ message: `The deploy key does not log in as ${probe.deployUser} on ${probe.key}`, suggestion: `Check the deploy user and key of ${probe.key} in servers.yml.` });
  }
  if (probe.server && probe.kubeconfigStat !== null && (probe.kubeconfigStat.owner !== probe.deployUser || probe.kubeconfigStat.mode !== '600')) {
    problems.push({
      message: `The Dockflow kubeconfig on ${probe.key} has owner/mode ${probe.kubeconfigStat.owner} ${probe.kubeconfigStat.mode}, expected ${probe.deployUser} 600`,
      suggestion: `Run \`dockflow setup k3s <env>\` again.`,
    });
  }
  if (
    probe.server &&
    probe.kubeconfigDirStat !== null &&
    (probe.kubeconfigDirStat.owner !== probe.deployUser || probe.kubeconfigDirStat.group !== probe.deployUser || probe.kubeconfigDirStat.mode !== '700')
  ) {
    problems.push({
      message: `The Dockflow kubeconfig directory on ${probe.key} has owner/mode ${probe.kubeconfigDirStat.owner} ${probe.kubeconfigDirStat.group} ${probe.kubeconfigDirStat.mode}, expected ${probe.deployUser} ${probe.deployUser} 700`,
      suggestion: 'Run `dockflow setup k3s <env>` again; a group- or world-writable parent lets another local user replace the kubeconfig.',
    });
  }
  if (probe.tokenDirStat !== null && (probe.tokenDirStat.owner !== 'root' || probe.tokenDirStat.group !== 'root' || probe.tokenDirStat.mode !== '700')) {
    problems.push({
      message: `The k3s token directory on ${probe.key} has owner/mode ${probe.tokenDirStat.owner} ${probe.tokenDirStat.group} ${probe.tokenDirStat.mode}, expected root root 700`,
      suggestion: 'Run `dockflow setup k3s <env>` again; the token files must not be reachable through a writable parent.',
    });
  }
  if (probe.server && probe.authCanI !== 'yes') {
    problems.push({ message: `The deploy identity cannot administer the cluster from ${probe.key}`, suggestion: 'Rotate the deploy token: `dockflow setup k3s <env> --rotate-deploy-token`.' });
  }
  if (probe.server && probe.readyz !== 'ok') {
    problems.push({ message: `The Kubernetes API on ${probe.key} did not answer ok to /readyz over the deploy identity`, suggestion: `Check k3s on ${probe.key}.` });
  }
  if (probe.server && probe.adminKubeconfigUnreadable === false) {
    problems.push({ message: `The admin kubeconfig on ${probe.key} is readable by the deploy user`, suggestion: 'Check the permissions of /etc/rancher/k3s/k3s.yaml.' });
  }
  if (probe.server && probe.helmVersion !== null && probe.helmVersion !== probe.expectedHelmVersion) {
    problems.push({ message: `Helm on ${probe.key} is ${probe.helmVersion}, expected ${probe.expectedHelmVersion}`, suggestion: `Run \`dockflow setup k3s <env>\` again.` });
  }
  if (probe.sudoUser && probe.sudoImagesOk === false) {
    problems.push({ message: `sudo rules for image import are missing on ${probe.key}`, suggestion: `Run \`dockflow setup k3s <env>\` again.` });
  }
  if (probe.tokenFileUnreadable === false) {
    problems.push({ message: `The k3s token file on ${probe.key} is readable by the deploy user`, suggestion: 'Check the permissions of /etc/rancher/k3s/dockflow/token.' });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 16.5 Exposure probe
// ---------------------------------------------------------------------------

export type ConnectOutcome = 'open' | 'refused' | 'timeout' | 'eperm';
export type ConnectProbe = (host: string, port: number, timeoutS: number) => Promise<ConnectOutcome>;

export interface ExposureProbeNode {
  key: string;
  /** the address to probe (public IP, or the SSH host); null skips the node entirely */
  addr: string | null;
  role: 'server' | 'agent';
  etcdMember: boolean;
}

export interface ExposureProbeOptions {
  env: string;
  timeoutS?: number;
  isPrivate: (addr: string) => boolean;
  onDebug?: (message: string) => void;
}

/** Warnings only (K55a): a connect success is evidence, a refusal or timeout proves nothing. */
export async function runExposureProbe(nodes: readonly ExposureProbeNode[], connectProbe: ConnectProbe, options: ExposureProbeOptions): Promise<SetupProblem[]> {
  const timeoutS = options.timeoutS ?? REACHABILITY_PROBE_TIMEOUT_S;
  const problems: SetupProblem[] = [];
  for (const node of nodes) {
    if (node.addr === null || options.isPrivate(node.addr)) continue;
    const ports: { port: number; label: string }[] = [];
    if (node.role === 'server') ports.push({ port: 6443, label: 'Kubernetes API' });
    ports.push({ port: 10250, label: 'kubelet' });
    if (node.role === 'server' && node.etcdMember) ports.push({ port: 2379, label: 'etcd' });
    for (const { port, label } of ports) {
      const outcome = await connectProbe(node.addr, port, timeoutS);
      if (outcome === 'open') problems.push(verifyMessages.exposed(label, node.key, node.addr, port, options.env));
      else if (outcome === 'eperm') options.onDebug?.(`Could not probe ${node.key} (${node.addr}:${port}): not permitted in this sandbox`);
    }
  }
  return problems;
}
