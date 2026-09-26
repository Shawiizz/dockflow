// LeaseLockStore (DESIGN-CORE 6.7, design-03 14): the deploy lock as a coordination.k8s.io Lease in
// `dockflow-system`, the one algorithm this section fixes precisely because it must be correct under
// concurrency. `create -o json` keeps the held identity (uid, resourceVersion); a stale takeover is
// `replace` carrying that resourceVersion, so two deployers racing the same stale lock cannot both
// win (the loser's replace fails with Conflict); release is a conditional delete over `--raw` with
// `DeleteOptions.preconditions`. The lock is renewed while held (K73), because a one-shot Lease and
// a slow deploy (large image imports, a long convergence wait) would otherwise let a second deploy
// take the lock out from under the first one before it finishes.

import { LOCK_STALE_THRESHOLD_MINUTES } from '../../../../constants';
import { OrchestratorUnavailableError } from '../../../../utils/errors';
import { printDebug, printWarning } from '../../../../utils/output';
import { err, ok, type Result } from '../../../../types/result';
import type { LockData, LockStatus, LockStore } from '../../interfaces';
import { ANNOTATIONS, K8S_LEASE_RENEW_INTERVAL_S, K8S_SYSTEM_NAMESPACE } from '../constants';
import type { KubernetesBundleDeps } from '../deps';
import { leaseLabels } from '../labels';
import { leaseNameFor } from '../naming';
import type { Lease } from '../resources/coordination';
import { classifyKubectlFailure, KubeError, type KubeErrorReason, kubeErrorToCliError } from '../runtime/errors';
import { emitObject } from '../yaml';

// ---------------------------------------------------------------------------
// Pure helpers (14.2, exported for tests)
// ---------------------------------------------------------------------------

/** RFC3339 with exactly six fractional digits, the MicroTime layout the API server expects. */
export function formatMicroTime(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export interface LeaseWriteOptions {
  /** the currently stored Lease, when this write targets an existing object (a takeover or a renewal) */
  existing?: Lease;
  /** true: a renewal (keeps acquireTime and leaseTransitions); false/absent: a takeover (leaseTransitions + 1) */
  renew?: boolean;
}

/**
 * The Lease object of an acquire, takeover or renewal, as YAML. A fresh create (no `existing`)
 * carries no `resourceVersion` and no `leaseTransitions`; a takeover carries the read
 * `resourceVersion` and increments `leaseTransitions`; a renewal carries the held `resourceVersion`
 * and keeps `acquireTime`/`leaseTransitions` exactly as they were, moving only `renewTime` and the
 * annotation's `started_at`/`timestamp` (through `data`).
 */
export function leaseYaml(stackId: string, data: LockData, now: Date, staleThresholdMinutes: number, options: LeaseWriteOptions = {}): string {
  const { existing, renew } = options;
  const microTime = formatMicroTime(now);
  const acquireTime = renew ? (existing?.spec?.acquireTime ?? microTime) : microTime;
  const leaseTransitions = existing === undefined ? undefined : renew ? existing.spec?.leaseTransitions : (existing.spec?.leaseTransitions ?? 0) + 1;
  const lease: Lease = {
    apiVersion: 'coordination.k8s.io/v1',
    kind: 'Lease',
    metadata: {
      name: leaseNameFor(stackId),
      namespace: K8S_SYSTEM_NAMESPACE,
      labels: leaseLabels(stackId),
      annotations: { [ANNOTATIONS.lock]: JSON.stringify(data) },
      ...(existing?.metadata.resourceVersion !== undefined ? { resourceVersion: existing.metadata.resourceVersion } : {}),
    },
    spec: {
      holderIdentity: data.performer,
      leaseDurationSeconds: staleThresholdMinutes * 60,
      acquireTime,
      renewTime: microTime,
      ...(leaseTransitions !== undefined ? { leaseTransitions } : {}),
    },
  };
  return emitObject(lease);
}

/** null when the annotation is missing, not JSON, or missing the fields staleness needs. */
export function parseLockData(lease: Lease): LockData | null {
  const raw = lease.metadata.annotations?.[ANNOTATIONS.lock];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const data = parsed as LockData;
  if (typeof data.performer !== 'string' || typeof data.started_at !== 'string') return null;
  return data;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface LeaseLockStoreDeps extends Pick<KubernetesBundleDeps, 'kubectl' | 'distribution' | 'clock'> {
  performer: string;
  env: string;
}

export class LeaseLockStore implements LockStore {
  /** set by a successful acquire; used for the conditional release and the renewal loop */
  private held: { lease: Lease; data: LockData } | null = null;
  /**
   * True once this process held the lock and a renewal discovered a takeover (Conflict/NotFound).
   * `release()` then does nothing: the Lease is the new holder's, not this process's to delete, and
   * this differs from `held === null` because it never held (a fresh `dockflow lock release`),
   * which still runs the documented manual, unconditional delete.
   */
  private lostLock = false;
  private renewing: Promise<void> | null = null;
  /** the renewal request on the wire, resolving to its Lease (null when it failed); null between renewals */
  private renewalInFlight: Promise<Lease | null> | null = null;

  constructor(
    private readonly deps: LeaseLockStoreDeps,
    private readonly stackName: string,
    private readonly stackId: string,
    private readonly staleThresholdMinutes: number = LOCK_STALE_THRESHOLD_MINUTES,
  ) {}

  async status(): Promise<Result<LockStatus, Error>> {
    try {
      const lease = await this.get();
      if (!lease) return ok({ locked: false });
      const data = parseLockData(lease);
      if (!data) return ok({ locked: true, isStale: true });
      const durationMinutes = this.minutesSince(data.started_at);
      return ok({ locked: true, data, durationMinutes, isStale: durationMinutes > this.staleThresholdMinutes });
    } catch (error) {
      return err(this.toLockError(error));
    }
  }

  async acquire(options?: { message?: string; force?: boolean; version?: string }): Promise<Result<LockData, Error>> {
    try {
      const now = this.deps.clock.now();
      const data: LockData = {
        performer: this.deps.performer,
        started_at: now.toISOString(),
        timestamp: Math.floor(now.getTime() / 1000),
        version: options?.version || 'manual-lock',
        stack: this.stackName,
        message: options?.message || 'Manual lock via CLI',
      };

      if (options?.force) {
        const existing = await this.get();
        const lease = existing ? await this.forceReplace(data, now, existing) : await this.forceCreate(data, now);
        this.hold(lease, data);
        return ok(data);
      }

      const created = await this.createOrNull(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes));
      if (created) {
        this.hold(created, data);
        return ok(data);
      }

      const existing = await this.get();
      if (!existing) {
        // released between the create attempt and the read: one more attempt before blaming permissions
        const retry = await this.createOrNull(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes));
        if (retry) {
          this.hold(retry, data);
          return ok(data);
        }
        return err(new Error('Lock was stale but another deploy acquired it first'));
      }

      const currentData = parseLockData(existing);
      const minutes = currentData ? this.minutesSince(currentData.started_at) : Number.POSITIVE_INFINITY;
      if (currentData && minutes <= this.staleThresholdMinutes) {
        return err(new Error(`Already locked by ${currentData.performer} (${minutes} min ago)`));
      }
      try {
        const lease = await this.replace(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes, { existing }));
        this.hold(lease, data);
        return ok(data);
      } catch (error) {
        if (this.isReason(error, 'Conflict') || this.isReason(error, 'NotFound')) {
          return err(new Error('Lock was stale but another deploy acquired it first'));
        }
        throw error;
      }
    } catch (error) {
      return err(this.toLockError(error));
    }
  }

  async release(): Promise<Result<void, Error>> {
    try {
      const held = this.held;
      if (held) {
        // Stop the renewal loop first, then let a renewal it already sent land: that renewal moves
        // the resourceVersion, and a delete conditioned on the older one would fail and leave the
        // Lease behind, no longer renewed.
        this.held = null;
        const holding = (await this.renewalInFlight) ?? held.lease;
        const body = JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: holding.metadata.uid, resourceVersion: holding.metadata.resourceVersion },
        });
        const result = await this.deps.kubectl.run({
          args: ['delete', `--raw=/apis/coordination.k8s.io/v1/namespaces/${K8S_SYSTEM_NAMESPACE}/leases/${leaseNameFor(this.stackId)}`, '-f', '-'],
          stdin: body,
          mutating: true,
          allowFailure: true,
        });
        const reason = result.exitCode === 0 ? null : classifyKubectlFailure(result.exitCode, result.stderr);
        if (reason === null || reason === 'NotFound') return ok(undefined);
        if (reason === 'Conflict') {
          const current = await this.status();
          const holder = current.success && current.data.data ? current.data.data.performer : 'another deploy';
          return err(new Error(`Lock for ${this.stackName} is now held by ${holder}; it was not released`));
        }
        throw new KubeError(reason, 'Lease release failed', this.deps.kubectl.node.name, result.exitCode, result.stderr);
      }
      if (this.lostLock) {
        this.lostLock = false;
        return ok(undefined); // already gone; the Lease now belongs to whoever took it over
      }
      // no held identity (a fresh `dockflow lock release`): the documented manual escape hatch
      await this.deps.kubectl.delete([`leases.coordination.k8s.io/${leaseNameFor(this.stackId)}`], {
        namespace: K8S_SYSTEM_NAMESPACE,
        wait: false,
        ignoreNotFound: true,
      });
      return ok(undefined);
    } catch (error) {
      return err(this.toLockError(error));
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  private minutesSince(iso: string): number {
    return Math.floor((this.deps.clock.now().getTime() - Date.parse(iso)) / 60000);
  }

  private async get(): Promise<Lease | undefined> {
    const [lease] = await this.deps.kubectl.getJson<Lease>(['leases.coordination.k8s.io'], {
      namespace: K8S_SYSTEM_NAMESPACE,
      name: leaseNameFor(this.stackId),
      allowNotFound: true,
    });
    return lease;
  }

  /** `create -f - -o json`; `AlreadyExists` -> null; a missing `dockflow-system` -> `OrchestratorUnavailableError`. */
  private async createOrNull(yaml: string): Promise<Lease | null> {
    try {
      const result = await this.deps.kubectl.create<Lease>(yaml, { namespace: K8S_SYSTEM_NAMESPACE, json: true });
      return result.result === 'exists' ? null : result.object;
    } catch (error) {
      if (error instanceof KubeError && /namespaces\s+"[^"]*"\s+not found/i.test(error.stderr)) {
        throw new OrchestratorUnavailableError(
          `Namespace ${K8S_SYSTEM_NAMESPACE} is missing on ${this.deps.kubectl.node.name}`,
          `Re-run \`dockflow setup ${this.deps.distribution.traits.name} ${this.deps.env}\`.`,
        );
      }
      throw error;
    }
  }

  /** `replace -f - -o json`: the YAML carries `metadata.resourceVersion`, so a changed object fails with `(Conflict)`. */
  private replace(yaml: string): Promise<Lease> {
    return this.deps.kubectl.replace<Lease>(yaml, { namespace: K8S_SYSTEM_NAMESPACE });
  }

  private async forceCreate(data: LockData, now: Date): Promise<Lease> {
    const created = await this.createOrNull(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes));
    if (created) return created;
    // lost the race to another acquirer between the read and the create: one more read, then take over
    const current = await this.get();
    if (!current) throw new Error(`Lock for ${this.stackName} could not be forced: the lease disappeared and reappeared during the takeover`);
    return this.replace(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes, { existing: current }));
  }

  private async forceReplace(data: LockData, now: Date, existing: Lease): Promise<Lease> {
    try {
      return await this.replace(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes, { existing }));
    } catch (error) {
      if (!this.isReason(error, 'Conflict')) throw error;
      const current = await this.get();
      if (!current) return this.forceCreate(data, now);
      return this.replace(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes, { existing: current }));
    }
  }

  /** stores the held identity and starts the renewal loop on the first hold; a renewal only refreshes it. */
  private hold(lease: Lease, data: LockData): void {
    const first = this.held === null;
    this.held = { lease, data };
    this.lostLock = false;
    if (first) this.startRenewal();
  }

  private startRenewal(): void {
    this.renewing = (async () => {
      while (this.held) {
        await this.deps.clock.sleep(K8S_LEASE_RENEW_INTERVAL_S * 1000);
        if (!this.held) return;
        const now = this.deps.clock.now();
        const data: LockData = { ...this.held.data, started_at: now.toISOString(), timestamp: Math.floor(now.getTime() / 1000) };
        const attempt = this.replace(leaseYaml(this.stackId, data, now, this.staleThresholdMinutes, { existing: this.held.lease, renew: true }));
        this.renewalInFlight = attempt.then(
          (lease) => lease,
          () => null,
        );
        try {
          const lease = await attempt;
          if (!this.held) return; // released meanwhile: release() deletes this renewed Lease
          this.hold(lease, data); // new resourceVersion for the conditional release
        } catch (error) {
          if (!this.held) return;
          if (this.isReason(error, 'Conflict') || this.isReason(error, 'NotFound')) {
            this.held = null; // someone forced a takeover
            this.lostLock = true;
            printWarning(`Lock for ${this.stackName} was taken over by another deploy; this run no longer holds it`);
            return;
          }
          printDebug(`Lock renewal failed: ${errorText(error)}`); // transient: try again next tick
        } finally {
          this.renewalInFlight = null;
        }
      }
    })();
    this.renewing.catch(() => {});
  }

  private isReason(error: unknown, reason: KubeErrorReason): boolean {
    return error instanceof KubeError && error.reason === reason;
  }

  private toLockError(error: unknown): Error {
    if (error instanceof KubeError) {
      return kubeErrorToCliError(error, { env: this.deps.env, operation: 'lock', mutating: true, distribution: this.deps.distribution.traits.name });
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
