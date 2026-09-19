// Builders for the inputs of the Kubernetes pipeline and backends (design-07 4.1, 5.1; DESIGN-CORE
// 8.9). Every field has a default, so a field added to a core contract touches this file only.
// Defaults: identity shop/production/1.4.2, k3s traits, progressDeadlineS 240, revisionHistoryLimit
// 3, the SSH reservation of server_1, serverNames ['server_1', 'agent_1'], traefikOnCluster false,
// and a fresh DiagnosticSink per call.

import { stringify } from 'yaml';
import { loadFromString, type ParsedCompose } from '../../../services/compose';
import { DiagnosticSink } from '../../../services/orchestrator/diagnostics';
import type {
  ClusterNodeRef,
  FileResolveFailure,
  FileResolver,
  ImageDelivery,
  OrchestratorTarget,
  StackDeployInput,
  StackRef,
} from '../../../services/orchestrator/interfaces';
import { K8S_PROGRESS_DEADLINE_S } from '../../../services/orchestrator/kubernetes/constants';
import type { DistributionTraits } from '../../../services/orchestrator/kubernetes/distribution';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import type {
  CanonicalFileSource,
  CanonicalService,
  CanonicalStack,
  CanonicalVolume,
  ImageSpec,
  NetworkSpec,
  PlacementSpec,
  ProcessSpec,
  ProxyIntent,
  ResourcesSpec,
  RestartSpec,
  SecuritySpec,
  ServiceExtension,
  ServiceMode,
  StackIdentity,
  UpdateSpec,
  WorkloadKind,
} from '../../../services/orchestrator/kubernetes/model/types';
import { hashedObjectName, namespaceFor, volumeClaimNameFor } from '../../../services/orchestrator/kubernetes/naming';
import {
  childPath,
  defaultService,
  NormalizeContext,
  type NormalizeInput,
  newServiceDraft,
  normalizeFilePath,
  type ServiceDraft,
} from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  createContext,
  type TranslateContext,
  type TranslateOptions,
} from '../../../services/orchestrator/kubernetes/translate/context';
import { sha256Hex } from '../../../utils/hash';
import type { DockflowConfig } from '../../../utils/config';

const DEFAULT_SERVICE_BODY = 'image: nginx:1.27';
export const DEFAULT_SERVER_NAMES: readonly string[] = ['server_1', 'agent_1'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function dedent(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines.filter((l) => l.trim() !== '').map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * A compose document. Source that does not start with `services:` is the body of service `web`
 * (design-07 4.1); indentation common to every line is removed first.
 */
export function composeYaml(source: string = DEFAULT_SERVICE_BODY): string {
  const text = dedent(source);
  if (text.startsWith('services:')) return `${text}\n`;
  if (text === '') return 'services:\n  web: {}\n';
  const body = text
    .split('\n')
    .map((line) => (line === '' ? line : `    ${line}`))
    .join('\n');
  return `services:\n  web:\n${body}\n`;
}

/** Loaded through the real loader. An object with a `services` key is the document, any other object the body of `web`. */
export function parsedCompose(source: string | Record<string, unknown> = DEFAULT_SERVICE_BODY): ParsedCompose {
  if (typeof source === 'string') return loadFromString(composeYaml(source), 'docker-compose.yml');
  const doc = 'services' in source ? source : { services: { web: source } };
  return loadFromString(stringify(doc), 'docker-compose.yml');
}

function isParsedCompose(value: unknown): value is ParsedCompose {
  return isRecord(value) && 'raw' in value && 'services' in value;
}

function toCompose(source: ParsedCompose | string | Record<string, unknown> | undefined): ParsedCompose {
  if (source === undefined) return parsedCompose();
  return isParsedCompose(source) ? source : parsedCompose(source);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Content of a fixture file, or the resolver failure it produces. */
export type FileFixture = string | Uint8Array | { fail: FileResolveFailure };

/** FileResolver over an in-memory map keyed by path from the compose directory; absent paths are `missing`. */
export function fileResolver(files: Record<string, FileFixture> = {}): FileResolver {
  const byPath = new Map(Object.entries(files).map(([path, content]) => [normalizeFilePath(path), content]));
  return (path) => {
    const content = byPath.get(normalizeFilePath(path));
    if (content === undefined) return { ok: false, reason: 'missing' };
    if (typeof content === 'string') return { ok: true, bytes: new TextEncoder().encode(content), rendered: true };
    if (content instanceof Uint8Array) return { ok: true, bytes: content, rendered: false };
    return { ok: false, reason: content.fail };
  };
}

function toResolver(files: FileResolver | Record<string, FileFixture> | undefined): FileResolver {
  if (files === undefined) return fileResolver();
  return typeof files === 'function' ? files : fileResolver(files);
}

// ---------------------------------------------------------------------------
// Identity, traits, sibling
// ---------------------------------------------------------------------------

/** `stackName` and `namespace` follow `project`/`env` unless given. */
export function identity(overrides: Partial<StackIdentity> = {}): StackIdentity {
  const project = overrides.project ?? 'shop';
  const env = overrides.env ?? 'production';
  return {
    project,
    env,
    stackName: overrides.stackName ?? `${project}-${env}`,
    namespace: overrides.namespace ?? namespaceFor(project, env),
    version: overrides.version ?? '1.4.2',
  };
}

/** k3s traits (a copy: tests may mutate it) with overrides. */
export function traits(overrides: Partial<DistributionTraits> = {}): DistributionTraits {
  return { ...structuredClone(k3sDistribution.traits), ...overrides };
}

type Sibling = NormalizeInput['sibling'];

export function sibling(overrides: Partial<Sibling> = {}): Sibling {
  return { services: overrides.services ?? [], volumes: overrides.volumes ?? [], middlewares: overrides.middlewares ?? [] };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export interface NormalizeInputOverrides
  extends Partial<Omit<NormalizeInput, 'compose' | 'identity' | 'sibling' | 'files' | 'traits'>> {
  compose?: ParsedCompose | string | Record<string, unknown>;
  identity?: Partial<StackIdentity>;
  sibling?: Partial<Sibling>;
  files?: FileResolver | Record<string, FileFixture>;
  traits?: Partial<DistributionTraits>;
}

/** Role app, proxy disabled, no sibling, import delivery (no registry configured), no files. */
export function normalizeInput(overrides: NormalizeInputOverrides = {}): NormalizeInput {
  return {
    compose: toCompose(overrides.compose),
    role: overrides.role ?? 'app',
    identity: identity(overrides.identity),
    proxy: overrides.proxy,
    sibling: sibling(overrides.sibling),
    serverNames: overrides.serverNames ?? [...DEFAULT_SERVER_NAMES],
    imageDelivery: overrides.imageDelivery ?? 'import',
    files: toResolver(overrides.files),
    traits: traits(overrides.traits),
    sink: overrides.sink ?? new DiagnosticSink(),
  };
}

export function normalizeContext(overrides: NormalizeInputOverrides = {}): NormalizeContext {
  return new NormalizeContext(normalizeInput(overrides));
}

/** A fresh draft of service `key`, as normalizeStack creates it before the handlers run. */
export function serviceDraft(key = 'web', ctx: NormalizeContext = normalizeContext()): ServiceDraft {
  return newServiceDraft(key, childPath('services', key), ctx);
}

// ---------------------------------------------------------------------------
// Canonical model
// ---------------------------------------------------------------------------

export interface ServiceOverrides
  extends Partial<
    Omit<
      CanonicalService,
      'image' | 'process' | 'update' | 'restart' | 'resources' | 'placement' | 'security' | 'network' | 'extension'
    >
  > {
  image?: Partial<ImageSpec>;
  process?: Partial<ProcessSpec>;
  update?: Partial<UpdateSpec>;
  restart?: Partial<RestartSpec>;
  resources?: { limits?: Partial<ResourcesSpec['limits']>; reservations?: Partial<ResourcesSpec['reservations']> };
  placement?: Partial<PlacementSpec>;
  security?: Partial<SecuritySpec>;
  network?: Partial<NetworkSpec>;
  extension?: Partial<ServiceExtension>;
}

function workloadKindFor(mode: ServiceMode, kind: ServiceExtension['kind']): WorkloadKind {
  if (mode === 'global') return 'DaemonSet';
  if (mode === 'replicated-job') return 'Job';
  return kind === 'statefulset' ? 'StatefulSet' : 'Deployment';
}

/**
 * A valid service `web` running `nginx:1.27`, every other field at its documented default.
 * `name` and `path` follow `composeName`, `update` follows `role`, `workloadKind` follows `mode`
 * and `extension.kind` unless given. Nested groups merge one level deep.
 */
export function canonicalService(overrides: ServiceOverrides = {}): CanonicalService {
  const composeName = overrides.composeName ?? 'web';
  const role = overrides.role ?? 'app';
  const base = defaultService(composeName, childPath('services', composeName), role);
  const extension = { ...base.extension, ...overrides.extension };
  const mode = overrides.mode ?? base.mode;
  return {
    ...base,
    ...overrides,
    composeName,
    role,
    mode,
    workloadKind: overrides.workloadKind ?? workloadKindFor(mode, extension.kind),
    image: { ...base.image, ref: 'nginx:1.27', composeRef: 'nginx:1.27', ...overrides.image },
    process: { ...base.process, ...overrides.process },
    update: { ...base.update, ...overrides.update },
    restart: { ...base.restart, ...overrides.restart },
    resources: {
      limits: { ...base.resources.limits, ...overrides.resources?.limits },
      reservations: { ...base.resources.reservations, ...overrides.resources?.reservations },
    },
    placement: { ...base.placement, ...overrides.placement },
    security: { ...base.security, ...overrides.security },
    network: { ...base.network, ...overrides.network },
    extension,
  };
}

/** Volume `data` used by `web`, default class and size, not external. */
export function canonicalVolume(overrides: Partial<CanonicalVolume> = {}): CanonicalVolume {
  const key = overrides.key ?? 'data';
  return {
    key,
    name: volumeClaimNameFor(key).value,
    role: 'app',
    external: false,
    size: '1Gi',
    storageClass: k3sDistribution.traits.defaultStorageClass,
    accessMode: 'ReadWriteOnce',
    perReplica: false,
    labels: {},
    usedBy: ['web'],
    path: childPath('volumes', key),
    ...overrides,
  };
}

/** Secret `api_key` with content `secret-value`; checksum and object name follow `data` unless given. */
export function canonicalFileSource(overrides: Partial<CanonicalFileSource> = {}): CanonicalFileSource {
  const kind = overrides.kind ?? 'secret';
  const key = overrides.key ?? 'api_key';
  const external = overrides.external ?? false;
  const data = overrides.data !== undefined ? overrides.data : external ? null : new TextEncoder().encode('secret-value');
  const checksum = overrides.checksum !== undefined ? overrides.checksum : data === null ? null : sha256Hex(data);
  return {
    kind,
    key,
    objectName: checksum === null ? key : hashedObjectName(key, kind, checksum),
    role: 'app',
    external,
    data,
    checksum,
    path: childPath(kind === 'secret' ? 'secrets' : 'configs', key),
    ...overrides,
  };
}

/** Proxy enabled with ACME and the domain `shop.example.com` (role app). */
export function proxyIntent(overrides: Partial<ProxyIntent> = {}): ProxyIntent {
  return {
    domain: 'shop.example.com',
    acme: true,
    entryPoint: 'websecure',
    certResolver: 'letsencrypt',
    manage: true,
    ...overrides,
  };
}

export interface StackOverrides extends Partial<Omit<CanonicalStack, 'identity'>> {
  identity?: Partial<StackIdentity>;
}

/** One default service of the stack's role, no volumes, files or middlewares, proxy disabled. */
export function canonicalStack(overrides: StackOverrides = {}): CanonicalStack {
  const role = overrides.role ?? 'app';
  return {
    schema: 1,
    identity: identity(overrides.identity),
    role,
    services: overrides.services ?? [canonicalService({ role })],
    volumes: overrides.volumes ?? [],
    files: overrides.files ?? [],
    middlewares: overrides.middlewares ?? [],
    proxy: overrides.proxy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

export interface TranslateOptionsOverrides extends Partial<Omit<TranslateOptions, 'traits'>> {
  traits?: Partial<DistributionTraits>;
}

export function translateOptions(overrides: TranslateOptionsOverrides = {}): TranslateOptions {
  return {
    pullSecretName: overrides.pullSecretName ?? null,
    revisionHistoryLimit: overrides.revisionHistoryLimit ?? 3,
    progressDeadlineS: overrides.progressDeadlineS ?? K8S_PROGRESS_DEADLINE_S,
    traits: traits(overrides.traits),
    extraReservedHostPorts: overrides.extraReservedHostPorts ?? [{ port: 22, protocol: 'TCP', reason: 'SSH port of server_1' }],
    traefikOnCluster: overrides.traefikOnCluster ?? false,
    serverNames: overrides.serverNames ?? [...DEFAULT_SERVER_NAMES],
    sink: overrides.sink ?? new DiagnosticSink(),
  };
}

export function translateContext(stack: CanonicalStack = canonicalStack(), options: TranslateOptionsOverrides = {}): TranslateContext {
  return createContext(stack, translateOptions(options));
}

// ---------------------------------------------------------------------------
// Orchestrator inputs
// ---------------------------------------------------------------------------

export function stackRef(overrides: Partial<StackRef> = {}): StackRef {
  return { project: 'shop', env: 'production', role: 'app', ...overrides };
}

const NODE_HOSTS: Record<string, string> = { server_1: '203.0.113.10', agent_1: '203.0.113.20' };

/** servers.yml key `name`; `agent*`/`worker*` names are workers, anything else a manager. */
export function nodeRef(name = 'server_1', overrides: Partial<ClusterNodeRef> = {}): ClusterNodeRef {
  const host = overrides.host ?? NODE_HOSTS[name] ?? '203.0.113.99';
  return {
    name,
    role: /^(agent|worker)/.test(name) ? 'worker' : 'manager',
    host,
    privateHost: host,
    connection: { host, port: 22, user: 'dockflow', privateKey: 'test-private-key' },
    ...overrides,
  };
}

/** k3s target of shop/production: `controlPlane` as the only manager, `agent_1` as the worker. */
export function target(controlPlane = 'server_1', overrides: Partial<OrchestratorTarget> = {}): OrchestratorTarget {
  const cp = nodeRef(controlPlane, { role: 'manager' });
  return {
    kind: 'k3s',
    project: 'shop',
    env: 'production',
    stackName: 'shop-production',
    controlPlane: cp,
    managers: [cp],
    workers: [nodeRef('agent_1', { role: 'worker' })],
    probes: [],
    ...overrides,
  };
}

export interface DeployInputOverrides
  extends Partial<Omit<StackDeployInput, 'ref' | 'compose' | 'images' | 'sibling' | 'files'>> {
  ref?: Partial<StackRef>;
  compose?: ParsedCompose | string | Record<string, unknown>;
  images?: Partial<ImageDelivery>;
  sibling?: Partial<Sibling>;
  files?: FileResolver | Record<string, FileFixture>;
}

/** Full deploy of role app, version 1.4.2, nothing built, no Helm release, every PD-10 field filled. */
export function deployInput(overrides: DeployInputOverrides = {}): StackDeployInput {
  return {
    ...overrides,
    ref: stackRef(overrides.ref),
    version: overrides.version ?? '1.4.2',
    compose: toCompose(overrides.compose),
    proxy: overrides.proxy,
    services: overrides.services ?? null,
    previousVersion: overrides.previousVersion ?? null,
    force: overrides.force ?? false,
    images: { built: [], mode: 'none', pullSecretName: null, ...overrides.images },
    helm: overrides.helm ?? [],
    helmDeclared: overrides.helmDeclared ?? [],
    sibling: sibling(overrides.sibling),
    serverNames: overrides.serverNames ?? [...DEFAULT_SERVER_NAMES],
    files: toResolver(overrides.files),
    onApplyProgress: overrides.onApplyProgress ?? (() => {}),
    rebindVolumes: overrides.rebindVolumes ?? false,
    traefikOnCluster: overrides.traefikOnCluster ?? false,
  };
}

/** config.yml of project `shop` on k3s; overrides replace top-level keys. */
export function config(overrides: Partial<DockflowConfig> = {}): DockflowConfig {
  return { project_name: 'shop', orchestrator: 'k3s', ...overrides };
}
