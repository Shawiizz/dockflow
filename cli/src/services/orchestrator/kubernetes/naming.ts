// Kubernetes names Dockflow derives from compose keys, versions and server keys (DESIGN-CORE 5.4),
// and the per-namespace collision registry. Every name has exactly one definition here: the
// translator, the normalizer, provisioning and the backends must agree by construction.
// Pure: no I/O, no clock.

import { sha256Hex } from '../../../utils/hash';
import type { DiagnosticSink } from '../diagnostics';
import { DNS_LABEL_MAX, K8S_IMPORTED_IMAGE_REGISTRY, SERVICE_NAME_MAX } from './constants';
import type { Protocol } from './model/types';

export interface SanitizedName {
  value: string;
  changed: boolean;
}

/** Generic DNS label sanitizer; every other sanitizing function below is built on it. */
export function sanitizeDnsLabel(input: string, options: { max: number; mustStartWithLetter: boolean }): SanitizedName {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9-]/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s === '') s = 'x';
  if (options.mustStartWithLetter && /^[0-9]/.test(s)) s = `s-${s}`;
  if (s.length > options.max) {
    s = `${s.slice(0, options.max - 7).replace(/-+$/, '')}-${sha256Hex(input).slice(0, 6)}`;
  }
  return { value: s, changed: s !== input };
}

const NAMESPACE_HEAD = 54;

/** `dockflow-<project>-<env>`; both parts are already DNS labels (config schema) */
export function namespaceFor(project: string, env: string): string {
  const raw = `dockflow-${project}-${env}`;
  if (raw.length <= DNS_LABEL_MAX) return raw;
  return `${raw.slice(0, NAMESPACE_HEAD).replace(/-+$/, '')}-${sha256Hex(raw).slice(0, 8)}`;
}

/** 52 = the StatefulSet limit, used for every kind so a kind switch never renames a service */
export function serviceNameFor(composeName: string): SanitizedName {
  return sanitizeDnsLabel(composeName, { max: SERVICE_NAME_MAX, mustStartWithLetter: true });
}

export function volumeClaimNameFor(composeKey: string): SanitizedName {
  return sanitizeDnsLabel(composeKey, { max: DNS_LABEL_MAX, mustStartWithLetter: false });
}

export function middlewareNameFor(labelName: string): SanitizedName {
  return sanitizeDnsLabel(labelName, { max: DNS_LABEL_MAX, mustStartWithLetter: false });
}

const HASHED_BASE_MAX = 40;

/**
 * Content-addressed Secret/ConfigMap name (5.6): `<base>-<kind>-<checksum 8>`. `base` is the
 * service name for `env` and the compose key for `secret`/`config`, sanitized here. At most 65
 * characters, a DNS-1123 subdomain.
 */
export function hashedObjectName(base: string, kind: 'env' | 'secret' | 'config', checksum: string): string {
  const head = kind === 'env' ? base : sanitizeDnsLabel(base, { max: HASHED_BASE_MAX, mustStartWithLetter: false }).value;
  return `${head}-${kind}-${checksum.slice(0, 8)}`;
}

const IANA_SVC_NAME_MAX = 15;

/** IANA_SVC_NAME: lowercase letters, digits and single inner `-`, at least one letter, at most 15 */
export function isIanaSvcName(name: string): boolean {
  return (
    name.length <= IANA_SVC_NAME_MAX && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && !name.includes('--') && /[a-z]/.test(name)
  );
}

function sanitizedPortName(requested: string | null): string | null {
  if (requested === null) return null;
  const s = requested
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isIanaSvcName(s) ? s : null;
}

/**
 * Port name from the TARGET (container) port for every Service shape (5.4): the requested compose
 * name sanitized to IANA_SVC_NAME when that yields a valid name, else `<protocol>-<port>`.
 */
export function portNameFor(port: number, protocol: Protocol, requested: string | null): string {
  return sanitizedPortName(requested) ?? `${protocol.toLowerCase()}-${port}`;
}

export interface PortNameRequest {
  /** target (container) port */
  port: number;
  protocol: Protocol;
  requested: string | null;
}

const GENERATED_PORT_NAME = /^(?:tcp|udp|sctp)-\d+$/;

/**
 * Names for the ports of one Service or container, in model order: the first entry that requests a
 * name keeps it, every later entry whose sanitized request is already taken falls back to
 * `<protocol>-<port>` (5.4 collision rule). A request of the generated form (`tcp-81`) is kept only
 * by the port it names, so it never takes another port's fallback, including a port added later.
 * The names are unique across entries with distinct (port, protocol), as container ports are.
 * Entries repeating a key (several published ports onto one target on `-lb`) share that key's
 * generated name, and the caller tells them apart by what only it knows.
 */
export function assignPortNames(entries: readonly PortNameRequest[]): string[] {
  const taken = new Set<string>();
  return entries.map((entry) => {
    const generated = portNameFor(entry.port, entry.protocol, null);
    const requested = sanitizedPortName(entry.requested);
    const foreign = requested !== null && requested !== generated && GENERATED_PORT_NAME.test(requested);
    const name = requested !== null && !foreign && !taken.has(requested) ? requested : generated;
    taken.add(name);
    return name;
  });
}

export function loadBalancerServiceName(serviceName: string): string {
  return `${serviceName}-lb`;
}

export function headlessServiceName(serviceName: string): string {
  return `${serviceName}-hl`;
}

/**
 * `<service>-<checksum 8>`. The caller passes the checksum of the canonical JSON of the complete
 * Job spec (PD-9): a changed Job creates a new Job, an unchanged one is not re-run.
 */
export function jobNameFor(serviceName: string, templateChecksum: string): string {
  return `${serviceName}-${templateChecksum.slice(0, 8)}`;
}

/**
 * The one mapping from a servers.yml key to a Kubernetes node name: lowercase, `_` -> `-`, nothing
 * else. Provisioning's `--node-name`, hostname node selectors and placement validation all use it.
 */
export function nodeNameFor(serverKey: string): string {
  return serverKey.toLowerCase().replace(/_/g, '-');
}

const RELEASE_SLUG_MAX = 40;
const RELEASE_SLUG_HEAD = 31;

/**
 * Label-value form of a release version (<= 40): the version itself when it is already a clean
 * lowercase name, else a readable prefix plus 8 hex of its sha256. A run of `-`/`.` longer than one
 * character collapses to `-`, so the slug is also a valid DNS subdomain (release Secret names).
 */
export function releaseSlug(version: string): string {
  const cleaned = version
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/[.-]{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (cleaned === version && cleaned.length <= RELEASE_SLUG_MAX) return cleaned;
  const head = cleaned.slice(0, RELEASE_SLUG_HEAD).replace(/[.-]+$/, '');
  const hash = sha256Hex(version).slice(0, 8);
  return head === '' ? hash : `${head}-${hash}`;
}

export function releaseSecretName(version: string): string {
  return `dockflow-release-${releaseSlug(version)}`;
}

/** Deploy lock Lease in dockflow-system (a subdomain of at most 68 characters) */
export function leaseNameFor(stackId: string): string {
  return `lock-${stackId}`;
}

/**
 * Reference under which an imported built image is stored in containerd (5.7). `.invalid` never
 * resolves, so a node missing the import fails with ErrImagePull instead of pulling a public image.
 * A registry host with a port or in brackets is not a valid path component; it is folded into one
 * so the result stays a valid reference.
 */
export function importedImageRef(ref: string): string {
  const slash = ref.indexOf('/');
  if (slash !== -1) {
    const first = ref.slice(0, slash);
    if (/[^a-z0-9._-]/.test(first)) {
      const folded = first
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '-')
        .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
      return `${K8S_IMPORTED_IMAGE_REGISTRY}/${folded}${ref.slice(slash)}`;
    }
  }
  return `${K8S_IMPORTED_IMAGE_REGISTRY}/${ref}`;
}

// ---------------------------------------------------------------------------
// Collision registry
// ---------------------------------------------------------------------------

/** Name spaces checked per namespace, across both roles (5.4 collision rules). */
export type NameSpace = 'service' | 'volume' | 'middleware' | 'file';

export interface NameOwner {
  /** what claims the name, as the user knows it, e.g. `service web_app` or `secret tls_cert` */
  description: string;
  /** compose path of the claimant, e.g. `services.web_app` */
  path: string;
}

export interface NameCollision {
  space: NameSpace;
  name: string;
  /** the second claimant, where the diagnostic is reported */
  owner: NameOwner;
  /** the first claimant, which keeps the name */
  existing: NameOwner;
}

export interface CollisionDiagnostic {
  code: string;
  message: string;
  hint?: string;
}

/** Default error per space; callers with a more specific rule (role or derived collisions) pass their own. */
export function defaultCollisionDiagnostic(c: NameCollision): CollisionDiagnostic {
  const other = `${c.existing.description} (${c.existing.path})`;
  switch (c.space) {
    case 'service':
      return {
        code: 'names.sanitize-collision',
        message: `resolves to the Kubernetes name ${c.name}, already used by ${other}`,
        hint: 'Rename one of the services.',
      };
    case 'volume':
      return {
        code: 'names.volume-collision',
        message: `${c.owner.description} is stored in the claim ${c.name}, already used by ${other}`,
        hint: 'Rename one of the volumes.',
      };
    case 'middleware':
      return {
        code: 'names.middleware-collision',
        message: `${c.owner.description} resolves to the middleware ${c.name}, already used by ${other}`,
        hint: 'Rename one of the middlewares.',
      };
    case 'file':
      return {
        code: 'names.file-collision',
        message: `${c.owner.description} would create the object ${c.name}, already created for ${other}`,
        hint: 'Rename one of them.',
      };
  }
}

/**
 * Records the owner of every generated name. The first claimant keeps a name; a different second
 * owner produces an error diagnostic at its own path that names the first owner's path. Claiming
 * the same name again for the same owner is not a collision.
 */
export class NameRegistry {
  private readonly owners = new Map<NameSpace, Map<string, NameOwner>>();

  constructor(private readonly sink: DiagnosticSink) {}

  /** true when the name now belongs to `owner` (claimed or already its own) */
  claim(
    space: NameSpace,
    name: string,
    owner: NameOwner,
    describe: (collision: NameCollision) => CollisionDiagnostic = defaultCollisionDiagnostic,
  ): boolean {
    let names = this.owners.get(space);
    if (names === undefined) {
      names = new Map();
      this.owners.set(space, names);
    }
    const existing = names.get(name);
    if (existing === undefined) {
      names.set(name, { description: owner.description, path: owner.path });
      return true;
    }
    if (existing.description === owner.description && existing.path === owner.path) return true;
    const d = describe({ space, name, owner, existing: { ...existing } });
    this.sink.error(d.code, owner.path, d.message, d.hint);
    return false;
  }

  ownerOf(space: NameSpace, name: string): NameOwner | null {
    const existing = this.owners.get(space)?.get(name);
    return existing ? { ...existing } : null;
  }
}
