// Stack-level checks and final assembly of the normalizer (design-01 9, 10; PD-1). stackChecks runs
// once every service draft is complete and reports what no single handler can see: name and claim
// collisions across services and across the two roles of one namespace, references to undeclared
// top-level entries, unused entries and per-replica volumes on another workload kind (8.3 X2, whose
// rule lives in extension.ts and runs from here, the one post-loop hook of design-01 1.2). finalize
// turns the drafts into the CanonicalStack with the DESIGN-CORE 3 invariants. The (T2) rows of
// design-01 10 (RWO volumes against replicas, published and host-port conflicts) are the
// translator's: the model carries every fact they need, so no D8 check is left that needs compose
// syntax.
// Pure: no I/O, no clock.

import type { DiagnosticSink } from '../../diagnostics';
import type {
  CanonicalFileSource,
  CanonicalService,
  CanonicalStack,
  CanonicalVolume,
  ExposeSpec,
  FileMountSpec,
  MiddlewareSpec,
  MountSpec,
  PortSpec,
  VolumeMountSpec,
} from '../model/types';
import {
  type CollisionDiagnostic,
  defaultCollisionDiagnostic,
  headlessServiceName,
  loadBalancerServiceName,
  type NameCollision,
  type NameOwner,
  NameRegistry,
} from '../naming';
import {
  childPath,
  compareCodeUnits,
  draftToFileSource,
  draftToService,
  type FileSourceDraft,
  type FileSourceTable,
  indexPath,
  isPlainMap,
  type NetworkTable,
  type NormalizeContext,
  type ServiceDraft,
  sortedKeys,
  sortedUnique,
  type VolumeTable,
} from './context';
import { checkPerReplicaVolumes } from './extension';

/** How the other role is named in messages (design-01 10 S5 wording). */
type SiblingFile = 'accessories' | 'app';

function siblingFileOf(ctx: NormalizeContext): SiblingFile {
  return ctx.input.role === 'app' ? 'accessories' : 'app';
}

function sortedMapKeys(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort(compareCodeUnits);
}

function byComposeName(a: ServiceDraft, b: ServiceDraft): number {
  return compareCodeUnits(a.composeName, b.composeName);
}

function volumeMounts(mounts: readonly MountSpec[]): VolumeMountSpec[] {
  return mounts.filter((m): m is VolumeMountSpec => m.type === 'volume');
}

function sourcesOf(fileSources: FileSourceTable, kind: FileMountSpec['kind']): ReadonlyMap<string, FileSourceDraft> {
  return kind === 'secret' ? fileSources.secrets : fileSources.configs;
}

/** `secret` and `config` contain no `/`, so the pair is unambiguous whatever the key holds. */
function fileRef(kind: FileMountSpec['kind'], key: string): string {
  return `${kind}/${key}`;
}

// ---------------------------------------------------------------------------
// stackChecks (design-01 10)
// ---------------------------------------------------------------------------

/**
 * Fills `usedBy` of every declared volume and reports the stack-level rows of design-01 10 that
 * belong to the normalizer. Every service, fatal ones included, counts as a user and a claimant:
 * the checks are about what the file says. Processing follows code-unit order of compose keys, never
 * the order of the arguments, so the diagnostics do not depend on it.
 */
export function stackChecks(
  drafts: readonly ServiceDraft[],
  volumes: VolumeTable,
  fileSources: FileSourceTable,
  networks: NetworkTable,
  ctx: NormalizeContext,
): void {
  const ordered = [...drafts].sort(byComposeName);
  fillUsedBy(ordered, volumes);
  checkReferences(ordered, volumes, fileSources, networks, ctx);
  reportUnused(ordered, volumes, fileSources, ctx);
  checkPerReplicaVolumes(ordered, volumes, ctx);
  checkServiceNames(ordered, ctx);
  checkVolumeClaims(volumes, ctx);
  checkFileObjects(ordered, fileSources, ctx);
}

function fillUsedBy(ordered: readonly ServiceDraft[], volumes: VolumeTable): void {
  for (const [key, volume] of volumes) {
    const users = ordered.filter((d) => volumeMounts(d.mounts).some((m) => m.volume === key)).map((d) => d.composeName);
    volume.usedBy = sortedUnique(users);
  }
}

/**
 * S6 for the references the model carries. The handlers refuse an undeclared entry where they
 * parse it and leave it out of the draft; this re-check, with the handlers' codes and text, keeps
 * a draft built any other way from reaching finalize (which drops the reference) unreported.
 * `depends_on` and `links` are not in the model and stay with their handlers.
 */
function checkReferences(
  ordered: readonly ServiceDraft[],
  volumes: VolumeTable,
  fileSources: FileSourceTable,
  networks: NetworkTable,
  ctx: NormalizeContext,
): void {
  for (const draft of ordered) {
    for (const mount of volumeMounts(draft.mounts)) {
      if (volumes.has(mount.volume)) continue;
      ctx.sink.error(
        'volumes.undeclared',
        mount.path,
        `volume ${mount.volume} is not declared under top-level volumes`,
        `Declare it: \`volumes: {${mount.volume}: {}}\`; a host path must start with \`/\`.`,
      );
    }
    for (const file of draft.files) {
      if (sourcesOf(fileSources, file.kind).has(file.source)) continue;
      const table = file.kind === 'secret' ? 'secrets' : 'configs';
      ctx.sink.error(
        'files.undeclared',
        file.path,
        `${file.kind} ${file.source} is not declared under top-level ${table}`,
        `Declare it, for example \`${table}: {${file.source}: {file: ./${file.source}.txt}}\`.`,
      );
    }
    // sorted: two networks may fall back to one path, and the sink keeps the first message
    for (const network of sortedUnique(draft.network.networks)) {
      if (network === 'default' || networks.has(network)) continue;
      ctx.sink.error(
        'network.undeclared',
        networkReferencePath(draft, network, ctx),
        `network ${network} is not declared under top-level networks`,
        'Declare it, or remove it from the service.',
      );
    }
  }
}

/**
 * NetworkSpec carries keys without paths; the written form (list or map) gives the most specific
 * path (design-01 9), the one the network handler reports at.
 */
function networkReferencePath(draft: ServiceDraft, network: string, ctx: NormalizeContext): string {
  const base = `${draft.path}.networks`;
  const services = ctx.input.compose.raw.services;
  const node = isPlainMap(services) ? services[draft.composeName] : undefined;
  const written = isPlainMap(node) ? node.networks : undefined;
  if (Array.isArray(written)) {
    const index = written.indexOf(network);
    return index === -1 ? base : indexPath(base, index);
  }
  if (isPlainMap(written) && Object.hasOwn(written, network)) return childPath(base, network);
  return base;
}

function referencedFiles(ordered: readonly ServiceDraft[]): Set<string> {
  return new Set(ordered.flatMap((d) => d.files.map((f) => fileRef(f.kind, f.source))));
}

/** design-01 6.2 TVOL-02 and 6.3 TFILE-09: only the whole stack knows an entry is unused */
function reportUnused(ordered: readonly ServiceDraft[], volumes: VolumeTable, fileSources: FileSourceTable, ctx: NormalizeContext): void {
  for (const key of sortedMapKeys(volumes)) {
    const volume = volumes.get(key);
    if (volume !== undefined && volume.usedBy.length === 0) {
      ctx.sink.info('volumes.unused', volume.path, 'is not mounted by any service, so no claim is created');
    }
  }
  const referenced = referencedFiles(ordered);
  for (const table of [fileSources.configs, fileSources.secrets]) {
    for (const key of sortedMapKeys(table)) {
      const source = table.get(key);
      if (source !== undefined && !referenced.has(fileRef(source.kind, key))) {
        ctx.sink.info('files.unused', source.path, 'is not used by any service, so no object is created');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S1: the Service name space of the namespace (DESIGN-CORE 5.4)
// ---------------------------------------------------------------------------

/** 'service' is the main Service named after the compose key; the others derive from it. */
type ServiceClaimKind = 'service' | 'load balancer' | 'headless' | 'alias';

interface ServiceClaim {
  kind: ServiceClaimKind;
  /** compose key of the service the Kubernetes Service belongs to */
  key: string;
  /** null for this file */
  sibling: SiblingFile | null;
  path: string;
}

function claimLabel(claim: ServiceClaim): string {
  return claim.sibling === null ? claim.key : `${claim.sibling} service ${claim.key}`;
}

function claimOwner(claim: ServiceClaim): NameOwner {
  if (claim.kind !== 'service') return { description: `${claim.kind} Service of ${claimLabel(claim)}`, path: claim.path };
  const description = claim.sibling === null ? `service ${claim.key}` : `${claim.sibling} service ${claim.key}`;
  return { description, path: claim.path };
}

/**
 * Two main Services: `names.sanitize-collision`. A main Service against a derived or alias one:
 * `names.derived-collision`, whichever came first. Two derived or alias Services share the space
 * like any name: `names.sanitize-collision`.
 */
function describeServiceCollision(claim: ServiceClaim, existing: ServiceClaim | undefined, c: NameCollision): CollisionDiagnostic {
  if (existing === undefined || (claim.kind === 'service' && existing.kind === 'service')) return defaultCollisionDiagnostic(c);
  if (claim.kind === 'service') {
    return {
      code: 'names.derived-collision',
      message: `resolves to ${c.name}, which is reserved for the ${existing.kind} Service of ${claimLabel(existing)}`,
      hint: 'Rename the service.',
    };
  }
  const taken =
    existing.kind === 'service'
      ? `the name of ${c.existing.description} (${c.existing.path})`
      : `the ${existing.kind} Service of ${claimLabel(existing)}`;
  return {
    code: existing.kind === 'service' ? 'names.derived-collision' : 'names.sanitize-collision',
    message: `needs the ${claim.kind} Service ${c.name}, which is already ${taken}`,
    hint: claim.kind === 'alias' ? 'Remove or rename the alias.' : 'Rename one of the services.',
  };
}

/**
 * A registry of its own rather than ctx.names: the sibling file's names must be reserved before
 * any name of this file, whatever a handler may have claimed earlier.
 */
class ServiceNameSpace {
  private readonly registry: NameRegistry;
  private readonly claims = new Map<string, ServiceClaim>();

  constructor(sink: DiagnosticSink) {
    this.registry = new NameRegistry(sink);
  }

  /** A name of the sibling file: the first one keeps it, collisions inside that file are its own render's to report. */
  reserve(name: string, claim: ServiceClaim): void {
    if (this.claims.has(name)) return;
    this.claims.set(name, claim);
    this.registry.claim('service', name, claimOwner(claim));
  }

  claim(name: string, claim: ServiceClaim): boolean {
    const claimed = this.registry.claim('service', name, claimOwner(claim), (c) => describeServiceCollision(claim, this.claims.get(c.name), c));
    if (claimed && !this.claims.has(name)) this.claims.set(name, claim);
    return claimed;
  }
}

/**
 * Order (design-01 10 S1): a compose key present in both files first; then every name of the
 * sibling file, reserved whether or not its load balancer or headless Service exists (the sibling
 * detail cannot tell); then the main, load balancer and headless names of this file per compose key
 * in code-unit order, so a service keeps its derived names against a later key; aliases last, so an
 * alias never takes a name from a service.
 */
function checkServiceNames(ordered: readonly ServiceDraft[], ctx: NormalizeContext): void {
  const sibling = siblingFileOf(ctx);
  const names = new ServiceNameSpace(ctx.sink);
  const siblings = [...ctx.input.sibling.services].sort((a, b) => compareCodeUnits(a.key, b.key));
  const siblingKeys = new Set(siblings.map((s) => s.key));

  for (const s of siblings) {
    const base = { key: s.key, sibling, path: childPath('services', s.key) };
    names.reserve(s.name, { ...base, kind: 'service' });
    names.reserve(loadBalancerServiceName(s.name), { ...base, kind: 'load balancer' });
    names.reserve(headlessServiceName(s.name), { ...base, kind: 'headless' });
    for (const alias of sortedUnique(s.aliases)) if (alias !== s.name) names.reserve(alias, { ...base, kind: 'alias' });
  }

  const holders: ServiceDraft[] = [];
  for (const draft of ordered) {
    if (siblingKeys.has(draft.composeName)) {
      ctx.sink.error(
        'names.role-collision',
        draft.path,
        `${draft.composeName} is declared in both docker-compose.yml and accessories.yml`,
        `Rename one of them: services and accessories share the namespace \`${ctx.input.identity.namespace}\`, so names must be unique.`,
      );
      continue;
    }
    const base = { key: draft.composeName, sibling: null, path: draft.path };
    if (!names.claim(draft.name, { ...base, kind: 'service' })) continue;
    names.claim(loadBalancerServiceName(draft.name), { ...base, kind: 'load balancer' });
    names.claim(headlessServiceName(draft.name), { ...base, kind: 'headless' });
    holders.push(draft);
  }
  for (const draft of holders) {
    const base = { key: draft.composeName, sibling: null, path: draft.path };
    for (const alias of sortedUnique(draft.network.aliases)) {
      if (alias !== draft.name) names.claim(alias, { ...base, kind: 'alias' });
    }
  }
}

// ---------------------------------------------------------------------------
// S2-S4: claim names (DESIGN-CORE 5.4, C3)
// ---------------------------------------------------------------------------

/**
 * Only claims Dockflow creates take part: an external volume names an existing claim, which is the
 * documented way to share one (S4), and an unused volume creates nothing. The same key declared
 * in both files is S3 (`volumes.role-collision`); sibling claims are reserved before this file's,
 * in a registry of its own so nothing claimed earlier can take their place.
 */
function checkVolumeClaims(volumes: VolumeTable, ctx: NormalizeContext): void {
  const sibling = siblingFileOf(ctx);
  const registry = new NameRegistry(ctx.sink);
  const siblingVolumes = ctx.input.sibling.volumes.filter((v) => !v.external).sort((a, b) => compareCodeUnits(a.key, b.key));
  const siblingKeys = new Set(siblingVolumes.map((v) => v.key));

  const claimants: CanonicalVolume[] = [];
  for (const key of sortedMapKeys(volumes)) {
    const volume = volumes.get(key);
    if (volume === undefined || volume.external || volume.usedBy.length === 0) continue;
    if (siblingKeys.has(key)) {
      ctx.sink.error(
        'volumes.role-collision',
        volume.path,
        `volume ${key} is declared in both docker-compose.yml and accessories.yml; on Kubernetes both would be the claim ${volume.name}`,
        `Declare the volume in one file and reference it from the other with \`external: true\` and \`name: ${volume.name}\`, or rename one of them.`,
      );
      continue;
    }
    claimants.push(volume);
  }
  for (const v of siblingVolumes) {
    if (registry.ownerOf('volume', v.claimName) !== null) continue;
    registry.claim('volume', v.claimName, { description: `${sibling} volume ${v.key}`, path: childPath('volumes', v.key) });
  }
  for (const volume of claimants) registry.claim('volume', volume.name, { description: `volume ${volume.key}`, path: volume.path });
}

/**
 * S9: two referenced secrets (or configs) whose keys sanitize to one base with identical content
 * produce one immutable object with two data keys. Only content-named objects are claimed; an
 * external object keeps its written name and may be shared. The claims go to ctx.names, the `file`
 * space of the render, so a handler claiming object names as it reads them agrees on the first
 * claimant and a collision is reported once, at one path.
 */
function checkFileObjects(ordered: readonly ServiceDraft[], fileSources: FileSourceTable, ctx: NormalizeContext): void {
  const referenced = referencedFiles(ordered);
  for (const table of [fileSources.configs, fileSources.secrets]) {
    for (const key of sortedMapKeys(table)) {
      const source = table.get(key);
      if (source === undefined || source.external || source.checksum === null) continue;
      if (!referenced.has(fileRef(source.kind, key))) continue;
      ctx.names.claim('file', source.objectName, { description: `${source.kind} ${key}`, path: source.path });
    }
  }
}

// ---------------------------------------------------------------------------
// finalize (design-01 9)
// ---------------------------------------------------------------------------

/**
 * The CanonicalStack of the drafts: services without a fatal error sorted by name, the volumes and
 * file sources they mount, the middlewares, every array in its documented order and a deep copy in
 * which no `undefined` remains. A mount of an undeclared volume, secret or config (reported by
 * stackChecks) is dropped, so the translator never looks up an entry that does not exist. Never
 * throws.
 */
export function finalize(
  drafts: readonly ServiceDraft[],
  volumes: VolumeTable,
  fileSources: FileSourceTable,
  middlewares: readonly MiddlewareSpec[],
  ctx: NormalizeContext,
): CanonicalStack {
  const services = drafts
    .filter((d) => !ctx.isFatal(d.path))
    .map((d) => finalService(d, volumes, fileSources))
    .sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.composeName, b.composeName));
  const stack: CanonicalStack = {
    schema: 1,
    identity: ctx.input.identity,
    role: ctx.input.role,
    services,
    volumes: finalVolumes(services, volumes),
    files: finalFiles(services, fileSources),
    middlewares: middlewares.map(finalMiddleware).sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.path, b.path)),
    proxy: ctx.proxy,
  };
  return plainCopy(stack) as CanonicalStack;
}

function comparePorts(a: PortSpec, b: PortSpec): number {
  return (
    a.target - b.target ||
    compareCodeUnits(a.protocol, b.protocol) ||
    (a.published ?? -1) - (b.published ?? -1) ||
    compareCodeUnits(a.hostIp ?? '', b.hostIp ?? '') ||
    compareCodeUnits(a.mode, b.mode) ||
    compareCodeUnits(a.path, b.path)
  );
}

function compareExpose(a: ExposeSpec, b: ExposeSpec): number {
  return a.target - b.target || compareCodeUnits(a.protocol, b.protocol) || compareCodeUnits(a.path, b.path);
}

function byTarget(a: { target: string; path: string }, b: { target: string; path: string }): number {
  return compareCodeUnits(a.target, b.target) || compareCodeUnits(a.path, b.path);
}

/**
 * Orders of DESIGN-CORE 3 and design-01 9. Constraints, spread labels, tolerations, DNS lists,
 * command, entrypoint and hook argv keep declaration order: their order has meaning.
 */
function finalService(draft: ServiceDraft, volumes: VolumeTable, fileSources: FileSourceTable): CanonicalService {
  const s = draftToService(draft);
  return {
    ...s,
    process: { ...s.process, groupAdd: [...new Set(s.process.groupAdd)].sort((a, b) => a - b) },
    environment: [...s.environment].sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.value, b.value)),
    ports: [...s.ports].sort(comparePorts),
    expose: [...s.expose].sort(compareExpose),
    mounts: s.mounts.filter((m) => m.type !== 'volume' || volumes.has(m.volume)).sort(byTarget),
    files: s.files.filter((f) => sourcesOf(fileSources, f.kind).has(f.source)).sort(byTarget),
    security: { ...s.security, capAdd: sortedUnique(s.security.capAdd), capDrop: sortedUnique(s.security.capDrop) },
    network: {
      ...s.network,
      networks: sortedUnique(s.network.networks),
      aliases: sortedUnique(s.network.aliases),
      extraHosts: [...s.network.extraHosts].sort((a, b) => compareCodeUnits(a.ip, b.ip) || compareCodeUnits(a.hostname, b.hostname)),
    },
    routes: s.routes
      .map((r) => ({ ...r, entryPoints: sortedUnique(r.entryPoints) }))
      .sort((a, b) => compareCodeUnits(a.router, b.router) || compareCodeUnits(a.path, b.path)),
    extension: { ...s.extension, loadBalancerSourceRanges: sortedUnique(s.extension.loadBalancerSourceRanges) },
  };
}

/**
 * Declared volumes mounted by a kept service, sorted by compose key (design-01 9: the compose name
 * of the volume, unique where claim names are not); usedBy lists the kept services only.
 */
function finalVolumes(services: readonly CanonicalService[], volumes: VolumeTable): CanonicalVolume[] {
  const users = new Map<string, string[]>();
  for (const service of services) {
    for (const mount of volumeMounts(service.mounts)) users.set(mount.volume, [...(users.get(mount.volume) ?? []), service.composeName]);
  }
  const out: CanonicalVolume[] = [];
  for (const key of sortedMapKeys(volumes)) {
    const v = volumes.get(key);
    const usedBy = users.get(key);
    if (v === undefined || usedBy === undefined) continue;
    out.push({
      key: v.key,
      name: v.name,
      role: v.role,
      external: v.external,
      size: v.size,
      storageClass: v.storageClass,
      accessMode: v.accessMode,
      perReplica: v.perReplica,
      labels: v.labels,
      usedBy: sortedUnique(usedBy),
      path: v.path,
    });
  }
  return out;
}

/** Declared secrets and configs a kept service mounts, sorted by (kind, key). */
function finalFiles(services: readonly CanonicalService[], fileSources: FileSourceTable): CanonicalFileSource[] {
  const referenced = new Set(services.flatMap((s) => s.files.map((f) => fileRef(f.kind, f.source))));
  const out: CanonicalFileSource[] = [];
  for (const table of [fileSources.configs, fileSources.secrets]) {
    for (const key of sortedMapKeys(table)) {
      const source = table.get(key);
      if (source !== undefined && referenced.has(fileRef(source.kind, key))) out.push(draftToFileSource(source));
    }
  }
  return out;
}

function finalMiddleware(m: MiddlewareSpec): MiddlewareSpec {
  return {
    name: m.name,
    spec: m.spec,
    users: m.users === null ? null : sortedUnique(m.users),
    errorsService: m.errorsService,
    path: m.path,
  };
}

/**
 * Deep copy of the model: plain objects rebuilt with sorted keys and `undefined` turned into
 * `null` (DESIGN-CORE 3), arrays in their order, byte arrays shared. The result shares nothing
 * mutable with the drafts, so finalize can run twice.
 */
function plainCopy(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => plainCopy(item));
  if (isPlainMap(value)) {
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys(value)) out[key] = plainCopy(value[key]);
    return out;
  }
  return value;
}
