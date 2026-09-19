// Namespace inventory shared by the stack, container, backup and volume backends of one bundle
// (design-06 2.2, DESIGN-CORE R5): one read per namespace per command, the revisions read only when
// a caller shows current revisions, and the pod metrics read at most once per namespace. Helm
// workloads are the namespace's own workloads carrying Helm's ownership metadata, so no release
// manifest (which holds rendered Secrets) is fetched for a day-2 command. Reads throw KubeError;
// each backend maps it for its own operation.

import type { HelmBackend, HelmReleaseStatus, StackRole } from '../../interfaces';
import { HELM_MANAGED_BY, KUBE_KEYS, LABELS } from '../constants';
import { memoize } from '../deps';
import { SEL_POD } from '../labels';
import type { ControllerRevision, ReplicaSet } from '../resources/apps';
import { KubeError } from '../runtime/errors';
import type { KubeExecutor } from '../runtime/kubectl';
import {
  buildInventoryView,
  type HelmReleaseWorkloads,
  type InventoryObject,
  type InventoryView,
  type RevisionIndex,
  type WorkloadObject,
} from '../status/pods';

/** the one namespace read: no ReplicaSets or ControllerRevisions, which carry a full pod template each */
export const INVENTORY_RESOURCES: readonly string[] = [
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
  'pods',
  'services',
  'persistentvolumeclaims',
];

export const REVISION_RESOURCES: readonly string[] = ['replicasets.apps', 'controllerrevisions.apps'];

export const EMPTY_REVISIONS: RevisionIndex = { replicaSets: [], controllerRevisions: [] };

export interface NamespaceInventory extends InventoryView {
  /**
   * ReplicaSets and ControllerRevisions, a second read made on first use and memoised: scoped to
   * the role's pods (`SEL_POD`), or the whole namespace for `null`, for a role with Helm releases
   * here (chart pods carry no Dockflow labels) and for a Helm release namespace.
   */
  revisions(role: StackRole | null): Promise<RevisionIndex>;
}

export interface StackInventory {
  /** the stack namespace, also the stack id */
  stackId: string;
  primary: NamespaceInventory;
  /** `primary` first, then every other namespace holding a Helm release of the stack */
  namespaces: NamespaceInventory[];
  /** Helm releases of the stack, cluster-wide */
  releases: HelmReleaseStatus[];
}

export interface ContainerMetrics {
  name: string;
  usage: { cpu?: string; memory?: string };
}

/** metrics.k8s.io PodMetrics, the fields Dockflow reads */
export interface PodMetrics {
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  containers: ContainerMetrics[];
}

export interface InventoryReader {
  /** the stack namespace and its Helm release namespaces, one read each, memoised until invalidate */
  read(stackId: string): Promise<StackInventory>;
  /** metrics.k8s.io pod metrics of one namespace, read at most once per bundle */
  podMetrics(namespace: string): Promise<PodMetrics[]>;
  /** called by every mutating method of the bundle's backends (all stacks when omitted); commands never call it */
  invalidate(stackId?: string): void;
}

export interface InventoryReaderDeps {
  kubectl: KubeExecutor;
  /** lists the stack's releases cluster-wide by label; null when the bundle has no Helm */
  helm: Pick<HelmBackend, 'listAll'> | null;
}

export function podMetricsPath(namespace: string): string {
  return `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
}

const HELM_WORKLOAD_KINDS: ReadonlySet<string> = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** workloads Helm installed for `release` in `namespace`, from the ownership label and annotations */
export function helmReleaseWorkloads(
  namespace: string,
  items: readonly InventoryObject[],
  releases: readonly HelmReleaseStatus[],
): HelmReleaseWorkloads[] {
  const workloads = items.filter((item): item is WorkloadObject => HELM_WORKLOAD_KINDS.has(item.kind));
  return releases
    .filter((release) => release.namespace === namespace)
    .sort((a, b) => compareText(a.name, b.name))
    .map((release) => ({
      release: release.name,
      role: release.role,
      namespace,
      workloads: workloads
        .filter((object) => {
          const labels = object.metadata.labels ?? {};
          const annotations = object.metadata.annotations ?? {};
          const releaseNamespace = annotations[KUBE_KEYS.helmReleaseNamespace];
          return (
            labels[LABELS.managedBy] === HELM_MANAGED_BY &&
            annotations[KUBE_KEYS.helmReleaseName] === release.name &&
            (releaseNamespace === undefined || releaseNamespace === namespace)
          );
        })
        .map((object) => ({ kind: object.kind as 'Deployment' | 'StatefulSet' | 'DaemonSet', name: object.metadata.name }))
        .sort((a, b) => compareText(a.kind, b.kind) || compareText(a.name, b.name)),
    }));
}

function splitRevisions(items: readonly (ReplicaSet | ControllerRevision)[]): RevisionIndex {
  const index: RevisionIndex = { replicaSets: [], controllerRevisions: [] };
  for (const item of items) {
    if (item.kind === 'ReplicaSet') index.replicaSets.push(item);
    else if (item.kind === 'ControllerRevision') index.controllerRevisions.push(item);
  }
  return index;
}

function parseMetrics(stdout: string): PodMetrics[] {
  const text = stdout.trim();
  if (text === '') return [];
  const parsed: unknown = JSON.parse(text);
  const items = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)
    ? (parsed as { items: PodMetrics[] }).items
    : [];
  return items.filter((item) => typeof item?.metadata?.name === 'string').map((item) => ({ ...item, containers: item.containers ?? [] }));
}

class KubernetesInventoryReader implements InventoryReader {
  private readonly stacks = new Map<string, Promise<StackInventory>>();
  private readonly metrics = new Map<string, Promise<PodMetrics[]>>();

  constructor(private readonly deps: InventoryReaderDeps) {}

  read(stackId: string): Promise<StackInventory> {
    return memoize(this.stacks, stackId, () => this.load(stackId));
  }

  podMetrics(namespace: string): Promise<PodMetrics[]> {
    return memoize(this.metrics, namespace, async () => {
      const kubectl = this.deps.kubectl;
      const path = podMetricsPath(namespace);
      const result = await kubectl.run({ args: ['get', '--raw', path], mutating: false });
      try {
        return parseMetrics(result.stdout);
      } catch {
        throw new KubeError('Unknown', `kubectl get --raw ${path} returned output that is not JSON on ${kubectl.node.name}`, kubectl.node.name, 0, '');
      }
    });
  }

  invalidate(stackId?: string): void {
    if (stackId === undefined) this.stacks.clear();
    else this.stacks.delete(stackId);
  }

  private readItems(namespace: string): Promise<InventoryObject[]> {
    return this.deps.kubectl.getJson<InventoryObject>([...INVENTORY_RESOURCES], { namespace });
  }

  private async load(stackId: string): Promise<StackInventory> {
    const helm = this.deps.helm;
    const [items, releases] = await Promise.all([this.readItems(stackId), helm ? helm.listAll(stackId) : Promise.resolve([])]);
    const others = [...new Set(releases.map((release) => release.namespace).filter((ns) => ns !== stackId))].sort(compareText);
    const otherItems = await Promise.all(others.map((namespace) => this.readItems(namespace)));
    const primary = this.namespaceInventory(stackId, stackId, items, releases);
    const rest = others.map((namespace, i) => this.namespaceInventory(stackId, namespace, otherItems[i], releases));
    return { stackId, primary, namespaces: [primary, ...rest], releases };
  }

  private namespaceInventory(
    stackId: string,
    namespace: string,
    items: readonly InventoryObject[],
    releases: readonly HelmReleaseStatus[],
  ): NamespaceInventory {
    const view = buildInventoryView(namespace, items, helmReleaseWorkloads(namespace, items, releases));
    const kubectl = this.deps.kubectl;
    const memo = new Map<string, Promise<RevisionIndex>>();
    const readRevisions = (key: StackRole | 'all'): Promise<RevisionIndex> =>
      memoize(memo, key, async () => {
        const selector = key === 'all' ? undefined : SEL_POD(stackId, key);
        const found = await kubectl.getJson<ReplicaSet | ControllerRevision>([...REVISION_RESOURCES], {
          namespace,
          ...(selector !== undefined ? { selector } : {}),
        });
        return splitRevisions(found);
      });
    return {
      ...view,
      revisions(role: StackRole | null): Promise<RevisionIndex> {
        if (view.workloads.length === 0) return Promise.resolve({ replicaSets: [], controllerRevisions: [] });
        const whole = memo.get('all');
        if (whole) return whole;
        if (role === null || namespace !== stackId || view.helm.some((release) => release.role === role)) return readRevisions('all');
        return readRevisions(role);
      },
    };
  }
}

export function createInventoryReader(deps: InventoryReaderDeps): InventoryReader {
  return new KubernetesInventoryReader(deps);
}
