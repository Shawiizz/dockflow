// Canonical model: compose intent after parsing, `$` interpolation, defaults, unit conversion and
// validation. Values are backend-neutral (milliseconds, bytes, millicores, compose vocabulary) and
// names are already Kubernetes-safe; translation decisions are never stored here.
//
// Invariants every normalizer function guarantees:
// - arrays documented as sorted use code-unit comparison (`a < b`), never `localeCompare`;
// - maps are plain objects whose key order is irrelevant (the emitter sorts);
// - no `undefined`: absent is `null`, an empty list `[]`, an empty map `{}`;
// - reportable elements carry `path` (compose YAML path such as `services.web.ports[1]`);
// - strings are final literals (interpolation applied, `$$` reduced to `$`).

export type StackRole = 'app' | 'accessory';
export type Protocol = 'TCP' | 'UDP' | 'SCTP';
/** Milliseconds. */
export type DurationMs = number;
/** Bytes (compose byte units are binary). */
export type Bytes = number;
/** CPU in millicores. */
export type MilliCpu = number;
export type AccessMode = 'ReadWriteOnce' | 'ReadWriteOncePod' | 'ReadWriteMany';

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface StackIdentity {
  /** config.project_name */
  project: string;
  env: string;
  /** `${project}-${env}`: releases, locks, audit, hooks */
  stackName: string;
  /** namespaceFor(project, env); also the value of the P/stack label ("stackId") */
  namespace: string;
  /** deploy version being rendered */
  version: string;
}

export interface ProxyIntent {
  /**
   * proxy.domains[env]; null = no injected default routes.
   * Always null for role 'accessory' (accessories never get injected routes, Swarm parity).
   */
  domain: string | null;
  acme: boolean;
  entryPoint: 'web' | 'websecure';
  certResolver: 'letsencrypt' | null;
  /** false = another project owns the cluster's Traefik; this stack emits routes but never mutates it */
  manage: boolean;
}

export interface CanonicalStack {
  schema: 1;
  identity: StackIdentity;
  role: StackRole;
  /** sorted by name */
  services: CanonicalService[];
  /** top-level volumes referenced by at least one service, sorted by name */
  volumes: CanonicalVolume[];
  /** top-level secrets and configs referenced by at least one service, sorted by (kind, key) */
  files: CanonicalFileSource[];
  /** from traefik.http.middlewares.* labels of this role, sorted by name */
  middlewares: MiddlewareSpec[];
  /**
   * null ONLY when proxy.enabled is false, for BOTH roles. An accessory render of a stack whose
   * proxy is enabled receives a ProxyIntent with domain: null. Route injection is skipped by role
   * (the normalizer tests `role !== 'app'`), never by a null intent, so a rule that needs to know
   * "the proxy exists" (reserving 80/443, validating entry points and cert resolvers, translating
   * explicit Traefik labels on accessories) works identically for both roles.
   * No rule anywhere may read `proxy !== null` to mean "role app"; it must read `role`.
   */
  proxy: ProxyIntent | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ServiceMode = 'replicated' | 'global' | 'replicated-job';
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job';

export interface CanonicalService {
  /** compose key, verbatim */
  composeName: string;
  /** serviceNameFor(composeName): DNS-1035 label, <= 52 chars */
  name: string;
  role: StackRole;
  /** 'services.<composeName>' */
  path: string;
  mode: ServiceMode;
  /** replicated -> Deployment (StatefulSet with x-dockflow.kind), global -> DaemonSet, replicated-job -> Job */
  workloadKind: WorkloadKind;
  /** deploy.replicas ?? scale ?? 1 (0 allowed); ignored for global */
  replicas: number;
  image: ImageSpec;
  process: ProcessSpec;
  /** env_file entries then environment entries, last wins; unset keys removed; sorted by name */
  environment: EnvVar[];
  /** ranges expanded; sorted by (target, protocol, published ?? -1) */
  ports: PortSpec[];
  /** sorted by (target, protocol) */
  expose: ExposeSpec[];
  /** volumes + tmpfs + shm_size; sorted by target */
  mounts: MountSpec[];
  /** service-level secrets and configs; sorted by target */
  files: FileMountSpec[];
  /** null when absent, `disable: true` or test NONE */
  healthcheck: HealthSpec | null;
  update: UpdateSpec;
  restart: RestartSpec;
  resources: ResourcesSpec;
  placement: PlacementSpec;
  security: SecuritySpec;
  network: NetworkSpec;
  /** sorted by router */
  routes: RouteSpec[];
  /** compose `labels` minus traefik.* and com.docker.*; become pod template annotations */
  containerLabels: Record<string, string>;
  /** compose `deploy.labels` minus traefik.* and com.docker.*; become workload annotations */
  serviceLabels: Record<string, string>;
  /** compose `annotations`; pod template annotations */
  podAnnotations: Record<string, string>;
  extension: ServiceExtension;
}

export interface ImageSpec {
  /** final reference used in manifests (built + imported images: importedImageRef()) */
  ref: string;
  /** reference as written in the tagged compose (release compose, GC) */
  composeRef: string;
  /** 'built' when the compose service has a `build` section */
  origin: 'built' | 'pulled';
  /** D12 rule, or compose pull_policy when set */
  pullPolicy: 'Always' | 'IfNotPresent' | 'Never';
}

export interface ProcessSpec {
  /** compose entrypoint (Kubernetes command); null = image default */
  entrypoint: string[] | null;
  /** compose command (Kubernetes args); null = image default */
  command: string[] | null;
  workingDir: string | null;
  /** numeric user only; names are rejected */
  user: { uid: number; gid: number | null } | null;
  /** sorted unique */
  groupAdd: number[];
  tty: boolean;
  stdinOpen: boolean;
  init: boolean;
  /** stop_grace_period, default 10_000 (D10) */
  stopGracePeriodMs: DurationMs;
  hostname: string | null;
  postStart: string[] | null;
  preStop: string[] | null;
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface PortSpec {
  target: number;
  /** null = container-only short form ("3000") */
  published: number | null;
  protocol: Protocol;
  mode: 'ingress' | 'host';
  hostIp: string | null;
  /** compose long-syntax `name` */
  name: string | null;
  appProtocol: string | null;
  path: string;
}

export interface ExposeSpec {
  target: number;
  protocol: Protocol;
  path: string;
}

export type MountSpec = VolumeMountSpec | BindMountSpec | TmpfsMountSpec | AnonymousMountSpec;

export interface VolumeMountSpec {
  type: 'volume';
  /** CanonicalVolume.key */
  volume: string;
  target: string;
  readOnly: boolean;
  subpath: string | null;
  path: string;
}

export interface BindMountSpec {
  type: 'bind';
  /** absolute host path; relative sources are rejected */
  source: string;
  target: string;
  readOnly: boolean;
  /** bind.create_host_path, default true */
  createHostPath: boolean;
  propagation: 'private' | 'rprivate' | 'slave' | 'rslave' | 'shared' | 'rshared' | null;
  /**
   * bind.recursive, default 'enabled'. Compose `disabled` is stored as 'enabled' (a host path
   * mount always includes submounts); 'readonly' only ever appears on a read-only mount.
   */
  recursive: 'enabled' | 'writable' | 'readonly';
  path: string;
}

export interface TmpfsMountSpec {
  type: 'tmpfs';
  target: string;
  sizeBytes: Bytes | null;
  path: string;
}

export interface AnonymousMountSpec {
  type: 'anonymous';
  target: string;
  path: string;
}

export interface FileMountSpec {
  kind: 'secret' | 'config';
  /** CanonicalFileSource.key */
  source: string;
  /** absolute path in the container (defaults: /run/secrets/<key> or /<key>) */
  target: string;
  /** numeric mode, default 0o444 */
  mode: number;
  uid: string | null;
  gid: string | null;
  path: string;
}

export interface HealthSpec {
  test: { type: 'exec'; argv: string[] } | { type: 'shell'; command: string };
  /** Docker defaults (D10) */
  intervalMs: DurationMs; // 30_000
  timeoutMs: DurationMs; // 30_000
  retries: number; // 3
  startPeriodMs: DurationMs; // 0
  startIntervalMs: DurationMs; // 5_000
  path: string;
}

export interface UpdateSpec {
  /** 0 = all at once */
  parallelism: number;
  delayMs: DurationMs;
  failureAction: 'rollback' | 'pause' | 'continue';
  monitorMs: DurationMs;
  order: 'start-first' | 'stop-first';
  maxFailureRatio: number;
  /** 'dockflow' = Compose.DEFAULT_UPDATE_CONFIG merged (role app), 'docker' = Docker defaults (role accessory) */
  defaults: 'dockflow' | 'docker';
}

export interface RestartSpec {
  condition: 'any' | 'on-failure' | 'none';
  delayMs: DurationMs | null;
  maxAttempts: number | null;
  windowMs: DurationMs | null;
}

export interface ResourcesSpec {
  limits: { cpu: MilliCpu | null; memory: Bytes | null; pids: number | null };
  reservations: { cpu: MilliCpu | null; memory: Bytes | null };
}

export type PlacementOperator = '==' | '!=';

export type PlacementConstraint =
  | { attribute: 'node.role'; operator: PlacementOperator; value: 'manager' | 'worker'; path: string }
  /** value = servers.yml key as written; the translator applies nodeNameFor() */
  | { attribute: 'node.hostname'; operator: PlacementOperator; value: string; path: string }
  | { attribute: 'node.labels'; key: string; operator: PlacementOperator; value: string; path: string }
  | { attribute: 'node.platform.os'; operator: PlacementOperator; value: string; path: string }
  | { attribute: 'node.platform.arch'; operator: PlacementOperator; value: string; path: string };

export interface PlacementSpec {
  /** declaration order */
  constraints: PlacementConstraint[];
  /** placement.preferences[].spread = node.labels.<key>; declaration order */
  spreadLabels: string[];
  maxReplicasPerNode: number | null;
}

export interface SecuritySpec {
  privileged: boolean;
  /** uppercase, CAP_ prefix stripped, sorted unique */
  capAdd: string[];
  capDrop: string[];
  readOnlyRootFilesystem: boolean;
  noNewPrivileges: boolean;
  seccomp: 'default' | 'unconfined' | { localhostProfile: string };
  apparmor: 'default' | 'unconfined' | { localhostProfile: string };
  sysctls: Record<string, string>;
  hostPid: boolean;
  hostIpc: boolean;
}

export interface NetworkSpec {
  /** attached compose network keys, sorted (informational: the pod network is flat) */
  networks: string[];
  /** network aliases + links aliases, sanitized with serviceNameFor, sorted unique */
  aliases: string[];
  endpointMode: 'vip' | 'dnsrr';
  hostNetwork: boolean;
  dns: string[];
  dnsSearch: string[];
  dnsOptions: string[];
  /** sorted by (ip, hostname) */
  extraHosts: { hostname: string; ip: string }[];
}

export interface RouteSpec {
  /** Traefik router name from labels, or `${stackName}-${composeName}` when injected */
  router: string;
  /** Traefik v3 rule, verbatim */
  rule: string;
  /** sorted unique */
  entryPoints: string[];
  tls: { certResolver: string | null } | null;
  /** middleware names in declaration order */
  middlewares: string[];
  priority: number | null;
  /** target container port */
  port: number;
  origin: 'injected' | 'labels';
  path: string;
}

export interface MiddlewareSpec {
  /** DNS-1123 name (sanitizeDnsLabel of the label name) */
  name: string;
  /** Traefik Middleware CRD spec in camelCase, built from the label tree */
  spec: Record<string, unknown>;
  /**
   * basicAuth/digestAuth `users` given inline as label values: the normalizer splits on ','
   * (a literal comma inside an htpasswd hash is escaped '\,'), trims, and puts the entries here.
   * The translator generates one Opaque Secret with the single key `users` and rewrites the spec
   * to `{ secret: <objectName> }`. null when the middleware declares `usersFile` or no users.
   */
  users: string[] | null;
  /**
   * `errors.service` resolved by the normalizer to a Kubernetes Service name and port (the label
   * names a compose service; an unknown name is `routing.service-undefined`). null otherwise.
   */
  errorsService: { name: string; port: number } | null;
  path: string;
}

export interface ServiceExtension {
  kind: 'deployment' | 'statefulset' | null;
  /** exposure of ingress-mode published ports; null = default 'loadbalancer' (D9) */
  publish: 'loadbalancer' | 'hostport' | 'none' | null;
  /** sorted unique CIDRs */
  loadBalancerSourceRanges: string[];
  probes: ProbeOverride | null;
  nodeSelector: Record<string, string>;
  /** declaration order */
  tolerations: TolerationSpec[];
  fsGroup: number | null;
  podLabels: Record<string, string>;
}

export interface ProbeOverride {
  /** which Kubernetes probes the healthcheck produces; default 'both' */
  use: 'both' | 'readiness' | 'liveness' | 'none';
  /** replaces the healthcheck command while keeping its timing (Docker defaults when no healthcheck) */
  handler:
    | { type: 'http'; path: string; port: number; scheme: 'HTTP' | 'HTTPS' }
    | { type: 'tcp'; port: number }
    | null;
}

export interface TolerationSpec {
  key: string | null;
  operator: 'Equal' | 'Exists';
  value: string | null;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' | null;
  tolerationSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Volumes and file sources
// ---------------------------------------------------------------------------

export interface CanonicalVolume {
  /** top-level compose key */
  key: string;
  /** PVC claim name: volumeClaimNameFor(key), or the validated external `name` */
  name: string;
  role: StackRole;
  external: boolean;
  /** Kubernetes quantity; x-dockflow.size, default '1Gi' */
  size: string;
  /** x-dockflow.storage_class, default DistributionTraits.defaultStorageClass */
  storageClass: string;
  /** x-dockflow.access_mode, default 'ReadWriteOnce' */
  accessMode: AccessMode;
  /** x-dockflow.per_replica: StatefulSet volumeClaimTemplates */
  perReplica: boolean;
  /** top-level volume `labels` (validated label keys/values) */
  labels: Record<string, string>;
  /** compose names of services mounting it, sorted */
  usedBy: string[];
  path: string;
}

export interface CanonicalFileSource {
  kind: 'secret' | 'config';
  /** top-level compose key */
  key: string;
  /** hashedObjectName(...) or the external `name` */
  objectName: string;
  role: StackRole;
  external: boolean;
  /** null when external */
  data: Uint8Array | null;
  /** sha256 hex of data; null when external */
  checksum: string | null;
  path: string;
}
