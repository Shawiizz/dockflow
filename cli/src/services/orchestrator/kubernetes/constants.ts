// Every Kubernetes constant and derived wait budget, declared once (PD-16): names, label and
// annotation keys, paths and limits (DESIGN-CORE 5.1), timeouts and polling (8.6), the stack
// backend's constants (design-03 21.1, PD-5) and the proxy/Helm block (design-04 1).
// Pure: no I/O, no clock.

import { CONVERGENCE_TIMEOUT_S } from '../../../constants';

// ---------------------------------------------------------------------------
// Names, label and annotation keys (DESIGN-CORE 5.1)
// ---------------------------------------------------------------------------

export const DOCKFLOW_K8S_PREFIX = 'dockflow.shawiizz.dev';
const P = DOCKFLOW_K8S_PREFIX;

export const K8S_MANAGED_BY = 'dockflow';
/** value Helm writes in LABELS.managedBy on every object of a release; never written by Dockflow */
export const HELM_MANAGED_BY = 'Helm';
export const K8S_FIELD_MANAGER = 'dockflow';
/** the only two other field managers Dockflow uses: the two writers of the state ConfigMap */
export const K8S_FIELD_MANAGER_RELEASE_STATE = 'dockflow-release-state';
export const K8S_FIELD_MANAGER_ACCESSORIES_STATE = 'dockflow-accessories-state';
export const K8S_NAMESPACE_PREFIX = 'dockflow';
export const K8S_SYSTEM_NAMESPACE = 'dockflow-system';

export const LABELS = {
  managedBy: 'app.kubernetes.io/managed-by',
  partOf: 'app.kubernetes.io/part-of',
  instance: 'app.kubernetes.io/instance',
  name: 'app.kubernetes.io/name',
  stack: `${P}/stack`,
  role: `${P}/role`,
  service: `${P}/service`,
  part: `${P}/part`,
  hashed: `${P}/hashed`,
  volume: `${P}/volume`,
  releaseVersion: `${P}/release-version`,
  /** Helm release label: 32 hex of the release spec, read by the skip predicate (design-04 3.4.4, PD-3) */
  specHash: `${P}/spec-hash`,
  /** Helm release label of the proxy: the TRAEFIK_VALUES_REVISION it was installed with (design-04 2.8) */
  valuesRevision: `${P}/values-revision`,
} as const;

export const ANNOTATIONS = {
  stackName: `${P}/stack-name`,
  composeService: `${P}/compose-service`,
  composeVolume: `${P}/compose-volume`,
  release: `${P}/release`,
  configHash: `${P}/config-hash`,
  replicasBeforeStop: `${P}/replicas-before-stop`,
  epoch: `${P}/epoch`,
  /** LockData JSON on the deploy Lease */
  lock: `${P}/lock`,
  /** JSON array of the node label keys Dockflow applied, on Node objects (setup, D19) */
  nodeLabels: `${P}/node-labels`,
  /** 64 hex, never a label (limit 63); PD-3 keeps it in Dockflow's release record, not on Helm storage Secrets */
  helmValues: `${P}/helm-values-sha256`,
  /** sha256 of the chart .tgz Dockflow installed from; same storage rule as helmValues */
  helmChartDigest: `${P}/helm-chart-sha256`,
  /** original PV reclaim policy recorded before a --volumes deletion (C13) */
  reclaimPolicyBefore: `${P}/reclaim-policy-before`,
  /** on the traefik.io CRDs Dockflow applies: the chart version they came from (design-04 2.5) */
  crdChartVersion: `${P}/chart-version`,
  /** on the same CRDs: the chart's Traefik appVersion */
  crdTraefikVersion: `${P}/traefik-version`,
  defaultContainer: 'kubectl.kubernetes.io/default-container',
} as const;

/** Values of LABELS.part; prune only considers `stack`. */
export const PARTS = {
  stack: 'stack',
  release: 'release',
  /** the in-cluster copy a same-version redeploy keeps while it replaces a release (design-03 13.4) */
  releaseBackup: 'release-backup',
  state: 'state',
  registry: 'registry',
  helper: 'helper',
  system: 'system',
} as const;

export type ObjectPart = (typeof PARTS)[keyof typeof PARTS];

/** Keys defined by Kubernetes or Helm that Dockflow reads or writes. */
export const KUBE_KEYS = {
  hostname: 'kubernetes.io/hostname',
  os: 'kubernetes.io/os',
  arch: 'kubernetes.io/arch',
  podTemplateHash: 'pod-template-hash',
  controllerRevisionHash: 'controller-revision-hash',
  deploymentRevision: 'deployment.kubernetes.io/revision',
  defaultStorageClass: 'storageclass.kubernetes.io/is-default-class',
  serviceAccountName: 'kubernetes.io/service-account.name',
  helmResourcePolicy: 'helm.sh/resource-policy',
  /** Helm's ownership annotations, with HELM_MANAGED_BY the only marks of a release-owned object */
  helmReleaseName: 'meta.helm.sh/release-name',
  helmReleaseNamespace: 'meta.helm.sh/release-namespace',
} as const;

export const K8S_STATE_CONFIGMAP = 'dockflow-state';
export const K8S_REGISTRY_SECRET = 'dockflow-registry';
export const K8S_STORAGE_CLASS = 'dockflow-local';
export const K8S_PROXY_RELEASE = 'dockflow-traefik';
/** ownership + values revision of the cluster-wide proxy (dockflow-system) */
export const K8S_PROXY_CONFIGMAP = 'dockflow-proxy';
/** lease name serialising proxy installs/upgrades across projects */
export const K8S_PROXY_LOCK_NAME = 'lock-dockflow-proxy';
export const K8S_DEPLOYER_SERVICE_ACCOUNT = 'dockflow-deployer';
export const K8S_DEPLOYER_TOKEN_SECRET = 'dockflow-deployer-token';
export const K8S_DEPLOYER_CLUSTER_ROLE_BINDING = 'dockflow-deployer';
export const K8S_IMPORTED_IMAGE_REGISTRY = 'dockflow.invalid';
/** `type` of the release Secrets (DESIGN-CORE 6.7) */
export const K8S_RELEASE_SECRET_TYPE = `${P}/release.v1`;

export const K8S_KUBECONFIG_DIR = '/var/lib/dockflow/kube';
export const K8S_KUBECONFIG_PATH = '/var/lib/dockflow/kube/config';
export const HELM_BIN_PATH = '/usr/local/lib/dockflow/bin/helm';
export const HELM_HOME_DIR = '/var/lib/dockflow/helm';

export const SERVICE_NAME_MAX = 52;
export const DNS_LABEL_MAX = 63;

// ---------------------------------------------------------------------------
// Timeouts and polling (DESIGN-CORE 8.6)
// ---------------------------------------------------------------------------

/** one-shot kubectl calls */
export const K8S_REQUEST_TIMEOUT_S = 30;
/** default local guard = request timeout + this margin (45 s for one-shot calls) */
export const K8S_GUARD_MARGIN_S = 15;
/** apply and server dry-run */
export const K8S_APPLY_TIMEOUT_S = 120;
export const K8S_APPLY_GUARD_S = 150;
/** control-plane probe */
export const K8S_PROBE_TIMEOUT_S = 5;
export const K8S_PROBE_GUARD_S = 10;
/** Deployment progressDeadlineSeconds floor; strictly below CONVERGENCE_TIMEOUT_S so F12 fires before F14 */
export const K8S_PROGRESS_DEADLINE_S = 240;
/** convergence polling starts here and grows by 1 s per poll up to CONVERGENCE_INTERVAL_S */
export const K8S_POLL_INITIAL_S = 2;
/** floor of revertWaitS */
export const K8S_REVERT_TIMEOUT_S = 180;
/** floor of deleteWaitS */
export const K8S_DELETE_WAIT_S = 120;
/** consecutive transient transport failures a polling loop absorbs; the next one ends it (`>`) */
export const K8S_TRANSPORT_FAILURES_TOLERATED = 2;
/** `helm.timeout` default */
export const HELM_DEFAULT_TIMEOUT = '5m';
/** one image import stream per node */
export const K8S_IMAGE_IMPORT_GUARD_S = 900;

// ---------------------------------------------------------------------------
// Stack backend (design-03 21.1, DESIGN-CORE 6.7)
// ---------------------------------------------------------------------------

export const K8S_EVENTS_PER_FAILURE = 3;
export const K8S_DEBUG_LOG_LINES = 20;
export const K8S_IMAGE_IMPORT_CONCURRENCY = 4;
/** time a changed `-lb` Service may stay without an ingress address before LoadBalancerPending */
export const K8S_LB_PENDING_GRACE_S = 60;
export const K8S_LEASE_RENEW_INTERVAL_S = 60;
/** older releases read by rollbackService */
export const K8S_ROLLBACK_SCAN_LIMIT = 10;
/** suffix of the in-cluster backup of a release Secret replaced by a same-version redeploy */
export const K8S_RELEASE_BACKUP_SUFFIX = '-prev';
/** decoded payload limit of one release Secret (Kubernetes Secrets are limited to 1 MiB) */
export const K8S_RELEASE_MAX_BYTES = 700 * 1024;

function maxGraceSeconds(workloads: readonly { graceSeconds: number }[]): number {
  return workloads.reduce((max, w) => Math.max(max, w.graceSeconds), 0);
}

/** delete, stop, prune: never shorter than the pods' own grace period plus a margin */
export function deleteWaitS(workloads: readonly { graceSeconds: number }[]): number {
  return Math.max(K8S_DELETE_WAIT_S, maxGraceSeconds(workloads) + 30);
}

/** revert: the failed pod must terminate (Recreate strategy) before the restored one starts */
export function revertWaitS(workloads: readonly { graceSeconds: number }[]): number {
  return Math.max(K8S_REVERT_TIMEOUT_S, maxGraceSeconds(workloads) + 60);
}

/**
 * Largest minReadySeconds whose rollout can still be observed inside the convergence deadline;
 * a larger `update_config.monitor` is the translator error `update.monitor-too-long` (PD-5).
 */
export const MAX_MIN_READY_S = CONVERGENCE_TIMEOUT_S - 90;

/** `ceil(update_config.monitor)` in seconds, never capped: the cap is a refusal, not a silent change (PD-5) */
export function minReadySecondsFor(monitorMs: number): number {
  return Math.max(0, Math.ceil(monitorMs / 1000));
}

/**
 * Deployment progressDeadlineSeconds (240..270): strictly below CONVERGENCE_TIMEOUT_S so F12 fires
 * before the global deadline, and strictly above minReadySeconds up to MAX_MIN_READY_S (API validation).
 */
export function progressDeadlineFor(minReadySeconds: number): number {
  return Math.min(CONVERGENCE_TIMEOUT_S - 30, Math.max(K8S_PROGRESS_DEADLINE_S, minReadySeconds + 60));
}

// ---------------------------------------------------------------------------
// Proxy and Helm (design-04 1)
// ---------------------------------------------------------------------------

/** the chart's ACME PVC */
export const K8S_PROXY_ACME_CLAIM = 'dockflow-traefik';
/** + '-' + 8 hex of the CA bundle */
export const K8S_PROXY_ACME_CA_SECRET = 'dockflow-traefik-acme-ca';
/** helper pod of the acme.json copy-in procedure */
export const K8S_PROXY_ACME_RESTORE_POD = 'dockflow-acme-restore';
export const K8S_PROXY_INGRESS_CLASS = 'traefik';
/** per-call temp root */
export const HELM_TMP_DIR = `${HELM_HOME_DIR}/tmp`;
/** content-addressed chart cache */
export const HELM_CHARTS_DIR = `${HELM_HOME_DIR}/charts`;
/** chart cache sweep threshold */
export const HELM_CHART_CACHE_DAYS = 30;
/** --timeout of every proxy Helm call */
export const TRAEFIK_TIMEOUT_S = 300;
/** --history-max of the proxy release */
export const TRAEFIK_HISTORY_MAX = 5;
/** max wait for K8S_PROXY_LOCK_NAME */
export const TRAEFIK_LOCK_WAIT_S = 300;
/** kubectl wait --for=condition=Established */
export const TRAEFIK_CRD_WAIT_S = 60;

// ---------------------------------------------------------------------------
// Ports (design-02 6.3, design-01 5.4)
// ---------------------------------------------------------------------------

/** k3s ServiceLB runs one container per Service port in its pod on every node */
export const MAX_LOAD_BALANCER_PORTS = 10;
/** entries one compose port range may expand to */
export const PORTS_EXPANSION_MAX = 100;
