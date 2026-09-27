// The cluster-wide Traefik Dockflow owns (D16, design-04 2.3-2.5): proxy intent, the values of the
// `dockflow-traefik` release, where it runs (placement) and which traefik.io CRDs it applies.
// Pure: observations come in as data, nothing here reads the cluster, the clock or the environment.

import type { ProxyConfig } from '../../../../utils/config';
import { ConfigError, DeployError, ErrorCode } from '../../../../utils/errors';
import { sha256Hex } from '../../../../utils/hash';
import { ANNOTATIONS, K8S_MANAGED_BY, K8S_PROXY_ACME_CA_SECRET, K8S_PROXY_ACME_CLAIM, KUBE_KEYS, LABELS, PARTS } from '../constants';
import type { DistributionTraits } from '../distribution';
import type { Deployment } from '../resources/apps';
import type { Node, PersistentVolume, Pod } from '../resources/core';
import type { KubeObjectBase } from '../resources/meta';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../versions';
import { compareChartVersions } from './parse';

/** Bumped whenever buildTraefikValues output changes for the same intent, placement and pin. */
export const TRAEFIK_VALUES_REVISION = 4;
/**
 * sha256 of the values goldens (`__tests__/kubernetes/backends/proxy-values`) at this revision. The
 * golden test fails when the output changes and this still names the old goldens: bump the
 * revision together with it, so deployed proxies see the change (design-04 2.8.1).
 */
export const TRAEFIK_VALUES_GOLDEN_SHA256 = 'ff1636589ddc7e74d0c56948931ce8fed0b9892194e87f18b19567be2b8b7208';
export const TRAEFIK_RUN_AS = 65532;

/** The two CRDs Dockflow's routes need; their presence is O4 and their versions decide 2.5. */
export const REQUIRED_TRAEFIK_CRDS = ['ingressroutes.traefik.io', 'middlewares.traefik.io'] as const;

// ---------------------------------------------------------------------------
// Warnings and refusals of the proxy catalogue (design-04 2.12)
// ---------------------------------------------------------------------------

export interface ProxyWarning {
  /** catalogue id, e.g. W-PX-NODE-MOVED */
  code: string;
  message: string;
  /** absent when the catalogue has none (W-PX-TAKEOVER) */
  suggestion?: string;
}

export interface ProxyRefusal {
  /** catalogue id, e.g. E-PX-CONFLICT */
  code: string;
  /** the DeployError code ensure() throws it with */
  errorCode: ErrorCode;
  message: string;
  suggestion: string;
}

/** ensure() throws a refusal as this error; plan() returns it as a blocker instead. */
export function proxyRefusalError(refusal: ProxyRefusal): DeployError {
  return new DeployError(refusal.message, refusal.errorCode, refusal.suggestion);
}

// ---------------------------------------------------------------------------
// Intent (2.3.2)
// ---------------------------------------------------------------------------

/** Everything in proxy config that shapes the cluster-wide Traefik (proxy.domains does not: routes do). */
export interface TraefikIntent {
  acme: boolean;
  /** null when unset (Let's Encrypt no longer needs a contact), when acme is false, and for a stack that does not manage the proxy */
  email: string | null;
  /** null = Let's Encrypt production (the chart emits no caServer) */
  caServer: string | null;
  /** PEM text of proxy.acme_ca_bundle, already rendered; null when unset */
  caBundle: string | null;
  /** domain is lowercase, null when disabled */
  dashboard: { enabled: boolean; domain: string | null };
  /** proxy.default_ingress_class */
  defaultIngressClass: boolean;
}

// The domain lands unquoted in the chart's `match:` field, so this also blocks rule and YAML injection
const HOST_NAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[-A-Za-z0-9]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[-A-Za-z0-9]{0,61}[A-Za-z0-9])?)*$/;

export function traefikIntentFrom(proxy: ProxyConfig, caBundle: string | null): TraefikIntent {
  const acme = proxy.acme !== false;
  const manage = proxy.manage !== false;
  const email = acme && manage ? (proxy.email ?? null) : null;
  const enabled = proxy.dashboard?.enabled === true;
  const domain = enabled ? (proxy.dashboard?.domain ?? '') : null;
  if (domain !== null && !HOST_NAME_RE.test(domain)) {
    throw new ConfigError(
      `proxy.dashboard.domain "${domain}" is not a valid host name`,
      'Use a DNS name such as `traefik.example.com`, without scheme, port, path or wildcard.',
    );
  }
  return {
    acme,
    email,
    caServer: acme ? (proxy.acme_ca_server ?? null) : null,
    caBundle: acme && proxy.acme_ca_server ? caBundle : null,
    dashboard: { enabled, domain: domain ? domain.toLowerCase() : null },
    defaultIngressClass: proxy.default_ingress_class === true,
  };
}

/** What a stack that does not manage the proxy can depend on; the only part of the intent stored in the clear. */
export interface ProxyCapabilities {
  /** websecure is published on hostPort 443 and certResolver letsencrypt exists */
  acme: boolean;
  /** web answers with a permanent redirect to websecure */
  redirectToHttps: boolean;
  dashboard: boolean;
  defaultIngressClass: boolean;
}

export function intentCapabilities(intent: TraefikIntent): ProxyCapabilities {
  return {
    acme: intent.acme,
    redirectToHttps: intent.acme,
    dashboard: intent.dashboard.enabled,
    defaultIngressClass: intent.defaultIngressClass,
  };
}

// ---------------------------------------------------------------------------
// Values (2.4)
// ---------------------------------------------------------------------------

/** The control-plane node that answers 80/443; resolved by resolvePlacement, never by the scheduler. */
export interface TraefikPlacement {
  /** kubernetes.io/hostname value = nodeNameFor(servers.yml key) */
  hostname: string;
}

/** Name of the Secret holding proxy.acme_ca_bundle: the content checksum is in the name (core 5.6). */
export function acmeCaSecretName(caBundle: string): string {
  return `${K8S_PROXY_ACME_CA_SECRET}-${sha256Hex(caBundle).slice(0, 8)}`;
}

/** Ports the Traefik pod publishes on its node (Swarm parity: 443 only with ACME). */
export function proxyHostPorts(acme: boolean): number[] {
  return acme ? [80, 443] : [80];
}

/**
 * Let's Encrypt production keeps `/data/acme.json`; any other CA gets a file of its own. Traefik
 * resets its account when the CA changes but keeps serving the stored certificates until they near
 * expiry, so a switch from staging to production would otherwise serve untrusted certificates for
 * two months.
 */
export function acmeStoragePath(caServer: string | null): string {
  if (caServer === null) return '/data/acme.json';
  const host = new URL(caServer).host.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  return `/data/acme-${host}-${sha256Hex(caServer).slice(0, 8)}.json`;
}

/**
 * User values of the `dockflow-traefik` release. Sent as canonical JSON on stdin; the PEM text of
 * a CA bundle never enters them, only the name of the Secret that carries it.
 */
export function buildTraefikValues(
  intent: TraefikIntent,
  traits: DistributionTraits,
  placement: TraefikPlacement,
  pin: TraefikChartPin = TRAEFIK_CHART_PIN,
): Record<string, unknown> {
  const imageRef = pin.imageDigest ? `docker.io/traefik@${pin.imageDigest}` : `docker.io/traefik:${pin.appVersion}`;
  const cp = traits.controlPlaneNodeLabel;

  const ports: Record<string, Record<string, unknown>> = {
    web: { port: 8000, hostPort: 80, expose: { default: true } },
    // websecure always terminates TLS; ACME decides whether it is published (2.7)
    websecure: { port: 8443, expose: { default: intent.acme }, http: { tls: { enabled: true } } },
  };

  const values: Record<string, unknown> = {
    image: {
      registry: 'docker.io',
      repository: 'traefik',
      tag: pin.appVersion,
      ...(pin.imageDigest ? { digest: pin.imageDigest } : {}),
    },
    commonLabels: { [LABELS.part]: PARTS.system },
    deployment: { kind: 'Deployment', replicas: 1 },
    // hostPort and the RWO ACME volume both forbid a second pod on the node
    updateStrategy: { type: 'Recreate' },
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    api: { dashboard: intent.dashboard.enabled },
    ingressRoute: { dashboard: { enabled: false }, healthcheck: { enabled: false } },
    // not the cluster default unless asked: a default class publishes every classless Ingress (C24)
    ingressClass: { enabled: true, isDefaultClass: intent.defaultIngressClass, name: 'traefik' },
    gateway: { enabled: false },
    gatewayClass: { enabled: false },
    providers: {
      kubernetesCRD: { enabled: true, allowCrossNamespace: false, allowExternalNameServices: false, allowEmptyServices: true },
      kubernetesIngress: { enabled: true, allowExternalNameServices: false, publishedService: { enabled: false } },
      kubernetesGateway: { enabled: false },
    },
    service: { enabled: true, spec: { type: 'ClusterIP' } },
    ports,
    persistence: { enabled: false },
    nodeSelector: { [cp.key]: cp.value, [KUBE_KEYS.hostname]: placement.hostname },
    tolerations: [
      { key: cp.key, operator: 'Exists', effect: 'NoSchedule' },
      { key: 'CriticalAddonsOnly', operator: 'Exists' },
    ],
    priorityClassName: 'system-cluster-critical',
    // Burstable QoS: a BestEffort ingress pod is the first eviction candidate (C24); no CPU limit
    resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
  };

  if (intent.dashboard.enabled) {
    values.ingressRoute = {
      healthcheck: { enabled: false },
      dashboard: {
        enabled: true,
        matchRule: `Host(\`${intent.dashboard.domain}\`)`,
        entryPoints: [intent.acme ? 'websecure' : 'web'],
        ...(intent.acme ? { tls: { certResolver: 'letsencrypt' } } : {}),
      },
    };
  }

  if (intent.acme) {
    // priority 1: an explicit router on web wins over the redirect instead of being shadowed (2.7)
    ports.web.http = { redirections: { entryPoint: { to: 'websecure', scheme: 'https', permanent: true, priority: 1 } } };
    ports.websecure.hostPort = 443;
    values.persistence = {
      enabled: true,
      name: 'data',
      accessMode: 'ReadWriteOnce',
      size: '128Mi',
      storageClass: traits.defaultStorageClass,
      path: '/data',
    };
    const storage = acmeStoragePath(intent.caServer);
    values.certificatesResolvers = {
      letsencrypt: {
        acme: {
          ...(intent.email ? { email: intent.email } : {}),
          storage,
          httpChallenge: { entryPoint: 'web' },
          ...(intent.caServer ? { caServer: intent.caServer } : {}),
        },
      },
    };
    values.podSecurityContext = { fsGroup: TRAEFIK_RUN_AS, fsGroupChangePolicy: 'OnRootMismatch' };
    values.deployment = {
      kind: 'Deployment',
      replicas: 1,
      initContainers: [
        {
          name: 'acme-permissions',
          image: imageRef,
          imagePullPolicy: 'IfNotPresent',
          // Traefik refuses an acme.json more open than 0600
          command: ['sh', '-c', `touch ${storage} && chmod 600 ${storage}`],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true },
          volumeMounts: [{ name: 'data', mountPath: '/data' }],
        },
      ],
    };
    if (intent.caBundle) {
      // lego trusts LEGO_CA_CERTIFICATES and keeps the system roots only with the second variable (F26)
      values.volumes = [{ name: acmeCaSecretName(intent.caBundle), mountPath: '/etc/dockflow/acme-ca', type: 'secret' }];
      values.env = [
        { name: 'LEGO_CA_CERTIFICATES', value: '/etc/dockflow/acme-ca/ca.crt' },
        { name: 'LEGO_CA_SYSTEM_CERT_POOL', value: 'true' },
      ];
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Placement (2.4.1)
// ---------------------------------------------------------------------------

/** O9: one control-plane node of the cluster. */
export interface ControlPlaneNodeFact {
  hostname: string;
  ready: boolean;
  schedulable: boolean;
}

export function controlPlaneNodeFacts(nodes: readonly Node[]): ControlPlaneNodeFact[] {
  return nodes.map((node) => ({
    hostname: node.metadata.labels?.[KUBE_KEYS.hostname] ?? node.metadata.name,
    ready: node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true,
    schedulable: node.spec?.unschedulable !== true,
  }));
}

/** O5: a Traefik pod of the release (label app.kubernetes.io/name=traefik in dockflow-system). */
export interface TraefikPodFact {
  name: string;
  /** spec.nodeName; null while unscheduled */
  node: string | null;
  phase: string;
  ready: boolean;
  /** display status for messages, e.g. `CrashLoopBackOff` or `Pending` */
  status: string;
}

function defaultPodStatus(pod: Pod): string {
  if (pod.metadata.deletionTimestamp) return 'Terminating';
  const waiting = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((s) => s.state?.waiting?.reason);
  return waiting?.state?.waiting?.reason ?? pod.status?.reason ?? pod.status?.phase ?? 'Unknown';
}

export function traefikPodFacts(pods: readonly Pod[], displayStatus: (pod: Pod) => string = defaultPodStatus): TraefikPodFact[] {
  return pods.map((pod) => ({
    name: pod.metadata.name,
    node: pod.spec.nodeName ?? null,
    phase: pod.status?.phase ?? 'Unknown',
    ready: pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true,
    status: displayStatus(pod),
  }));
}

/** spec.nodeName of the first running Traefik pod (row 3 of 2.4.1, drift of 2.8.3) */
export function runningTraefikNode(pods: readonly TraefikPodFact[]): string | null {
  return pods.find((pod) => pod.phase === 'Running' && pod.node !== null)?.node ?? null;
}

/** O5: Deployment dockflow-traefik; null when it does not exist. */
export function traefikDeploymentFact(deployment: Deployment | null): { replicas: number; readyReplicas: number } | null {
  if (deployment === null) return null;
  return { replicas: deployment.spec.replicas ?? 1, readyReplicas: deployment.status?.readyReplicas ?? 0 };
}

/**
 * O10: the node a local volume is pinned to, the single value of the `kubernetes.io/hostname` `In`
 * expression of its node affinity; null without one.
 */
export function pvNodeHostname(pv: PersistentVolume | null): string | null {
  for (const term of pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? []) {
    for (const expression of term.matchExpressions ?? []) {
      if (expression.key === KUBE_KEYS.hostname && expression.operator === 'In' && expression.values?.length === 1) return expression.values[0];
    }
  }
  return null;
}

export interface PlacementInput {
  /** intent.acme */
  acme: boolean;
  /** O10: hostname of the PV bound to claim dockflow-traefik; null when absent, unbound or not node-pinned */
  acmeVolumeHostname: string | null;
  /** ConfigMap key `node-hostname` */
  recordedHostname: string | null;
  /** spec.nodeName of the live Traefik pod */
  runningHostname: string | null;
  /** O9: every control-plane node of the cluster */
  controlPlaneNodes: readonly ControlPlaneNodeFact[];
  /** nodeNameFor(servers.yml key) of the managers, servers.yml order */
  managers: readonly string[];
  /** environment name, for messages */
  env: string;
}

export type PlacementResult = { kind: 'ok'; hostname: string; warnings: ProxyWarning[] } | { kind: 'refuse'; refusal: ProxyRefusal };

/**
 * The node that answers 80/443, for managing stacks only. Sticky: a recorded node or a claim that
 * pins Traefik keeps it there, so a recreation never moves the ingress away from DNS. Drift of a
 * running pod is reported by planProxy, which sees the desired values.
 */
export function resolvePlacement(input: PlacementInput): PlacementResult {
  const inCluster = (hostname: string): ControlPlaneNodeFact | undefined => input.controlPlaneNodes.find((node) => node.hostname === hostname);
  const firstCandidate = (): string | null =>
    input.managers.find((manager) => {
      const node = inCluster(manager);
      return node !== undefined && node.ready && node.schedulable;
    }) ?? null;
  const noNode: PlacementResult = { kind: 'refuse', refusal: noNodeRefusal(input.env) };

  // 0a / 0b: a local RWO claim can only be mounted on its node
  if (input.acme && input.acmeVolumeHostname !== null) {
    const node = inCluster(input.acmeVolumeHostname);
    if (node === undefined) return { kind: 'refuse', refusal: acmeNodeLostRefusal(input.acmeVolumeHostname, input.env) };
    const warnings = nodeHealthWarnings(node);
    if (input.recordedHostname !== null && input.recordedHostname !== node.hostname) {
      warnings.unshift(nodeMovedWarning(input.recordedHostname, node.hostname));
    }
    return { kind: 'ok', hostname: node.hostname, warnings };
  }

  if (input.recordedHostname !== null) {
    const node = inCluster(input.recordedHostname);
    // 1
    if (node !== undefined && input.managers.includes(node.hostname)) return { kind: 'ok', hostname: node.hostname, warnings: nodeHealthWarnings(node) };
    // 2
    const next = firstCandidate();
    if (next === null) return noNode;
    return { kind: 'ok', hostname: next, warnings: [nodeMovedWarning(input.recordedHostname, next)] };
  }

  // 3: adopting what already serves never moves the ingress
  if (input.runningHostname !== null) return { kind: 'ok', hostname: input.runningHostname, warnings: [] };
  // 4 / 5
  const first = firstCandidate();
  return first === null ? noNode : { kind: 'ok', hostname: first, warnings: [] };
}

function nodeHealthWarnings(node: ControlPlaneNodeFact): ProxyWarning[] {
  if (node.ready && node.schedulable) return [];
  const state = node.ready ? 'cordoned' : 'not Ready';
  return [
    {
      code: 'W-PX-NODE-NOTREADY',
      message: `The node that runs Traefik, ${node.hostname}, is ${state}, so ports 80 and 443 may answer nowhere`,
      suggestion: `Bring ${node.hostname} back, or remove it from \`servers.yml\` and deploy again to move Traefik.`,
    },
  ];
}

function nodeMovedWarning(from: string, to: string): ProxyWarning {
  return {
    code: 'W-PX-NODE-MOVED',
    message: `Traefik moves from ${from} to ${to}, which is the node that answers ports 80 and 443 from now on`,
    suggestion: `Point the DNS records of this environment at ${to} before the deploy finishes.`,
  };
}

function acmeNodeLostRefusal(node: string, env: string): ProxyRefusal {
  return {
    code: 'E-PX-ACME-NODE-LOST',
    errorCode: ErrorCode.DEPLOY_FAILED,
    message: `Traefik's ACME volume ${K8S_PROXY_ACME_CLAIM} is bound to node ${node}, which is no longer in the cluster, so Traefik cannot start on any other node`,
    suggestion: `Follow the lost-node steps printed by \`dockflow helm status ${env} --system\`: \`dockflow helm uninstall ${env} --system --volumes --force\`, then deploy again and restore acme.json from a backup.`,
  };
}

function noNodeRefusal(env: string): ProxyRefusal {
  return {
    code: 'E-PX-NO-NODE',
    errorCode: ErrorCode.DEPLOY_FAILED,
    message: `No control-plane node of ${env} is ready and schedulable to run Traefik`,
    suggestion: `Check the cluster with \`dockflow diagnose ${env}\`, then deploy again.`,
  };
}

// ---------------------------------------------------------------------------
// CRDs (2.5)
// ---------------------------------------------------------------------------

export interface CustomResourceDefinition extends KubeObjectBase<'apiextensions.k8s.io/v1', 'CustomResourceDefinition'> {
  spec: { group: string; names?: { plural?: string; kind?: string }; [field: string]: unknown };
}

function isTraefikCrd(doc: unknown): doc is CustomResourceDefinition {
  if (typeof doc !== 'object' || doc === null) return false;
  const object = doc as { kind?: unknown; metadata?: { name?: unknown }; spec?: { group?: unknown } };
  return object.kind === 'CustomResourceDefinition' && typeof object.metadata?.name === 'string' && object.spec?.group === 'traefik.io';
}

/**
 * Documents of `helm show crds`, keeping the CustomResourceDefinitions of group traefik.io only
 * (hub.traefik.io and the Gateway API CRDs are not needed). A chart without them is a broken pin.
 */
export function filterTraefikCrds(docs: readonly unknown[], chartVersion: string = TRAEFIK_CHART_PIN.version): CustomResourceDefinition[] {
  const crds = docs.filter(isTraefikCrd);
  if (crds.length === 0) throw new DeployError(`Traefik chart ${chartVersion} contains no traefik.io CRDs; the pin is broken`);
  return crds;
}

/** The CRDs as Dockflow applies them: ownership labels and the pin they came from. */
export function labelTraefikCrds(crds: readonly CustomResourceDefinition[], pin: TraefikChartPin = TRAEFIK_CHART_PIN): CustomResourceDefinition[] {
  return crds.map((crd) => {
    const copy = structuredClone(crd);
    copy.metadata.labels = { ...copy.metadata.labels, [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: PARTS.system };
    copy.metadata.annotations = {
      ...copy.metadata.annotations,
      [ANNOTATIONS.crdChartVersion]: pin.version,
      [ANNOTATIONS.crdTraefikVersion]: pin.appVersion,
    };
    return copy;
  });
}

export type CrdApplyDecision = { action: 'apply' } | { action: 'skip'; warning: ProxyWarning } | { action: 'refuse'; refusal: ProxyRefusal };

type InstalledCrdState =
  | { kind: 'foreign'; managedBy: string | null }
  | { kind: 'absent' }
  | { kind: 'dockflow' }
  | { kind: 'versioned'; version: string };

/**
 * Never overwrite CRDs another owner or a newer pin installed (2.5). `installed` holds what
 * `get crds ingressroutes.traefik.io middlewares.traefik.io` returned; when the two disagree the
 * lower state wins, so the apply repairs the cluster or the refusal names the foreign owner.
 */
export function planCrdApply(
  installed: readonly { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> } }[],
  stackName: string,
  pin: TraefikChartPin = TRAEFIK_CHART_PIN,
): CrdApplyDecision {
  const states: InstalledCrdState[] = REQUIRED_TRAEFIK_CRDS.map((name) => {
    const crd = installed.find((item) => item.metadata.name === name);
    if (crd === undefined) return { kind: 'absent' };
    const version = crd.metadata.annotations?.[ANNOTATIONS.crdChartVersion];
    if (version !== undefined) return { kind: 'versioned', version };
    const managedBy = crd.metadata.labels?.[LABELS.managedBy] ?? null;
    return managedBy === K8S_MANAGED_BY ? { kind: 'dockflow' } : { kind: 'foreign', managedBy };
  });

  const foreign = states.find((state) => state.kind === 'foreign');
  if (foreign !== undefined) {
    return {
      action: 'refuse',
      refusal: {
        code: 'E-PX-CRDS-FOREIGN',
        errorCode: ErrorCode.VALIDATION_FAILED,
        message: `The traefik.io CRDs on this cluster were installed by ${foreign.managedBy ?? 'another tool'}, and Dockflow will not overwrite CRDs it does not own`,
        suggestion: 'Let that installation own the proxy and set `proxy.manage: false` here, or remove its CRDs before deploying.',
      },
    };
  }
  const versions = states.flatMap((state) => (state.kind === 'versioned' ? [state.version] : []));
  // an absent or unannotated CRD is below any annotated one: the apply repairs it
  if (versions.length < states.length) return { action: 'apply' };
  const lowest = versions.reduce((low, version) => ((compareChartVersions(version, low) ?? 0) < 0 ? version : low));
  if ((compareChartVersions(lowest, pin.version) ?? 0) <= 0) return { action: 'apply' };
  return {
    action: 'skip',
    warning: {
      code: 'W-PX-CRDS-NEWER',
      message: `The traefik.io CRDs on this cluster come from chart ${lowest}, which is newer than this Dockflow release (${pin.version}), so they are left unchanged`,
      suggestion: `Upgrade the Dockflow CLI used for ${stackName}.`,
    },
  };
}
