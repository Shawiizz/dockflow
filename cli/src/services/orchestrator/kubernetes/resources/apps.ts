// apps/v1 kinds (DESIGN-CORE 4.1; design-02 4, design-03 2.4 and 9.3, design-06 2.2-2.4).
// Deployment, StatefulSet and DaemonSet are emitted; ReplicaSet and ControllerRevision are read
// only (revision gate of the convergence evaluator, `current` of day-2 listings, template refs).

import type { PersistentVolumeClaimSpec, PodTemplateSpec } from './core';
import type { Condition, IntOrString, KubeObjectBase, LabelSelector, ObjectMeta } from './meta';

export interface RollingUpdateDeployment {
  maxSurge?: IntOrString;
  maxUnavailable?: IntOrString;
}

export interface DeploymentStrategy {
  type: 'RollingUpdate' | 'Recreate';
  rollingUpdate?: RollingUpdateDeployment;
}

export interface DeploymentSpec {
  replicas?: number;
  /** immutable: `P/stack` + `P/service` only */
  selector: LabelSelector;
  template: PodTemplateSpec;
  strategy?: DeploymentStrategy;
  minReadySeconds?: number;
  progressDeadlineSeconds?: number;
  revisionHistoryLimit?: number;
  /** read only: an operator's paused rollout (fail-fast F15); never emitted */
  paused?: boolean;
}

export interface DeploymentStatus {
  observedGeneration?: number;
  replicas?: number;
  updatedReplicas?: number;
  readyReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Condition[];
}

export interface Deployment extends KubeObjectBase<'apps/v1', 'Deployment'> {
  spec: DeploymentSpec;
  status?: DeploymentStatus;
}

/** A claim template: emitted without apiVersion/kind, which the API server adds on read. */
export interface PersistentVolumeClaimTemplate {
  apiVersion?: 'v1';
  kind?: 'PersistentVolumeClaim';
  metadata: ObjectMeta;
  spec: PersistentVolumeClaimSpec;
}

export interface StatefulSetUpdateStrategy {
  type: 'RollingUpdate' | 'OnDelete';
  rollingUpdate?: { partition?: number; maxUnavailable?: IntOrString };
}

export interface StatefulSetPersistentVolumeClaimRetentionPolicy {
  whenDeleted: 'Retain' | 'Delete';
  whenScaled: 'Retain' | 'Delete';
}

export interface StatefulSetSpec {
  replicas?: number;
  selector: LabelSelector;
  template: PodTemplateSpec;
  /** always `<svc>-hl` in Dockflow output (immutable) */
  serviceName?: string;
  /** always the literal `Parallel` in Dockflow output (immutable, design-02 4.3) */
  podManagementPolicy?: 'OrderedReady' | 'Parallel';
  updateStrategy?: StatefulSetUpdateStrategy;
  persistentVolumeClaimRetentionPolicy?: StatefulSetPersistentVolumeClaimRetentionPolicy;
  volumeClaimTemplates?: PersistentVolumeClaimTemplate[];
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
}

export interface StatefulSetStatus {
  observedGeneration?: number;
  replicas?: number;
  readyReplicas?: number;
  currentReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  currentRevision?: string;
  updateRevision?: string;
  conditions?: Condition[];
}

export interface StatefulSet extends KubeObjectBase<'apps/v1', 'StatefulSet'> {
  spec: StatefulSetSpec;
  status?: StatefulSetStatus;
}

export interface DaemonSetUpdateStrategy {
  type: 'RollingUpdate' | 'OnDelete';
  rollingUpdate?: { maxSurge?: IntOrString; maxUnavailable?: IntOrString };
}

export interface DaemonSetSpec {
  selector: LabelSelector;
  template: PodTemplateSpec;
  updateStrategy?: DaemonSetUpdateStrategy;
  minReadySeconds?: number;
  revisionHistoryLimit?: number;
}

export interface DaemonSetStatus {
  observedGeneration?: number;
  desiredNumberScheduled?: number;
  currentNumberScheduled?: number;
  updatedNumberScheduled?: number;
  numberReady?: number;
  numberAvailable?: number;
  numberUnavailable?: number;
  numberMisscheduled?: number;
  conditions?: Condition[];
}

export interface DaemonSet extends KubeObjectBase<'apps/v1', 'DaemonSet'> {
  spec: DaemonSetSpec;
  status?: DaemonSetStatus;
}

/** Read only. The Deployment revision is the `deployment.kubernetes.io/revision` annotation. */
export interface ReplicaSet extends KubeObjectBase<'apps/v1', 'ReplicaSet'> {
  spec?: {
    replicas?: number;
    selector?: LabelSelector;
    template?: PodTemplateSpec;
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
}

/** Read only: StatefulSet and DaemonSet history; `data` is the template patch of that revision. */
export interface ControllerRevision extends KubeObjectBase<'apps/v1', 'ControllerRevision'> {
  revision?: number;
  data?: { spec?: { template?: PodTemplateSpec } };
}
