// State of a DeployReceipt that revert and finalize need but callers must not see (design-03 2.3).
// The stack backend keeps it keyed by receipt identity; receipts never cross process boundaries.
// `stateFor` is the only constructor and fills every field (K18): revert tests `previous === null`
// and `targets === null`, which a field left undefined silently fails.
// Pure: no I/O, no clock (the default snapshots are stamped with the `now` the caller passes).

import type { HelmReleaseRecord, ResolvedHelmRelease, StackRef } from '../../interfaces';
import type { DisruptiveSwitch } from '../apply/pre-apply';
import type { FailureAction, PreviousRelease } from '../apply/revert-plan';
import { emptySnapshot, isWorkload, type LbWatchTarget, podSpecOf, type Snapshot } from '../apply/snapshot';
import type { ManifestObject } from '../resources/registry';

export type ReceiptOrigin = 'deploy' | 'apply' | 'revert';

export interface ReceiptState {
  origin: ReceiptOrigin;
  ref: StackRef;
  namespace: string;
  /** full render (deploy) or full stored artifact (apply) */
  objects: ManifestObject[];
  /** what was actually sent to the API server (closure under --only / rollback <service>) */
  applied: ManifestObject[];
  /** compose names; null = whole role */
  targets: string[] | null;
  /** finalize prunes and collects hashed objects */
  prune: boolean;
  before: Snapshot;
  after: Snapshot;
  /** role app deploys only */
  previous: PreviousRelease | null;
  /** from the canonical stack; {} for apply/revert receipts */
  failureActions: Record<string, FailureAction>;
  /** Helm releases of the role as resolved for this deploy (auth included, never persisted) */
  helmInputs: ResolvedHelmRelease[];
  /** names of every release of the role declared in config.yml; what finalize compares live releases against */
  helmDeclared: string[];
  /** Helm releases actually upgraded by this receipt, with the record they replaced */
  helmApplied: { release: HelmReleaseRecord; replaced: HelmReleaseRecord | null }[];
  pullSecretName: string | null;
  /** compose names whose live workload was deleted before the apply (kind switch, failed Job) */
  disruptive: DisruptiveSwitch[];
  /** `-lb` Services this receipt changed; waited on by waitConvergence (K19) */
  lbWatch: LbWatchTarget[];
}

/**
 * What the enclosing call always passes, and every field it may set. A field that is absent, or
 * explicitly undefined, gets the default of design-03 2.3.
 */
export type ReceiptStateInit = Pick<ReceiptState, 'ref' | 'namespace' | 'objects'> &
  Partial<Omit<ReceiptState, 'ref' | 'namespace' | 'objects'>> & {
    /** stamps the default `before` and `after` snapshots */
    now: Date;
  };

/** The registry Secret the stored pod templates pull with, if any (apply receipts, design-03 16.2). */
export function pullSecretOf(objects: readonly ManifestObject[]): string | null {
  for (const object of objects) {
    if (!isWorkload(object)) continue;
    const name = podSpecOf(object).imagePullSecrets?.find((s) => s.name)?.name;
    if (name) return name;
  }
  return null;
}

export function stateFor(init: ReceiptStateInit): ReceiptState {
  const helmInputs = init.helmInputs ?? [];
  return {
    origin: init.origin ?? 'deploy',
    ref: init.ref,
    namespace: init.namespace,
    objects: init.objects,
    applied: init.applied ?? [],
    targets: init.targets ?? null,
    prune: init.prune ?? false,
    before: init.before ?? emptySnapshot(new Date(init.now.getTime())),
    after: init.after ?? emptySnapshot(new Date(init.now.getTime())),
    previous: init.previous ?? null,
    failureActions: init.failureActions ?? {},
    helmInputs,
    helmDeclared: init.helmDeclared ?? helmInputs.map((h) => h.name),
    helmApplied: init.helmApplied ?? [],
    pullSecretName: init.pullSecretName === undefined ? pullSecretOf(init.objects) : init.pullSecretName,
    disruptive: init.disruptive ?? [],
    lbWatch: init.lbWatch ?? [],
  };
}
