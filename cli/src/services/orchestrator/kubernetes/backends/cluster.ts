// KubernetesClusterBackend (design-03 5.3, 19.1): the control-plane probe used by failover, the
// preflight checks a deploy runs before touching anything, the node listing of `dockflow details`
// and `dockflow diagnose`, and the raw server version. Never prints (returns data or throws).

import { canonicalJson } from '../../../../utils/hash';
import { DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../../utils/errors';
import type { ClusterBackend, ClusterNodeRef, ControlPlaneProbe, NodeInfo, OrchestratorTarget } from '../../interfaces';
import { K8S_PROBE_GUARD_S, K8S_PROBE_TIMEOUT_S, K8S_SYSTEM_NAMESPACE } from '../constants';
import { memoize, type KubernetesBundleDeps, type SharedMemo } from '../deps';
import type { K8sDistribution } from '../distribution';
import { nodeNameFor } from '../naming';
import type { Namespace, Node } from '../resources/core';
import type { StorageClass } from '../resources/storage';
import { classifyKubectlFailure, KubeError, type KubeErrorReason } from '../runtime/errors';
import { createKubeExecutor, firstLine, type KubeExecutor } from '../runtime/kubectl';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strips `+k3s1`-style build metadata and compares `major.minor.patch`. */
export function compareKubeVersions(a: string, b: string): number {
  const parts = (version: string): [number, number, number] => {
    const [major = '0', minor = '0', patch = '0'] = version.replace(/^v/, '').split('+')[0].split('.');
    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
  };
  const [aMajor, aMinor, aPatch] = parts(a);
  const [bMajor, bMinor, bPatch] = parts(b);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/** k3s node name (`nodeNameFor`, setup's `--node-name`) -> servers.yml key. */
function nodeToServerMap(nodes: readonly ClusterNodeRef[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of nodes) map.set(nodeNameFor(node.name), node.name);
  return map;
}

const UNREACHABLE_PROBE_REASONS: ReadonlySet<KubeErrorReason> = new Set([
  'ToolMissing',
  'KubeconfigMissing',
  'Unreachable',
  'CertificateMismatch',
  'Unauthorized',
  'Timeout',
]);

function probeDetail(reason: KubeErrorReason, distributionName: string): string {
  switch (reason) {
    case 'ToolMissing':
      return `${distributionName} is not installed`;
    case 'KubeconfigMissing':
      return 'kubeconfig missing or unreadable';
    case 'CertificateMismatch':
      return 'kubeconfig CA mismatch';
    case 'Unauthorized':
      return 'deploy identity rejected';
    case 'Timeout':
      return `probe timed out after ${K8S_PROBE_GUARD_S}s`;
    default:
      return 'API not answering';
  }
}

function toNodeInfo(node: Node, distribution: K8sDistribution, nodeToServer: ReadonlyMap<string, string>): NodeInfo {
  const labels = node.metadata.labels ?? {};
  const isControlPlane = labels[distribution.traits.controlPlaneNodeLabel.key] === distribution.traits.controlPlaneNodeLabel.value;
  const conditions = node.status?.conditions ?? [];
  const pressure = ['DiskPressure', 'MemoryPressure', 'PIDPressure'].filter(
    (type) => conditions.find((condition) => condition.type === type)?.status === 'True',
  );
  return {
    name: node.metadata.name,
    server: nodeToServer.get(node.metadata.name) ?? null,
    role: isControlPlane ? 'manager' : 'worker',
    ready: conditions.find((condition) => condition.type === 'Ready')?.status === 'True',
    schedulable: node.spec?.unschedulable !== true,
    version: node.status?.nodeInfo?.kubeletVersion ?? null,
    internalIp: node.status?.addresses?.find((address) => address.type === 'InternalIP')?.address ?? null,
    pressure,
  };
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface KubernetesClusterBackendOptions {
  /** builds a KubeExecutor bound to an arbitrary node, for probe() during failover; default: a real executor, or the bound one for the control plane */
  executorFor?: (node: ClusterNodeRef) => KubeExecutor;
}

export class KubernetesClusterBackend implements ClusterBackend {
  private readonly kubectl: KubeExecutor;
  private readonly distribution: K8sDistribution;
  private readonly memo: SharedMemo;
  private readonly env: string;
  private readonly nodeToServer: ReadonlyMap<string, string>;
  private readonly buildExecutor: (node: ClusterNodeRef) => KubeExecutor;

  constructor(
    deps: Pick<KubernetesBundleDeps, 'kubectl' | 'distribution' | 'redactor' | 'clock'>,
    memo: SharedMemo,
    target: Pick<OrchestratorTarget, 'env' | 'managers' | 'workers'>,
    options: KubernetesClusterBackendOptions = {},
  ) {
    this.kubectl = deps.kubectl;
    this.distribution = deps.distribution;
    this.memo = memo;
    this.env = target.env;
    this.nodeToServer = nodeToServerMap([...target.managers, ...target.workers]);
    this.buildExecutor =
      options.executorFor ??
      ((node) =>
        node.name === deps.kubectl.node.name
          ? deps.kubectl
          : createKubeExecutor(node, { distribution: deps.distribution, redactor: deps.redactor, clock: deps.clock }));
  }

  /** `get --raw=/readyz` (K45); never throws. */
  async probe(node: ClusterNodeRef): Promise<ControlPlaneProbe> {
    try {
      const executor = this.buildExecutor(node);
      const result = await executor.run({
        args: ['get', '--raw=/readyz'],
        mutating: false,
        requestTimeoutS: K8S_PROBE_TIMEOUT_S,
        guardS: K8S_PROBE_GUARD_S,
        allowFailure: true,
      });
      if (result.exitCode === 0 && result.stdout.trim() === 'ok') return { node: node.name, status: 'ready' };
      const reason = classifyKubectlFailure(result.exitCode, result.stderr);
      if (UNREACHABLE_PROBE_REASONS.has(reason)) {
        return { node: node.name, status: 'unreachable', detail: probeDetail(reason, this.distribution.traits.name) };
      }
      return { node: node.name, status: 'unready', detail: firstLine(result.stdout || result.stderr) };
    } catch (error) {
      return { node: node.name, status: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Server version >= the distribution's minimum (C1), `dockflow-system` present, and, when
   * needed, the Traefik CRDs and the default storage class. Memoized once per bundle and need-set.
   */
  async preflight(needs: { routes: boolean; volumes: boolean; helm: boolean }): Promise<void> {
    return memoize(this.memo.preflight, canonicalJson(needs), async () => {
      const version = await this.serverVersion();
      if (compareKubeVersions(version, this.distribution.minimumServerVersion) < 0) {
        throw new DeployError(
          `${this.distribution.traits.name} ${version} on ${this.kubectl.node.name} is older than ${this.distribution.minimumServerVersion}, the minimum for this Dockflow release`,
          ErrorCode.DEPLOY_FAILED,
          `Run \`dockflow setup ${this.distribution.traits.name} ${this.env} --upgrade\`.`,
        );
      }
      const [system] = await this.kubectl.getJson<Namespace>(['namespaces'], { name: K8S_SYSTEM_NAMESPACE, allowNotFound: true });
      if (!system) {
        throw new OrchestratorUnavailableError(
          `Namespace ${K8S_SYSTEM_NAMESPACE} is missing on ${this.kubectl.node.name}`,
          `Re-run \`dockflow setup ${this.distribution.traits.name} ${this.env}\`.`,
        );
      }
      if (needs.routes) {
        const crds = await this.kubectl.getJson(['customresourcedefinitions.apiextensions.k8s.io'], {
          names: ['ingressroutes.traefik.io', 'middlewares.traefik.io'],
          ignoreNotFound: true,
        });
        if (crds.length < 2) {
          throw new DeployError(
            'The cluster has no IngressRoute resource type (missing CRDs)',
            ErrorCode.DEPLOY_FAILED,
            'Set `proxy.enabled: true` so Dockflow installs Traefik, or remove the Traefik labels.',
          );
        }
      }
      if (needs.volumes) await this.requireStorageClass(this.distribution.traits.defaultStorageClass);
      // needs.helm is checked by the Helm backend itself (binary and version), not here.
    });
  }

  async nodes(): Promise<NodeInfo[]> {
    const items = await this.kubectl.getJson<Node>(['nodes']);
    return items.map((node) => toNodeInfo(node, this.distribution, this.nodeToServer));
  }

  /** K03: `version -o json` `.serverVersion.gitVersion`. */
  async serverVersion(): Promise<string> {
    const result = await this.kubectl.run({ args: ['version', '-o', 'json'], mutating: false });
    const version = this.parseServerVersion(result.stdout);
    if (version === null) {
      throw new KubeError('Unknown', `kubectl version returned output that is not JSON on ${this.kubectl.node.name}`, this.kubectl.node.name, 0, '');
    }
    return version;
  }

  private parseServerVersion(stdout: string): string | null {
    try {
      const parsed = JSON.parse(stdout) as { serverVersion?: { gitVersion?: unknown } };
      const version = parsed.serverVersion?.gitVersion;
      return typeof version === 'string' && version !== '' ? version : null;
    } catch {
      return null;
    }
  }

  private async requireStorageClass(name: string): Promise<void> {
    const classes = await this.kubectl.getJson<StorageClass>(['storageclasses.storage.k8s.io'], { names: [name], ignoreNotFound: true });
    if (classes.some((storageClass) => storageClass.metadata.name === name)) return;
    throw new DeployError(
      `StorageClass ${name} does not exist on the cluster`,
      ErrorCode.DEPLOY_FAILED,
      `Re-run \`dockflow setup ${this.distribution.traits.name} ${this.env}\`.`,
    );
  }
}
