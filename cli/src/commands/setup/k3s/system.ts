// dockflow-system namespace, the dockflow-local StorageClass and node labels (design-05 8, 11,
// kubernetes/k3s/storage-class.ts). `assertSingleDefaultStorageClass` runs on every `control-plane`
// (K22, C18): k3s re-applies `local-storage.yaml` on every start and every upgrade (F30), so the
// non-default patch on `local-path` is re-asserted here rather than written once.

import { ANNOTATIONS, K8S_STORAGE_CLASS, K8S_SYSTEM_NAMESPACE, KUBE_KEYS } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { dockflowStorageClass, nonDefaultStorageClassPatch } from '../../../services/orchestrator/kubernetes/k3s/storage-class';
import { systemObjectLabels } from '../../../services/orchestrator/kubernetes/labels';
import type { Namespace, Node } from '../../../services/orchestrator/kubernetes/resources/core';
import type { StorageClass } from '../../../services/orchestrator/kubernetes/resources/storage';
import type { KubeExecutor } from '../../../services/orchestrator/kubernetes/runtime/kubectl';
import { emitObject } from '../../../services/orchestrator/kubernetes/yaml';
import { LOCAL_PATH_CLASS_TIMEOUT_S, LOCAL_PATH_STORAGE_CLASS } from './constants';
import { SetupStepError } from './host-runner';
import { setupMessages, type SetupProblem } from './messages';

const LOCAL_PATH_POLL_MS = 2000;

export const systemMessages = {
  existingClassWrongPolicy: (env: string, actual: string): SetupProblem => ({
    message: `StorageClass ${K8S_STORAGE_CLASS} on ${env} has reclaimPolicy ${actual}, and Dockflow needs Retain`,
    suggestion: `Delete it after checking that no PersistentVolume uses it (\`kubectl get pv\`), then run setup again.`,
  }),
  localPathMissing: (env: string, timeoutS: number): SetupProblem => ({
    message: `k3s did not create its StorageClass ${LOCAL_PATH_STORAGE_CLASS} on ${env} within ${timeoutS}s`,
    suggestion: `Dockflow volumes use the local-path provisioner k3s bundles: check that local-storage is not disabled in the k3s configuration, and look for deploy controller errors with \`journalctl -u k3s\`.`,
  }),
} as const;

/**
 * Waits for k3s's own `local-path` class. k3s creates it a few seconds after its API answers, and
 * it is marked default when created: `dockflow-local` must come after it to be the most recently
 * created default (F32), and `assertSingleDefaultStorageClass` must see it to patch it.
 */
export async function waitForLocalPathClass(kube: KubeExecutor, clock: Clock, options: { env: string; timeoutS?: number }): Promise<void> {
  const timeoutS = options.timeoutS ?? LOCAL_PATH_CLASS_TIMEOUT_S;
  const deadline = clock.now().getTime() + timeoutS * 1000;
  for (;;) {
    const found = await kube.getJson<StorageClass>(['storageclass'], { name: LOCAL_PATH_STORAGE_CLASS, allowNotFound: true });
    if (found.length > 0) return;
    if (clock.now().getTime() >= deadline) {
      const problem = systemMessages.localPathMissing(options.env, timeoutS);
      throw new SetupStepError(problem.message, problem.suggestion);
    }
    await clock.sleep(LOCAL_PATH_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Namespace and StorageClass (11.1)
// ---------------------------------------------------------------------------

export function dockflowSystemNamespace(): Namespace {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: K8S_SYSTEM_NAMESPACE, labels: systemObjectLabels() } };
}

/** The namespace and the class, in that order, `---` separated (S1). */
export function systemManifest(): string {
  const objects: readonly object[] = [dockflowSystemNamespace(), dockflowStorageClass()];
  return objects.map((object) => `---\n${emitObject(object)}`).join('');
}

/**
 * Applies the namespace and the class. An existing `dockflow-local` whose `reclaimPolicy` differs
 * from `Retain` is refused before the apply: the field is immutable, and the server-side conflict it
 * would otherwise produce is less useful than this message (11.1).
 */
export async function applySystemObjects(kube: KubeExecutor, options: { env: string }): Promise<void> {
  await kube.apply(`---\n${emitObject(dockflowSystemNamespace())}`, { dryRun: false });
  const existing = await kube.getJson<StorageClass>(['storageclass'], { name: K8S_STORAGE_CLASS, allowNotFound: true });
  const desired = dockflowStorageClass();
  const current = existing[0];
  if (current !== undefined) {
    const actual = current.reclaimPolicy ?? 'Delete';
    if (actual !== desired.reclaimPolicy) {
      const problem = systemMessages.existingClassWrongPolicy(options.env, actual);
      throw new SetupStepError(problem.message, problem.suggestion);
    }
  }
  await kube.apply(`---\n${emitObject(desired)}`, { dryRun: false });
}

// ---------------------------------------------------------------------------
// One default StorageClass, enforced (11.2, K22, C18)
// ---------------------------------------------------------------------------

export interface StorageDefaultResult {
  /** 'unchanged' | 'patched-local-path' | 'recreated-dockflow-local' (or both), in the order applied */
  actions: string[];
  /** every StorageClass carrying the default annotation, newest last */
  defaults: { name: string; createdAt: string }[];
}

function isDefaultClass(sc: StorageClass): boolean {
  return sc.metadata.annotations?.[KUBE_KEYS.defaultStorageClass] === 'true';
}

function defaultsOf(classes: readonly StorageClass[]): { name: string; createdAt: string }[] {
  return classes
    .filter(isDefaultClass)
    .map((sc) => ({ name: sc.metadata.name, createdAt: sc.metadata.creationTimestamp ?? '' }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * The `storage-default` step of `control-plane` (11.2): a foreign default class refuses, k3s's own
 * `local-path` is patched non-default (never deleted, its provisioner stays k3s-managed), and
 * `dockflow-local` is recreated only when it is not the most recently created default (the tie-break
 * backstop for the window k3s's own re-apply opens, F30/F32). Idempotent: a second run over the
 * resulting state issues no mutating call.
 */
export async function assertSingleDefaultStorageClass(kube: KubeExecutor, options: { env: string }): Promise<StorageDefaultResult> {
  const classes = await kube.getJson<StorageClass>(['storageclass'], {});
  const foreign = classes.filter(
    (sc) => isDefaultClass(sc) && sc.metadata.name !== K8S_STORAGE_CLASS && sc.metadata.name !== LOCAL_PATH_STORAGE_CLASS,
  );
  if (foreign.length > 0) {
    const [name] = foreign.map((sc) => sc.metadata.name).sort();
    const problem = setupMessages.foreignDefaultStorageClass(options.env, name);
    throw new SetupStepError(problem.message, problem.suggestion);
  }

  const actions: string[] = [];
  const localPath = classes.find((sc) => sc.metadata.name === LOCAL_PATH_STORAGE_CLASS);
  if (localPath !== undefined && isDefaultClass(localPath)) {
    await kube.run({
      args: ['patch', 'storageclass', LOCAL_PATH_STORAGE_CLASS, '--type=merge', '-p', JSON.stringify(nonDefaultStorageClassPatch())],
      mutating: true,
    });
    actions.push('patched-local-path');
  }

  const dockflowLocal = classes.find((sc) => sc.metadata.name === K8S_STORAGE_CLASS);
  const dockflowCreated = dockflowLocal?.metadata.creationTimestamp;
  const localPathCreated = localPath?.metadata.creationTimestamp;
  if (localPath !== undefined && (dockflowCreated === undefined || (localPathCreated !== undefined && localPathCreated > dockflowCreated))) {
    if (dockflowLocal !== undefined) await kube.delete([`storageclass/${K8S_STORAGE_CLASS}`], { wait: true, ignoreNotFound: true });
    await kube.apply(`---\n${emitObject(dockflowStorageClass())}`, { dryRun: false });
    actions.push('recreated-dockflow-local');
  }

  const after = actions.length > 0 ? await kube.getJson<StorageClass>(['storageclass'], {}) : classes;
  return { actions, defaults: defaultsOf(after) };
}

// ---------------------------------------------------------------------------
// Node labels (section 8, K76)
// ---------------------------------------------------------------------------

function sortedEqual(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((value, index) => value === sb[index]);
}

/**
 * Applies `servers.yml node_labels` to a Node and removes labels Dockflow previously applied and no
 * longer wants (tracked in `ANNOTATIONS.nodeLabels`, since a Node carries no other record of who set
 * a label). A label Dockflow never applied is never touched.
 */
export async function reconcileNodeLabels(kube: KubeExecutor, nodeName: string, wanted: Readonly<Record<string, string>>): Promise<'unchanged' | 'updated'> {
  const nodes = await kube.getJson<Node>(['node'], { name: nodeName });
  const node = nodes[0];
  const currentLabels = node?.metadata.labels ?? {};
  const recordedRaw = node?.metadata.annotations?.[ANNOTATIONS.nodeLabels];
  let recorded: string[] = [];
  if (recordedRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(recordedRaw);
      if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) recorded = parsed;
    } catch {
      recorded = [];
    }
  }
  const wantedKeys = Object.keys(wanted);
  const toRemove = recorded.filter((key) => !(key in wanted));
  const toSet = wantedKeys.filter((key) => currentLabels[key] !== wanted[key]);
  if (toSet.length === 0 && toRemove.length === 0 && sortedEqual(recorded, wantedKeys)) return 'unchanged';

  if (toSet.length > 0 || toRemove.length > 0) {
    const args = ['label', 'node', nodeName, ...toSet.map((key) => `${key}=${wanted[key]}`), ...toRemove.map((key) => `${key}-`), '--overwrite'];
    await kube.run({ args, mutating: true });
  }
  const sortedWanted = [...wantedKeys].sort();
  await kube.run({
    args: ['annotate', 'node', nodeName, `${ANNOTATIONS.nodeLabels}=${JSON.stringify(sortedWanted)}`, '--overwrite'],
    mutating: true,
  });
  return 'updated';
}
