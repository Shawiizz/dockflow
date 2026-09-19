// ClusterReleaseStore (DESIGN-CORE 6.7, design-03 13): release history kept as immutable Secrets in
// the stack namespace, plus the `dockflow-state` ConfigMap two field managers share (RoleStateStore).
// `list` never reads a release's payload (PD-7): only `readArtifact`/`readCompose` do. A same-version
// redeploy keeps the replaced Secret as an in-cluster backup until the new one is safely written
// (design-03 13.4, K44), so a CLI killed mid-redeploy never leaves the running version unreadable.

import { gunzipSync, gzipSync } from 'zlib';
import { DeployError, ErrorCode } from '../../../../utils/errors';
import { canonicalJson } from '../../../../utils/hash';
import { printDebug, printWarning } from '../../../../utils/output';
import type { HelmReleaseRecord, ReleaseInput, ReleaseMetadata, ReleaseStore, StackArtifact, StackRef } from '../../interfaces';
import type { ApplyEngine } from '../apply/engine';
import type { KubernetesBundleDeps } from '../deps';
import {
  ANNOTATIONS,
  K8S_FIELD_MANAGER_ACCESSORIES_STATE,
  K8S_FIELD_MANAGER_RELEASE_STATE,
  K8S_RELEASE_BACKUP_SUFFIX,
  K8S_RELEASE_MAX_BYTES,
  K8S_RELEASE_SECRET_TYPE,
  K8S_STATE_CONFIGMAP,
  LABELS,
  PARTS,
} from '../constants';
import { releaseSecretLabels, SEL_RELEASE, SEL_RELEASE_BACKUP, stateConfigMapLabels } from '../labels';
import { namespaceFor, releaseSecretName } from '../naming';
import type { ConfigMap, Secret } from '../resources/core';
import { KubeError, kubeErrorToCliError } from '../runtime/errors';
import { artifactDigest, emitObject, readArtifactFormat } from '../yaml';

/** the two namespace operations the stores reuse instead of re-implementing (P41). */
export type NamespaceGuard = Pick<ApplyEngine, 'ensureNamespace' | 'assertNamespaceOwner'>;

/** cwd of remote hooks (13.3): never `/tmp`, which is world-writable and would hold a hook's cluster-admin KUBECONFIG. */
const HOOK_WORKING_DIR_ROOT = '/var/lib/dockflow/hooks';
/** prefix of `releaseSecretName` (naming.ts): a release backup carries no `P/release` when it predates that annotation */
const RELEASE_SECRET_PREFIX = 'dockflow-release-';

// ---------------------------------------------------------------------------
// Pure helpers (13.2, exported for tests)
// ---------------------------------------------------------------------------

export const RELEASE_KEYS = {
  metadata: 'metadata.json',
  compose: 'compose.yml.gz',
  stack: 'stack.yml.gz',
  helm: 'helm.json.gz',
} as const;

/** the K48 listing template (PD-7): name, `P/release` and the base64 of `metadata.json` only */
export const RELEASE_LIST_TEMPLATE = `go-template={{range .items}}{{.metadata.name}} {{index .metadata.annotations "${ANNOTATIONS.release}"}} {{index .data "${RELEASE_KEYS.metadata}"}}{{"\\n"}}{{end}}`;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatKiB(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

function gzipUtf8(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
}

function gunzipText(base64: string | undefined): string | null {
  if (base64 === undefined) return null;
  return gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
}

/** Builds the release Secret and checks the decoded (post-compression) payload before any mutation. */
export function buildReleaseSecret(ref: Pick<StackRef, 'project' | 'env'>, release: ReleaseInput): { yaml: string; decodedBytes: number } {
  const namespace = namespaceFor(ref.project, ref.env);
  const metadataBytes = Buffer.from(JSON.stringify(release.metadata), 'utf8');
  const composeBytes = gzipUtf8(release.compose);
  const stackBytes = gzipUtf8(release.artifact.content);
  const helmBytes = gzipUtf8(canonicalJson(release.artifact.helm));
  const decodedBytes = metadataBytes.length + composeBytes.length + stackBytes.length + helmBytes.length;
  if (decodedBytes > K8S_RELEASE_MAX_BYTES) {
    throw new DeployError(
      `Release ${release.version} is ${formatKiB(decodedBytes)} after compression; Kubernetes Secrets are limited to 1 MiB`,
      ErrorCode.DEPLOY_FAILED,
      'Move large files out of `env_file`, `secrets` and `configs` (use uploads), then deploy again.',
    );
  }
  const secret: Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: releaseSecretName(release.version),
      namespace,
      labels: releaseSecretLabels({ project: ref.project, namespace }, release.version),
      annotations: { [ANNOTATIONS.release]: release.version, [ANNOTATIONS.epoch]: String(release.metadata.epoch) },
    },
    type: K8S_RELEASE_SECRET_TYPE,
    immutable: true,
    data: {
      [RELEASE_KEYS.metadata]: metadataBytes.toString('base64'),
      [RELEASE_KEYS.compose]: composeBytes.toString('base64'),
      [RELEASE_KEYS.stack]: stackBytes.toString('base64'),
      [RELEASE_KEYS.helm]: helmBytes.toString('base64'),
    },
  };
  return { yaml: emitObject(secret), decodedBytes };
}

/** null on missing/invalid JSON or a version that does not match the `P/release` annotation. */
export function decodeReleaseMetadata(secret: Secret): ReleaseMetadata | null {
  const raw = secret.data?.[RELEASE_KEYS.metadata];
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const metadata = parsed as ReleaseMetadata;
  if (typeof metadata.version !== 'string' || metadata.version === '') return null;
  if (metadata.version !== secret.metadata.annotations?.[ANNOTATIONS.release]) return null;
  return metadata;
}

/** gunzip, format detection, digest recomputed over the decoded content (never trusted from storage). */
export function decodeReleaseArtifact(secret: Secret): StackArtifact {
  const version = secret.metadata.annotations?.[ANNOTATIONS.release] ?? secret.metadata.name;
  try {
    const content = gunzipText(secret.data?.[RELEASE_KEYS.stack]) ?? '';
    const helmText = gunzipText(secret.data?.[RELEASE_KEYS.helm]);
    const helm = (helmText !== null ? (JSON.parse(helmText) as unknown) : []) as HelmReleaseRecord[];
    if (!Array.isArray(helm)) throw new Error('helm records are not an array');
    return { format: readArtifactFormat(content), role: 'app', content, helm, diagnostics: [], digest: artifactDigest(content, helm) };
  } catch {
    throw new DeployError(`Release ${version} has corrupted content`, ErrorCode.ROLLBACK_FAILED);
  }
}

export function buildStateConfigMap(ref: Pick<StackRef, 'project' | 'env'>, data: { current?: string; accessoriesDigest?: string }): string {
  const namespace = namespaceFor(ref.project, ref.env);
  const content: Record<string, string> = { schema: '1' };
  if (data.current !== undefined) content.current = data.current;
  if (data.accessoriesDigest !== undefined) content['accessories-digest'] = data.accessoriesDigest;
  const cm: ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: K8S_STATE_CONFIGMAP, namespace, labels: stateConfigMapLabels({ project: ref.project, namespace }) },
    data: content,
  };
  return emitObject(cm);
}

export function readState(cm: ConfigMap | undefined): { current: string | null; accessoriesDigest: string | null } {
  return { current: cm?.data?.current ?? null, accessoriesDigest: cm?.data?.['accessories-digest'] ?? null };
}

/** Drops the server-owned metadata a `create` must not carry (K25). */
export function cleanForRecreate(secret: Secret): Secret {
  const { uid: _uid, resourceVersion: _resourceVersion, creationTimestamp: _creationTimestamp, generation: _generation, managedFields: _managedFields, ...rest } = secret.metadata;
  return { ...secret, metadata: rest };
}

/** the in-cluster backup name and `P/part` of a Secret being set aside during a same-version redeploy */
export function asBackup(secret: Secret): Secret {
  return {
    ...secret,
    metadata: {
      ...secret.metadata,
      name: `${secret.metadata.name}${K8S_RELEASE_BACKUP_SUFFIX}`,
      labels: { ...secret.metadata.labels, [LABELS.part]: PARTS.releaseBackup },
    },
  };
}

/** the reverse of `asBackup`: what a repaired (promoted) backup becomes as the live release again */
export function asRelease(secret: Secret): Secret {
  const name = secret.metadata.name.endsWith(K8S_RELEASE_BACKUP_SUFFIX)
    ? secret.metadata.name.slice(0, -K8S_RELEASE_BACKUP_SUFFIX.length)
    : secret.metadata.name;
  return { ...secret, metadata: { ...secret.metadata, name, labels: { ...secret.metadata.labels, [LABELS.part]: PARTS.release } } };
}

/** one K48 row as a Secret-shaped stand-in, so `decodeReleaseMetadata` can be reused directly */
export function parseReleaseRows(stdout: string): Secret[] {
  const rows: Secret[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.trim() === '') continue;
    const first = raw.indexOf(' ');
    const second = first === -1 ? -1 : raw.indexOf(' ', first + 1);
    if (first === -1 || second === -1) continue;
    const name = raw.slice(0, first);
    const release = raw.slice(first + 1, second);
    const metadataBase64 = raw.slice(second + 1);
    rows.push({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, annotations: { [ANNOTATIONS.release]: release } },
      data: { [RELEASE_KEYS.metadata]: metadataBase64 },
    });
  }
  return rows;
}

/** Keeps the `keep` most recent releases, always keeping `current` in addition to that window (K21, C-REL-09). */
function selectRetention(releases: readonly ReleaseMetadata[], current: string | null, keep: number): ReleaseMetadata[] {
  const kept = new Set(releases.slice(0, Math.max(0, keep)).map((release) => release.version));
  if (current !== null) kept.add(current);
  return releases.filter((release) => !kept.has(release.version));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ClusterReleaseStoreDeps extends Pick<KubernetesBundleDeps, 'kubectl' | 'distribution'> {
  /** namespace lifecycle, reused rather than re-implemented (P41) */
  engine: NamespaceGuard;
}

export class ClusterReleaseStore implements ReleaseStore {
  private readonly namespace: string;
  private readonly ref: StackRef;
  /** `<stack>/<version>` whose previous Secret this process kept aside during a same-version create */
  private readonly replacedReleases = new Map<string, Secret>();

  constructor(
    private readonly deps: ClusterReleaseStoreDeps,
    ref: Pick<StackRef, 'project' | 'env'>,
  ) {
    this.namespace = namespaceFor(ref.project, ref.env);
    this.ref = { project: ref.project, env: ref.env, role: 'app' };
  }

  async create(_stackName: string, release: ReleaseInput): Promise<{ previous: string | null }> {
    const { yaml } = buildReleaseSecret(this.ref, release);
    return this.guarded('create release', true, async () => {
      await this.deps.engine.ensureNamespace(this.ref);
      await this.repairInterruptedReplacement();
      const [stateCm] = await this.deps.kubectl.getJson<ConfigMap>(['configmaps'], {
        namespace: this.namespace,
        name: K8S_STATE_CONFIGMAP,
        allowNotFound: true,
      });
      const previous = readState(stateCm).current;
      const name = releaseSecretName(release.version);
      const backupName = `${name}${K8S_RELEASE_BACKUP_SUFFIX}`;
      const [existing] = await this.deps.kubectl.getJson<Secret>(['secrets'], { namespace: this.namespace, name, allowNotFound: true });

      if (existing) {
        // K44: the copy lives IN THE CLUSTER, not only in process memory, so an interruption between
        // the delete and the create cannot destroy the only stored copy of what is running.
        this.replacedReleases.set(release.version, existing);
        await this.deps.kubectl.delete([`secrets/${backupName}`], { namespace: this.namespace, wait: true, ignoreNotFound: true });
        await this.deps.kubectl.create(emitObject(asBackup(cleanForRecreate(existing))), { namespace: this.namespace });
        await this.deps.kubectl.delete([`secrets/${name}`], { namespace: this.namespace, wait: true, ignoreNotFound: true }); // immutable: cannot be replaced (I-2)
      }
      try {
        const created = await this.deps.kubectl.create(yaml, { namespace: this.namespace });
        if (created.result === 'exists') {
          throw new DeployError(
            `Release ${release.version} was written concurrently in ${this.namespace}`,
            ErrorCode.DEPLOY_FAILED,
            'Check `dockflow lock status <env>`, then deploy again.',
          );
        }
        await this.applyState(K8S_FIELD_MANAGER_RELEASE_STATE, buildStateConfigMap(this.ref, { current: release.version }));
      } catch (error) {
        await this.deps.kubectl.delete([`secrets/${name}`], { namespace: this.namespace, wait: true, ignoreNotFound: true }).catch(() => {});
        if (existing) {
          await this.restoreReplaced(release.version).catch((restoreError: unknown) =>
            printDebug(`Release ${release.version} restore failed: ${errorText(restoreError)}`),
          );
        }
        throw error;
      }
      if (existing) {
        await this.deps.kubectl
          .delete([`secrets/${backupName}`], { namespace: this.namespace, wait: false, ignoreNotFound: true })
          .catch((error: unknown) => printDebug(`Release backup cleanup failed: ${errorText(error)}`));
      }
      printDebug(`Release ${release.version} stored in ${this.namespace}`);
      return { previous };
    });
  }

  async current(_stackName: string): Promise<ReleaseMetadata | null> {
    return this.guarded('read current release', false, async () => {
      const version = readState(await this.readStateConfigMap()).current;
      if (version === null) return null;
      const secret = await this.getReleaseSecret(version);
      return secret ? decodeReleaseMetadata(secret) : null;
    });
  }

  async currentVersion(_stackName: string): Promise<string | null> {
    return this.guarded('read release state', false, async () => readState(await this.readStateConfigMap()).current);
  }

  async currentCompose(stackName: string): Promise<string | null> {
    const version = await this.currentVersion(stackName);
    return version ? this.readCompose(stackName, version) : null;
  }

  async list(_stackName: string): Promise<ReleaseMetadata[]> {
    return this.guarded('list releases', false, async () => {
      if ((await this.deps.engine.assertNamespaceOwner(this.ref)) === 'missing') return [];
      await this.repairInterruptedReplacement();
      const result = await this.deps.kubectl.run({
        args: ['get', 'secrets', '-l', SEL_RELEASE(this.namespace), '-o', RELEASE_LIST_TEMPLATE],
        namespace: this.namespace,
        mutating: false,
      });
      const releases: ReleaseMetadata[] = [];
      for (const row of parseReleaseRows(result.stdout)) {
        const metadata = decodeReleaseMetadata(row);
        if (metadata) releases.push(metadata);
        else printWarning(`Skipping release ${row.metadata.name} with corrupted metadata in ${this.namespace}`);
      }
      return releases.sort((a, b) => b.epoch - a.epoch || compareCodeUnits(b.version, a.version));
    });
  }

  async latestVersion(stackName: string): Promise<string | null> {
    return (await this.list(stackName))[0]?.version ?? null;
  }

  async readArtifact(_stackName: string, version: string): Promise<StackArtifact> {
    return this.guarded('read release artifact', false, async () => {
      const secret = await this.getReleaseSecret(version);
      if (!secret) throw new DeployError(`Release ${version} not found in namespace ${this.namespace}`, ErrorCode.ROLLBACK_FAILED);
      return decodeReleaseArtifact(secret);
    });
  }

  async readCompose(_stackName: string, version: string): Promise<string | null> {
    return this.guarded('read release compose', false, async () => {
      const secret = await this.getReleaseSecret(version);
      return secret ? gunzipText(secret.data?.[RELEASE_KEYS.compose]) : null;
    });
  }

  async setCurrent(_stackName: string, version: string | null): Promise<void> {
    return this.guarded('write the release state', true, async () => {
      await this.deps.engine.ensureNamespace(this.ref);
      await this.applyState(K8S_FIELD_MANAGER_RELEASE_STATE, buildStateConfigMap(this.ref, version !== null ? { current: version } : {}));
    });
  }

  async remove(stackName: string, version: string, options?: { restoreCurrentTo: string | null }): Promise<void> {
    return this.guarded('remove release', true, async () => {
      if (this.replacedReleases.has(version) || (await this.hasBackup(version))) {
        await this.restoreReplaced(version);
        if (options) await this.setCurrent(stackName, options.restoreCurrentTo);
        return;
      }
      if (options && (await this.currentVersion(stackName)) === version) {
        await this.setCurrent(stackName, options.restoreCurrentTo); // current first: never a dangling pointer
      }
      await this.deps.kubectl.delete([`secrets/${releaseSecretName(version)}`], { namespace: this.namespace, wait: true, ignoreNotFound: true });
    });
  }

  async prune(stackName: string, keep: number): Promise<ReleaseMetadata[]> {
    return this.guarded('prune releases', true, async () => {
      const [list, current] = await Promise.all([this.list(stackName), this.currentVersion(stackName)]);
      const removed = selectRetention(list, current, keep);
      if (removed.length === 0) return [];
      await this.deps.kubectl.delete(
        removed.map((release) => `secrets/${releaseSecretName(release.version)}`),
        { namespace: this.namespace, wait: false, ignoreNotFound: true },
      );
      return removed;
    });
  }

  hookWorkingDir(stackName: string): string {
    return `${HOOK_WORKING_DIR_ROOT}/${stackName}`;
  }

  // ---- RoleStateStore -----------------------------------------------------------------------

  async writeAccessoriesDigest(_stackName: string, digest: string | null): Promise<void> {
    return this.guarded('write the accessories state', true, async () => {
      await this.deps.engine.ensureNamespace(this.ref);
      await this.applyState(K8S_FIELD_MANAGER_ACCESSORIES_STATE, buildStateConfigMap(this.ref, digest !== null ? { accessoriesDigest: digest } : {}));
    });
  }

  async readState(_stackName: string): Promise<{ current: string | null; accessoriesDigest: string | null }> {
    return this.guarded('read release state', false, async () => readState(await this.readStateConfigMap()));
  }

  // ---- internals ------------------------------------------------------------------------------

  private async readStateConfigMap(): Promise<ConfigMap | undefined> {
    const [cm] = await this.deps.kubectl.getJson<ConfigMap>(['configmaps'], {
      namespace: this.namespace,
      name: K8S_STATE_CONFIGMAP,
      allowNotFound: true,
    });
    return cm;
  }

  /** Reads a release, repairing an interrupted same-version redeploy on a miss (13.4, K44). */
  private async getReleaseSecret(version: string): Promise<Secret | undefined> {
    const [secret] = await this.deps.kubectl.getJson<Secret>(['secrets'], {
      namespace: this.namespace,
      name: releaseSecretName(version),
      allowNotFound: true,
    });
    if (secret) return secret;
    const restored = await this.repairInterruptedReplacement();
    return restored.get(version);
  }

  private async hasBackup(version: string): Promise<boolean> {
    const backupName = `${releaseSecretName(version)}${K8S_RELEASE_BACKUP_SUFFIX}`;
    const [backup] = await this.deps.kubectl.getJson<Secret>(['secrets'], { namespace: this.namespace, name: backupName, allowNotFound: true });
    return backup !== undefined;
  }

  /**
   * K44 repair: a backup whose live Secret is missing is promoted back. Called by `create`
   * unconditionally and by `getReleaseSecret` on a miss, so a killed CLI is healed by the next
   * command that touches releases, not only by the next deploy. Returns the releases it restored,
   * so a caller with a specific version in mind never needs a second read.
   */
  private async repairInterruptedReplacement(): Promise<Map<string, Secret>> {
    const restored = new Map<string, Secret>();
    const backups = await this.deps.kubectl.getJson<Secret>(['secrets'], { namespace: this.namespace, selector: SEL_RELEASE_BACKUP(this.namespace) });
    for (const backup of backups) {
      const name = backup.metadata.name.slice(0, -K8S_RELEASE_BACKUP_SUFFIX.length);
      const [live] = await this.deps.kubectl.getJson<Secret>(['secrets'], { namespace: this.namespace, name, allowNotFound: true });
      if (live) {
        await this.deps.kubectl.delete([`secrets/${backup.metadata.name}`], { namespace: this.namespace, wait: false, ignoreNotFound: true });
        continue;
      }
      const releaseSecret = asRelease(cleanForRecreate(backup));
      await this.deps.kubectl.create(emitObject(releaseSecret), { namespace: this.namespace });
      await this.deps.kubectl.delete([`secrets/${backup.metadata.name}`], { namespace: this.namespace, wait: false, ignoreNotFound: true });
      const version = backup.metadata.annotations?.[ANNOTATIONS.release] ?? name.slice(RELEASE_SECRET_PREFIX.length);
      restored.set(version, releaseSecret);
      printWarning(`Release ${version} was restored from an interrupted redeploy`);
    }
    return restored;
  }

  /** Puts back the Secret a same-version create kept aside: delete live, create from the copy, drop the backup. */
  private async restoreReplaced(version: string): Promise<void> {
    const name = releaseSecretName(version);
    const backupName = `${name}${K8S_RELEASE_BACKUP_SUFFIX}`;
    let secret = this.replacedReleases.get(version);
    if (!secret) {
      const [found] = await this.deps.kubectl.getJson<Secret>(['secrets'], { namespace: this.namespace, name: backupName, allowNotFound: true });
      secret = found;
    }
    if (!secret) return;
    await this.deps.kubectl.delete([`secrets/${name}`], { namespace: this.namespace, wait: true, ignoreNotFound: true });
    await this.deps.kubectl.create(emitObject(asRelease(cleanForRecreate(secret))), { namespace: this.namespace });
    await this.deps.kubectl.delete([`secrets/${backupName}`], { namespace: this.namespace, wait: false, ignoreNotFound: true });
    this.replacedReleases.delete(version);
  }

  /**
   * Server-side apply under one of the two state field managers (13.3, K69): the very first write
   * of `dockflow-state` can race the other writer's own first write, and the loser sees
   * `AlreadyExists` from the create path SSA takes for a not-yet-existing object. One retry (a
   * plain re-apply) then merges by field manager as intended; a second failure is not retried again.
   */
  private async applyState(fieldManager: string, yaml: string): Promise<void> {
    try {
      await this.deps.kubectl.apply(yaml, { namespace: this.namespace, dryRun: false, fieldManager });
    } catch (first) {
      if (!(first instanceof KubeError) || first.reason !== 'AlreadyExists') throw this.mapError(first, 'write the release state', true);
      try {
        await this.deps.kubectl.apply(yaml, { namespace: this.namespace, dryRun: false, fieldManager });
      } catch (second) {
        throw this.mapError(second, 'write the release state', true);
      }
    }
  }

  private async guarded<T>(operation: string, mutating: boolean, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.mapError(error, operation, mutating);
    }
  }

  private mapError(error: unknown, operation: string, mutating: boolean): unknown {
    if (!(error instanceof KubeError)) return error;
    return kubeErrorToCliError(error, { env: this.ref.env, operation, mutating, distribution: this.deps.distribution.traits.name });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
