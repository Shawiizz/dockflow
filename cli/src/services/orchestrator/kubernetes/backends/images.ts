// Images on Kubernetes nodes (D12, D13, DV5; design-03 12). Built images are tagged under the
// imported registry (`dockflow.invalid/<ref>`), saved once per node that lacks them and imported with
// the pinned label through that node's NodeShell; the pull Secret is applied with server-side apply;
// removal and release GC only ever name imported references. Every node command comes from the
// K8sDistribution and runs with `sudo -n`, the rule setup wrote.

import { createGzip } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import {
  CLIError,
  DeployError,
  ErrorCode,
  OrchestratorUnavailableError,
  UnsupportedOperationError,
} from '../../../../utils/errors';
import { canonicalJson } from '../../../../utils/hash';
import {
  type ContainerRuntime,
  createLocalEngine,
  detectLocalEngine,
  imageProgress,
  type LocalEngine,
} from '../../../distribution';
import { capabilityRefusal } from '../../capabilities';
import type {
  ClusterNodeRef,
  ImageBackend,
  NodeImage,
  OrchestratorTarget,
  RegistryCredentials,
  ReleaseStore,
  StackRef,
} from '../../interfaces';
import {
  K8S_GUARD_MARGIN_S,
  K8S_IMAGE_IMPORT_CONCURRENCY,
  K8S_IMAGE_IMPORT_GUARD_S,
  K8S_IMPORTED_IMAGE_REGISTRY,
  K8S_REGISTRY_SECRET,
  K8S_REQUEST_TIMEOUT_S,
} from '../constants';
import type { KubernetesBundleDeps } from '../deps';
import { importedImageRef } from '../naming';
import { KubeError, kubeErrorToCliError, stderrExcerpt } from '../runtime/errors';
import { driveChannel, getJsonCall, guarded, type KubectlResult, parseJsonItems } from '../runtime/kubectl';
import { isSudoRefusal, type NodeShell } from '../runtime/node-shell';
import { dockerConfigJson, registrySecret, registrySecretRedactions } from '../translate/registry-secret';

// ---------------------------------------------------------------------------
// Output phrases (R-S5-01)
// ---------------------------------------------------------------------------

/** The stable parts of the distribution lines; e2e scenarios match on them. */
export const IMAGE_PHRASES = {
  imported: 'imported on',
  alreadyPresent: 'already present on',
} as const;

export function importedLine(node: string, refs: readonly string[]): string {
  return `images: ${refs.join(', ')} ${IMAGE_PHRASES.imported} ${node}`;
}

export function alreadyPresentLine(node: string, count: number): string {
  return `images: ${count} image(s) ${IMAGE_PHRASES.alreadyPresent} ${node}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const IMPORTED_PREFIX = `${K8S_IMPORTED_IMAGE_REGISTRY}/`;
// what may follow the prefix in a removal: nothing a shell or ctr would interpret
const IMPORTED_REST = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** one-shot node reads (listings, disk usage) */
const NODE_READ_GUARD_S = K8S_REQUEST_TIMEOUT_S + K8S_GUARD_MARGIN_S;
/** K44 reads every pod and pod template of the cluster: twice the one-shot budget (design-03 20) */
const IN_USE_TIMEOUT_S = 2 * K8S_REQUEST_TIMEOUT_S;
const IN_USE_RESOURCES = [
  'pods',
  'replicasets.apps',
  'controllerrevisions.apps',
  'deployments.apps',
  'statefulsets.apps',
  'daemonsets.apps',
  'jobs.batch',
];
/** revision history: what a workload ran before, not what it runs */
const HISTORY_RESOURCES = new Set(['replicasets.apps', 'controllerrevisions.apps']);
const CONTAINER_LISTS = new Set(['containers', 'initContainers', 'ephemeralContainers']);

/** The reference an image is imported under; one already imported is kept as it is. */
export function toImportedRef(ref: string): string {
  return ref.startsWith(IMPORTED_PREFIX) ? ref : importedImageRef(ref);
}

/** `dockflow.invalid/web-production:1.4.2` -> `dockflow.invalid/web-production` */
function repositoryOf(ref: string): string {
  const at = ref.indexOf('@');
  const name = at === -1 ? ref : ref.slice(0, at);
  const colon = name.lastIndexOf(':');
  return colon > name.lastIndexOf('/') ? name.slice(0, colon) : name;
}

/** What the removal rule may name (DV5): an imported reference made of plain characters. */
export function isRemovableRef(ref: string): boolean {
  return ref.startsWith(IMPORTED_PREFIX) && IMPORTED_REST.test(ref.slice(IMPORTED_PREFIX.length));
}

/**
 * The name the container runtime stores: Docker Hub names gain `docker.io/` (and `library/` for
 * official images), an untagged reference gains `:latest`. Pod specs and runtime listings compare
 * equal through it.
 */
export function canonicalImageRef(ref: string): string {
  let name = ref.trim();
  let digest = '';
  const at = name.indexOf('@');
  if (at !== -1) {
    digest = name.slice(at);
    name = name.slice(0, at);
  }
  const slash = name.indexOf('/');
  const first = slash === -1 ? '' : name.slice(0, slash);
  const hasHost = slash !== -1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasHost) {
    name = slash === -1 ? `docker.io/library/${name}` : `docker.io/${name}`;
  } else if ((first === 'docker.io' || first === 'index.docker.io') && !name.slice(slash + 1).includes('/')) {
    name = `docker.io/library/${name.slice(slash + 1)}`;
  }
  const lastSegment = name.slice(name.lastIndexOf('/') + 1);
  if (digest === '' && !lastSegment.includes(':')) name = `${name}:latest`;
  return `${name}${digest}`;
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** One image of the runtime listing (N1, `crictl images -o json`). */
export interface RuntimeImage {
  /** config digest, `sha256:...` */
  id: string;
  repoTags: string[];
  repoDigests: string[];
  sizeBytes: number | null;
  pinned: boolean;
}

/** N1; null when the output is not the JSON listing. */
export function parseRuntimeImages(stdout: string): RuntimeImage[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() === '' ? '{}' : stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const images = parsed.images ?? [];
  if (!Array.isArray(images)) return null;
  return images.filter(isRecord).map((image) => {
    const size = typeof image.size === 'string' || typeof image.size === 'number' ? Number(image.size) : Number.NaN;
    return {
      id: typeof image.id === 'string' ? image.id : '',
      repoTags: stringArray(image.repoTags),
      repoDigests: stringArray(image.repoDigests),
      sizeBytes: Number.isFinite(size) ? size : null,
      pinned: image.pinned === true,
    };
  });
}

/** N2 (`ctr images ls`): the first three columns `REF TYPE DIGEST`; the size column has a space. */
export function parseStoreImages(stdout: string): { ref: string; digest: string }[] {
  const rows: { ref: string; digest: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [ref, , digest] = line.trim().split(/\s+/);
    if (ref === undefined || ref === 'REF' || digest === undefined || !digest.startsWith('sha256:')) continue;
    rows.push({ ref, digest });
  }
  return rows;
}

export interface NodeImageEntry {
  /** the image id as the runtime reports it (Docker's classic store id) */
  configDigest: string | null;
  /** the manifest or index digest (Docker's containerd image store id) */
  targetDigest: string | null;
  pinned: boolean;
}

/** N1 and N2 merged, by canonical reference. */
export interface NodeImageIndex {
  byRef: Map<string, NodeImageEntry>;
}

export function nodeImageIndex(runtime: readonly RuntimeImage[], store: readonly { ref: string; digest: string }[]): NodeImageIndex {
  const byRef = new Map<string, NodeImageEntry>();
  for (const image of runtime) {
    for (const tag of image.repoTags) {
      byRef.set(canonicalImageRef(tag), { configDigest: image.id || null, targetDigest: null, pinned: image.pinned });
    }
  }
  for (const row of store) {
    const key = canonicalImageRef(row.ref);
    const entry = byRef.get(key);
    if (entry) entry.targetDigest = row.digest;
    else byRef.set(key, { configDigest: null, targetDigest: row.digest, pinned: false });
  }
  return { byRef };
}

/**
 * The node has `ref` with the local image id, pinned. An unpinned copy is imported again: kubelet
 * image GC may delete it once unused, and a revert would then need a pull that cannot succeed (DV5).
 */
export function isPresent(index: NodeImageIndex, ref: string, localId: string): boolean {
  const entry = index.byRef.get(canonicalImageRef(ref));
  if (!entry || !entry.pinned || localId === '') return false;
  const id = withAlgorithm(localId);
  return (entry.configDigest !== null && withAlgorithm(entry.configDigest) === id) || (entry.targetDigest !== null && withAlgorithm(entry.targetDigest) === id);
}

function withAlgorithm(digest: string): string {
  return digest.includes(':') ? digest : `sha256:${digest}`;
}

/** Canonical image references of every container and init container found in the objects (K44). */
export function containerImagesOf(objects: readonly unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (CONTAINER_LISTS.has(key) && Array.isArray(child)) {
        for (const container of child) {
          if (isRecord(container) && typeof container.image === 'string') found.add(canonicalImageRef(container.image));
        }
      } else {
        walk(child);
      }
    }
  };
  walk(objects);
  return found;
}

/** `image:` of every service of a stored compose; [] when it cannot be read. */
export function composeImageRefs(compose: string | null): string[] {
  if (compose === null || compose.trim() === '') return [];
  let doc: unknown;
  try {
    doc = parseYaml(compose, { merge: true });
  } catch {
    return [];
  }
  const services = isRecord(doc) ? doc.services : undefined;
  if (!isRecord(services)) return [];
  const images: string[] = [];
  for (const service of Object.values(services)) {
    if (isRecord(service) && typeof service.image === 'string' && service.image !== '') images.push(service.image);
  }
  return unique(images);
}

/** `df -h`-style size: 1024-based, rounded up, one decimal below 10. */
export function humanSize(bytes: number): string {
  const units = ['', 'K', 'M', 'G', 'T', 'P'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${bytes}`;
  return value < 10 ? `${(Math.ceil(value * 10) / 10).toFixed(1)}${units[unit]}` : `${Math.ceil(value)}${units[unit]}`;
}

/** `df -Pk <dir>` -> `12G used of 40G, 30%`; null when the output is not one data row. */
export function parseDiskUsage(stdout: string): string | null {
  const row = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)[1];
  if (row === undefined) return null;
  const columns = row.trim().split(/\s+/);
  const size = Number(columns[1]);
  const used = Number(columns[2]);
  const capacity = columns[4];
  if (!Number.isFinite(size) || !Number.isFinite(used) || capacity === undefined || !/^\d+%$/.test(capacity)) return null;
  return `${humanSize(used * 1024)} used of ${humanSize(size * 1024)}, ${capacity}`;
}

/** Settles every item, at most `limit` at a time, in item order. */
async function settleEach<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** The fulfilled values in item order, or the first rejection. */
function valuesOrThrow<R>(results: readonly PromiseSettledResult<R>[]): R[] {
  const values: R[] = [];
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    values.push(result.value);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface ImageEvents {
  /** one line per node outcome of a distribution */
  info(line: string): void;
  /** best-effort failures that do not fail the caller */
  debug(line: string): void;
}

export interface KubernetesImageBackendOptions {
  /** the apply engine's namespace ensure (ownership guard, memo shared by the bundle) */
  ensureNamespace(ref: StackRef): Promise<void>;
  /** images of the current release are never removed by a failed deploy's cleanup (design-03 12.4) */
  releases?: Pick<ReleaseStore, 'currentCompose'>;
  /** `container_engine` of config.yml; detected on this machine when absent */
  containerEngine?: ContainerRuntime;
  /** default: the docker or podman CLI of this machine */
  localEngine?: LocalEngine;
  /** default: dim lines and debug output */
  events?: ImageEvents;
}

interface ImageRefs {
  compose: string;
  imported: string;
}

interface NodeFailureDetail {
  detail: string;
  sudo: boolean;
}

export class KubernetesImageBackend implements ImageBackend {
  private readonly events: ImageEvents;
  private local: LocalEngine | null;

  constructor(
    private readonly deps: KubernetesBundleDeps,
    private readonly target: OrchestratorTarget,
    private readonly options: KubernetesImageBackendOptions,
  ) {
    this.events = options.events ?? imageProgress;
    this.local = options.localEngine ?? null;
  }

  async distribute(images: string[], nodes: ClusterNodeRef[]): Promise<void> {
    const refs: ImageRefs[] = unique(images).map((compose) => ({ compose, imported: toImportedRef(compose) }));
    if (refs.length === 0 || nodes.length === 0) return;
    const engine = this.localEngine();
    for (const ref of refs) {
      if (ref.compose !== ref.imported) await engine.tag(ref.compose, ref.imported);
    }
    const ids = new Map<string, string>();
    for (const ref of refs) ids.set(ref.imported, await engine.imageId(ref.imported));

    const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, (node) => this.importOnNode(node, refs, ids, engine));
    const failures: CLIError[] = [];
    results.forEach((result, i) => {
      if (result.status === 'rejected') failures.push(this.nodeError(nodes[i], 'Image import', result.reason));
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new DeployError(
        `Image import failed on ${failures.length} nodes: ${failures.map((f) => f.message).join('; ')}`,
        ErrorCode.DEPLOY_FAILED,
        failures[0].suggestion,
      );
    }
  }

  async verifyPresence(images: string[], nodes: ClusterNodeRef[]): Promise<{ node: string; missing: string[] }[]> {
    // registry and public references are pulled by the nodes: presence only matters for imports
    const refs = unique(images.filter((ref) => ref.startsWith(IMPORTED_PREFIX)));
    if (refs.length === 0 || nodes.length === 0) return [];
    const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, async (node) => {
      const index = await this.readIndex(this.deps.nodeShell(node), 'Image check');
      return { node: node.name, missing: refs.filter((ref) => !index.byRef.has(canonicalImageRef(ref))) };
    });
    const reports = results.map((result, i) => {
      if (result.status === 'rejected') throw this.nodeError(nodes[i], 'Image check', result.reason);
      return result.value;
    });
    return reports.filter((report) => report.missing.length > 0);
  }

  async ensurePullSecret(ref: StackRef, registry: RegistryCredentials): Promise<string> {
    this.deps.redactor.add(registrySecretRedactions(registry));
    const secret = registrySecret(ref, dockerConfigJson(registry));
    try {
      await this.options.ensureNamespace(ref);
      await this.deps.kubectl.apply(`${canonicalJson(secret)}\n`, { namespace: secret.metadata.namespace, dryRun: false });
    } catch (error) {
      throw this.kubeFailure(error, 'apply the registry pull Secret', true);
    }
    return K8S_REGISTRY_SECRET;
  }

  /** Best effort: nothing here fails the deploy that is already failing. */
  async remove(images: string[], nodes: ClusterNodeRef[]): Promise<void> {
    try {
      const candidates = unique(images.map(toImportedRef)).filter(isRemovableRef);
      if (candidates.length === 0 || nodes.length === 0) return;
      // after the revert the failed revision stays as ReplicaSet/ControllerRevision history, which
      // must not protect the very images it failed with; pods and live templates still do
      const protectedRefs = await this.imagesInUse({ history: false });
      const current = this.options.releases ? await this.options.releases.currentCompose(this.target.stackName) : null;
      for (const image of composeImageRefs(current)) protectedRefs.add(canonicalImageRef(toImportedRef(image)));
      const refs = new Set(candidates.map(canonicalImageRef).filter((ref) => !protectedRefs.has(ref)));
      if (refs.size === 0) return;
      const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, (node) => this.removeOnNode(node, (ref) => refs.has(ref), 'Image cleanup'));
      results.forEach((result, i) => {
        if (result.status === 'rejected') this.events.debug(this.nodeError(nodes[i], 'Image cleanup', result.reason).message);
      });
    } catch (error) {
      this.events.debug(`Image cleanup skipped: ${errorText(error)}`);
    }
  }

  /**
   * Removes the imported images the pruned releases used, and every other tag the node holds of a
   * repository Dockflow named for this environment (`<image>-<env>`, image_auto_tag): an image a
   * ReplicaSet still referenced when its release was pruned goes at a later cleanup. Nothing a kept
   * release or a workload of the cluster references is removed.
   */
  async collectGarbage(nodes: ClusterNodeRef[], removedReleaseImages: string[], keptReleaseImages: string[]): Promise<void> {
    const imported = (images: readonly string[]): string[] => images.map((image) => canonicalImageRef(toImportedRef(image))).filter(isRemovableRef);
    const kept = new Set(imported(keptReleaseImages));
    const explicit = new Set(imported(removedReleaseImages).filter((ref) => !kept.has(ref)));
    const swept = new Set(
      imported([...removedReleaseImages, ...keptReleaseImages])
        .map(repositoryOf)
        .filter((repository) => repository.endsWith(`-${this.target.env}`)),
    );
    if ((explicit.size === 0 && swept.size === 0) || nodes.length === 0) return;
    let inUse: Set<string>;
    try {
      inUse = await this.imagesInUse();
    } catch (error) {
      throw this.kubeFailure(error, 'list pods and workloads', false);
    }
    const removable = (ref: string): boolean =>
      isRemovableRef(ref) && !ref.includes('@') && !kept.has(ref) && !inUse.has(ref) && (explicit.has(ref) || swept.has(repositoryOf(ref)));
    const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, (node) => this.removeOnNode(node, removable, 'Image cleanup'));
    const failures = results.flatMap((result, i) =>
      result.status === 'rejected' ? [this.nodeError(nodes[i], 'Image cleanup', result.reason)] : [],
    );
    if (failures.length > 0) {
      throw new DeployError(failures.map((f) => f.message).join('; '), ErrorCode.DEPLOY_FAILED, failures[0].suggestion);
    }
  }

  async list(
    nodes: ClusterNodeRef[],
    options: { all: boolean },
  ): Promise<{ node: string; images: NodeImage[]; diskUsage: string | null }[]> {
    if (nodes.length === 0) return [];
    // "in use" as the listing shows it: a container of a pod runs it (design-06 3.6)
    let inUse: Set<string>;
    try {
      inUse = containerImagesOf(await this.deps.kubectl.getJson<unknown>(['pods'], { allNamespaces: true }));
    } catch (error) {
      throw this.kubeFailure(error, 'list pods', false);
    }
    const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, async (node) => {
      const shell = this.deps.nodeShell(node);
      const command = this.deps.distribution.listImagesCommands().byConfigDigest;
      let listed: RuntimeImage[] | null;
      try {
        const result = await shell.run(`sudo -n ${command}`, { guardS: NODE_READ_GUARD_S });
        if (result.exitCode !== 0) throw this.listFailure(node, this.failureDetail(command, result));
        listed = parseRuntimeImages(result.stdout);
      } catch (error) {
        if (error instanceof CLIError) throw error;
        throw new OrchestratorUnavailableError(`Listing images on ${node.name} failed: ${errorText(error)}`);
      }
      if (listed === null) {
        throw new OrchestratorUnavailableError(`Listing images on ${node.name} returned output that is not JSON`);
      }
      return { node: node.name, images: nodeImageRows(listed, inUse, options.all), diskUsage: await this.diskUsage(shell) };
    });
    return valuesOrThrow(results);
  }

  async prune(nodes: ClusterNodeRef[], options: { all: boolean }): Promise<{ node: string; reclaimed: string | null }[]> {
    // containerd keeps no dangling images, so the default prune has nothing to remove (DV-S4-2);
    // the runtime reports no reclaimed size either way
    if (!options.all) return nodes.map((node) => ({ node: node.name, reclaimed: null }));
    const command = this.deps.distribution.pruneImagesCommand();
    const results = await settleEach(nodes, K8S_IMAGE_IMPORT_CONCURRENCY, async (node): Promise<NodeFailureDetail | null> => {
      try {
        const result = await this.deps.nodeShell(node).run(`sudo -n ${command}`, { guardS: K8S_IMAGE_IMPORT_GUARD_S });
        return result.exitCode === 0 ? null : this.failureDetail(command, result);
      } catch (error) {
        return { detail: errorText(error), sudo: false };
      }
    });
    // every node is attempted; a failure on one must not read as a success on the others
    const failures = valuesOrThrow(results);
    const lines = failures.flatMap((failure, i) => (failure ? [`Image prune failed on ${nodes[i].name}: ${failure.detail}`] : []));
    if (lines.length > 0) {
      const sudo = failures.some((failure) => failure?.sudo === true);
      throw new DeployError(lines.join('; '), ErrorCode.DEPLOY_FAILED, sudo ? this.rerunSetup() : undefined);
    }
    return nodes.map((node) => ({ node: node.name, reclaimed: null }));
  }

  async pruneRuntime(
    _nodes: ClusterNodeRef[],
    target: 'containers' | 'volumes' | 'networks',
  ): Promise<{ node: string; reclaimed: string | null }[]> {
    const orchestrator = this.deps.distribution.traits.name;
    const env = this.target.env;
    switch (target) {
      case 'networks': {
        const refusal = capabilityRefusal('networkPrune', 'dockflow prune --networks');
        throw new UnsupportedOperationError(refusal.message, refusal.suggestion);
      }
      case 'volumes':
        throw new UnsupportedOperationError(
          `dockflow prune --volumes is not supported with orchestrator: ${orchestrator}: volumes are only deleted explicitly`,
          `List them with \`dockflow volumes list ${env}\`, then delete the ones you no longer need with \`dockflow volumes rm ${env} <name>\`.`,
        );
      case 'containers':
        throw new UnsupportedOperationError(
          `dockflow prune --containers is not supported with orchestrator: ${orchestrator}: the kubelet removes exited containers itself`,
          `Reclaim image space with \`dockflow prune ${env} --images --all\`.`,
        );
    }
  }

  // ---- node work ------------------------------------------------------------------------------

  private localEngine(): LocalEngine {
    if (this.local === null) this.local = createLocalEngine(detectLocalEngine(this.options.containerEngine));
    return this.local;
  }

  private async importOnNode(node: ClusterNodeRef, refs: readonly ImageRefs[], ids: ReadonlyMap<string, string>, engine: LocalEngine): Promise<void> {
    const shell = this.deps.nodeShell(node);
    const localId = (ref: string): string => ids.get(ref) ?? '';
    const before = await this.readIndex(shell, 'Image import');
    const missing = refs.filter((ref) => !isPresent(before, ref.imported, localId(ref.imported)));
    if (missing.length === 0) {
      this.events.info(alreadyPresentLine(node.name, refs.length));
      return;
    }
    // one stream per node: references sharing an image id travel together
    const imported = missing.map((ref) => ref.imported);
    await this.importStream(shell, imported, engine);
    const after = await this.readIndex(shell, 'Image import');
    for (const ref of imported) {
      if (!isPresent(after, ref, localId(ref))) {
        throw new DeployError(
          `Image import on ${node.name} did not produce ${ref} with id ${shortId(localId(ref))}`,
          ErrorCode.DEPLOY_FAILED,
          `Run \`dockflow list images ${this.target.env} --all\` to inspect ${node.name}, then deploy again.`,
        );
      }
    }
    this.events.info(importedLine(node.name, imported));
  }

  /** `docker save <refs> | gzip -1` into `gzip -dc | sudo -n <import>` on the node. */
  private async importStream(shell: NodeShell, refs: readonly string[], engine: LocalEngine): Promise<void> {
    const node = shell.node.name;
    const command = this.deps.distribution.importImagesCommand();
    const channel = await shell.channel(`gzip -dc | sudo -n ${command}`);
    const gzip = createGzip({ level: 1 });
    const save = engine.save(refs);
    save.on('error', (error) => gzip.destroy(error instanceof Error ? error : new Error(String(error))));
    save.pipe(gzip);
    try {
      const out = await guarded(
        this.deps.clock,
        K8S_IMAGE_IMPORT_GUARD_S,
        (signal) => driveChannel(channel, { stdin: gzip, signal }),
        () =>
          new DeployError(
            `Image import on ${node} did not finish within ${K8S_IMAGE_IMPORT_GUARD_S}s`,
            ErrorCode.DEPLOY_FAILED,
            `Check the connection to ${node} with \`dockflow ssh ${this.target.env}\`, then deploy again.`,
          ),
      );
      if (out.failure !== null) {
        const error = out.failure.error;
        throw error instanceof CLIError ? error : new DeployError(`Image import on ${node} failed: ${errorText(error)}`);
      }
      if (out.exitCode !== 0) {
        const result: KubectlResult = {
          exitCode: out.exitCode,
          stdout: '',
          stderr: this.deps.redactor.redact(out.stderr.toString('utf8')),
        };
        const failure = this.failureDetail(command, result);
        throw new DeployError(
          `Image import on ${node} failed: ${failure.detail}`,
          ErrorCode.DEPLOY_FAILED,
          failure.sudo ? this.rerunSetup() : undefined,
        );
      }
    } finally {
      // an abandoned stream must not keep the local save running
      save.destroy();
      gzip.destroy();
    }
  }

  /** N1 + N2 on one node. */
  private async readIndex(shell: NodeShell, what: string): Promise<NodeImageIndex> {
    const commands = this.deps.distribution.listImagesCommands();
    const runtime = await this.sudoRead(shell, commands.byConfigDigest, what);
    const images = parseRuntimeImages(runtime.stdout);
    if (images === null) {
      throw new DeployError(`${what} on ${shell.node.name} failed: the image listing is not JSON`, ErrorCode.DEPLOY_FAILED);
    }
    const store = await this.sudoRead(shell, commands.byTargetDigest, what);
    return nodeImageIndex(images, parseStoreImages(store.stdout));
  }

  private async sudoRead(shell: NodeShell, command: string, what: string): Promise<KubectlResult> {
    const result = await shell.run(`sudo -n ${command}`, { guardS: NODE_READ_GUARD_S });
    if (result.exitCode === 0) return result;
    const failure = this.failureDetail(command, result);
    throw new DeployError(
      `${what} on ${shell.node.name} failed: ${failure.detail}`,
      ErrorCode.DEPLOY_FAILED,
      failure.sudo ? this.rerunSetup() : undefined,
    );
  }

  /** Removes the (canonical) references the node holds that `select` picks; the distribution refuses anything but imported ones. */
  private async removeOnNode(node: ClusterNodeRef, select: (ref: string) => boolean, what: string): Promise<void> {
    const shell = this.deps.nodeShell(node);
    const index = await this.readIndex(shell, what);
    const present = [...index.byRef.keys()].filter(select).sort();
    if (present.length === 0) return;
    const command = this.deps.distribution.removeImagesCommand(present);
    const result = await shell.run(`sudo -n ${command}`, { guardS: NODE_READ_GUARD_S });
    if (result.exitCode !== 0) {
      const failure = this.failureDetail(command, result);
      throw new DeployError(
        `${what} on ${node.name} failed: ${failure.detail}`,
        ErrorCode.DEPLOY_FAILED,
        failure.sudo ? this.rerunSetup() : undefined,
      );
    }
  }

  /** Canonical references of every container image of the cluster (K44). */
  /** Every image a pod or a pod template of the cluster references (K44); `history: false` leaves out old revisions. */
  private async imagesInUse(options: { history: boolean } = { history: true }): Promise<Set<string>> {
    const resources = options.history ? IN_USE_RESOURCES : IN_USE_RESOURCES.filter((r) => !HISTORY_RESOURCES.has(r));
    const call = {
      ...getJsonCall(resources, { allNamespaces: true }),
      requestTimeoutS: IN_USE_TIMEOUT_S,
      guardS: IN_USE_TIMEOUT_S + K8S_GUARD_MARGIN_S,
    };
    const result = await this.deps.kubectl.run(call);
    let items: unknown[];
    try {
      items = parseJsonItems<unknown>(result.stdout);
    } catch {
      throw new DeployError('The cluster-wide pod listing returned output that is not JSON', ErrorCode.DEPLOY_FAILED);
    }
    return containerImagesOf(items);
  }

  /** Usage of the file system holding the image store; null when it cannot be read. */
  private async diskUsage(shell: NodeShell): Promise<string | null> {
    const root = this.deps.distribution.traits.imageStoreRoot;
    if (!SAFE_PATH.test(root)) return null;
    try {
      const result = await shell.run(`df -Pk ${root}`, { guardS: NODE_READ_GUARD_S });
      return result.exitCode === 0 ? parseDiskUsage(result.stdout) : null;
    } catch {
      return null;
    }
  }

  // ---- messages -------------------------------------------------------------------------------

  private rerunSetup(): string {
    return `Re-run \`dockflow setup ${this.deps.distribution.traits.name} ${this.target.env}\`.`;
  }

  /** A failed node command: the binary and subcommand sudo refused, else the first stderr lines. */
  private failureDetail(command: string, result: KubectlResult): NodeFailureDetail {
    if (isSudoRefusal(result.stderr)) {
      const head = command.split(' ').slice(0, 2).join(' ');
      return { detail: `sudo refused ${head} (the host was provisioned by an older Dockflow)`, sudo: true };
    }
    return { detail: stderrExcerpt(result.stderr) || `exit ${result.exitCode}`, sudo: false };
  }

  private listFailure(node: ClusterNodeRef, failure: NodeFailureDetail): OrchestratorUnavailableError {
    if (failure.sudo) {
      return new OrchestratorUnavailableError(`Listing images on ${node.name} needs the Dockflow sudo rules`, this.rerunSetup());
    }
    return new OrchestratorUnavailableError(`Listing images on ${node.name} failed: ${failure.detail}`);
  }

  private nodeError(node: ClusterNodeRef, what: string, reason: unknown): CLIError {
    if (reason instanceof CLIError) return reason;
    return new DeployError(`${what} on ${node.name} failed: ${errorText(reason)}`, ErrorCode.DEPLOY_FAILED);
  }

  private kubeFailure(error: unknown, operation: string, mutating: boolean): unknown {
    if (!(error instanceof KubeError)) return error;
    return kubeErrorToCliError(error, {
      env: this.target.env,
      operation,
      mutating,
      distribution: this.deps.distribution.traits.name,
    });
  }
}

/** One row per tag; untagged images only with `all`, under their digest or id. */
function nodeImageRows(images: readonly RuntimeImage[], inUse: ReadonlySet<string>, all: boolean): NodeImage[] {
  const rows: NodeImage[] = [];
  for (const image of images) {
    const used = [...image.repoTags, ...image.repoDigests].some((ref) => inUse.has(canonicalImageRef(ref)));
    const refs = image.repoTags.length > 0 ? image.repoTags : all ? [image.repoDigests[0] ?? image.id] : [];
    for (const ref of refs) rows.push({ ref, id: image.id, sizeBytes: image.sizeBytes, inUse: used });
  }
  return rows.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
