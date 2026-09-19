// Kubernetes BackupBackend (design-06 4.3, D22): dumps and restores through `kubectl exec` in the
// service's own pod, volume archives and restores through a throwaway helper pod mounting the
// claims and bind mounts read-only (archive) or read-write (restore). Files live on the control
// plane node the command ran on (C16). Verification, metadata and the restore refusals belong to
// `services/backup.ts`, which is the same for both orchestrators (K05, K62c); this backend never
// classifies a restore's exit code or stderr itself.

import { posix } from 'path';
import type {
  BackupBackend,
  BackupFile,
  BackupVolume,
  ClusterNodeRef,
  InstanceTarget,
  StackRef,
  StackRole,
} from '../../interfaces';
import { BackupError, CLIError, ErrorCode, UnsupportedOperationError } from '../../../../utils/errors';
import { shortHash } from '../../../../utils/hash';
import { shellQuote } from '../../../../utils/ssh';
import {
  buildCapturePipeline,
  buildDiscardScript,
  buildExtractScript,
  buildSwapScript,
  isExcluded,
  previousDirName,
  sanitizePathName,
} from '../../../backup-strategies';
import { ANNOTATIONS, deleteWaitS, LABELS, PARTS } from '../constants';
import type { KubernetesBundleDeps, SshChannel } from '../deps';
import type { K8sDistribution } from '../distribution';
import { helperPodLabels, SEL_POD } from '../labels';
import { namespaceFor, nodeNameFor } from '../naming';
import type { Deployment, StatefulSet } from '../resources/apps';
import type {
  Container,
  PersistentVolume,
  PersistentVolumeClaim,
  Pod,
  Toleration,
  Volume,
  VolumeMount,
} from '../resources/core';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import type { GetJsonOptions, KubeExecutor, KubectlResult } from '../runtime/kubectl';
import {
  defaultContainerName,
  podCondition,
  podOwner,
  selectContainer,
  selectInstance,
  toInstanceInfo,
  type WorkloadRecord,
} from '../status/pods';
import { emitObject } from '../yaml';
import { EMPTY_REVISIONS, type InventoryReader, type StackInventory } from './inventory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELPER_CONTAINER = 'helper';
/** the helper's own `sleep`; also the stale-sweep age (design-06 4.3 step 1, K77) */
const HELPER_ACTIVE_DEADLINE_S = 21600;
const HELPER_READY_TIMEOUT_S = 120;
const HELPER_POLL_MS = 2000;
const RESTART_TIMEOUT_MS = 120_000;
const RESTART_FORCE_AFTER_MS = 30_000;

/** exactly the taints a k3s server may carry by default (m14): never a blanket NoSchedule/NoExecute */
const HELPER_TOLERATIONS: readonly Toleration[] = [
  { key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'node-role.kubernetes.io/master', operator: 'Exists', effect: 'NoSchedule' },
  { key: 'CriticalAddonsOnly', operator: 'Exists' },
];

const HELPER_SELECTOR = `${LABELS.part}=${PARTS.helper}`;

const TERMINATED_LINE = /^command terminated with exit code \d+$/;
const FATAL_IMAGE_REASONS: ReadonlySet<string> = new Set(['ImagePullBackOff', 'ErrImagePull']);

function mountDirFor(index: number): string {
  return `/dockflow/v${index}`;
}

function stripTerminatedLine(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !TERMINATED_LINE.test(line.trim()))
    .join('\n');
}

function headLines(text: string, count = 5): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, count)
    .join('; ');
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** the node holding a local claim: the `kubernetes.io/hostname In` term of its PV's node affinity */
function pvHostnameAffinity(pv: PersistentVolume): string | null {
  for (const term of pv.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? []) {
    for (const expression of term.matchExpressions ?? []) {
      if (expression.key === 'kubernetes.io/hostname' && expression.operator === 'In' && expression.values?.[0] !== undefined) {
        return expression.values[0];
      }
    }
  }
  return null;
}

function sameNode(a: ClusterNodeRef, b: ClusterNodeRef): boolean {
  return a.connection.host === b.connection.host && a.connection.port === b.connection.port;
}

/** stable per restore (hash of the backup's own directory/id), so a retry cleans what an interrupted run left */
function restoreId8(archives: readonly { file: BackupFile }[]): string {
  const path = archives[0].file.remotePath;
  const id = posix.basename(path).split('.')[0];
  return shortHash(`${posix.dirname(path)}/${id}`, 8);
}

// ---------------------------------------------------------------------------
// Helper pod manifest (design-06 4.3)
// ---------------------------------------------------------------------------

interface HelperMount {
  kind: 'volume' | 'bind';
  /** claim name (volume) or host path (bind) */
  source: string;
}

interface HelperIdentity {
  project: string;
  namespace: string;
}

function buildHelperPod(params: {
  name: string;
  namespace: string;
  identity: HelperIdentity;
  composeService: string;
  helperImage: string;
  mounts: readonly HelperMount[];
  readOnly: boolean;
  nodeName: string | null;
}): Pod {
  const volumes: Volume[] = params.mounts.map((mount, index) =>
    mount.kind === 'volume'
      ? { name: `v${index}`, persistentVolumeClaim: { claimName: mount.source, readOnly: params.readOnly } }
      : { name: `v${index}`, hostPath: { path: mount.source, type: 'Directory' } },
  );
  const volumeMounts: VolumeMount[] = params.mounts.map((_mount, index) => ({
    mountPath: mountDirFor(index),
    name: `v${index}`,
    readOnly: params.readOnly,
  }));
  const container: Container = {
    name: HELPER_CONTAINER,
    image: params.helperImage,
    imagePullPolicy: 'IfNotPresent',
    command: ['sleep', String(HELPER_ACTIVE_DEADLINE_S)],
    resources: { requests: { cpu: '10m', memory: '16Mi' } },
    volumeMounts,
  };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: helperPodLabels({ project: params.identity.project, namespace: params.identity.namespace }),
      annotations: { [ANNOTATIONS.composeService]: params.composeService },
    },
    spec: {
      activeDeadlineSeconds: HELPER_ACTIVE_DEADLINE_S,
      automountServiceAccountToken: false,
      containers: [container],
      enableServiceLinks: false,
      ...(params.nodeName !== null ? { nodeName: params.nodeName } : {}),
      restartPolicy: 'Never',
      securityContext: { runAsGroup: 0, runAsUser: 0, seccompProfile: { type: 'RuntimeDefault' } },
      terminationGracePeriodSeconds: 0,
      tolerations: [...HELPER_TOLERATIONS],
      volumes,
    },
  };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface KubernetesBackupBackendOptions {
  deps: Pick<KubernetesBundleDeps, 'kubectl' | 'nodeShell' | 'clock' | 'redactor' | 'distribution'>;
  inventory: InventoryReader;
  /** environment name, for messages */
  env: string;
  /** servers.yml keys of the environment: node names map back to them */
  serverNames: readonly string[];
}

interface ResolvedInstance {
  pod: Pod;
  container: string;
  record: WorkloadRecord;
}

interface MappedVolume {
  /** BackupVolume.name, for messages */
  name: string;
  kind: 'volume' | 'bind';
  /** claim name (volume) or host path (bind) */
  source: string;
  /** servers.yml key; null for a PVC (the PV's node affinity places the helper) */
  node: string | null;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class KubernetesBackupBackend implements BackupBackend {
  private readonly kubectl: KubeExecutor;
  private readonly deps: Pick<KubernetesBundleDeps, 'nodeShell' | 'clock' | 'redactor' | 'distribution'>;
  private readonly inventory: InventoryReader;
  private readonly env: string;
  private readonly nodeToServer: Map<string, string>;
  /** {pod, container, restartCount} of the last `restore` of a service, read by `restartAfterRestore` */
  private readonly restoreMemo = new Map<string, { pod: string; container: string; restartCount: number }>();

  constructor(options: KubernetesBackupBackendOptions) {
    this.kubectl = options.deps.kubectl;
    this.deps = options.deps;
    this.inventory = options.inventory;
    this.env = options.env;
    this.nodeToServer = new Map(options.serverNames.map((key) => [nodeNameFor(key), key]));
  }

  // ---- errors -------------------------------------------------------------------------------

  private cliError(error: unknown, operation: string, mutating: boolean): unknown {
    if (!(error instanceof KubeError)) return error;
    return kubeErrorToCliError(error, { env: this.env, operation, mutating, distribution: this.distribution.traits.name });
  }

  private get distribution(): K8sDistribution {
    return this.deps.distribution;
  }

  // ---- kubectl helpers ------------------------------------------------------------------------

  private async getJson<T>(resources: string[], options: GetJsonOptions, operation: string): Promise<T[]> {
    try {
      return await this.kubectl.getJson<T>(resources, options);
    } catch (error) {
      throw this.cliError(error, operation, false);
    }
  }

  /** a POSIX sh script on the control-plane node (K exec pipelines); never a local guard (design-06 4.3) */
  private async runShell(script: string, operation: string): Promise<KubectlResult> {
    try {
      return await this.kubectl.shell({ script, guardS: null });
    } catch (error) {
      throw this.cliError(error, operation, true);
    }
  }

  private async removeFile(file: BackupFile): Promise<void> {
    try {
      await this.kubectl.shell({ script: `rm -f -- ${shellQuote(file.remotePath)}`, guardS: null });
    } catch {
      // best-effort: an unreachable node here is reported by the call that failed first
    }
  }

  // ---- inventory and target resolution ---------------------------------------------------------

  private async readStack(ref: StackRef): Promise<StackInventory> {
    try {
      return await this.inventory.read(namespaceFor(ref.project, ref.env));
    } catch (error) {
      throw this.cliError(error, 'read the stack', false);
    }
  }

  private workloadOf(stack: StackInventory, service: string): WorkloadRecord {
    const record = stack.primary.composeWorkloads.get(service);
    if (!record) {
      throw new CLIError(
        `Service ${service} is not deployed in namespace ${stack.stackId}`,
        ErrorCode.SERVICE_NOT_FOUND,
        `Run \`dockflow status ${this.env}\` to see what is deployed.`,
      );
    }
    return record;
  }

  private servicePods(stack: StackInventory, service: string): Pod[] {
    return stack.primary.pods.filter((pod) => {
      const owner = podOwner(pod, stack.primary);
      return owner !== null && owner.source === 'compose' && owner.service === service;
    });
  }

  /** compose instance and container of `target`, requiring one running (backup never targets Helm, R-14) */
  private async resolveInstance(ref: StackRef, target: InstanceTarget, requireReady: boolean): Promise<ResolvedInstance> {
    const stack = await this.readStack(ref);
    const record = this.workloadOf(stack, target.service);
    const pods = this.servicePods(stack, target.service);
    const instances = pods
      .map((pod) => ({ pod, info: toInstanceInfo(pod, stack.primary, EMPTY_REVISIONS, this.nodeToServer, this.deps.redactor) }))
      .filter((entry): entry is { pod: Pod; info: NonNullable<typeof entry.info> } => entry.info !== null);
    const chosen = selectInstance(
      instances.map((entry) => entry.info),
      { service: target.service, instance: target.instance, requireReady, env: this.env },
    );
    const found = instances.find((entry) => entry.info.id === chosen.id);
    if (!found) throw new Error(`unreachable: instance ${chosen.id} of ${target.service} has no pod`);
    const container = selectContainer(found.pod, target.container, record.serviceName);
    return { pod: found.pod, container, record };
  }

  // ---- streaming a backup file into (or out of) a container -------------------------------------

  /** the "K exec ... -- sh -c '<script>'" builder, for both the app container and helper containers */
  private execCommand(pod: string, container: string, script: string, namespace: string, stdin: boolean): string {
    const flags = stdin ? ['-i'] : [];
    return this.kubectl.command(['exec', ...flags, pod, '-c', container, '--', 'sh', '-c', script], namespace);
  }

  /**
   * Streams `file` into `execArgs` (an `exec -i ... sh -c '<script>'` command): one pipeline when the
   * file is on the control plane, else a relay through the CLI with backpressure (design-06 4.3 step
   * 3). The backend never classifies the outcome (K05, K62c).
   */
  private async pipeFileIntoExec(
    file: BackupFile,
    gunzip: boolean,
    pod: string,
    container: string,
    script: string,
    namespace: string,
  ): Promise<{ exitCode: number; stderr: string }> {
    const consumer = this.execCommand(pod, container, script, namespace, true);
    if (sameNode(file.node, this.kubectl.node)) {
      const producer = gunzip ? `gunzip -c ${shellQuote(file.remotePath)}` : `cat ${shellQuote(file.remotePath)}`;
      const result = await this.runShell(`${producer} | ${consumer}`, `restore ${pod}`);
      return { exitCode: result.exitCode, stderr: stripTerminatedLine(result.stderr) };
    }
    return this.relay(file, gunzip, consumer);
  }

  private async relay(file: BackupFile, gunzip: boolean, consumerScript: string): Promise<{ exitCode: number; stderr: string }> {
    const path = shellQuote(file.remotePath);
    const producerScript = gunzip ? `gunzip -c ${path}` : `cat ${path}`;
    let source: SshChannel;
    try {
      source = await this.deps.nodeShell(file.node).channel(producerScript);
      source.stdin.end();
    } catch (error) {
      throw this.cliError(error, `read backup file ${file.remotePath}`, false);
    }
    let sink: SshChannel;
    try {
      sink = await this.kubectl.channel(consumerScript);
    } catch (error) {
      source.close();
      throw this.cliError(error, 'restore over the relay', true);
    }
    let sourceStderr = '';
    let sinkStderr = '';
    source.stderr.on('data', (chunk: unknown) => {
      sourceStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    sink.stderr.on('data', (chunk: unknown) => {
      sinkStderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });

    const settled: { first: 'source' | 'sink' | null } = { first: null };
    const sourceOutcome = source.done.then(
      (result) => {
        settled.first ??= 'source';
        return result.exitCode;
      },
      (error: unknown) => {
        settled.first ??= 'source';
        sourceStderr += error instanceof Error ? error.message : String(error);
        return -1;
      },
    );
    const sinkOutcome = sink.done.then((result) => {
      settled.first ??= 'sink';
      if (!source.stdout.readableEnded) {
        source.stdout.unpipe(sink.stdin);
        source.close();
      }
      return result;
    });
    source.stdout.pipe(sink.stdin);

    const [sourceExit, sinkResult] = await Promise.all([sourceOutcome, sinkOutcome]);
    if (settled.first === 'source' && sourceExit !== 0) {
      throw new BackupError(`Cannot read backup file ${file.remotePath} on ${file.node.name}: ${headLines(sourceStderr) || `exit code ${sourceExit}`}`, {
        code: ErrorCode.RESTORE_FAILED,
      });
    }
    return { exitCode: sinkResult.exitCode, stderr: stripTerminatedLine(this.deps.redactor.redact(sinkStderr)) };
  }

  // ---- helper pods ----------------------------------------------------------------------------

  private async sweepStaleHelpers(namespace: string): Promise<void> {
    const pods = await this.getJson<Pod>(['pods'], { namespace, selector: HELPER_SELECTOR }, 'list backup helper pods');
    const staleAgeMs = HELPER_ACTIVE_DEADLINE_S * 1000;
    const nowMs = this.deps.clock.now().getTime();
    const stale = pods.filter((pod) => {
      const phase = pod.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') return true;
      const created = pod.metadata.creationTimestamp ? Date.parse(pod.metadata.creationTimestamp) : Number.NaN;
      return Number.isFinite(created) && nowMs - created > staleAgeMs;
    });
    if (stale.length === 0) return;
    try {
      await this.kubectl.delete(
        stale.map((pod) => `pods/${pod.metadata.name}`),
        { namespace, wait: false, ignoreNotFound: true },
      );
    } catch {
      // best-effort sweep; the create below still runs
    }
  }

  private async deleteHelper(namespace: string, name: string, options: { wait: boolean; timeoutS?: number } = { wait: false }): Promise<void> {
    try {
      await this.kubectl.delete([`pods/${name}`], { namespace, wait: options.wait, timeoutS: options.timeoutS, ignoreNotFound: true });
    } catch {
      // best-effort: either the caller retries create (a second AlreadyExists surfaces) or this is final cleanup
    }
  }

  /** name collision (m15): delete the existing helper and create once more; a second collision is an error */
  private async createHelper(namespace: string, name: string, manifest: Pod, service: string): Promise<void> {
    const text = emitObject(manifest);
    const create = async (): Promise<boolean> => {
      try {
        const result = await this.kubectl.create(text, { namespace });
        return result.result === 'created';
      } catch (error) {
        throw this.cliError(error, 'create the backup helper pod', true);
      }
    };
    if (await create()) return;
    await this.deleteHelper(namespace, name, { wait: true, timeoutS: 30 });
    if (await create()) return;
    throw new BackupError(`A backup helper pod for ${service} already exists and could not be replaced`, {
      suggestion: `Delete it with \`dockflow ssh ${this.env}\`, then \`${this.distribution.traits.name} kubectl -n ${namespace} delete pod ${name}\`, and retry.`,
    });
  }

  private async mountFailureEvent(namespace: string, podName: string): Promise<string | null> {
    const events = await this.getJson<{ involvedObject?: { kind?: string; name?: string }; type?: string; reason?: string; message?: string }>(
      ['events'],
      { namespace },
      'read cluster events',
    );
    const warning = events.find(
      (event) =>
        event.type === 'Warning' &&
        event.involvedObject?.kind === 'Pod' &&
        event.involvedObject.name === podName &&
        (event.reason === 'FailedMount' || event.reason === 'FailedAttachVolume'),
    );
    return warning?.message ?? null;
  }

  private async waitHelperReady(namespace: string, name: string, helperImage: string): Promise<void> {
    const deadlineMs = HELPER_READY_TIMEOUT_S * 1000;
    const start = this.deps.clock.now().getTime();
    for (;;) {
      const pods = await this.getJson<Pod>(['pods'], { namespace, name, ignoreNotFound: true }, 'wait for the backup helper pod');
      const pod = pods[0];
      if (pod) {
        const status = pod.status?.containerStatuses?.find((candidate) => candidate.name === HELPER_CONTAINER);
        if (status?.ready) return;
        const waitingReason = status?.state?.waiting?.reason;
        if (waitingReason && FATAL_IMAGE_REASONS.has(waitingReason)) {
          throw new BackupError(`The backup helper image ${helperImage} cannot be pulled on ${pod.spec.nodeName ?? 'its node'}`);
        }
        const scheduled = podCondition(pod, 'PodScheduled');
        if (scheduled?.status === 'False') {
          throw new BackupError(`The backup helper pod cannot be scheduled: ${scheduled.message ?? 'no node matched'}`);
        }
        const mountFailure = await this.mountFailureEvent(namespace, name);
        if (mountFailure !== null) throw new BackupError(`The backup helper cannot mount a volume: ${mountFailure}`);
      }
      if (this.deps.clock.now().getTime() - start >= deadlineMs) {
        throw new BackupError(`The backup helper pod did not become ready within ${HELPER_READY_TIMEOUT_S}s`);
      }
      await this.deps.clock.sleep(HELPER_POLL_MS);
    }
  }

  // ---- BackupBackend ----------------------------------------------------------------------------

  async dump(ref: StackRef, target: InstanceTarget, script: string, remotePath: string, options: { gzip: boolean }): Promise<BackupFile> {
    const namespace = namespaceFor(ref.project, ref.env);
    const resolved = await this.resolveInstance(ref, target, true);
    const producer = this.execCommand(resolved.pod.metadata.name, resolved.container, script, namespace, false);
    const pipeline = buildCapturePipeline(producer, remotePath, options.gzip);
    const result = await this.runShell(pipeline, `back up ${target.service}`);
    if (result.exitCode !== 0) {
      await this.removeFile({ node: this.kubectl.node, remotePath });
      throw new BackupError(`Backup of ${target.service} failed (exit ${result.exitCode}): ${headLines(result.stderr)}`);
    }
    return { node: this.kubectl.node, remotePath };
  }

  async restore(
    ref: StackRef,
    target: InstanceTarget,
    script: string,
    file: BackupFile,
    options: { gunzip: boolean },
  ): Promise<{ exitCode: number; stderr: string }> {
    const namespace = namespaceFor(ref.project, ref.env);
    const resolved = await this.resolveInstance(ref, target, true);
    const podName = resolved.pod.metadata.name;
    const restartCount = resolved.pod.status?.containerStatuses?.find((c) => c.name === resolved.container)?.restartCount ?? 0;
    this.restoreMemo.set(this.memoKey(ref, target.service), { pod: podName, container: resolved.container, restartCount });
    return this.pipeFileIntoExec(file, options.gunzip, podName, resolved.container, script, namespace);
  }

  async volumes(ref: StackRef, service: string, options: { includeBindMounts: boolean; exclude: string[] }): Promise<BackupVolume[]> {
    const namespace = namespaceFor(ref.project, ref.env);
    const stack = await this.readStack(ref);
    const record = this.workloadOf(stack, service);
    const pods = this.servicePods(stack, service);

    let sourcePod: Pod | null = null;
    let containerName: string;
    try {
      const instances = pods
        .map((pod) => ({ pod, info: toInstanceInfo(pod, stack.primary, EMPTY_REVISIONS, this.nodeToServer, this.deps.redactor) }))
        .filter((entry): entry is { pod: Pod; info: NonNullable<typeof entry.info> } => entry.info !== null);
      const chosen = selectInstance(
        instances.map((entry) => entry.info),
        { service, requireReady: false, env: this.env },
      );
      sourcePod = instances.find((entry) => entry.info.id === chosen.id)?.pod ?? null;
    } catch {
      sourcePod = null;
    }

    const podSpec = sourcePod ? sourcePod.spec : record.object.spec.template.spec;
    if (sourcePod) {
      containerName = selectContainer(sourcePod, undefined, record.serviceName);
    } else {
      const names = podSpec.containers.map((c) => c.name);
      containerName = defaultContainerName(names, record.object.spec.template.metadata.annotations, record.serviceName) ?? names[0] ?? record.serviceName;
    }
    const podNode = sourcePod?.spec.nodeName ? (this.nodeToServer.get(sourcePod.spec.nodeName) ?? sourcePod.spec.nodeName) : null;
    const container = podSpec.containers.find((c) => c.name === containerName);
    const mounts = container?.volumeMounts ?? [];

    const claimMounts = (podSpec.volumes ?? []).flatMap((volume) => {
      const claim = volume.persistentVolumeClaim;
      if (!claim) return [];
      const mount = mounts.find((m) => m.name === volume.name);
      return mount ? [{ volumeName: volume.name, claimName: claim.claimName, mount }] : [];
    });
    const bindMounts = options.includeBindMounts
      ? (podSpec.volumes ?? []).flatMap((volume) => {
          const hostPath = volume.hostPath;
          if (!hostPath) return [];
          const mount = mounts.find((m) => m.name === volume.name);
          return mount && !mount.readOnly ? [{ path: hostPath.path, mount }] : [];
        })
      : [];

    const claimNames = unique(claimMounts.map((c) => c.claimName));
    const claims =
      claimNames.length > 0
        ? await this.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace, names: claimNames, ignoreNotFound: true }, 'read volume claims')
        : [];
    const claimsByName = new Map(claims.map((claim) => [claim.metadata.name, claim]));
    const pvNames = unique(claims.flatMap((claim) => (claim.spec.volumeName !== undefined ? [claim.spec.volumeName] : [])));
    const pvs =
      pvNames.length > 0 ? await this.getJson<PersistentVolume>(['persistentvolumes'], { names: pvNames, ignoreNotFound: true }, 'read persistent volumes') : [];
    const pvsByName = new Map(pvs.map((pv) => [pv.metadata.name, pv]));

    const result: BackupVolume[] = [];
    for (const { claimName, mount } of claimMounts) {
      const claim = claimsByName.get(claimName);
      if (sourcePod && claim?.status?.accessModes?.includes('ReadWriteOncePod')) {
        throw new UnsupportedOperationError(
          `Volume ${claim.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? claimName} of service ${service} is ReadWriteOncePod and cannot be read while ${service} runs`,
          `Stop it with \`dockflow accessories stop ${this.env} ${service}\`, run the backup, then \`dockflow accessories restart ${this.env} ${service}\`.`,
        );
      }
      const pv = claim?.spec.volumeName !== undefined ? pvsByName.get(claim.spec.volumeName) : undefined;
      const affinity = pv ? pvHostnameAffinity(pv) : null;
      result.push({
        name: claim?.metadata.annotations?.[ANNOTATIONS.composeVolume] ?? claimName,
        kind: 'volume',
        source: claimName,
        mountPath: mount.mountPath,
        node: affinity ? (this.nodeToServer.get(affinity) ?? affinity) : null,
      });
    }
    for (const { path, mount } of bindMounts) {
      result.push({ name: sanitizePathName(mount.mountPath), kind: 'bind', source: path, mountPath: mount.mountPath, node: podNode });
    }

    return result.filter((volume) => !isExcluded(options.exclude, [volume.name, volume.source, volume.mountPath]));
  }

  async archiveVolumes(
    ref: StackRef,
    service: string,
    volumes: BackupVolume[],
    pathPrefix: string,
    options: { gzip: boolean },
  ): Promise<BackupFile[]> {
    if (volumes.length === 0) return [];
    const namespace = namespaceFor(ref.project, ref.env);
    const stack = await this.readStack(ref);
    const bindNodes = unique(volumes.filter((v) => v.kind === 'bind' && v.node !== null).map((v) => v.node as string));
    if (bindNodes.length > 1) throw new BackupError(`Bind mounts of ${service} live on different nodes (${bindNodes.join(', ')})`);
    const nodeName = bindNodes[0] !== undefined ? nodeNameFor(bindNodes[0]) : null;

    const id8 = shortHash(pathPrefix, 8);
    const name = `dockflow-helper-backup-${id8}`;
    await this.sweepStaleHelpers(namespace);
    const manifest = buildHelperPod({
      name,
      namespace,
      identity: { project: ref.project, namespace: stack.stackId },
      composeService: service,
      helperImage: this.distribution.traits.helperImage,
      mounts: volumes.map((v) => ({ kind: v.kind, source: v.source })),
      readOnly: true,
      nodeName,
    });
    await this.createHelper(namespace, name, manifest, service);
    try {
      await this.waitHelperReady(namespace, name, this.distribution.traits.helperImage);
      const files: BackupFile[] = [];
      for (const [index, volume] of volumes.entries()) {
        const remotePath = `${pathPrefix}.${volume.name}.tar${options.gzip ? '.gz' : ''}`;
        const producer = this.kubectl.command(['exec', name, '-c', HELPER_CONTAINER, '--', 'tar', 'cf', '-', '-C', mountDirFor(index), '.'], namespace);
        const result = await this.runShell(buildCapturePipeline(producer, remotePath, options.gzip), `archive ${volume.name} of ${service}`);
        if (result.exitCode !== 0) {
          await this.removeFile({ node: this.kubectl.node, remotePath });
          throw new BackupError(`Backup failed for ${volume.kind} ${volume.source}: ${headLines(result.stderr) || `exit code ${result.exitCode}`}`);
        }
        files.push({ node: this.kubectl.node, remotePath });
      }
      return files;
    } finally {
      await this.deleteHelper(namespace, name);
    }
  }

  private async mapRestoreTargets(
    namespace: string,
    service: string,
    archives: readonly { volume: BackupVolume; file: BackupFile }[],
    stack: StackInventory,
  ): Promise<MappedVolume[]> {
    const claims = await this.getJson<PersistentVolumeClaim>(['persistentvolumeclaims'], { namespace }, 'read the volume claims');
    const pods = this.servicePods(stack, service);
    const firstPodNode = pods.map((pod) => pod.spec.nodeName).find((name): name is string => Boolean(name)) ?? null;
    const firstPodServerKey = firstPodNode ? (this.nodeToServer.get(firstPodNode) ?? firstPodNode) : null;

    return archives.map(({ volume }) => {
      if (volume.kind === 'bind') {
        return { name: volume.name, kind: 'bind', source: volume.source, node: volume.node ?? firstPodServerKey };
      }
      const claim = claims.find(
        (candidate) =>
          candidate.metadata.annotations?.[ANNOTATIONS.composeVolume] === volume.name ||
          candidate.metadata.name === volume.name ||
          candidate.metadata.name === volume.source,
      );
      if (!claim) {
        throw new BackupError(`Backup volume ${volume.name} has no matching volume in service ${service}; nothing was restored`, {
          code: ErrorCode.RESTORE_FAILED,
        });
      }
      return { name: volume.name, kind: 'volume', source: claim.metadata.name, node: null };
    });
  }

  private memoKey(ref: StackRef, service: string): string {
    return `${ref.project}/${ref.env}/${ref.role}/${service}`;
  }

  /** R-23's live re-check (K24): the command and `Backup.restore` already refused once against `ServiceInfo` */
  private refuseMultiReplica(service: string, replicas: number, role: StackRole): never {
    const suggestion =
      role === 'accessory'
        ? `Set \`deploy.replicas: 1\` for ${service} in accessories.yml and run \`dockflow deploy ${this.env} --accessories\` first, restore, then set it back.`
        : `Scale it to 1 first with \`dockflow scale ${this.env} ${service} 1\`, restore, then scale it back.`;
    throw new UnsupportedOperationError(`Service ${service} runs ${replicas} replicas; dockflow backup restore writes one replica only`, suggestion);
  }

  private resourceOf(kind: 'Deployment' | 'StatefulSet'): string {
    return kind === 'Deployment' ? 'deployments.apps' : 'statefulsets.apps';
  }

  private patchTarget(kind: 'Deployment' | 'StatefulSet'): string {
    return kind === 'Deployment' ? 'deployment' : 'statefulset';
  }

  private async patchWorkload(namespace: string, kind: 'Deployment' | 'StatefulSet', name: string, body: unknown, operation: string): Promise<void> {
    try {
      await this.kubectl.run({ args: ['patch', `${this.patchTarget(kind)}/${name}`, '--type=merge', '-p', JSON.stringify(body)], namespace, mutating: true });
    } catch (error) {
      throw this.cliError(error, operation, true);
    }
  }

  private async waitPodsGone(namespace: string, selector: string, waitS: number): Promise<boolean> {
    const start = this.deps.clock.now().getTime();
    for (;;) {
      const pods = await this.getJson<Pod>(['pods'], { namespace, selector }, 'wait for pods to stop');
      if (pods.length === 0) return true;
      if (this.deps.clock.now().getTime() - start >= waitS * 1000) return false;
      await this.deps.clock.sleep(HELPER_POLL_MS);
    }
  }

  private async stopWorkload(
    namespace: string,
    kind: 'Deployment' | 'StatefulSet',
    name: string,
    desired: number,
    graceSeconds: number,
    selector: string,
    service: string,
  ): Promise<void> {
    await this.patchWorkload(
      namespace,
      kind,
      name,
      { metadata: { annotations: { [ANNOTATIONS.replicasBeforeStop]: String(desired) } }, spec: { replicas: 0 } },
      `stop ${service}`,
    );
    const waitS = deleteWaitS([{ graceSeconds }]);
    const stopped = await this.waitPodsGone(namespace, selector, waitS);
    if (!stopped) {
      await this.resumeWorkload(namespace, kind, name, desired, service).catch(() => {});
      throw new BackupError(`Pods of ${service} did not stop within ${waitS}s; nothing was restored`, { code: ErrorCode.RESTORE_FAILED });
    }
  }

  private async resumeWorkload(namespace: string, kind: 'Deployment' | 'StatefulSet', name: string, desired: number, service: string): Promise<void> {
    await this.patchWorkload(
      namespace,
      kind,
      name,
      { metadata: { annotations: { [ANNOTATIONS.replicasBeforeStop]: null } }, spec: { replicas: desired } },
      `restart ${service}`,
    );
  }

  private extractionFailure(mount: MappedVolume, service: string, stderr: string): BackupError {
    if (/No space left on device/i.test(stderr)) {
      return new BackupError(`Restore of ${service} needs room for a second copy of volume ${mount.name} on ${mount.node ?? 'its node'}; nothing was changed`, {
        code: ErrorCode.RESTORE_FAILED,
        suggestion: `Free disk space on ${mount.node ?? 'its node'} and run the restore again; the current contents were kept.`,
      });
    }
    return new BackupError(
      `Restore of ${service} failed while reading the archive of volume ${mount.name}: ${stderr || 'the extraction failed'}; nothing was changed`,
      { code: ErrorCode.RESTORE_FAILED },
    );
  }

  private async discardAll(namespace: string, helperName: string, mapping: readonly MappedVolume[], id8: string): Promise<void> {
    for (let index = 0; index < mapping.length; index++) {
      const script = this.kubectl.command(['exec', helperName, '-c', HELPER_CONTAINER, '--', 'sh', '-c', buildDiscardScript(mountDirFor(index), id8)], namespace);
      try {
        await this.kubectl.shell({ script, guardS: null });
      } catch {
        // best-effort cleanup; the original failure is what the caller reports
      }
    }
  }

  async restoreVolumes(ref: StackRef, service: string, archives: { volume: BackupVolume; file: BackupFile }[]): Promise<void> {
    if (archives.length === 0) return;
    const namespace = namespaceFor(ref.project, ref.env);
    const stack = await this.readStack(ref);
    const record = this.workloadOf(stack, service);

    if (record.kind === 'DaemonSet' || record.kind === 'Job') {
      throw new UnsupportedOperationError(
        `Service ${service} runs as a ${record.kind} and cannot be stopped for a volume restore`,
        'Restore the files with `dockflow cp`, or use a database backup type.',
      );
    }
    const kind = record.kind;
    const name = record.object.metadata.name;
    const live = await this.getJson<Deployment | StatefulSet>([this.resourceOf(kind)], { namespace, name, ignoreNotFound: true }, 'read the workload').then(
      (items) => items[0],
    );
    if (!live) throw new CLIError(`Service ${service} is not deployed in namespace ${stack.stackId}`, ErrorCode.SERVICE_NOT_FOUND);
    const desired = live.spec.replicas ?? 0;
    if (desired > 1) this.refuseMultiReplica(service, desired, record.role);

    const mapping = await this.mapRestoreTargets(namespace, service, archives, stack);
    const bindNodes = unique(mapping.filter((m) => m.kind === 'bind' && m.node !== null).map((m) => m.node as string));
    const nodeName = bindNodes[0] !== undefined ? nodeNameFor(bindNodes[0]) : null;

    const id8 = restoreId8(archives);
    const helperName = `dockflow-helper-restore-${id8}`;
    await this.sweepStaleHelpers(namespace);
    const manifest = buildHelperPod({
      name: helperName,
      namespace,
      identity: { project: ref.project, namespace: stack.stackId },
      composeService: service,
      helperImage: this.distribution.traits.helperImage,
      mounts: mapping.map((m) => ({ kind: m.kind, source: m.source })),
      readOnly: false,
      nodeName,
    });
    await this.createHelper(namespace, helperName, manifest, service);

    try {
      await this.waitHelperReady(namespace, helperName, this.distribution.traits.helperImage);

      const selector = SEL_POD(stack.stackId, record.role, [record.serviceName]);
      const graceSeconds = live.spec.template.spec.terminationGracePeriodSeconds ?? 30;
      if (desired > 0) await this.stopWorkload(namespace, kind, name, desired, graceSeconds, selector, service);

      let duringSwap = false;
      try {
        for (let index = 0; index < mapping.length; index++) {
          const target = mapping[index];
          const file = archives[index].file;
          const gzip = file.remotePath.endsWith('.gz');
          const script = buildExtractScript(mountDirFor(index), id8);
          const result = await this.pipeFileIntoExec(file, gzip, helperName, HELPER_CONTAINER, script, namespace);
          if (result.exitCode !== 0) throw this.extractionFailure(target, service, result.stderr);
        }
        duringSwap = true;
        for (let index = 0; index < mapping.length; index++) {
          const target = mapping[index];
          const script = this.kubectl.command(['exec', helperName, '-c', HELPER_CONTAINER, '--', 'sh', '-c', buildSwapScript(mountDirFor(index), id8)], namespace);
          const result = await this.runShell(script, `restore ${target.name} of ${service}`);
          if (result.exitCode !== 0) {
            throw new BackupError(
              `Restore of ${service} failed while swapping volume ${target.name}: ${result.stderr || 'the swap failed'}; the service was left stopped and the previous contents are in ${target.name}/${previousDirName(id8)}`,
              {
                code: ErrorCode.RESTORE_FAILED,
                suggestion: `Retry the restore, or move the files back and start the service again with \`dockflow accessories restart ${this.env} ${service}\` (app services: \`dockflow restart ${this.env} ${service}\`).`,
              },
            );
          }
        }
      } catch (error) {
        if (!duringSwap) {
          await this.discardAll(namespace, helperName, mapping, id8);
          if (desired > 0) await this.resumeWorkload(namespace, kind, name, desired, service).catch(() => {});
        }
        throw error;
      }
      if (desired > 0) await this.resumeWorkload(namespace, kind, name, desired, service);
    } finally {
      await this.deleteHelper(namespace, helperName);
    }
  }

  async restartAfterRestore(ref: StackRef, service: string): Promise<void> {
    const namespace = namespaceFor(ref.project, ref.env);
    const stack = await this.readStack(ref);
    const record = this.workloadOf(stack, service);
    const remembered = this.restoreMemo.get(this.memoKey(ref, service));
    const selector = SEL_POD(stack.stackId, record.role, [record.serviceName]);

    const start = this.deps.clock.now().getTime();
    let forced = false;
    for (;;) {
      const pods = await this.getJson<Pod>(['pods'], { namespace, selector }, 'wait for the service to restart');
      const ready = pods.some((pod) => {
        if (pod.metadata.deletionTimestamp) return false;
        const statuses = pod.status?.containerStatuses ?? [];
        if (!statuses.every((status) => status.ready)) return false;
        if (remembered && pod.metadata.name === remembered.pod) {
          const status = statuses.find((candidate) => candidate.name === remembered.container);
          return (status?.restartCount ?? 0) > remembered.restartCount;
        }
        return remembered === undefined || pod.metadata.name !== remembered.pod;
      });
      if (ready) return;
      const elapsed = this.deps.clock.now().getTime() - start;
      if (!forced && elapsed >= RESTART_FORCE_AFTER_MS && remembered) {
        forced = true;
        await this.kubectl.delete([`pods/${remembered.pod}`], { namespace, wait: false, ignoreNotFound: true }).catch(() => {});
      }
      if (elapsed >= RESTART_TIMEOUT_MS) {
        throw new BackupError(`Service ${service} did not become ready within 120s after the restore`, {
          code: ErrorCode.RESTORE_FAILED,
          suggestion: `Run \`dockflow diagnose ${this.env}\`.`,
        });
      }
      await this.deps.clock.sleep(HELPER_POLL_MS);
    }
  }
}

export function createKubernetesBackupBackend(options: KubernetesBackupBackendOptions): BackupBackend {
  return new KubernetesBackupBackend(options);
}
