/**
 * The Kubernetes orchestrator bundle (DESIGN-CORE 2.3, 6.4): `createKubernetesOrchestrator` builds
 * every backend of one bundle around one `KubeExecutor`/`HelmExecutor` bound to the control plane,
 * one `SharedMemo` and one `Redactor`, all shared through `KubernetesBundleDeps`. Commands and tests
 * never construct backends directly; tests pass fake executors through the `deps` overrides.
 */

import { usesRegistry } from '../../compose';
import { getPerformer, loadServersConfig, type DockflowConfig } from '../../../utils/config';
import { printInfo, printWarning } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { capabilitiesFor } from '../capabilities';
import type { Orchestrator, OrchestratorTarget, StackNaming } from '../interfaces';
import { ApplyEngine } from './apply/engine';
import { createKubernetesBackupBackend } from './backends/backup';
import { KubernetesClusterBackend } from './backends/cluster';
import { KubernetesContainerBackend } from './backends/containers';
import { KubernetesHelmBackend } from './backends/helm';
import { createInventoryReader } from './backends/inventory';
import { KubernetesImageBackend } from './backends/images';
import { LeaseLockStore } from './backends/lock-store';
import { KubernetesProxyBackend } from './backends/proxy';
import { ClusterReleaseStore } from './backends/release-store';
import { KubernetesStackBackend } from './backends/stack';
import { KubernetesVolumeBackend, type VolumeNotices } from './backends/volumes';
import {
  createSharedMemo,
  systemClock,
  type Clock,
  type KubernetesBundleDeps,
  type NodeShellFactory,
} from './deps';
import type { K8sDistribution } from './distribution';
import { namespaceFor, serviceNameFor } from './naming';
import { nodeShellFactory } from './runtime/node-shell';
import { createHelmExecutor, type HelmExecutor } from './runtime/helm';
import { createKubeExecutor, type KubeExecutor } from './runtime/kubectl';
import { DEFAULT_KEEP_RELEASES, reservedHostPortsFromConfig, type RenderEnvironment } from './render';

/** Test-only overrides of the seams DESIGN-CORE 6.4 names; production builds the real ones. */
export interface KubernetesOrchestratorOverrides {
  kubectl?: KubeExecutor;
  helm?: HelmExecutor;
  nodeShell?: NodeShellFactory;
  clock?: Clock;
}

const HELM_HISTORY_MIN = 5;
const HELM_HISTORY_MARGIN = 2;

function stackNaming(): StackNaming {
  return {
    scope: (ref) => namespaceFor(ref.project, ref.env),
    describe: (ref) =>
      ref.role === 'accessory'
        ? `namespace ${namespaceFor(ref.project, ref.env)} (accessories)`
        : `namespace ${namespaceFor(ref.project, ref.env)}`,
    serviceNativeName: (_ref, composeService) => serviceNameFor(composeService).value,
  };
}

function helmHistoryMaxFor(config: DockflowConfig): number {
  const keepReleases = config.stack_management?.keep_releases ?? DEFAULT_KEEP_RELEASES;
  return Math.max(HELM_HISTORY_MIN, keepReleases + HELM_HISTORY_MARGIN);
}

function helmAuthFor(config: DockflowConfig): (release: string) => { username: string; password: string } | null {
  return (release) => config.helm?.releases?.find((candidate) => candidate.name === release)?.auth ?? null;
}

export function createKubernetesOrchestrator(
  target: OrchestratorTarget,
  config: DockflowConfig,
  distribution: K8sDistribution,
  overrides: KubernetesOrchestratorOverrides = {},
): Orchestrator {
  const redactor = new Redactor();
  const clock = overrides.clock ?? systemClock;
  const memo = createSharedMemo();
  const serverNames = [...target.managers, ...target.workers].map((node) => node.name);

  const deps: KubernetesBundleDeps = {
    kubectl: overrides.kubectl ?? createKubeExecutor(target.controlPlane, { distribution, redactor, clock }),
    helm: overrides.helm ?? createHelmExecutor(target.controlPlane, { redactor, clock }),
    nodeShell: overrides.nodeShell ?? nodeShellFactory({ redactor, clock }),
    clock,
    redactor,
    distribution,
  };

  const engine = new ApplyEngine({
    kubectl: deps.kubectl,
    clock,
    distribution,
    memo,
    events: { step: printInfo, warn: printWarning },
  });

  const releases = new ClusterReleaseStore(
    { kubectl: deps.kubectl, distribution, engine },
    { project: target.project, env: target.env },
  );

  const helm = new KubernetesHelmBackend({ deps, env: target.env });
  const inventory = createInventoryReader({ kubectl: deps.kubectl, helm });

  const cluster = new KubernetesClusterBackend(
    { kubectl: deps.kubectl, distribution, redactor, clock },
    memo,
    { env: target.env, managers: target.managers, workers: target.workers },
  );

  const proxy = new KubernetesProxyBackend({
    deps,
    managers: target.managers,
    project: target.project,
    env: target.env,
    performer: getPerformer(),
  });

  const images = new KubernetesImageBackend(deps, target, {
    ensureNamespace: (ref) => engine.ensureNamespace(ref),
    releases,
    containerEngine: config.container_engine,
  });

  const containers = new KubernetesContainerBackend({
    deps: { kubectl: deps.kubectl, clock, redactor, distribution },
    inventory,
    env: target.env,
    serverNames,
  });

  const backups = createKubernetesBackupBackend({
    deps: { kubectl: deps.kubectl, nodeShell: deps.nodeShell, clock, redactor, distribution },
    inventory,
    env: target.env,
    serverNames,
  });

  const volumeNotices: VolumeNotices = {
    warn: (message, suggestion) => printWarning(suggestion ? `${message} ${suggestion}` : message),
  };
  const volumes = new KubernetesVolumeBackend({ kubectl: deps.kubectl, distribution }, { serverKeys: serverNames, notices: volumeNotices });

  const serversConfig = loadServersConfig() ?? { servers: {} };
  const render: RenderEnvironment = {
    traits: distribution.traits,
    imageDelivery: usesRegistry(config) ? 'registry' : 'import',
    keepReleases: config.stack_management?.keep_releases,
    extraReservedHostPorts: reservedHostPortsFromConfig(config, serversConfig, target.env),
  };

  const stack = new KubernetesStackBackend({
    deps,
    memo,
    target: { env: target.env, controlPlane: target.controlPlane },
    cluster,
    releases,
    render,
    serverNames,
    helmHistoryMax: helmHistoryMaxFor(config),
    proxy,
    helmAuth: helmAuthFor(config),
  });

  return {
    kind: 'k3s',
    target,
    capabilities: capabilitiesFor('k3s'),
    naming: stackNaming(),
    stack,
    containers,
    proxy,
    images,
    cluster,
    backups,
    releases,
    volumes,
    helm,
    lock: (stackName, staleThresholdMinutes, leaseName) =>
      new LeaseLockStore(
        { kubectl: deps.kubectl, distribution, clock, performer: getPerformer(), env: target.env },
        stackName,
        leaseName ?? namespaceFor(target.project, target.env),
        staleThresholdMinutes,
      ),
  };
}
