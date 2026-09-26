// KubernetesProxyBackend (design-04 2.1-2.13, 4.1, 4.4; DESIGN-CORE 6.1, C23, C24): the cluster-wide,
// Dockflow-owned Traefik. Observation (2.8.2) is read-only and runs for every call; planProxy (P39)
// and resolvePlacement/buildTraefikValues/planCrdApply (P39) decide, this file only executes: it
// takes the proxy lease around mutations, applies the pinned CRDs, installs or upgrades
// `dockflow-traefik` from the verified chart archive, records state in the ConfigMap, and reports
// `status()` with the exact recovery lines of 2.11. Never prints (HelmEventSink only, DESIGN-CORE 1.1).

import { parseAllDocuments } from 'yaml';
import { DOCKFLOW_VERSION } from '../../../../constants';
import type { ProxyConfig } from '../../../../utils/config';
import { getPerformer } from '../../../../utils/config';
import { DeployError, ErrorCode, OrchestratorUnavailableError } from '../../../../utils/errors';
import { canonicalJson } from '../../../../utils/hash';
import type { ClusterNodeRef, HelmEventSink, ProxyBackend, ProxyEnsureResult, ProxyPlan, ProxyStatus } from '../../interfaces';
import {
  K8S_MANAGED_BY,
  K8S_PROXY_ACME_CA_SECRET,
  K8S_PROXY_ACME_CLAIM,
  K8S_PROXY_CONFIGMAP,
  K8S_PROXY_RELEASE,
  K8S_REQUEST_TIMEOUT_S,
  K8S_SYSTEM_NAMESPACE,
  LABELS,
  PARTS,
  TRAEFIK_CRD_WAIT_S,
  TRAEFIK_HISTORY_MAX,
  TRAEFIK_LOCK_WAIT_S,
  TRAEFIK_TIMEOUT_S,
} from '../constants';
import type { KubernetesBundleDeps } from '../deps';
import { historyFacts, isPendingStatus, parseDeployedValues, parseHelmHistory, parseHelmList } from '../helm/parse';
import {
  capabilitiesFromValues,
  classlessIngressWarning,
  hostPortRefusals,
  type IngressFact,
  type InternalProxyPlan,
  missingValuesRevisionSelector,
  newerValuesRevisionSelector,
  parseProxyState,
  type PlanProxyInput,
  planProxy,
  podPortConflicts,
  podPortRefusal,
  proxyReleaseFrom,
  proxyStateData,
  type ProxyObservation,
  type ProxyState,
  schedulingFailures,
  servicePortConflicts,
  servicePortRefusal,
} from '../helm/plan';
import {
  acmeCaSecretName,
  buildTraefikValues,
  type ControlPlaneNodeFact,
  controlPlaneNodeFacts,
  type CustomResourceDefinition,
  filterTraefikCrds,
  labelTraefikCrds,
  planCrdApply,
  proxyHostPorts,
  proxyRefusalError,
  type ProxyWarning,
  pvNodeHostname,
  REQUIRED_TRAEFIK_CRDS,
  resolvePlacement,
  runningTraefikNode,
  traefikDeploymentFact,
  traefikIntentFrom,
  traefikPodFacts,
  TRAEFIK_VALUES_REVISION,
  type TraefikIntent,
  type TraefikPlacement,
} from '../helm/traefik-values';
import { namespaceFor, nodeNameFor } from '../naming';
import type { Deployment } from '../resources/apps';
import type {
  ConfigMap,
  Event,
  Namespace,
  Node,
  PersistentVolume,
  PersistentVolumeClaim,
  PersistentVolumeReclaimPolicy,
  Pod,
  Service,
} from '../resources/core';
import { resolveTraefikChartArchive, type ChartArchive, type ChartArchiveDeps } from '../runtime/chart-archive';
import { HELM_LIST_EVERY_STATUS } from '../runtime/helm';
import { classifyHelmFailure, helmFailureDetail } from '../runtime/helm-errors';
import { hostCommands } from '../runtime/host';
import { parseNameList } from '../runtime/kubectl';
import { TRAEFIK_CHART_PIN, type TraefikChartPin } from '../versions';
import { emitObject, secretDataValue } from '../yaml';
import { LeaseLockStore } from './lock-store';

// ---------------------------------------------------------------------------
// Observation bundle: ProxyObservation (P39) plus the placement/status facts it does not carry
// ---------------------------------------------------------------------------

interface AcmeVolumeFact {
  hostname: string | null;
  reclaimPolicy: PersistentVolumeReclaimPolicy | null;
  pvName: string | null;
}

interface FullObservation {
  proxy: ProxyObservation;
  controlPlaneNodes: ControlPlaneNodeFact[];
  acmeVolume: AcmeVolumeFact;
}

interface PlannedState {
  plan: InternalProxyPlan;
  observation: FullObservation;
  desired: Record<string, unknown> | null;
  placement: TraefikPlacement | null;
}

/** `leaseNameFor(PROXY_LOCK_STACK_ID)` = `K8S_PROXY_LOCK_NAME` (`lock-dockflow-proxy`): the proxy
 * lease through the same `LeaseLockStore` algorithm as a stack lock, addressed by this fixed id. */
const PROXY_LOCK_STACK_ID = 'dockflow-proxy';

function safeJsonArray(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Recovery lines (2.11, exact)
// ---------------------------------------------------------------------------

function recoveryLost(env: string): string[] {
  return [
    `1. Remove the Traefik release and its ACME claim with \`dockflow helm uninstall ${env} --system --volumes --force\`.`,
    `2. Reinstall Traefik on a Ready control-plane node with \`dockflow deploy ${env}\` from the stack that manages the proxy.`,
    "3. Restore acme.json at once if you have a backup (proxy documentation, \"Copy in\"); without one, Traefik requests new certificates and Let's Encrypt allows 5 duplicates per week.",
  ];
}

function recoveryDown(node: string, env: string): string[] {
  return [
    `1. Bring ${node} back; after a drain, run \`kubectl uncordon ${node}\` from \`dockflow ssh ${env}\`.`,
    `2. If ${node} is gone for good, run \`kubectl delete node ${node}\`, remove it from servers.yml, then follow the steps for a lost ACME node in the proxy documentation.`,
  ];
}

function recoveryScaled(env: string): string[] {
  return [
    `1. Run \`dockflow deploy ${env}\` from the stack that manages the proxy, or \`kubectl -n ${K8S_SYSTEM_NAMESPACE} scale deployment/${K8S_PROXY_RELEASE} --replicas=1\` if a copy-in is finished.`,
  ];
}

function recoveryReclaim(pv: string, env: string, distribution: string): string {
  return `Set the ACME volume back to Retain with \`kubectl patch pv ${pv} --type=merge -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'\`, then re-run \`dockflow setup ${distribution} ${env}\`, which makes dockflow-local the only default StorageClass (core C18).`;
}

// ---------------------------------------------------------------------------
// Plan mapping (2.9)
// ---------------------------------------------------------------------------

type NonRefuseKind = Exclude<InternalProxyPlan['kind'], 'refuse'>;

const ACTION_BY_KIND: Readonly<Record<NonRefuseKind, ProxyPlan['action']>> = {
  unchanged: 'unchanged',
  'keep-newer': 'unchanged',
  consume: 'not-owner',
  'crds-only': 'upgrade',
  install: 'install',
  upgrade: 'upgrade',
};

function reasonOf(plan: Extract<InternalProxyPlan, { kind: NonRefuseKind }>, pin: TraefikChartPin, ownerStackName: string | null): string {
  switch (plan.kind) {
    case 'unchanged':
      return `chart ${pin.version}, values revision ${TRAEFIK_VALUES_REVISION}`;
    case 'keep-newer':
      return plan.reasons[0] ?? 'chart deployed is newer than this Dockflow release';
    case 'consume':
      return ownerStackName ? `managed by ${ownerStackName}` : 'managed outside Dockflow';
    case 'crds-only':
      return 'restoring the traefik.io CRDs';
    case 'install':
      return 'not installed';
    case 'upgrade':
      return plan.reasons.join(', ');
  }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface ProxyBackendOptions {
  deps: Pick<KubernetesBundleDeps, 'kubectl' | 'helm' | 'nodeShell' | 'clock' | 'redactor' | 'distribution'>;
  /** servers.yml managers, in servers.yml order (placement candidates, 2.4.1) */
  managers: readonly ClusterNodeRef[];
  project: string;
  env: string;
  /**
   * Resolves `proxy.acme_ca_bundle` (a project-relative path) to its rendered PEM text. Reading and
   * rendering project files belongs to the render pipeline (PD-1); this backend only consumes the
   * result, exactly as `buildTraefikValues` only consumes the intent it is handed.
   */
  resolveCaBundle?: (path: string) => Promise<string>;
  /** `LockData.performer`; default: `user@host` of this machine */
  performer?: string;
  dockflowVersion?: string;
  /** override for tests; default the real pin */
  pin?: TraefikChartPin;
}

export class KubernetesProxyBackend implements ProxyBackend {
  private readonly deps: ProxyBackendOptions['deps'];
  private readonly managers: readonly ClusterNodeRef[];
  private readonly project: string;
  private readonly env: string;
  private readonly resolveCaBundleFile: (path: string) => Promise<string>;
  private readonly performer: string;
  private readonly dockflowVersion: string;
  private readonly pin: TraefikChartPin;
  private readonly hostnameToServer: ReadonlyMap<string, string>;
  private readonly chartDeps: ChartArchiveDeps;

  constructor(options: ProxyBackendOptions) {
    this.deps = options.deps;
    this.managers = options.managers;
    this.project = options.project;
    this.env = options.env;
    this.resolveCaBundleFile =
      options.resolveCaBundle ??
      (() => {
        throw new Error('This KubernetesProxyBackend has no resolveCaBundle configured');
      });
    this.performer = options.performer ?? getPerformer();
    this.dockflowVersion = options.dockflowVersion ?? DOCKFLOW_VERSION;
    this.pin = options.pin ?? TRAEFIK_CHART_PIN;
    this.hostnameToServer = new Map(this.managers.map((m) => [nodeNameFor(m.name), m.name]));
    this.chartDeps = { helm: this.deps.helm, shell: this.deps.nodeShell(this.deps.helm.node) };
  }

  // -------------------------------------------------------------------------
  // ProxyBackend
  // -------------------------------------------------------------------------

  async plan(proxy: ProxyConfig, env: string): Promise<ProxyPlan> {
    const intent = await this.intentFrom(proxy);
    const manage = proxy.manage !== false;
    const me = this.meOf(env);
    const planned = await this.planOnce(intent, manage, me, env);
    const status = this.buildStatus(planned.observation, env);

    if (planned.plan.kind === 'refuse') {
      return {
        action: manage ? 'unchanged' : 'not-owner',
        reason: planned.plan.refusal.message,
        status,
        blockers: [{ message: planned.plan.refusal.message, suggestion: planned.plan.refusal.suggestion }],
        warnings: planned.plan.warnings.map(toPlainWarning),
        node: status.node ?? null,
      };
    }
    return {
      action: ACTION_BY_KIND[planned.plan.kind],
      reason: reasonOf(planned.plan, this.pin, ownerNameOf(planned.observation.proxy.state)),
      status,
      blockers: [],
      warnings: planned.plan.warnings.map(toPlainWarning),
      node: status.node ?? null,
    };
  }

  async ensure(proxy: ProxyConfig, env: string, events?: HelmEventSink): Promise<ProxyEnsureResult> {
    const intent = await this.intentFrom(proxy);
    const manage = proxy.manage !== false;
    const me = this.meOf(env);

    let planned = await this.planOnce(intent, manage, me, env);
    if (planned.plan.kind === 'refuse') throw proxyRefusalError(planned.plan.refusal);
    if (planned.plan.kind === 'consume' || planned.plan.kind === 'keep-newer') return this.finish(planned, false, events);
    if (planned.plan.kind === 'unchanged') {
      if (planned.plan.adoptState) await this.writeState(me, intent, planned.desired!, planned.placement!);
      return this.finish(planned, false, events);
    }

    const lock = new LeaseLockStore(
      { kubectl: this.deps.kubectl, distribution: this.deps.distribution, clock: this.deps.clock, performer: this.performer, env },
      PROXY_LOCK_STACK_ID,
      PROXY_LOCK_STACK_ID,
    );
    await this.acquireWaiting(lock, me.stackName, env);
    try {
      planned = await this.planOnce(intent, manage, me, env); // double check under the lock
      if (planned.plan.kind === 'refuse') throw proxyRefusalError(planned.plan.refusal);
      if (planned.plan.kind !== 'install' && planned.plan.kind !== 'upgrade' && planned.plan.kind !== 'crds-only') {
        return this.finish(planned, false, events);
      }

      await this.assertSystemNamespace(env);
      const archive = await resolveTraefikChartArchive(this.chartDeps, this.pin, { env, distribution: this.deps.distribution.traits.name });

      if (planned.plan.applyCrds || planned.plan.kind === 'crds-only') {
        events?.step('Applying Traefik CRDs...');
        await this.applyCrds(archive, me.stackName, events);
      }
      if (planned.plan.kind === 'crds-only') return this.finish(planned, true, events);

      await this.assertPortsFree(intent, planned.placement!);
      if (intent.caBundle) await this.applyCaSecret(intent.caBundle);
      events?.step(
        planned.plan.kind === 'install'
          ? `Installing Traefik (chart ${this.pin.version}) in ${K8S_SYSTEM_NAMESPACE}...`
          : `Updating Traefik (${planned.plan.reasons.join(', ')})...`,
      );

      if (planned.plan.recoverTo !== null) {
        await this.deps.helm.run({
          args: [
            'rollback',
            K8S_PROXY_RELEASE,
            String(planned.plan.recoverTo),
            '-n',
            K8S_SYSTEM_NAMESPACE,
            '--wait=watcher',
            '--timeout',
            `${TRAEFIK_TIMEOUT_S}s`,
            '--history-max',
            String(TRAEFIK_HISTORY_MAX),
            '--description',
            'Dockflow proxy recovery',
          ],
          mutating: true,
          timeoutS: TRAEFIK_TIMEOUT_S,
        });
      }

      const run = await this.deps.helm.run({
        args: this.upgradeArgs(archive.path),
        stdin: `${canonicalJson(planned.desired)}\n`,
        mutating: true,
        timeoutS: TRAEFIK_TIMEOUT_S,
        allowFailure: true,
      });
      if (run.exitCode !== 0) throw await this.upgradeFailure(planned.plan, run, env);

      await this.writeState(me, intent, planned.desired!, planned.placement!);
      await this.pruneCaSecrets(intent);
      if (intent.defaultIngressClass) await this.warnClasslessIngresses(events);

      // the deployed state changed: re-observe so finish() reports the fresh version and node
      planned = { ...planned, observation: await this.observe(me.stackId) };
      return this.finish(planned, true, events);
    } finally {
      await lock.release();
    }
  }

  async status(): Promise<ProxyStatus> {
    const full = await this.observe(this.meOf(this.env).stackId);
    const status = this.buildStatus(full, this.env);
    if (!status.installed) return status;
    return { ...status, conflicts: await this.liveConflicts(full, status.acme) };
  }

  // -------------------------------------------------------------------------
  // Intent and identity
  // -------------------------------------------------------------------------

  private meOf(env: string): { stackId: string; stackName: string } {
    return { stackId: namespaceFor(this.project, env), stackName: `${this.project}-${env}` };
  }

  private async intentFrom(proxy: ProxyConfig): Promise<TraefikIntent> {
    const caBundleText = proxy.acme_ca_bundle ? await this.resolveCaBundleFile(proxy.acme_ca_bundle) : null;
    return traefikIntentFrom(proxy, caBundleText);
  }

  private serverKeyFor(hostname: string): string {
    return this.hostnameToServer.get(hostname) ?? hostname;
  }

  private nodeRefForHostname(hostname: string): ClusterNodeRef {
    const found = this.managers.find((m) => nodeNameFor(m.name) === hostname);
    if (!found) throw new Error(`Traefik is pinned to node ${hostname}, which is not one of this environment's managers`);
    return found;
  }

  // -------------------------------------------------------------------------
  // Planning (2.4.1, 2.8.3)
  // -------------------------------------------------------------------------

  private async planOnce(intent: TraefikIntent, manage: boolean, me: { stackId: string; stackName: string }, env: string): Promise<PlannedState> {
    const observation = await this.observe(me.stackId);
    const distribution = this.deps.distribution.traits.name;
    const now = this.deps.clock.now();

    if (!manage) {
      const input: PlanProxyInput = { manage: false, intent, desired: null, placement: null, me, env, distribution, observation: observation.proxy, now, pin: this.pin };
      return { plan: planProxy(input), observation, desired: null, placement: null };
    }

    const managers = this.managers.map((m) => nodeNameFor(m.name));
    const placementResult = resolvePlacement({
      acme: intent.acme,
      acmeVolumeHostname: observation.acmeVolume.hostname,
      recordedHostname: observation.proxy.state?.nodeHostname ?? null,
      runningHostname: runningTraefikNode(observation.proxy.pods),
      controlPlaneNodes: observation.controlPlaneNodes,
      managers,
      env,
    });
    if (placementResult.kind === 'refuse') {
      return { plan: { kind: 'refuse', refusal: placementResult.refusal, warnings: [] }, observation, desired: null, placement: null };
    }

    const placement: TraefikPlacement = { hostname: placementResult.hostname };
    const desired = buildTraefikValues(intent, this.deps.distribution.traits, placement, this.pin);
    const input: PlanProxyInput = {
      manage: true,
      intent,
      desired,
      placement: { hostname: placement.hostname, warnings: placementResult.warnings },
      me,
      env,
      distribution,
      observation: observation.proxy,
      now,
      pin: this.pin,
    };
    return { plan: planProxy(input), observation, desired, placement };
  }

  // -------------------------------------------------------------------------
  // Observation (2.8.2)
  // -------------------------------------------------------------------------

  private async readState(): Promise<ProxyState | null> {
    const [cm] = await this.deps.kubectl.getJson<ConfigMap>(['configmaps'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_PROXY_CONFIGMAP, allowNotFound: true });
    return parseProxyState(cm?.data);
  }

  private async readValuesRevisionFacts(): Promise<{ newer: boolean; missing: boolean }> {
    const [newerResult, missingResult] = await Promise.all([
      this.deps.kubectl.run({ args: ['get', 'secrets', '-l', newerValuesRevisionSelector(), '-o', 'name'], namespace: K8S_SYSTEM_NAMESPACE, mutating: false, allowFailure: true }),
      this.deps.kubectl.run({ args: ['get', 'secrets', '-l', missingValuesRevisionSelector(), '-o', 'name'], namespace: K8S_SYSTEM_NAMESPACE, mutating: false, allowFailure: true }),
    ]);
    return {
      newer: newerResult.exitCode === 0 && newerResult.stdout.trim() !== '',
      missing: missingResult.exitCode === 0 && missingResult.stdout.trim() !== '',
    };
  }

  private async ownerNamespaceExists(owner: string): Promise<boolean> {
    const [ns] = await this.deps.kubectl.getJson<Namespace>(['namespaces'], { name: owner, allowNotFound: true });
    return ns !== undefined && ns.metadata.deletionTimestamp === undefined;
  }

  /** O1-O10, one round of parallel reads (a transient transport failure propagates: 2.8.2). */
  private async observe(stackId: string): Promise<FullObservation> {
    const cp = this.deps.distribution.traits.controlPlaneNodeLabel;
    const [listResult, state, crdRows, deploymentRows, pods, nodes, pvcRows] = await Promise.all([
      this.deps.helm.run({
        args: ['list', ...HELM_LIST_EVERY_STATUS, '-n', K8S_SYSTEM_NAMESPACE, '--filter', `^${K8S_PROXY_RELEASE}$`, '-o', 'json'],
        mutating: false,
        timeoutS: K8S_REQUEST_TIMEOUT_S,
        allowFailure: true,
      }),
      this.readState(),
      this.deps.kubectl.getJson<CustomResourceDefinition>(['customresourcedefinitions.apiextensions.k8s.io'], {
        names: [...REQUIRED_TRAEFIK_CRDS],
        ignoreNotFound: true,
      }),
      this.deps.kubectl.getJson<Deployment>(['deployments'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_PROXY_RELEASE, allowNotFound: true }),
      this.deps.kubectl.getJson<Pod>(['pods'], { namespace: K8S_SYSTEM_NAMESPACE, selector: `${LABELS.name}=traefik`, allowNotFound: true }),
      this.deps.kubectl.getJson<Node>(['nodes'], { selector: `${cp.key}=${cp.value}` }),
      this.deps.kubectl.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace: K8S_SYSTEM_NAMESPACE, name: K8S_PROXY_ACME_CLAIM, allowNotFound: true }),
    ]);

    const release = proxyReleaseFrom(listResult.exitCode === 0 ? parseHelmList(safeJsonArray(listResult.stdout)) : []);
    const deployment = traefikDeploymentFact(deploymentRows[0] ?? null);
    const podFacts = traefikPodFacts(pods);
    const crdsPresent = crdRows.length >= REQUIRED_TRAEFIK_CRDS.length;

    let deployedValues: Record<string, unknown> | null = null;
    let deployedValuesNewer = false;
    let revisionLabelMissing = false;
    let pendingSince: string | null = null;
    let lastDeployedRevision: number | null = null;
    let ownerNsExists: boolean | null = null;

    const jobs: Promise<void>[] = [];
    if (release !== null) {
      jobs.push(
        this.deps.helm.json<unknown>(['get', 'values', K8S_PROXY_RELEASE, '-n', K8S_SYSTEM_NAMESPACE]).then((json) => {
          deployedValues = parseDeployedValues(json);
        }),
      );
      jobs.push(
        this.readValuesRevisionFacts().then(({ newer, missing }) => {
          deployedValuesNewer = newer;
          revisionLabelMissing = missing;
        }),
      );
      if (release.status === 'failed' || isPendingStatus(release.status)) {
        jobs.push(
          this.deps.helm.json<unknown>(['history', K8S_PROXY_RELEASE, '-n', K8S_SYSTEM_NAMESPACE, '--max', '20']).then((json) => {
            const history = parseHelmHistory(json ?? [], { name: K8S_PROXY_RELEASE, namespace: K8S_SYSTEM_NAMESPACE });
            const facts = historyFacts(history);
            lastDeployedRevision = facts.lastDeployedRevision;
            pendingSince = facts.pendingSince;
          }),
        );
      }
    }
    if (state !== null && state.owner !== null && state.owner !== stackId) {
      jobs.push(
        this.ownerNamespaceExists(state.owner).then((exists) => {
          ownerNsExists = exists;
        }),
      );
    }

    let acmeHostname: string | null = null;
    let acmeReclaimPolicy: PersistentVolumeReclaimPolicy | null = null;
    const pvc = pvcRows[0] ?? null;
    const acmePvName = pvc?.spec.volumeName ?? null;
    if (pvc?.status?.phase === 'Bound' && pvc.spec.volumeName) {
      jobs.push(
        this.deps.kubectl.getJson<PersistentVolume>(['persistentvolumes'], { name: pvc.spec.volumeName, allowNotFound: true }).then(([pv]) => {
          if (pv) {
            acmeHostname = pvNodeHostname(pv);
            acmeReclaimPolicy = pv.spec?.persistentVolumeReclaimPolicy ?? null;
          }
        }),
      );
    }

    await Promise.all(jobs);

    const proxy: ProxyObservation = {
      release,
      deployedValues,
      state,
      crdsPresent,
      deployment,
      pods: podFacts,
      ownerNamespaceExists: ownerNsExists,
      pendingSince,
      lastDeployedRevision,
      deployedValuesNewer,
      revisionLabelMissing,
    };
    return {
      proxy,
      controlPlaneNodes: controlPlaneNodeFacts(nodes),
      acmeVolume: { hostname: acmeHostname, reclaimPolicy: acmeReclaimPolicy, pvName: acmePvName },
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  private async assertSystemNamespace(env: string): Promise<void> {
    const [ns] = await this.deps.kubectl.getJson<Namespace>(['namespaces'], { name: K8S_SYSTEM_NAMESPACE, allowNotFound: true });
    if (!ns) {
      throw new OrchestratorUnavailableError(
        `Namespace ${K8S_SYSTEM_NAMESPACE} is missing on ${this.deps.kubectl.node.name}`,
        `Re-run \`dockflow setup ${this.deps.distribution.traits.name} ${env}\`.`,
      );
    }
  }

  private async applyCrds(archive: ChartArchive, stackName: string, events?: HelmEventSink): Promise<void> {
    const shown = await this.deps.helm.run({ args: ['show', 'crds', archive.path], mutating: false, timeoutS: K8S_REQUEST_TIMEOUT_S });
    const docs = parseYamlDocuments(shown.stdout);
    const crds = filterTraefikCrds(docs, this.pin.version);
    const installed = await this.deps.kubectl.getJson<CustomResourceDefinition>(['customresourcedefinitions.apiextensions.k8s.io'], {
      names: [...REQUIRED_TRAEFIK_CRDS],
      ignoreNotFound: true,
    });
    const decision = planCrdApply(installed, stackName, this.pin);
    if (decision.action === 'refuse') throw proxyRefusalError(decision.refusal);
    if (decision.action === 'skip') {
      events?.warn(decision.warning.message, decision.warning.suggestion);
      return;
    }
    const labelled = labelTraefikCrds(crds, this.pin);
    const manifest = labelled.map((crd) => `---\n${emitObject(crd)}`).join('');
    await this.deps.kubectl.apply(manifest, { dryRun: false });
    await this.deps.kubectl.run({
      args: ['wait', '--for=condition=Established', `--timeout=${TRAEFIK_CRD_WAIT_S}s`, ...labelled.map((crd) => `crd/${crd.metadata.name}`)],
      mutating: false,
      requestTimeoutS: null,
      guardS: TRAEFIK_CRD_WAIT_S + 30,
    });
  }

  /** the 2.10 scans re-run as warnings for `status()` (a host daemon or pod can start after install); node scan skipped when the running node has left `managers` (no credentials to shell in). */
  private async liveConflicts(full: FullObservation, acme: boolean): Promise<string[]> {
    const ports = proxyHostPorts(acme);
    const hostname = runningTraefikNode(full.proxy.pods);
    const managerNode = hostname !== null ? this.managers.find((m) => nodeNameFor(m.name) === hostname) : undefined;
    const lines: string[] = [];
    if (managerNode) {
      const listeners = await hostCommands(this.deps.nodeShell(managerNode)).listeningPorts();
      if (listeners !== null) lines.push(...hostPortRefusals(listeners, ports, hostname!).map((refusal) => refusal.message));
    }
    const services = await this.deps.kubectl.getJson<Service>(['services'], { allNamespaces: true });
    const byService = servicePortConflicts(services, ports);
    lines.push(...byService.map((conflict) => servicePortRefusal(conflict).message));
    const pods = await this.deps.kubectl.getJson<Pod>(['pods'], { allNamespaces: true });
    const byPod = podPortConflicts(pods, ports).filter((conflict) => !byService.some((taken) => taken.port === conflict.port));
    lines.push(...byPod.map((conflict) => podPortRefusal(conflict).message));
    return lines;
  }

  private async assertPortsFree(intent: TraefikIntent, placement: TraefikPlacement): Promise<void> {
    const ports = proxyHostPorts(intent.acme);
    const pinnedNode = this.nodeRefForHostname(placement.hostname);
    const listeners = await hostCommands(this.deps.nodeShell(pinnedNode)).listeningPorts();
    if (listeners !== null) {
      const refusals = hostPortRefusals(listeners, ports, placement.hostname);
      if (refusals.length > 0) throw proxyRefusalError(refusals[0]);
    }
    const services = await this.deps.kubectl.getJson<Service>(['services'], { allNamespaces: true });
    const taken = servicePortConflicts(services, ports);
    if (taken.length > 0) throw proxyRefusalError(servicePortRefusal(taken[0]));
    const pods = await this.deps.kubectl.getJson<Pod>(['pods'], { allNamespaces: true });
    const conflicts = podPortConflicts(pods, ports);
    if (conflicts.length > 0) throw proxyRefusalError(podPortRefusal(conflicts[0]));
  }

  private async applyCaSecret(caBundle: string): Promise<void> {
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: acmeCaSecretName(caBundle),
        namespace: K8S_SYSTEM_NAMESPACE,
        labels: { [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: PARTS.system, [LABELS.hashed]: 'true' },
      },
      data: { 'ca.crt': secretDataValue(caBundle) },
    };
    await this.deps.kubectl.apply(emitObject(secret), { namespace: K8S_SYSTEM_NAMESPACE, dryRun: false });
  }

  private async pruneCaSecrets(intent: TraefikIntent): Promise<void> {
    const current = intent.caBundle ? acmeCaSecretName(intent.caBundle) : null;
    const result = await this.deps.kubectl.run({
      args: ['get', 'secrets', '-l', `${LABELS.managedBy}=${K8S_MANAGED_BY},${LABELS.part}=${PARTS.system}`, '-o', 'name'],
      namespace: K8S_SYSTEM_NAMESPACE,
      mutating: false,
      allowFailure: true,
    });
    if (result.exitCode !== 0) return;
    const stale = parseNameList(result.stdout)
      .map((line) => line.replace(/^secret\//, ''))
      .filter((name) => name.startsWith(`${K8S_PROXY_ACME_CA_SECRET}-`) && name !== current);
    if (stale.length === 0) return;
    await this.deps.kubectl.delete(
      stale.map((name) => `secret/${name}`),
      { namespace: K8S_SYSTEM_NAMESPACE, wait: false, ignoreNotFound: true },
    );
  }

  private async warnClasslessIngresses(events?: HelmEventSink): Promise<void> {
    const [ingresses, namespaces] = await Promise.all([
      this.deps.kubectl.getJson<IngressFact>(['ingresses.networking.k8s.io'], { allNamespaces: true }),
      this.deps.kubectl.getJson<Namespace>(['namespaces'], { selector: `${LABELS.managedBy}=${K8S_MANAGED_BY}` }),
    ]);
    const stackNamespaces = new Set(namespaces.map((ns) => ns.metadata.name));
    const warning = classlessIngressWarning(ingresses, stackNamespaces);
    if (warning) events?.warn(warning.message, warning.suggestion);
  }

  private async writeState(me: { stackId: string; stackName: string }, intent: TraefikIntent, desired: Record<string, unknown>, placement: TraefikPlacement): Promise<void> {
    const node = this.serverKeyFor(placement.hostname);
    const data = proxyStateData({
      owner: me,
      intent,
      desired,
      placement: { hostname: placement.hostname, node },
      dockflowVersion: this.dockflowVersion,
      now: this.deps.clock.now(),
      pin: this.pin,
    });
    const configMap: ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: K8S_PROXY_CONFIGMAP, namespace: K8S_SYSTEM_NAMESPACE, labels: { [LABELS.managedBy]: K8S_MANAGED_BY, [LABELS.part]: PARTS.system } },
      data,
    };
    await this.deps.kubectl.apply(emitObject(configMap), { namespace: K8S_SYSTEM_NAMESPACE, dryRun: false });
  }

  private upgradeArgs(archivePath: string): string[] {
    return [
      'upgrade',
      '--install',
      K8S_PROXY_RELEASE,
      archivePath,
      '-n',
      K8S_SYSTEM_NAMESPACE,
      '--values',
      '-',
      '--reset-values',
      '--skip-crds',
      '--rollback-on-failure',
      '--wait=watcher',
      '--timeout',
      `${TRAEFIK_TIMEOUT_S}s`,
      '--history-max',
      String(TRAEFIK_HISTORY_MAX),
      '--force-conflicts',
      '--description',
      `Dockflow proxy (values revision ${TRAEFIK_VALUES_REVISION})`,
      '--labels',
      `${LABELS.part}=${PARTS.system},${LABELS.valuesRevision}=${TRAEFIK_VALUES_REVISION}`,
    ];
  }

  private async upgradeFailure(plan: InternalProxyPlan, run: { exitCode: number; stderr: string }, env: string): Promise<DeployError> {
    const reason = classifyHelmFailure(run.exitCode, run.stderr);
    let detail = helmFailureDetail(run.stderr, this.deps.redactor);
    if (reason !== 'RepoUnreachable' && reason !== 'ChartNotFound') {
      const events = await this.deps.kubectl.getJson<Event>(['events'], { namespace: K8S_SYSTEM_NAMESPACE, allowNotFound: true });
      const scheduling = schedulingFailures(events);
      if (scheduling.length > 0) detail = [detail, ...scheduling].filter((part) => part !== '').join('; ');
    }
    const verb = plan.kind === 'install' ? 'install' : 'upgrade';
    const restored = plan.kind === 'install' ? 'nothing was installed' : 'the previous configuration was restored';
    return new DeployError(
      `Traefik failed to ${verb} in ${K8S_SYSTEM_NAMESPACE}: ${detail}; ${restored}`,
      ErrorCode.DEPLOY_FAILED,
      `Run \`dockflow helm status ${env} --system\`, then \`dockflow diagnose ${env}\`.`,
    );
  }

  // -------------------------------------------------------------------------
  // Locking (design-03 14.2 / core 6.7; only the lease name differs)
  // -------------------------------------------------------------------------

  private async acquireWaiting(lock: LeaseLockStore, stackName: string, env: string): Promise<void> {
    const deadline = this.deps.clock.now().getTime() + TRAEFIK_LOCK_WAIT_S * 1000;
    for (;;) {
      const result = await lock.acquire({ message: `Traefik update by ${stackName}` });
      if (result.success) return;
      if (this.deps.clock.now().getTime() >= deadline) {
        const status = await lock.status();
        const held = status.success && status.data.locked ? status.data.data : undefined;
        throw new DeployError(
          `Traefik in ${K8S_SYSTEM_NAMESPACE} is being updated by ${held?.performer ?? 'another deploy'} since ${held?.started_at ?? 'an unknown time'}`,
          ErrorCode.DEPLOY_LOCKED,
          'Retry the deploy when that update finishes.',
        );
      }
      await this.deps.clock.sleep(5000);
    }
  }

  // -------------------------------------------------------------------------
  // Finishing an ensure() call and building ProxyStatus (2.9, 2.11)
  // -------------------------------------------------------------------------

  private finish(planned: PlannedState, changed: boolean, events?: HelmEventSink): ProxyEnsureResult {
    if (planned.plan.kind === 'refuse') throw new Error('finish() never sees a refused plan');
    for (const warning of planned.plan.warnings) events?.warn(warning.message, warning.suggestion);
    const helmRan = planned.plan.kind === 'install' || planned.plan.kind === 'upgrade';
    const version = helmRan ? this.pin.appVersion : (planned.observation.proxy.release?.appVersion ?? null);
    return { changed, action: ACTION_BY_KIND[planned.plan.kind], version };
  }

  private buildStatus(full: FullObservation, env: string): ProxyStatus {
    const { proxy, controlPlaneNodes, acmeVolume } = full;
    const release = proxy.release;
    const installed = release !== null || proxy.deployment !== null;
    if (!installed) {
      return {
        installed: false,
        ready: false,
        version: null,
        owner: null,
        entryPoints: [],
        acme: false,
        acmeReclaimPolicy: null,
        detail: 'not installed',
        ownerStackName: null,
        node: null,
        recordedNode: null,
        conflicts: [],
        recovery: [],
      };
    }

    const capabilities = proxy.state?.capabilities ?? capabilitiesFromValues(proxy.deployedValues);
    const ownerStackName = ownerNameOf(proxy.state);
    const runningHostname = runningTraefikNode(proxy.pods);
    const node = runningHostname ? this.serverKeyFor(runningHostname) : null;
    const recordedNode = proxy.state?.node ?? null;
    const version = release?.appVersion ?? null;
    const readyReplicas = proxy.deployment?.readyReplicas ?? 0;
    const replicas = proxy.deployment?.replicas ?? 1;
    let ready = readyReplicas >= 1;
    let detail: string;
    const recovery: string[] = [];
    const pending = proxy.pods.some((pod) => pod.phase === 'Pending');
    const acmeNodeInCluster = acmeVolume.hostname === null || controlPlaneNodes.some((n) => n.hostname === acmeVolume.hostname);

    if (release !== null && (release.status === 'failed' || isPendingStatus(release.status))) {
      detail = `release ${release.status} since ${proxy.pendingSince ?? 'an unknown time'}`;
    } else if (replicas < 1) {
      ready = false;
      detail = 'Traefik is scaled to 0 replicas';
      recovery.push(...recoveryScaled(env));
    } else if (pending && acmeVolume.hostname !== null && !acmeNodeInCluster) {
      ready = false;
      detail = `Traefik pod Pending: PersistentVolumeClaim ${K8S_PROXY_ACME_CLAIM} is bound to node ${acmeVolume.hostname}, which is not in the cluster`;
      recovery.push(...recoveryLost(env));
    } else if (pending && acmeVolume.hostname !== null && controlPlaneNodes.some((n) => n.hostname === acmeVolume.hostname && (!n.ready || !n.schedulable))) {
      const cpNode = controlPlaneNodes.find((n) => n.hostname === acmeVolume.hostname)!;
      ready = false;
      detail = `Traefik pod Pending: its ACME volume is on node ${acmeVolume.hostname}, which is ${!cpNode.ready ? 'NotReady' : 'cordoned'}`;
      recovery.push(...recoveryDown(acmeVolume.hostname, env));
    } else if (readyReplicas < 1) {
      detail = `not ready: ${proxy.pods[0]?.status ?? 'no pod'} on ${node ?? 'unknown'}`;
    } else {
      detail = `chart ${release?.chartVersion ?? this.pin.version} on ${node ?? 'unknown'}, configured by ${ownerStackName ?? 'unknown'}`;
    }

    if (recordedNode !== null && node !== null && node !== recordedNode) {
      detail += `; running on ${node} but recorded as ${recordedNode}`;
    }
    if (acmeVolume.reclaimPolicy === 'Delete') {
      detail += `; the ACME volume ${acmeVolume.pvName ?? K8S_PROXY_ACME_CLAIM} has reclaim policy Delete`;
      recovery.push(recoveryReclaim(acmeVolume.pvName ?? K8S_PROXY_ACME_CLAIM, env, this.deps.distribution.traits.name));
    }

    return {
      installed: true,
      ready,
      version,
      owner: proxy.state?.owner ?? null,
      entryPoints: ['web', 'websecure'],
      acme: capabilities?.acme ?? false,
      acmeReclaimPolicy: acmeVolume.reclaimPolicy,
      detail,
      ownerStackName,
      node,
      recordedNode,
      conflicts: [],
      recovery,
    };
  }
}

function toPlainWarning(warning: ProxyWarning): { message: string; suggestion: string } {
  return { message: warning.message, suggestion: warning.suggestion ?? '' };
}

function ownerNameOf(state: ProxyState | null): string | null {
  return state?.ownerStackName ?? state?.owner ?? null;
}

/** documents of `helm show crds`: parsed with the `yaml` package, empty and errored documents dropped */
function parseYamlDocuments(text: string): unknown[] {
  return parseAllDocuments(text)
    .filter((doc) => doc.errors.length === 0)
    .map((doc) => doc.toJS())
    .filter((value) => value !== null && value !== undefined);
}
