// Content-named configuration objects (design-02 8, DESIGN-CORE 5.6, DV1): the per-service env
// Secret, one Secret per compose secret and one ConfigMap per compose config, the pod volumes and
// mounts that expose them as single files (design-02 8.4, 5.5) and the P/config-hash value
// (DESIGN-CORE 5.3). The name carries the checksum, so a revert of a pod template always finds the
// content it was written for. Pure (T2); a broken normalizer precondition throws (T6).

import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { DNS_LABEL_MAX } from '../constants';
import { hashedObjectLabels } from '../labels';
import type { CanonicalFileSource, CanonicalService, EnvVar, FileMountSpec } from '../model/types';
import { isSecretDataKey } from '../model/units';
import { hashedObjectName, sanitizeDnsLabel } from '../naming';
import type { ConfigMap, Secret, Volume, VolumeMount } from '../resources/core';
import { type EnvSecretResult, fileSourceKey, type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';

/** Kubernetes MaxSecretSize: decoded bytes one Secret or ConfigMap may hold (design-02 0). */
export const MAX_CONFIG_OBJECT_BYTES = 1024 * 1024;

/** Largest mode a volume `defaultMode` accepts (0777). */
const MAX_FILE_MODE = 0o777;

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Environment Secret (design-02 8.1)
// ---------------------------------------------------------------------------

/** The environment as the checksum reads it: `{name, value}` pairs sorted by name, names unique. */
function checksumEnvironment(svc: CanonicalService): EnvVar[] {
  const sorted = svc.environment.map(({ name, value }) => ({ name, value })).sort((a, b) => compareCodeUnits(a.name, b.name));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].name === sorted[i - 1].name) {
      translatorBug(`Environment variable ${sorted[i].name} of service ${svc.composeName} is defined twice in the canonical model`);
    }
  }
  return sorted;
}

/** `sha256Hex(canonicalJson(environment))` over the sorted `EnvVar[]` (DESIGN-CORE 5.6). */
export function envChecksum(svc: CanonicalService): string {
  return sha256Hex(canonicalJson(checksumEnvironment(svc)));
}

/**
 * The service's env Secret, read by the container through `envFrom` (values are not expanded
 * there, so nothing is escaped). null when the environment is empty: no Secret, no `envFrom`.
 */
export function buildEnvSecret(svc: CanonicalService, ctx: TranslateContext): EnvSecretResult | null {
  if (svc.environment.length === 0) return null;
  const environment = checksumEnvironment(svc);
  for (const variable of environment) {
    if (!isSecretDataKey(variable.name)) {
      translatorBug(`Environment variable name ${JSON.stringify(variable.name)} of service ${svc.composeName} is not a valid Secret key`);
    }
  }
  const checksum = sha256Hex(canonicalJson(environment));
  // fromEntries defines own properties, so a variable named `__proto__` stays a data key
  const data = Object.fromEntries(environment.map((v) => [v.name, base64(new TextEncoder().encode(v.value))]));
  const secret: Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: hashedObjectName(svc.name, 'env', checksum),
      namespace: ctx.namespace,
      labels: hashedObjectLabels(ctx.stack.identity, svc.role, svc.name),
    },
    data,
    immutable: true,
  };
  return { secret, checksum };
}

// ---------------------------------------------------------------------------
// Compose secrets and configs (design-02 8.2, 8.3)
// ---------------------------------------------------------------------------

function sourceWord(kind: CanonicalFileSource['kind']): string {
  return kind === 'secret' ? 'Secret' : 'Config';
}

function sourceBytes(source: CanonicalFileSource): Uint8Array {
  if (source.data === null || source.checksum === null) {
    return translatorBug(`${sourceWord(source.kind)} ${source.key} has no content in the canonical model`);
  }
  if (!isSecretDataKey(source.key)) {
    translatorBug(`${sourceWord(source.kind)} key ${JSON.stringify(source.key)} is not a valid data key`);
  }
  return source.data;
}

/** The text of `bytes` when they are valid UTF-8, byte for byte (a leading BOM included); else null. */
function utf8Text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function fileSecret(source: CanonicalFileSource, bytes: Uint8Array, ctx: TranslateContext): Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: source.objectName, namespace: ctx.namespace, labels: hashedObjectLabels(ctx.stack.identity, source.role, null) },
    data: Object.fromEntries([[source.key, base64(bytes)]]),
    immutable: true,
  };
}

function fileConfigMap(source: CanonicalFileSource, bytes: Uint8Array, ctx: TranslateContext): ConfigMap {
  const text = utf8Text(bytes);
  const content = text === null ? { binaryData: Object.fromEntries([[source.key, base64(bytes)]]) } : { data: Object.fromEntries([[source.key, text]]) };
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: source.objectName, namespace: ctx.namespace, labels: hashedObjectLabels(ctx.stack.identity, source.role, null) },
    ...content,
    immutable: true,
  };
}

/**
 * One immutable object per non-external compose secret (Secret) and config (ConfigMap), named
 * `source.objectName`, with the compose key as its single data key. External sources belong to
 * the user and produce nothing; content over 1 MiB is `files.too-large` and is not emitted.
 */
export function buildFileObjects(ctx: TranslateContext): (Secret | ConfigMap)[] {
  const objects: (Secret | ConfigMap)[] = [];
  for (const source of ctx.stack.files) {
    if (source.external) continue;
    const bytes = sourceBytes(source);
    if (bytes.length > MAX_CONFIG_OBJECT_BYTES) {
      reportTranslator(ctx.sink, 'files.too-large', source.path, { kind: source.kind, key: source.key, sizeBytes: bytes.length });
      continue;
    }
    objects.push(source.kind === 'secret' ? fileSecret(source, bytes, ctx) : fileConfigMap(source, bytes, ctx));
  }
  return objects;
}

// ---------------------------------------------------------------------------
// File mounts (design-02 8.4, 5.5) and P/config-hash (DESIGN-CORE 5.3)
// ---------------------------------------------------------------------------

function fileSourceFor(file: FileMountSpec, ctx: TranslateContext): CanonicalFileSource {
  const source = ctx.files.get(fileSourceKey(file.kind, file.source));
  return source ?? translatorBug(`${file.path} references ${file.kind} ${file.source}, which the canonical stack does not define`);
}

/**
 * `secret-<key>-<octal mode>` / `config-<key>-<octal mode>`: the mode is part of the name, so two
 * mounts of one source with different modes get two volumes and one mode never overrides the other.
 */
export function fileVolumeName(kind: FileMountSpec['kind'], key: string, mode: number): string {
  return sanitizeDnsLabel(`${kind}-${key}-${mode.toString(8)}`, { max: DNS_LABEL_MAX, mustStartWithLetter: true }).value;
}

function fileVolume(name: string, file: FileMountSpec, source: CanonicalFileSource): Volume {
  // The normalizer already masked the mode (mode & 0o555, K35); it is emitted as given.
  const items = [{ key: source.key, path: source.key }];
  return file.kind === 'secret'
    ? { name, secret: { secretName: source.objectName, defaultMode: file.mode, items } }
    : { name, configMap: { name: source.objectName, defaultMode: file.mode, items } };
}

export interface FileMounts {
  /** one per (source, mode), sorted by name */
  volumes: Volume[];
  /** one per mounted file, read-only, `subPath` = the compose key; sorted by mountPath */
  mounts: VolumeMount[];
}

/**
 * Pod volumes and mounts of the service's compose secrets and configs. External sources are
 * referenced by their own name with the compose key as item key. Each mount exposes exactly one
 * regular file (`subPath`), like `/run/secrets/<name>` on Swarm; content-named objects never
 * change, so subPath mounts missing updates is irrelevant.
 */
export function buildFileMounts(svc: CanonicalService, ctx: TranslateContext): FileMounts {
  const volumes = new Map<string, { owner: string; key: string; volume: Volume }>();
  const mounts: VolumeMount[] = [];
  for (const file of svc.files) {
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > MAX_FILE_MODE) {
      translatorBug(`${file.path} has mode ${file.mode}, outside 0..0777`);
    }
    const source = fileSourceFor(file, ctx);
    const name = fileVolumeName(file.kind, file.source, file.mode);
    const owner = fileSourceKey(file.kind, file.source);
    const existing = volumes.get(name);
    if (existing === undefined) {
      volumes.set(name, { owner, key: file.source, volume: fileVolume(name, file, source) });
    } else if (existing.owner !== owner) {
      // reported at the declaration, like the volume collisions (catalogue path `volumes.<key>`)
      reportTranslator(ctx.sink, 'volumes.pod-volume-name-collision', source.path, {
        service: svc.composeName,
        volume: file.source,
        other: existing.key,
      });
      continue;
    }
    mounts.push({ name, mountPath: file.target, readOnly: true, subPath: source.key });
  }
  return {
    volumes: [...volumes.values()].map((v) => v.volume).sort((a, b) => compareCodeUnits(a.name, b.name)),
    mounts: mounts.sort((a, b) => compareCodeUnits(a.mountPath, b.mountPath)),
  };
}

/**
 * Value of the `P/config-hash` pod template annotation, or null (annotation omitted) when the
 * service has neither an environment nor a file mount. Files keep model order (sorted by target);
 * an external source contributes null because Dockflow never reads its content, so changing it in
 * the cluster does not roll the pods.
 */
export function configHashFor(svc: CanonicalService, env: EnvSecretResult | null, ctx: TranslateContext): string | null {
  if (env === null && svc.files.length === 0) return null;
  const files = svc.files.map((file) => {
    const source = fileSourceFor(file, ctx);
    return [file.target, source.external ? null : source.checksum];
  });
  return sha256Hex(canonicalJson({ env: env === null ? null : env.checksum, files }));
}
