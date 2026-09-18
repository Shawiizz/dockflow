// Hand-written minimal Kubernetes types (DESIGN-CORE 4.1). A field exists only when Dockflow emits
// or reads it. One type serves both directions, so a field is required only when every object of
// the kind carries it, whether a builder produced it or `kubectl -o json` returned it (names,
// selectors, templates, containers, port numbers and protocols). Everything else is optional: the
// API server omits empty and zero values. The per-kind mandatory fields of emission rule 8 are
// asserted by the semantic validator and the goldens, not by these types.
// Quantities and timestamps are strings, IntOrString is `number | string`.

export type IntOrString = number | string;

export type ConditionStatus = 'True' | 'False' | 'Unknown';

/** Shape shared by pod, workload, Job and Node conditions. */
export interface Condition {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastUpdateTime?: string;
  lastProbeTime?: string;
  lastHeartbeatTime?: string;
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

/** Present only with `--show-managed-fields` (foreign ownership pre-check). */
export interface ManagedFieldsEntry {
  manager?: string;
  operation?: 'Apply' | 'Update';
  apiVersion?: string;
  time?: string;
  subresource?: string;
  fieldsType?: string;
  fieldsV1?: Record<string, unknown>;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  // read-only, present in kubectl JSON, never emitted
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  ownerReferences?: OwnerReference[];
  finalizers?: string[];
  managedFields?: ManagedFieldsEntry[];
}

/** Metadata of an embedded pod template: no name of its own. */
export interface TemplateMetadata {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface LabelSelectorRequirement {
  key: string;
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  values?: string[];
}

export interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: LabelSelectorRequirement[];
}

export interface KubeObjectBase<A extends string, K extends string> {
  apiVersion: A;
  kind: K;
  metadata: ObjectMeta;
}

export interface KubeList<T> {
  apiVersion: 'v1';
  kind: 'List';
  items: T[];
}
