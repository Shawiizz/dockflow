/**
 * Orchestrator contracts. Swarm and Kubernetes each provide one Orchestrator bundle;
 * commands and services only see these types.
 */

import type { Readable, Writable } from 'stream';
import type { Result } from '../../types/result';
import type { SSHKeyConnection } from '../../types';
import type { DeployError } from '../../utils/errors';
import type { ProxyConfig } from '../../utils/config';
import type { ParsedCompose } from '../compose';
import type { Diagnostic } from './diagnostics';

// ---------------------------------------------------------------------------
// Identity and topology
// ---------------------------------------------------------------------------

/** Config value of `orchestrator` (D1). */
export type OrchestratorKind = 'swarm' | 'k3s';
export type StackRole = 'app' | 'accessory';
export type StackArtifactFormat = 'swarm-compose/1' | 'k8s-manifests/1';
/** wire protocol, uppercase as Kubernetes writes it (the model uses the same union) */
export type Protocol = 'TCP' | 'UDP' | 'SCTP';

export interface StackRef {
  project: string;
  env: string;
  role: StackRole;
}

export interface ClusterNodeRef {
  /** servers.yml key */
  name: string;
  role: 'manager' | 'worker';
  host: string;
  /** servers.yml private_host ?? host */
  privateHost: string;
  connection: SSHKeyConnection;
}

export interface ControlPlaneProbe {
  node: string;
  status: 'leader' | 'ready' | 'unready' | 'unreachable' | 'skipped';
  detail?: string;
}

export interface OrchestratorTarget {
  kind: OrchestratorKind;
  project: string;
  env: string;
  /** `${project}-${env}` */
  stackName: string;
  /** node every orchestrator call runs on (Swarm manager / k3s server) */
  controlPlane: ClusterNodeRef;
  /** managers with SSH credentials, servers.yml order, controlPlane included */
  managers: ClusterNodeRef[];
  /** workers with SSH credentials, servers.yml order */
  workers: ClusterNodeRef[];
  /** probe results when failover probing ran, else [] */
  probes: ControlPlaneProbe[];
}

// ---------------------------------------------------------------------------
// Capabilities and naming
// ---------------------------------------------------------------------------

export interface OrchestratorCapabilities {
  /** 'native': the orchestrator reverts failed updates itself; 'backend': call StackBackend.revert */
  revert: 'native' | 'backend';
  execAsUser: boolean;
  remoteBuild: boolean;
  helm: boolean;
  volumes: boolean;
  networkPrune: boolean;
  /** lock and release history shared by every control-plane node */
  clusterState: boolean;
  artifactFormat: StackArtifactFormat;
}

export type CapabilityName = 'execAsUser' | 'remoteBuild' | 'helm' | 'volumes' | 'networkPrune';

export interface StackNaming {
  /** Swarm stack name or Kubernetes namespace holding the role */
  scope(ref: StackRef): string;
  /** for messages: "stack shop-production-accessories", "namespace dockflow-shop-production (accessories)" */
  describe(ref: StackRef): string;
  /** native object name of a compose service: "<stack>_<svc>" or the sanitized Kubernetes name */
  serviceNativeName(ref: StackRef, composeService: string): string;
}

// ---------------------------------------------------------------------------
// Artifacts, deploy inputs and receipts
// ---------------------------------------------------------------------------

export type FileResolveFailure = 'missing' | 'directory' | 'outside-project' | 'unreadable';

/**
 * Reads a file referenced by compose (env_file, secrets.file, configs.file), path relative to the
 * compose directory. Returns raw BYTES, never a decoded string: `renderTemplates` renders
 * everything under `.dockflow/` as UTF-8 Nunjucks text, which corrupts binary secrets and configs
 * kept there (Java keystores, DER certificates, binary fixtures). Files that are not valid UTF-8
 * are passed through unrendered, and the render exclusion list is part of the docs.
 *
 * On failure the reason is returned instead of a bare null, because `missing`, `directory` and
 * `outside-project` need three different diagnostics.
 */
export type FileResolver = (
  pathFromComposeDir: string,
) => { ok: true; bytes: Uint8Array; rendered: boolean } | { ok: false; reason: FileResolveFailure };

export type HelmChartSource = { kind: 'repo'; repo: string; chart: string } | { kind: 'oci'; ref: string };

export interface ResolvedHelmRelease {
  name: string;
  role: StackRole;
  namespace: string;
  chart: HelmChartSource;
  version: string;
  values: Record<string, unknown>;
  valuesSha256: string;
  timeoutS: number;
  auth: { username: string; password: string } | null;
  /** sha256 of the chart .tgz (`digest:` in config, the only chart pin); verified after the pull */
  declaredDigest: string | null;
}

/** What releases store: credentials are never persisted. */
export type HelmReleaseRecord = Omit<ResolvedHelmRelease, 'auth' | 'declaredDigest'> & {
  /** sha256 of the chart .tgz this release was installed from (2.5); null for pre-rewrite records */
  chartSha256: string | null;
};

export interface StackArtifact {
  format: StackArtifactFormat;
  role: StackRole;
  content: string;
  helm: HelmReleaseRecord[];
  /** render-time diagnostics; not persisted, [] when read from a store */
  diagnostics: Diagnostic[];
  digest: string;
}

export interface ImageDelivery {
  /** image references Dockflow built for this deploy (compose references) */
  built: string[];
  /** 'import' = streamed into node runtimes; 'registry' = pushed */
  mode: 'import' | 'registry' | 'none';
  pullSecretName: string | null;
}

/**
 * ONE predicate decides registry mode, and the same function is used by `resolveImageDelivery`,
 * `Compose.updateImageTags` and the push path:
 *
 *     registryMode(config) = config.registry?.enabled === true
 *                         && !!config.registry.url
 *                         && !!config.registry.password
 *
 * A config with the URL set and the password missing (credentials are usually injected from CI
 * secrets) falls back to import; a user who wants registry mode without credentials gets a config
 * error naming the missing key. Three call sites testing three different predicates rendered pod
 * templates with the registry reference while nothing was pushed.
 */

export interface StackDeployInput {
  ref: StackRef;
  version: string;
  compose: ParsedCompose;
  proxy: ProxyConfig | undefined;
  /** --only filter (compose names and app Helm release names); null = full deploy */
  services: string[] | null;
  /** role app: release that was current before this deploy */
  previousVersion: string | null;
  /** role accessory: bypass change detection */
  force: boolean;
  images: ImageDelivery;
  /** releases of this role */
  helm: ResolvedHelmRelease[];
  /**
   * Names of every release of this role declared in config.yml, including ones filtered out by
   * --only. finalize() uninstalls app releases that are in the deployed record but not here; it
   * cannot use `helm` for that, because --only and a role change both shrink `helm`.
   */
  helmDeclared: string[];
  /** the other role's normalized surface (D6 collisions and cross-role checks); see NormalizeInput in 3 */
  sibling: {
    services: { key: string; name: string; aliases: string[]; published: { port: number; protocol: Protocol }[] }[];
    volumes: { key: string; claimName: string; external: boolean }[];
    middlewares: string[];
  };
  /** servers.yml keys of the environment (placement validation, node selectors) */
  serverNames: string[];
  files: FileResolver;
  /** progress of the apply inside deploy(), for the CLI spinner; backends never print */
  onApplyProgress?: (progress: { kind: 'started' } | { kind: 'reverted'; revert: RevertResult }) => void;
  /**
   * --rebind-volumes: accept a claim-shape change that repoints a service at another claim.
   * Never persisted, not part of the artifact or its digest.
   */
  rebindVolumes: boolean;
  /**
   * A Traefik owned by Dockflow runs (or is ensured by this deploy) on the cluster, so 80/443 are
   * reserved. Read in deploy.ts before the synchronous render, which cannot read the cluster.
   */
  traefikOnCluster: boolean;
}

export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job';

export interface WorkloadChange {
  service: string;
  kind: WorkloadKind;
  name: string;
  created: boolean;
  /** Deployment: deployment.kubernetes.io/revision; StatefulSet/DaemonSet: ControllerRevision name */
  previousRevision: string | null;
  /**
   * The integer `rollout undo --to-revision` takes. For a Deployment it is the numeric value of
   * the revision annotation; for StatefulSet/DaemonSet it is `ControllerRevision.revision`, which
   * is NOT the ControllerRevision name. Without it the fallback revert path cannot be built.
   */
  previousRevisionNumber: number | null;
  previousReplicas: number | null;
  /** metadata.generation after apply */
  generation: number;
}

export interface HelmReleaseChange {
  name: string;
  namespace: string;
  role: StackRole;
  /** 'skipped': the deployed release already matches the resolved spec, nothing ran */
  action: 'installed' | 'upgraded' | 'skipped';
  /** revision before this deploy; null when the release did not exist */
  previousRevision: number | null;
  revision: number;
}

/** HelmReleaseStatus.status values; anything Helm adds later parses as 'unknown' */
export type HelmStatus =
  | 'deployed'
  | 'failed'
  | 'pending-install'
  | 'pending-upgrade'
  | 'pending-rollback'
  | 'superseded'
  | 'uninstalling'
  | 'uninstalled'
  | 'unknown';

export interface HelmReleaseStatus {
  name: string;
  namespace: string;
  role: StackRole | null;
  revision: number;
  status: string;
  chart: string;
  appVersion: string | null;
  updated: string | null;
}

export interface DeployReceipt {
  ref: StackRef;
  version: string;
  startedAt: Date;
  services: string[] | null;
  /** change detection skipped the apply (accessories unchanged) */
  skipped: boolean;
  artifactDigest: string;
  /** workloads whose spec changed or that were created; [] on Swarm */
  changes: WorkloadChange[];
  helm: HelmReleaseStatus[];
  /** per-release outcome of this apply (skip detection, revert revisions); [] on Swarm */
  helmChanges: HelmReleaseChange[];
  /** copied from StackDeployInput so finalize() can uninstall removed app releases */
  helmDeclared: string[];
  previousVersion: string | null;
}

export interface WaitOptions {
  timeoutS: number;
  intervalS: number;
}

export interface HealthOptions extends WaitOptions {
  /** pods must stay Ready with unchanged restart counts this long */
  stabilityS: number;
}

export interface ServiceFailure {
  /** compose name, or Helm release name */
  service: string;
  /** stable reason: CrashLoopBackOff, ImagePullBackOff, ErrImagePull, ErrImageNeverPull, InvalidImageName,
      CreateContainerConfigError, CreateContainerError, RunContainerError, ContainerRestarted,
      OOMKilled, Unschedulable, ReplicaFailure, ProgressDeadlineExceeded, Paused, WorkloadDeleting,
      PvcPending, LoadBalancerPending, Timeout, TaskFailed, HelmFailed */
  reason: string;
  /** redacted, single paragraph */
  message: string;
  instance?: string;
  node?: string;
}

export interface ConvergenceResult {
  status: 'converged' | 'failed' | 'timeout' | 'reverted';
  failures: ServiceFailure[];
  message?: string;
  suggestion?: string;
}

/**
 * Convergence covers Services, not only workloads. Every `-lb` Service changed by the deploy is a
 * convergence target: after the wait (grace ~60 s) it must have `status.loadBalancer.ingress`,
 * otherwise the deploy fails with a `LoadBalancerPending` failure naming the conflicting host port
 * and the Service and namespace that already own it (found with `get svc -A`). This is the
 * backstop for cross-role and cross-stack host-port collisions no render-time check can see:
 * renders of the two roles are separate, and another project's stack on the same cluster is
 * invisible to the renderer entirely. On Swarm the equivalent mistake fails loudly ("port is
 * already in use"), so this restores parity.
 */

export interface InternalHealthResult {
  healthy: boolean;
  /** Swarm: a native rollback happened during the window */
  rolledBack: boolean;
  failures: ServiceFailure[];
  message?: string;
  /** set when the check ended on a read it could not make, so the failure mapping keeps the hint */
  suggestion?: string;
}

export interface RevertResult {
  status: 'native' | 'reverted' | 'nothing-to-revert' | 'failed';
  services: string[];
  message?: string;
}

export interface ApplyOptions {
  prune: boolean;
  services: string[] | null;
  /** `dockflow rollback --allow-chart-drift`, forwarded to Helm upgrades from a record; never set by `on_failure: rollback` */
  allowChartDrift?: boolean;
}

export interface ControlOptions {
  wait: boolean;
  timeoutS: number;
}

// ---------------------------------------------------------------------------
// Inspection results
// ---------------------------------------------------------------------------

export interface PortInfo {
  target: number;
  published: number | null;
  protocol: 'tcp' | 'udp' | 'sctp';
  mode: 'ingress' | 'host' | 'cluster';
}

export interface ServiceInfo {
  /** compose name, or Helm release name for kind 'helm' */
  name: string;
  nativeName: string;
  kind: 'service' | 'helm';
  role: StackRole;
  mode: 'replicated' | 'global' | 'job';
  image: string;
  replicas: { running: number; desired: number };
  ports: PortInfo[];
  state: 'running' | 'converging' | 'degraded' | 'stopped';
}

export interface InstanceInfo {
  /** Swarm task id / pod name */
  id: string;
  /** short display name: Swarm task slot `web.2`, Kubernetes `web.x2x4q` or `db.0` (log prefixes, pickers) */
  label: string;
  service: string;
  /** servers.yml key when mappable, else native node name */
  node: string | null;
  status: string;
  severity: 'ok' | 'warning' | 'error';
  ready: boolean;
  /** null when the orchestrator does not report it (Swarm); printed as `-`, never as 0 */
  restarts: number | null;
  /** belongs to the current revision */
  current: boolean;
  /** null when unknown; printed as `-`, never as an age computed from now */
  startedAt: string | null;
  error: string | null;
  containers: string[];
}

export interface DiagnosticIssue {
  severity: 'error' | 'warning';
  category: string;
  message: string;
  suggestion?: string;
}

export type DiagnosticLineLevel = 'ok' | 'warning' | 'error' | 'pending' | 'dim' | 'plain';

export interface DiagnosticReport {
  /** both backends need per-line severity for colouring; a marker convention inside a string is not it */
  sections: { title: string; lines: { text: string; level: DiagnosticLineLevel }[] }[];
  issues: DiagnosticIssue[];
}

export interface NodeInfo {
  /** native node name */
  name: string;
  /** servers.yml key when mappable */
  server: string | null;
  role: 'manager' | 'worker';
  ready: boolean;
  schedulable: boolean;
  version: string | null;
  internalIp: string | null;
  /** DiskPressure, MemoryPressure, PIDPressure when true */
  pressure: string[];
}

// ---------------------------------------------------------------------------
// StackBackend
// ---------------------------------------------------------------------------

export interface StackBackend {
  /** Pure and synchronous. Throws ComposeTranslationError / ConfigError on invalid input. Never prints. */
  render(input: StackDeployInput): StackArtifact;

  /** Render and apply one role. Kubernetes: never prunes here (finalize does). */
  deploy(input: StackDeployInput): Promise<Result<DeployReceipt, DeployError>>;

  /** Apply a stored artifact (rollback, rollback <service>). Verifies artifact.format first (ROLLBACK_FAILED on mismatch). */
  apply(
    ref: StackRef,
    version: string,
    artifact: StackArtifact,
    options: ApplyOptions,
  ): Promise<Result<DeployReceipt, DeployError>>;

  /** Never throws. Kubernetes: fail-fast classification (D15); never reverts by itself. */
  waitConvergence(receipt: DeployReceipt, options: WaitOptions): Promise<ConvergenceResult>;

  /** Never throws. */
  checkHealth(receipt: DeployReceipt, options: HealthOptions): Promise<InternalHealthResult>;

  /** Restore the workloads changed by `receipt` (DV2). Swarm: {status: 'native'}. Never throws. */
  revert(receipt: DeployReceipt): Promise<RevertResult>;

  /**
   * After success: prune (full deploys), hashed-object GC, removed app Helm releases, accessories
   * digest. Swarm: accessories hash file, and a no-op for app receipts of `origin: 'apply'`.
   *
   * NEVER THROWS. Every failure inside it is a warning and the method resolves. `appDeployed`
   * becomes true once `finalize` returned, so a throwing prune would send a converged deploy down
   * the not-deployed failure path and delete the release record of the version that is running.
   * Callers therefore do not wrap it in try/catch.
   */
  finalize(receipt: DeployReceipt): Promise<void>;

  /** Queries throw OrchestratorUnavailableError on tool/transport/auth errors; not-found yields false / []. */
  exists(ref: StackRef): Promise<boolean>;
  getServices(ref: StackRef): Promise<ServiceInfo[]>;
  listInstances(ref: StackRef, options?: { service?: string; includeTerminated?: boolean }): Promise<InstanceInfo[]>;
  diagnose(ref: StackRef, options: { verbose: boolean }): Promise<DiagnosticReport>;

  /** Mutations throw DeployError / UnsupportedOperationError. */
  scale(ref: StackRef, service: string, replicas: number, options: ControlOptions): Promise<void>;
  restart(ref: StackRef, service: string | null, options: ControlOptions): Promise<void>;
  /**
   * Roll one service back to the newest stored release whose objects for it differ from what runs.
   * Returns the version reached, or `{toVersion: null}` when no stored release differs, so the
   * command can print it instead of guessing.
   */
  rollbackService(ref: StackRef, service: string, options: ControlOptions): Promise<{ toVersion: string | null }>;
  /** scale to 0 recording P/replicas-before-stop (accessories stop) */
  stop(ref: StackRef, services: string[] | null, options: ControlOptions): Promise<void>;
  /**
   * Remove the role's workloads, Services, routes and hashed objects; volumes only with 'delete'
   * (D7) and then strictly by the protocol of C13. Removing a role also clears that role's change
   * detection state (k3s: the `accessories-digest` key; Swarm: the hash file), otherwise the next
   * `deploy --accessories` skips as unchanged.
   */
  remove(ref: StackRef, options: { volumes: 'retain' | 'delete' }): Promise<void>;
}

/**
 * Day-2 method ownership (binding). `deploy`, `apply`, `waitConvergence`, `revert`, `finalize`,
 * `remove`, `stop`, `scale`, `restart`, `rollbackService` and `exists` are specified once, in
 * design-03; design-06 keeps only the command surface. Refusals are command-level
 * `UnsupportedOperationError`, never backend `DeployError`.
 */

// ---------------------------------------------------------------------------
// ContainerBackend
// ---------------------------------------------------------------------------

export interface InstanceTarget {
  /** compose service name, or a Helm release name when `workload` is set */
  service: string;
  /** workload inside a Helm release (a release with several workloads needs no string encoding) */
  workload?: string;
  /** InstanceInfo.id chosen by --pod / --pick */
  instance?: string;
  container?: string;
}

export interface ExecRequest {
  argv: string[];
  workdir?: string;
  env?: Record<string, string>;
  /** refused when !capabilities.execAsUser */
  user?: string;
  tty: boolean;
  /** forward local stdin */
  stdin: boolean;
  /** streams to use instead of process stdio; lets exec/shell be unit-tested and reused by the API */
  io?: { stdin: Readable; stdout: Writable; stderr: Writable };
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LogsOptions {
  follow: boolean;
  tail: number | 'all';
  /** raw user value; the backend converts (durations or timestamps) */
  since?: string;
  timestamps: boolean;
  instance?: string;
  includeTerminated: boolean;
  container?: string;
}

export interface LogLine {
  service: string;
  instance: string;
  text: string;
  timestamp: string | null;
}

export interface LogSink {
  line(line: LogLine): void;
  /** stream-level problems (pod gone, selector empty); never throws inside SSH listeners */
  warn(message: string): void;
}

export interface ContainerStats {
  service: string;
  /** role of the pod the row came from; `details` and /api/metrics/stats filter on it */
  role: StackRole;
  instance: string;
  container: string;
  node: string | null;
  cpuMilli: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  /** Swarm `docker stats` columns; null on Kubernetes (metrics-server reports neither) */
  netIO: string | null;
  blockIO: string | null;
}

export interface ContainerBackend {
  /** streams to process stdio; resolves with the remote exit code */
  exec(ref: StackRef, target: InstanceTarget, request: ExecRequest): Promise<number>;
  /** buffered, no TTY, internal use */
  capture(ref: StackRef, target: InstanceTarget, argv: string[]): Promise<ExecResult>;
  shell(ref: StackRef, target: InstanceTarget, shell: 'auto' | '/bin/sh' | '/bin/bash'): Promise<number>;
  /** PTY command for the web terminal */
  interactiveCommand(
    ref: StackRef,
    target: InstanceTarget,
    shell: '/bin/sh' | '/bin/bash',
  ): Promise<{ connection: SSHKeyConnection; command: string }>;
  /** service null = whole role scope (one prefixed stream when following) */
  streamLogs(ref: StackRef, service: string | null, options: LogsOptions, sink: LogSink): Promise<void>;
  /**
   * tar stream of `path`. The remote exit code is only known after the data, so the stream emits
   * `ContainerPathError` (`services/orchestrator/copy.ts`) with reason `not-found` | `no-tar` |
   * `other` when the remote process exited non-zero. `cp` can then say "path does not exist in the
   * container" instead of "empty archive".
   */
  copyOut(ref: StackRef, target: InstanceTarget, path: string): Promise<Readable>;
  /** extracts a tar stream into `destDir` */
  copyIn(ref: StackRef, target: InstanceTarget, destDir: string, tar: Readable): Promise<void>;
  /** one row per container of the ref's role only (helper pods and the other role excluded) */
  stats(ref: StackRef): Promise<ContainerStats[]>;
}

// ---------------------------------------------------------------------------
// Proxy, images, cluster
// ---------------------------------------------------------------------------

export interface ProxyStatus {
  installed: boolean;
  ready: boolean;
  version: string | null;
  /** owning stack id from the dockflow-proxy ConfigMap; null when the proxy is not Dockflow-owned */
  owner: string | null;
  /** capabilities the deployed proxy offers, used by the non-owning mode */
  entryPoints: string[];
  acme: boolean;
  /** Retain | Delete of the ACME PVC's PV; a Delete here is warned about (K22) */
  acmeReclaimPolicy: 'Retain' | 'Delete' | 'Recycle' | null;
  detail?: string;
  /** stack name of the owner, for messages; null when the proxy is not Dockflow-owned */
  ownerStackName?: string | null;
  /** servers.yml key of the node the Traefik pod runs on */
  node?: string | null;
  /** node recorded in the dockflow-proxy ConfigMap */
  recordedNode?: string | null;
  /** host listeners and other pods' hostPorts on 80/443 */
  conflicts?: string[];
  /** exact recovery steps, printed verbatim by status, diagnose and helm status; empty when none applies */
  recovery?: string[];
}

/** read-only; safe inside `deploy --dry-run`, never throws E-PX-CONFLICT */
export interface ProxyPlan {
  action: 'install' | 'upgrade' | 'unchanged' | 'not-owner';
  /** why an upgrade is needed, or why this stack is not the owner; for the deploy spinner */
  reason: string;
  status: ProxyStatus;
  /** every refusal ensure() would raise, for managing and consuming stacks alike */
  blockers: { message: string; suggestion: string }[];
  /** the warnings ensure() would emit, so deploy --dry-run can print them */
  warnings?: { message: string; suggestion: string }[];
  /** servers.yml key of the node that answers 80/443 once ensure() ran; null when unknown or not owned */
  node?: string | null;
}

export interface ProxyEnsureResult {
  changed: boolean;
  action: ProxyPlan['action'];
  version: string | null;
}

/** backends never print; progress reaches the CLI through this sink */
export interface HelmEventSink {
  /** spinner text of the operation about to run */
  step(text: string): void;
  /** the optional suggestion is printed dim under the warning */
  warn(message: string, suggestion?: string): void;
}

export interface ProxyBackend {
  /** read-only plan; `deploy --dry-run` and `proxy status` use it */
  plan(proxy: ProxyConfig, env: string): Promise<ProxyPlan>;
  /** idempotent; no disruption when the effective configuration is unchanged */
  ensure(proxy: ProxyConfig, env: string, events?: HelmEventSink): Promise<ProxyEnsureResult>;
  status(): Promise<ProxyStatus>;
}

export interface RegistryCredentials {
  server: string;
  username: string;
  password: string;
}

export interface NodeImage {
  ref: string;
  id: string;
  sizeBytes: number | null;
  inUse: boolean;
}

export interface ImageBackend {
  /** Kubernetes: import on every node with image-ID dedupe (D13); Swarm: today's transfer */
  distribute(images: string[], nodes: ClusterNodeRef[]): Promise<void>;
  /**
   * Presence only, before applying a stored artifact in import mode (rollback): no local image is
   * needed, so it works for a release whose build tree is gone. Nodes missing nothing are omitted.
   */
  verifyPresence(images: string[], nodes: ClusterNodeRef[]): Promise<{ node: string; missing: string[] }[]>;
  /** Kubernetes: dockerconfigjson Secret in the ref namespace, returns its name; Swarm: docker login on the manager, returns null */
  ensurePullSecret(ref: StackRef, registry: RegistryCredentials): Promise<string | null>;
  /** best effort removal of images imported by a failed deploy */
  remove(images: string[], nodes: ClusterNodeRef[]): Promise<void>;
  /** remove images of removed releases not used by running workloads or kept releases */
  collectGarbage(nodes: ClusterNodeRef[], removedReleaseImages: string[], keptReleaseImages: string[]): Promise<void>;
  list(
    nodes: ClusterNodeRef[],
    options: { all: boolean },
  ): Promise<{ node: string; images: NodeImage[]; diskUsage: string | null }[]>;
  /**
   * `all: false` = dangling only (Swarm `docker image prune`), `all: true` = every unused image
   * (`-a`, k3s `crictl rmi --prune`). `reclaimed` is null when the runtime does not report a size;
   * callers print no figure and the API returns null rather than summing nulls.
   */
  prune(nodes: ClusterNodeRef[], options: { all: boolean }): Promise<{ node: string; reclaimed: string | null }[]>;
  /**
   * Swarm only: `docker container|volume|network prune`. On Kubernetes it throws
   * `UnsupportedOperationError` so the backend stays total and `dockflow prune` has one code path;
   * the command still refuses before any SSH work through `requireCapabilityFor`.
   */
  pruneRuntime(
    nodes: ClusterNodeRef[],
    target: 'containers' | 'volumes' | 'networks',
  ): Promise<{ node: string; reclaimed: string | null }[]>;
}

export interface ClusterBackend {
  probe(node: ClusterNodeRef): Promise<ControlPlaneProbe>;
  /** Kubernetes: kubeconfig readable, server version >= minimum, dockflow-system present, storage class and CRDs when needed */
  preflight(needs: { routes: boolean; volumes: boolean; helm: boolean }): Promise<void>;
  nodes(): Promise<NodeInfo[]>;
  serverVersion(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Volumes (D7), Helm (D17), backups (D22)
// ---------------------------------------------------------------------------

export interface VolumeScope {
  project: string;
  env: string;
  /** null = both roles and unlabelled PVCs of the namespace (Helm charts) */
  role: StackRole | null;
  /**
   * Namespace override; defaults to the stack namespace. Needed for Helm releases that target
   * their own namespace, and for `dockflow-system` (the Traefik ACME volume, K48). Listing another
   * namespace is allowed; removing outside the stack namespace requires the same typed
   * confirmation plus an explicit `--namespace`, and is refused for namespaces Dockflow does not
   * manage.
   */
  namespace?: string;
}

export interface VolumeInfo {
  /** PVC name, or PV name when unclaimed */
  name: string;
  composeName: string | null;
  role: StackRole | null;
  phase: 'Bound' | 'Pending' | 'Lost' | 'Released' | 'Available' | 'Failed' | 'Unknown';
  capacity: string | null;
  storageClass: string | null;
  node: string | null;
  reclaimPolicy: 'Retain' | 'Delete' | 'Recycle' | null;
  /** compose names or pod names currently mounting it */
  usedBy: string[];
  hostPath: string | null;
}

export interface VolumeRemovalReport {
  /** PVC + PV pairs whose data was deleted */
  deleted: { claim: string; volume: string | null }[];
  /** PVs whose recorded reclaim policy was put back because their PVC still exists */
  restored: string[];
  /** PVs left in a non-recorded policy: named so the operator can repair them by hand */
  restoreFailed: { volume: string; policy: string; error: string }[];
}

export interface VolumeBackend {
  list(scope: VolumeScope): Promise<VolumeInfo[]>;
  /**
   * The caller has confirmed. Refuses in-use volumes. Deletes data by the protocol of C13 and
   * nothing else: one volume at a time, the PV's original policy recorded and restored in a
   * try/finally. Never patches a set of PVs up front. Returns what happened, by name, so the
   * command can print it.
   */
  remove(scope: VolumeScope, names: string[]): Promise<VolumeRemovalReport>;
}

export interface HelmManifestObject {
  kind: string;
  name: string;
  /** the object's own namespace (a chart may place objects outside the release namespace) */
  namespace: string | null;
  /** helm.sh/resource-policy: keep — helm uninstall never deletes these (DV3) */
  keep: boolean;
  /** StatefulSet claim templates: PVCs that are not in the manifest and survive any uninstall */
  claimTemplates: string[];
}

export interface HelmUpgradeResult extends HelmReleaseStatus {
  /** false when the skip predicate held and nothing ran */
  changed: boolean;
  /** last deployed revision before the call; null for an install */
  previousRevision: number | null;
  /** sha256 of the .tgz installed from; skipped: release.declaredDigest ?? '' */
  chartSha256: string;
  /** this call took over a release installed outside Dockflow */
  adopted?: boolean;
}

export interface HelmPlanEntry {
  release: string;
  namespace: string;
  action: HelmReleaseChange['action'] | 'blocked';
  /** 'not installed' | 'changed' | 'failed' | 'adopt' | 'recover' | the refusal message */
  reason: string;
  /** set with 'blocked' */
  suggestion?: string;
  /** a stale pending release is rolled back to this revision first */
  rollbackTo?: number;
}

export interface HelmBackend {
  /** plan, optional recovery, upgrade --install from the verified archive; changed: false when the skip predicate holds */
  upgradeInstall(
    release: ResolvedHelmRelease,
    options: {
      historyMax: number;
      stackId: string;
      events?: HelmEventSink;
      /** --description; default `Dockflow <CLI version>`, deploy passes `Dockflow <deploy version>` */
      description?: string;
      /** the release was named by deploy --adopt */
      adopt?: boolean;
      /** deploy/rollback --allow-chart-drift */
      allowChartDrift?: boolean;
    },
  ): Promise<HelmUpgradeResult>;
  uninstall(
    namespace: string,
    name: string,
    options: { timeoutS: number; keepHistory?: boolean; description?: string; events?: HelmEventSink },
  ): Promise<void>;
  /** native `helm rollback` to a revision (used by `dockflow helm rollback` and Helm revert) */
  rollback(
    namespace: string,
    name: string,
    revision: number,
    options: { timeoutS: number; historyMax?: number; description?: string; events?: HelmEventSink },
  ): Promise<HelmReleaseStatus>;
  /** read-only: what upgradeInstall would do, without mutating; safe in --dry-run */
  plan(releases: ResolvedHelmRelease[], stackId: string, options?: { adopt?: string[] }): Promise<HelmPlanEntry[]>;
  /** namespaces [] = every namespace (with stackId) */
  list(namespaces: string[], stackId: string | null): Promise<HelmReleaseStatus[]>;
  /** every release labelled with this stack id, cluster-wide (finalize, remove): never a guessed namespace list */
  listAll(stackId: string): Promise<HelmReleaseStatus[]>;
  status(namespace: string, name: string): Promise<HelmReleaseStatus | null>;
  /** newest first, with helm's `description` column (why a revision exists / why it failed); `max` defaults to 20 */
  history(namespace: string, name: string, max?: number): Promise<(HelmReleaseStatus & { description: string | null })[]>;
  /** user values of the deployed (or given) revision, for drift display; valuesSha256 computed locally */
  deployedValues(
    namespace: string,
    name: string,
    revision?: number,
  ): Promise<{ values: Record<string, unknown>; valuesSha256: string } | null>;
  /**
   * Deployed or superseded revisions, newest first, to pick a rollback target. With `specHash`,
   * only those whose spec-hash label equals it. valuesSha256 is null: reading it per revision
   * would transfer every revision's payload.
   */
  revisionsWithSpec(
    namespace: string,
    name: string,
    specHash?: string,
  ): Promise<{ revision: number; version: string; valuesSha256: string | null; status: string }[]>;
  /** which Dockflow stack owns a release (ownership labels), null when unowned */
  ownerOf(namespace: string, name: string): Promise<{ stackId: string; role: StackRole } | null>;
  /** objects of the deployed manifest (DV3 PVC rule, --volumes, K48); the manifest text never leaves memory */
  manifestObjects(namespace: string, name: string): Promise<HelmManifestObject[]>;
  /** fixes the chart bytes of app releases before the release record is written */
  pinCharts(
    releases: ResolvedHelmRelease[],
    previous: HelmReleaseRecord[],
    options: { allowChartDrift: boolean },
  ): Promise<ResolvedHelmRelease[]>;
}

export interface BackupVolume {
  name: string;
  kind: 'volume' | 'bind';
  source: string;
  mountPath: string;
  node: string | null;
}

export interface BackupFile {
  node: ClusterNodeRef;
  remotePath: string;
}

export interface BackupBackend {
  /** runs `script` in the service container, stdout streamed to a file on a node */
  dump(
    ref: StackRef,
    target: InstanceTarget,
    script: string,
    remotePath: string,
    options: { gzip: boolean },
  ): Promise<BackupFile>;
  /**
   * Streams the file into `script` stdin in the service container. Returns the remote outcome so
   * the orchestrator-neutral `services/backup.ts` can turn an in-container refusal marker
   * (`DOCKFLOW_REFUSED: <id>`) into the catalogue message for both backends.
   */
  restore(
    ref: StackRef,
    target: InstanceTarget,
    script: string,
    file: BackupFile,
    options: { gunzip: boolean },
  ): Promise<{ exitCode: number; stderr: string }>;
  volumes(
    ref: StackRef,
    service: string,
    options: { includeBindMounts: boolean; exclude: string[] },
  ): Promise<BackupVolume[]>;
  /** files are named `<pathPrefix>.<volume.name>.tar[.gz]`; a bare directory cannot carry the backup id */
  archiveVolumes(
    ref: StackRef,
    service: string,
    volumes: BackupVolume[],
    pathPrefix: string,
    options: { gzip: boolean },
  ): Promise<BackupFile[]>;
  /** Kubernetes: scales the workload to 0 first and restores replicas afterwards (D22) */
  restoreVolumes(ref: StackRef, service: string, archives: { volume: BackupVolume; file: BackupFile }[]): Promise<void>;
  restartAfterRestore(ref: StackRef, service: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stores (D20)
// ---------------------------------------------------------------------------

export interface ReleaseMetadata {
  project_name: string;
  version: string;
  env: string;
  timestamp: string;
  epoch: number;
  performer: string;
  branch: string;
  /** absent in releases written before the rewrite: 'swarm' */
  orchestrator?: OrchestratorKind;
  artifact_format?: StackArtifactFormat;
  helm?: {
    name: string;
    chart: string;
    version: string;
    values_sha256: string;
    /** bytes of the .tgz actually installed; absent or null in releases written before the rewrite */
    chart_sha256?: string | null;
  }[];
  /**
   * Digest of the accessories artifact rendered by the same deploy; null when accessories were
   * skipped or absent, absent in releases written before the rewrite. Only used to tell the
   * operator that a rollback did not touch the accessories.
   */
  accessories_digest?: string | null;
}

export interface ReleaseInput {
  version: string;
  /** tagged compose (images of this release) */
  compose: string;
  artifact: StackArtifact;
  metadata: ReleaseMetadata;
}

/**
 * Role change-detection state, implemented by BOTH stores (k3s: keys of the `dockflow-state`
 * ConfigMap; Swarm: the accessories hash file), so `deploy-phases.ts` can call it without knowing
 * the backend.
 *
 * The two writers (`setCurrent` during the release create, `writeAccessoriesDigest` in the
 * accessories finalize) run concurrently on the same ConfigMap. This is safe because each uses
 * server-side apply under its OWN field manager (`dockflow-release-state` /
 * `dockflow-accessories-state`), so neither owns nor removes the other's key. The only race is the
 * very first create of the ConfigMap, handled by a single retry on `AlreadyExists`.
 */
export interface RoleStateStore {
  /** null clears the key (a removed role must not be skipped as unchanged on the next deploy) */
  writeAccessoriesDigest(stackName: string, digest: string | null): Promise<void>;
  readState(stackName: string): Promise<{ current: string | null; accessoriesDigest: string | null }>;
}

export interface ReleaseStore extends RoleStateStore {
  /** writes the release and makes it current; returns the version that was current */
  create(stackName: string, release: ReleaseInput): Promise<{ previous: string | null }>;
  current(stackName: string): Promise<ReleaseMetadata | null>;
  /** the `current` pointer without reading any payload */
  currentVersion(stackName: string): Promise<string | null>;
  currentCompose(stackName: string): Promise<string | null>;
  /** newest first (epoch descending) */
  list(stackName: string): Promise<ReleaseMetadata[]>;
  latestVersion(stackName: string): Promise<string | null>;
  readArtifact(stackName: string, version: string): Promise<StackArtifact>;
  readCompose(stackName: string, version: string): Promise<string | null>;
  setCurrent(stackName: string, version: string | null): Promise<void>;
  /** removes one release; when it is current, current becomes restoreCurrentTo */
  remove(stackName: string, version: string, options?: { restoreCurrentTo: string | null }): Promise<void>;
  /** keeps the `keep` newest releases (current always kept); returns removed metadata */
  prune(stackName: string, keep: number): Promise<ReleaseMetadata[]>;
  /**
   * cwd for remote hooks. Never null and never a shared world-writable directory: on k3s it is a
   * per-stack directory under `/var/lib/dockflow`, mode 0700, owned by the deploy user, created on
   * demand. Hooks export a cluster-admin `KUBECONFIG`; running them in `/tmp` would let any local
   * user place files a hook may read or execute.
   */
  hookWorkingDir(stackName: string): string;
}

export interface LockData {
  performer: string;
  started_at: string;
  timestamp: number;
  version: string;
  stack: string;
  message?: string;
}

export interface LockStatus {
  locked: boolean;
  data?: LockData;
  durationMinutes?: number;
  isStale?: boolean;
}

export interface LockStore {
  status(): Promise<Result<LockStatus, Error>>;
  acquire(options?: { message?: string; force?: boolean; version?: string }): Promise<Result<LockData, Error>>;
  release(): Promise<Result<void, Error>>;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

export interface Orchestrator {
  readonly kind: OrchestratorKind;
  readonly target: OrchestratorTarget;
  readonly capabilities: OrchestratorCapabilities;
  readonly naming: StackNaming;
  readonly stack: StackBackend;
  readonly containers: ContainerBackend;
  readonly proxy: ProxyBackend;
  readonly images: ImageBackend;
  readonly cluster: ClusterBackend;
  readonly backups: BackupBackend;
  readonly releases: ReleaseStore;
  /**
   * Never null. Swarm provides a read-only implementation (`docker volume ls/inspect`) whose
   * `remove` throws `UnsupportedOperationError`, because `accessories list` and
   * `accessories remove` display Swarm volumes and commands may not call docker directly.
   * `capabilities.volumes` keeps gating the `dockflow volumes` command group.
   */
  readonly volumes: VolumeBackend;
  /** null when !capabilities.helm */
  readonly helm: HelmBackend | null;
  /** lock a stack, or any other Dockflow-owned lease by explicit name (the shared proxy) */
  lock(stackName: string, staleThresholdMinutes?: number, leaseName?: string): LockStore;
}
