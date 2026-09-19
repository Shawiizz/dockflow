/**
 * Release flows shared by both orchestrators (DESIGN-CORE 6.8, design-03 12.5 and 16): the
 * full-stack rollback, the cleanup of old releases, and the pure selections they and the stores
 * rely on. Where releases live is the ReleaseStore's business (files on Swarm, Secrets on k3s).
 */

import { parse, parseAllDocuments } from 'yaml';
import { DeployError, ErrorCode } from '../utils/errors';
import { printDebug, printDim, printInfo, printWarning } from '../utils/output';
import type {
  ApplyOptions,
  ClusterNodeRef,
  Orchestrator,
  ReleaseMetadata,
  RevertResult,
  StackArtifact,
  StackRef,
  WaitOptions,
} from './orchestrator/interfaces';
import { K8S_IMPORTED_IMAGE_REGISTRY } from './orchestrator/kubernetes/constants';

export interface RollbackReleaseArgs {
  ref: StackRef;
  stackName: string;
  /** explicit target; null picks the release before current (or the newest other than the failed one) */
  to: string | null;
  /** the version whose deploy failed; its record is removed once the rollback converged */
  failedVersion: string | null;
  wait: WaitOptions;
  /** `dockflow rollback --allow-chart-drift`; the automatic rollback of `on_failure: rollback` never sets it */
  allowChartDrift?: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** newest first: epoch descending, then version descending (the ReleaseStore.list order) */
function newestFirst(list: readonly ReleaseMetadata[]): ReleaseMetadata[] {
  return [...list].sort((a, b) => b.epoch - a.epoch || compareText(b.version, a.version));
}

/** The newest `keep` releases by epoch, plus current when it is older; everything else is removed. */
export function selectRetention(
  list: readonly ReleaseMetadata[],
  current: string | null,
  keep: number,
): { kept: ReleaseMetadata[]; removed: ReleaseMetadata[] } {
  const sorted = newestFirst(list);
  const kept = sorted.slice(0, Math.max(0, keep));
  if (current !== null && !kept.some((r) => r.version === current)) {
    const currentRelease = sorted.find((r) => r.version === current);
    if (currentRelease) kept.push(currentRelease);
  }
  const keptVersions = new Set(kept.map((r) => r.version));
  return { kept, removed: sorted.filter((r) => !keptVersions.has(r.version)) };
}

/**
 * The newest release strictly older than current. With the failed version known, the newest
 * release other than it. Without a current record, the newest is skipped (it is what runs).
 */
export function selectRollbackTarget(
  list: readonly ReleaseMetadata[],
  current: string | null,
  failedVersion: string | null,
): ReleaseMetadata | null {
  const sorted = newestFirst(list);
  if (failedVersion !== null) return sorted.find((r) => r.version !== failedVersion) ?? null;
  const index = sorted.findIndex((r) => r.version === current);
  return index === -1 ? (sorted[1] ?? null) : (sorted[index + 1] ?? null);
}

/** Image references of a stored compose, in service order, without duplicates; [] when unreadable. */
export function composeImages(compose: string | null): string[] {
  if (compose === null || compose.trim() === '') return [];
  let doc: unknown;
  try {
    doc = parse(compose, { merge: true });
  } catch {
    return [];
  }
  const services = isRecord(doc) ? doc.services : undefined;
  if (!isRecord(services)) return [];
  const images: string[] = [];
  for (const service of Object.values(services)) {
    const image = isRecord(service) ? service.image : undefined;
    if (typeof image === 'string' && image !== '' && !images.includes(image)) images.push(image);
  }
  return images;
}

/**
 * Image references of an artifact that Dockflow streamed into the node runtimes (import mode).
 * Registry and public images are pulled by the nodes and need no presence check.
 */
export function importedImages(content: string): string[] {
  const prefix = `${K8S_IMPORTED_IMAGE_REGISTRY}/`;
  const found = new Set<string>();
  // an unreadable document is refused by the backend's apply, which parses the same content
  for (const doc of parseAllDocuments(content)) {
    if (doc.errors.length > 0) continue;
    try {
      collectContainerImages(doc.toJS(), found);
    } catch {}
  }
  return [...found].filter((ref) => ref.startsWith(prefix));
}

const CONTAINER_LISTS = new Set(['containers', 'initContainers']);

/** container images wherever a pod template sits (Deployment, StatefulSet, DaemonSet, Job); never ConfigMap data */
function collectContainerImages(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectContainerImages(item, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (!CONTAINER_LISTS.has(key) || !Array.isArray(child)) {
      collectContainerImages(child, into);
      continue;
    }
    for (const container of child) {
      if (isRecord(container) && typeof container.image === 'string') into.add(container.image);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this revert prove the app role runs what `previousVersion` describes again (design-03 3.4,
 * PD-8)? Only then may the failed version's record be rewound.
 */
export function settles(r: RevertResult, previousVersion: string | null, nativeRolledBack: boolean): boolean {
  if (r.status === 'native') return nativeRolledBack;
  if (r.status === 'reverted') return true;
  // a first deploy leaves its workloads for debugging, but there is no earlier state to describe
  return r.status === 'nothing-to-revert' && previousVersion === null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeNodes(orchestrator: Orchestrator): ClusterNodeRef[] {
  return [...orchestrator.target.managers, ...orchestrator.target.workers];
}

// ---------------------------------------------------------------------------
// Full-stack rollback (design-03 16.1)
// ---------------------------------------------------------------------------

/**
 * Applies a stored release with prune on, waits for it, then makes it current and drops the failed
 * record. Returns the version rolled back to. On Kubernetes the backend's `apply` feeds its Redactor
 * from the artifact's Secrets and resolves Helm credentials from the current config (design-03 16.2).
 */
export async function rollbackRelease(orchestrator: Orchestrator, args: RollbackReleaseArgs): Promise<string> {
  const { releases, stack, capabilities } = orchestrator;
  const [list, current] = await Promise.all([releases.list(args.stackName), releases.current(args.stackName)]);
  const target = args.to ?? selectRollbackTarget(list, current?.version ?? null, args.failedVersion)?.version ?? null;
  if (target === null) {
    throw new DeployError('No previous release available for rollback', ErrorCode.ROLLBACK_FAILED);
  }
  if (target === args.failedVersion) {
    throw new DeployError(
      `Release ${target} is the failed release; nothing distinct to roll back to`,
      ErrorCode.ROLLBACK_FAILED,
    );
  }

  printInfo(`Rolling back to ${target}...`);
  const artifact = await releases.readArtifact(args.stackName, target);
  if (artifact.format !== capabilities.artifactFormat) {
    throw new DeployError(
      `Release ${target} was produced for ${artifact.format} and cannot be applied with orchestrator: ${orchestrator.kind}`,
      ErrorCode.ROLLBACK_FAILED,
    );
  }
  await assertImagesPresent(orchestrator, target, artifact, args.ref.env);

  const options: ApplyOptions = { prune: true, services: null };
  if (args.allowChartDrift === true) options.allowChartDrift = true;
  const applied = await stack.apply(args.ref, target, artifact, options);
  if (!applied.success) {
    throw new DeployError(applied.error.message, ErrorCode.ROLLBACK_FAILED, applied.error.suggestion);
  }
  const receipt = applied.data;

  const convergence = await stack.waitConvergence(receipt, args.wait);
  if (convergence.status !== 'converged') {
    const detail = convergence.message ?? convergence.failures[0]?.message ?? convergence.status;
    throw new DeployError(
      `Rollback to ${target} did not converge: ${detail}`,
      ErrorCode.ROLLBACK_FAILED,
      `Run \`dockflow diagnose ${args.ref.env}\`.`,
    );
  }

  // prunes what the rolled-back-from version added; finalize never throws, but a converged rollback
  // must reach setCurrent whatever happens here
  try {
    await stack.finalize(receipt);
  } catch (error) {
    printWarning(`Cleanup after rollback failed: ${errorText(error)}; the rollback itself succeeded`);
  }
  await releases.setCurrent(args.stackName, target);
  if (args.failedVersion !== null) {
    const failed = args.failedVersion;
    await releases
      .remove(args.stackName, failed)
      .catch((error) => printWarning(`Could not remove failed release ${failed}: ${errorText(error)}`));
  }
  await warnAccessoriesNotRolledBack(orchestrator, args, target, list);
  return target;
}

/**
 * A node that never received the release's imported images (added or re-provisioned since) would
 * leave the rollback in ImagePullBackOff; refuse before anything is touched (design-03 16.2, K45).
 */
async function assertImagesPresent(
  orchestrator: Orchestrator,
  version: string,
  artifact: StackArtifact,
  env: string,
): Promise<void> {
  const refs = importedImages(artifact.content);
  if (refs.length === 0) return;
  const report = await orchestrator.images.verifyPresence(refs, activeNodes(orchestrator));
  const missingRefs = report.flatMap((entry) => entry.missing);
  const ref = refs.find((r) => missingRefs.includes(r)) ?? missingRefs[0];
  if (ref === undefined) return;
  const nodes = report.filter((entry) => entry.missing.includes(ref)).map((entry) => entry.node);
  throw new DeployError(
    `Release ${version} cannot be applied: image ${ref} is missing on ${nodes.join(', ')}`,
    ErrorCode.ROLLBACK_FAILED,
    `Re-deploy that version with \`dockflow deploy ${env} ${version}\`, or remove the affected node(s) from servers.yml.`,
  );
}

/**
 * Releases record the app role only, so the accessories keep what was deployed last (design-03
 * 16.3, DV-S2-4). Said only when both digests are known and differ.
 */
async function warnAccessoriesNotRolledBack(
  orchestrator: Orchestrator,
  args: RollbackReleaseArgs,
  target: string,
  list: readonly ReleaseMetadata[],
): Promise<void> {
  try {
    const recorded = list.find((r) => r.version === target)?.accessories_digest ?? null;
    if (recorded === null) return;
    const state = await orchestrator.releases.readState(args.stackName);
    if (state.accessoriesDigest === null || state.accessoriesDigest === recorded) return;
    const accessories = await orchestrator.stack.getServices({ ...args.ref, role: 'accessory' });
    printWarning(
      `Accessories were not rolled back; ${accessories.length} accessory service(s) still run the definition deployed after ${target}`,
    );
    printDim(
      `  Restore them by checking out the accessories.yml of ${target} and running \`dockflow deploy ${args.ref.env} --accessories\`.`,
    );
  } catch (error) {
    printDebug(`Accessories check after the rollback was skipped: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Release cleanup (design-03 12.5)
// ---------------------------------------------------------------------------

/**
 * Removes releases beyond `keep`, then the images only they used. The composes of the releases to
 * drop are read before `prune`, which deletes them (I-6). Failures are warnings: the deploy is done.
 */
export async function cleanupReleases(orchestrator: Orchestrator, stackName: string, keep: number): Promise<void> {
  try {
    const { releases } = orchestrator;
    const [list, current] = await Promise.all([releases.list(stackName), releases.current(stackName)]);
    const { kept, removed } = selectRetention(list, current?.version ?? null, keep);
    if (removed.length === 0) return;
    const read = (version: string): Promise<string | null> => releases.readCompose(stackName, version).catch(() => null);
    const removedCompose = await Promise.all(removed.map((r) => read(r.version)));
    const keptCompose = await Promise.all(kept.map((r) => read(r.version)));

    const actuallyRemoved = await releases.prune(stackName, keep);
    if (actuallyRemoved.length === 0) return;
    const removedVersions = new Set(actuallyRemoved.map((r) => r.version));
    const removedImages = unique(
      removed.flatMap((r, i) => (removedVersions.has(r.version) ? composeImages(removedCompose[i] ?? null) : [])),
    );
    const keptImages = unique(keptCompose.flatMap((compose) => composeImages(compose)));
    await orchestrator.images.collectGarbage(activeNodes(orchestrator), removedImages, keptImages);
    printInfo(`Cleaned up ${actuallyRemoved.length} old release(s)`);
  } catch (error) {
    printWarning(`Release cleanup failed: ${errorText(error)}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
