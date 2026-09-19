// core/v1 kinds Dockflow emits or reads (DESIGN-CORE 4.1; field sources: design-02 4-9,
// design-03 2.4 and 9.2, design-04 2, design-05 11-12, design-06 2.2-2.3, 3.17 and 4.3).
// The deployer ClusterRoleBinding sits here with the ServiceAccount it binds.

import type { Protocol } from '../model/types';
import type { Condition, IntOrString, KubeObjectBase, LabelSelector, TemplateMetadata } from './meta';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Quantities keyed by resource name; containers use cpu and memory, claims and volumes storage. */
export interface ResourceList {
  cpu?: string;
  memory?: string;
  storage?: string;
}

export interface ResourceRequirements {
  limits?: ResourceList;
  requests?: ResourceList;
}

export type NodeSelectorOperator = 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';

export interface NodeSelectorRequirement {
  key: string;
  operator: NodeSelectorOperator;
  values?: string[];
}

export interface NodeSelectorTerm {
  matchExpressions?: NodeSelectorRequirement[];
}

export interface NodeSelector {
  nodeSelectorTerms: NodeSelectorTerm[];
}

export interface ObjectReference {
  apiVersion?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  uid?: string;
}

export type TaintEffect = 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------

export interface Namespace extends KubeObjectBase<'v1', 'Namespace'> {
  spec?: { finalizers?: string[] };
  status?: { phase?: 'Active' | 'Terminating' };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer' | 'ExternalName';

export interface ServicePort {
  name?: string;
  port: number;
  /** always emitted: second half of the list-map key (emission rule 8) */
  protocol: Protocol;
  /** omitted on ClusterIP, headless and alias Services (equals `port`); numeric on `-lb` Services */
  targetPort?: IntOrString;
  appProtocol?: string;
}

export interface ServiceSpec {
  /** omitted = ClusterIP */
  type?: ServiceType;
  /** 'None' for headless Services */
  clusterIP?: string;
  ports?: ServicePort[];
  selector?: Record<string, string>;
  allocateLoadBalancerNodePorts?: boolean;
  loadBalancerSourceRanges?: string[];
}

export interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

export interface ServiceStatus {
  loadBalancer?: { ingress?: LoadBalancerIngress[] };
}

export interface Service extends KubeObjectBase<'v1', 'Service'> {
  spec: ServiceSpec;
  status?: ServiceStatus;
}

// ---------------------------------------------------------------------------
// Secret and ConfigMap
// ---------------------------------------------------------------------------

export interface Secret extends KubeObjectBase<'v1', 'Secret'> {
  /**
   * Omitted = Opaque. Other values Dockflow writes or reads: `kubernetes.io/dockerconfigjson`
   * (registry Secret), `kubernetes.io/service-account-token` (deployer token), the release type.
   */
  type?: string;
  /** base64 of the raw bytes; the plain-string form of Secret data is never emitted (emission rule 7) */
  data?: Record<string, string>;
  immutable?: boolean;
}

export interface ConfigMap extends KubeObjectBase<'v1', 'ConfigMap'> {
  /** valid UTF-8 content */
  data?: Record<string, string>;
  /** base64 of content that is not valid UTF-8 */
  binaryData?: Record<string, string>;
  immutable?: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type PersistentVolumeAccessMode = 'ReadWriteOnce' | 'ReadOnlyMany' | 'ReadWriteMany' | 'ReadWriteOncePod';

export type PersistentVolumeReclaimPolicy = 'Retain' | 'Delete' | 'Recycle';

export interface PersistentVolumeClaimSpec {
  accessModes: PersistentVolumeAccessMode[];
  resources: { requests: { storage: string } };
  /** always emitted by Dockflow (design-02 7.4 invariant 2); may be absent on foreign claims */
  storageClassName?: string;
  /** read: the bound PersistentVolume */
  volumeName?: string;
}

export interface PersistentVolumeClaimStatus {
  phase?: 'Pending' | 'Bound' | 'Lost';
  capacity?: { storage?: string };
  accessModes?: PersistentVolumeAccessMode[];
}

export interface PersistentVolumeClaim extends KubeObjectBase<'v1', 'PersistentVolumeClaim'> {
  spec: PersistentVolumeClaimSpec;
  status?: PersistentVolumeClaimStatus;
}

/** Read and patched only (reclaim policy, `P/reclaim-policy-before`); never emitted by the translator. */
export interface PersistentVolume extends KubeObjectBase<'v1', 'PersistentVolume'> {
  spec?: {
    capacity?: { storage?: string };
    accessModes?: PersistentVolumeAccessMode[];
    persistentVolumeReclaimPolicy?: PersistentVolumeReclaimPolicy;
    storageClassName?: string;
    claimRef?: ObjectReference;
    hostPath?: { path: string };
    local?: { path: string };
    /** local volumes: the `kubernetes.io/hostname` `In` expression names the node holding the data */
    nodeAffinity?: { required?: NodeSelector };
  };
  status?: { phase?: 'Pending' | 'Available' | 'Bound' | 'Released' | 'Failed' };
}

// ---------------------------------------------------------------------------
// Pod
// ---------------------------------------------------------------------------

export interface KeySelector {
  name: string;
  key: string;
  optional?: boolean;
}

/** Read only: Dockflow passes user environment through `envFrom` (design-02 5.3). */
export interface ContainerEnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: KeySelector; configMapKeyRef?: KeySelector };
}

export interface EnvFromSource {
  secretRef?: { name: string; optional?: boolean };
  configMapRef?: { name: string; optional?: boolean };
}

export interface ContainerPort {
  name?: string;
  containerPort: number;
  /** always emitted: second half of the list-map key (emission rule 8) */
  protocol: Protocol;
  hostPort?: number;
  hostIP?: string;
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  subPath?: string;
  recursiveReadOnly?: 'Disabled' | 'IfPossible' | 'Enabled';
  mountPropagation?: 'None' | 'HostToContainer' | 'Bidirectional';
}

export interface ExecAction {
  command: string[];
}

export interface HTTPGetAction {
  path: string;
  port: IntOrString;
  /** omitted = HTTP */
  scheme?: 'HTTP' | 'HTTPS';
}

export interface TCPSocketAction {
  port: IntOrString;
}

export interface Probe {
  exec?: ExecAction;
  httpGet?: HTTPGetAction;
  tcpSocket?: TCPSocketAction;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  successThreshold?: number;
  failureThreshold?: number;
}

export interface Lifecycle {
  postStart?: { exec: ExecAction };
  preStop?: { exec: ExecAction };
}

export interface Capabilities {
  add?: string[];
  drop?: string[];
}

export interface SecurityContext {
  privileged?: boolean;
  capabilities?: Capabilities;
  readOnlyRootFilesystem?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
}

export type ImagePullPolicy = 'Always' | 'IfNotPresent' | 'Never';

export interface Container {
  name: string;
  image: string;
  imagePullPolicy?: ImagePullPolicy;
  /** compose entrypoint */
  command?: string[];
  /** compose command */
  args?: string[];
  workingDir?: string;
  env?: ContainerEnvVar[];
  envFrom?: EnvFromSource[];
  ports?: ContainerPort[];
  volumeMounts?: VolumeMount[];
  resources?: ResourceRequirements;
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
  lifecycle?: Lifecycle;
  securityContext?: SecurityContext;
  stdin?: boolean;
  tty?: boolean;
}

export interface KeyToPath {
  key: string;
  path: string;
}

export type HostPathType =
  | ''
  | 'Directory'
  | 'DirectoryOrCreate'
  | 'File'
  | 'FileOrCreate'
  | 'Socket'
  | 'CharDevice'
  | 'BlockDevice';

export interface Volume {
  name: string;
  persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
  /** the translator never emits `type` (design-02 5.5); helper pods do */
  hostPath?: { path: string; type?: HostPathType };
  emptyDir?: { medium?: '' | 'Memory'; sizeLimit?: string };
  secret?: { secretName: string; defaultMode?: number; items?: KeyToPath[]; optional?: boolean };
  configMap?: { name: string; defaultMode?: number; items?: KeyToPath[]; optional?: boolean };
  /** read only: Secret and ConfigMap references of foreign templates */
  projected?: { sources?: { secret?: { name: string }; configMap?: { name: string } }[] };
}

export interface SeccompProfile {
  type: 'RuntimeDefault' | 'Unconfined' | 'Localhost';
  localhostProfile?: string;
}

export interface AppArmorProfile {
  type: 'RuntimeDefault' | 'Unconfined' | 'Localhost';
  localhostProfile?: string;
}

export interface Sysctl {
  name: string;
  value: string;
}

export interface PodSecurityContext {
  seccompProfile?: SeccompProfile;
  appArmorProfile?: AppArmorProfile;
  sysctls?: Sysctl[];
  supplementalGroups?: number[];
  fsGroup?: number;
  fsGroupChangePolicy?: 'OnRootMismatch' | 'Always';
  runAsUser?: number;
  runAsGroup?: number;
}

export interface Toleration {
  key?: string;
  /** omitted = Equal */
  operator?: 'Equal' | 'Exists';
  value?: string;
  effect?: TaintEffect;
  tolerationSeconds?: number;
}

export interface PodAffinityTerm {
  labelSelector?: LabelSelector;
  matchLabelKeys?: string[];
  topologyKey: string;
}

export interface Affinity {
  nodeAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: NodeSelector };
  podAntiAffinity?: { requiredDuringSchedulingIgnoredDuringExecution?: PodAffinityTerm[] };
}

export interface TopologySpreadConstraint {
  maxSkew: number;
  topologyKey: string;
  whenUnsatisfiable: 'DoNotSchedule' | 'ScheduleAnyway';
  labelSelector?: LabelSelector;
  matchLabelKeys?: string[];
}

export interface PodDNSConfig {
  nameservers?: string[];
  searches?: string[];
  options?: { name: string; value?: string }[];
}

export interface HostAlias {
  ip: string;
  hostnames: string[];
}

export interface PodSpec {
  containers: Container[];
  initContainers?: Container[];
  volumes?: Volume[];
  automountServiceAccountToken?: boolean;
  enableServiceLinks?: boolean;
  terminationGracePeriodSeconds?: number;
  securityContext?: PodSecurityContext;
  imagePullSecrets?: { name: string }[];
  /** Jobs and helper pods only (design-02 4.5) */
  restartPolicy?: 'Always' | 'OnFailure' | 'Never';
  activeDeadlineSeconds?: number;
  hostname?: string;
  shareProcessNamespace?: boolean;
  hostNetwork?: boolean;
  hostPID?: boolean;
  hostIPC?: boolean;
  /** emitted only when not ClusterFirst */
  dnsPolicy?: 'ClusterFirst' | 'ClusterFirstWithHostNet' | 'Default' | 'None';
  dnsConfig?: PodDNSConfig;
  hostAliases?: HostAlias[];
  nodeSelector?: Record<string, string>;
  affinity?: Affinity;
  tolerations?: Toleration[];
  topologySpreadConstraints?: TopologySpreadConstraint[];
  /** helper pods pinned to the node of a bind mount; on read, the node the pod was scheduled to */
  nodeName?: string;
}

export interface PodTemplateSpec {
  metadata: TemplateMetadata;
  spec: PodSpec;
}

export interface ContainerStateWaiting {
  reason?: string;
  message?: string;
}

export interface ContainerStateRunning {
  startedAt?: string;
}

export interface ContainerStateTerminated {
  exitCode: number;
  signal?: number;
  reason?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ContainerState {
  waiting?: ContainerStateWaiting;
  running?: ContainerStateRunning;
  terminated?: ContainerStateTerminated;
}

export interface ContainerStatus {
  name: string;
  ready: boolean;
  started?: boolean;
  restartCount: number;
  image: string;
  imageID?: string;
  containerID?: string;
  state?: ContainerState;
  lastState?: ContainerState;
}

export type PodPhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';

export interface PodStatus {
  phase?: PodPhase;
  /** Evicted, NodeLost, UnexpectedAdmissionError */
  reason?: string;
  message?: string;
  conditions?: Condition[];
  startTime?: string;
  hostIP?: string;
  podIP?: string;
  initContainerStatuses?: ContainerStatus[];
  containerStatuses?: ContainerStatus[];
}

/** Read for every stack pod; emitted for helper pods (backup, restore, volume) only. */
export interface Pod extends KubeObjectBase<'v1', 'Pod'> {
  spec: PodSpec;
  status?: PodStatus;
}

// ---------------------------------------------------------------------------
// Node and Event (read only)
// ---------------------------------------------------------------------------

export interface Taint {
  key: string;
  value?: string;
  effect: TaintEffect;
}

export interface NodeAddress {
  /** InternalIP, ExternalIP, Hostname */
  type: string;
  address: string;
}

export interface Node extends KubeObjectBase<'v1', 'Node'> {
  spec?: { unschedulable?: boolean; taints?: Taint[] };
  status?: {
    conditions?: Condition[];
    addresses?: NodeAddress[];
    nodeInfo?: { kubeletVersion?: string; architecture?: string; operatingSystem?: string };
  };
}

export interface Event extends KubeObjectBase<'v1', 'Event'> {
  involvedObject?: ObjectReference;
  type?: 'Normal' | 'Warning';
  reason?: string;
  message?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  /** MicroTime; set instead of the two timestamps by newer reporters */
  eventTime?: string;
}

// ---------------------------------------------------------------------------
// Deployer identity (setup-owned, design-05 12.1)
// ---------------------------------------------------------------------------

export interface ServiceAccount extends KubeObjectBase<'v1', 'ServiceAccount'> {
  automountServiceAccountToken?: boolean;
  /** read: must not list the deployer token, which would make it cleanable (design-05 12.1) */
  secrets?: { name?: string }[];
}

export interface ClusterRoleBinding extends KubeObjectBase<'rbac.authorization.k8s.io/v1', 'ClusterRoleBinding'> {
  roleRef: { apiGroup: 'rbac.authorization.k8s.io'; kind: 'ClusterRole' | 'Role'; name: string };
  subjects?: { kind: 'ServiceAccount' | 'User' | 'Group'; name: string; namespace?: string; apiGroup?: string }[];
}
