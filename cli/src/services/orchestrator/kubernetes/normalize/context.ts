// Normalizer contracts shared by every handler (design-01 1.2, 1.3, 1.5; PD-1): the input and
// result of normalizeStack, the per-render NormalizeContext, the service drafts and top-level
// tables handlers fill, and the small helpers they all need. Pure: no I/O, no clock; file contents
// come from input.files.

import type { ProxyConfig } from '../../../../utils/config';
import type { ParsedCompose } from '../../../compose';
import type { DiagnosticSink } from '../../diagnostics';
import type { FileResolveFailure, FileResolver } from '../../interfaces';
import type { DistributionTraits } from '../distribution';
import type {
  CanonicalFileSource,
  CanonicalService,
  CanonicalStack,
  CanonicalVolume,
  HealthSpec,
  Protocol,
  ProxyIntent,
  StackIdentity,
  StackRole,
  UpdateSpec,
} from '../model/types';
import { NameRegistry, serviceNameFor, volumeClaimNameFor } from '../naming';

// ---------------------------------------------------------------------------
// Entry point contract (DESIGN-CORE 3)
// ---------------------------------------------------------------------------

export interface NormalizeInput {
  compose: ParsedCompose;
  role: StackRole;
  identity: StackIdentity;
  /**
   * Passed for BOTH roles; undefined only when proxy.enabled is false. For role 'accessory' the
   * normalizer builds a ProxyIntent with domain: null (no injected routes) but still validates
   * entry points and cert resolvers and lets the translator emit explicit Traefik labels (C4).
   */
  proxy: ProxyConfig | undefined;
  /**
   * The other role, normalized first (pure, no diagnostics kept). Keys alone are not enough:
   * external-ness decides whether two claim names are a collision or the documented sharing
   * pattern, aliases and published ports collide across roles, and a Service applied with the
   * shared field manager would silently take over the other role's object.
   */
  sibling: {
    services: { key: string; name: string; aliases: string[]; published: { port: number; protocol: Protocol }[] }[];
    volumes: { key: string; claimName: string; external: boolean }[];
    middlewares: string[];
  };
  /**
   * servers.yml keys of this environment. `node.hostname` placement values are servers.yml keys;
   * a value absent from this list is error `placement.unknown-server` (never a Pending pod).
   * The translator receives the same list in TranslateOptions and applies nodeNameFor().
   */
  serverNames: string[];
  /**
   * Derived from config.registry only, never from StackDeployInput.images.mode: --skip-build sets
   * that to 'none', which would change the artifact between two deploys of one release. It decides
   * ImageSpec.ref (importedImageRef for built images under 'import') and the D12 pull rules.
   */
  imageDelivery: 'import' | 'registry' | 'none';
  files: FileResolver;
  traits: DistributionTraits;
  /** the ONE sink of this render (DESIGN-CORE 8.2); the normalizer never creates its own */
  sink: DiagnosticSink;
}

/** Diagnostics live in the shared sink, never in the result. */
export interface NormalizeResult {
  stack: CanonicalStack;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A mapping as YAML produces it: not null, not an array, not a class instance. */
export function isPlainMap(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Code-unit order (`a < b`), the only string order the model uses; never localeCompare. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortedKeys(map: Record<string, unknown>): string[] {
  return Object.keys(map).sort(compareCodeUnits);
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

const PLAIN_PATH_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Path segment of a map key (design-01 0.3): a plain key as is, any other key JSON-quoted in
 * brackets (`["com.example.team"]`). Join segments with childPath, which drops the dot before a
 * bracket.
 */
export function pathKey(key: string): string {
  return PLAIN_PATH_KEY.test(key) ? key : `[${JSON.stringify(key)}]`;
}

/** `services.web`, `services.web.labels["com.example.team"]`; an empty parent yields the key alone. */
export function childPath(parent: string, key: string): string {
  const segment = pathKey(key);
  if (parent === '') return segment;
  return segment.startsWith('[') ? `${parent}${segment}` : `${parent}.${segment}`;
}

/** `services.web.ports[1]` */
export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

// ---------------------------------------------------------------------------
// Proxy intent (DESIGN-CORE 3, K02)
// ---------------------------------------------------------------------------

/**
 * null only when the proxy is disabled (`proxy.enabled` defaults to false), for both roles.
 * Accessories get `domain: null`: route injection is decided by role, never by a null intent.
 */
export function proxyIntentFor(proxy: ProxyConfig | undefined, role: StackRole, env: string): ProxyIntent | null {
  if (proxy === undefined || proxy.enabled !== true) return null;
  const acme = proxy.acme !== false;
  // `manage` (default true) is declared by the config schema package; read structurally meanwhile.
  const { manage } = proxy as ProxyConfig & { manage?: boolean };
  return {
    domain: role === 'app' ? (proxy.domains?.[env] ?? null) : null,
    acme,
    entryPoint: acme ? 'websecure' : 'web',
    certResolver: acme ? 'letsencrypt' : null,
    manage: manage !== false,
  };
}

// ---------------------------------------------------------------------------
// File reads (design-01 1.5)
// ---------------------------------------------------------------------------

/** Resolver failures plus the two refusals made before the resolver is called. */
export type FileReadFailure = FileResolveFailure | 'absolute-path' | 'backslash-path';

export type FileReadResult = { ok: true; bytes: Uint8Array; rendered: boolean } | { ok: false; reason: FileReadFailure };

/** Which compose key reads the file. */
export type FileReadKind = 'env_file' | 'label_file' | 'secret' | 'config';

export interface FileReadDiagnostic {
  code: string;
  message: string;
  hint?: string;
}

/** The one mapping from a failed read to its diagnostic; `path` is the path as the user wrote it. */
export function fileReadDiagnostic(reason: FileReadFailure, path: string): FileReadDiagnostic {
  switch (reason) {
    case 'missing':
      return {
        code: 'files.not-found',
        message: `file ${path} was not found in the project`,
        hint: 'Paths are relative to the directory of the compose file and must stay inside the project.',
      };
    case 'directory':
      return { code: 'files.not-a-file', message: `${path} is a directory`, hint: 'Point the key at a file.' };
    case 'outside-project':
      return {
        code: 'files.outside-project',
        message: `${path} is outside the project directory and is not read`,
        hint: 'Move the file into the project; Dockflow never reads files from the machine running `dockflow` outside it.',
      };
    case 'unreadable':
      return { code: 'files.unreadable', message: `${path} could not be read`, hint: 'Check the file permissions.' };
    case 'absolute-path':
      return {
        code: 'files.absolute-path',
        message: `absolute paths are not supported: ${path} would be read on the machine running dockflow`,
        hint: 'Put the file in the project and use a path relative to the compose file.',
      };
    case 'backslash-path':
      return { code: 'files.backslash-path', message: `path ${path} must use / separators` };
  }
}

const ABSOLUTE_PATH = /^([\\/]|~|[A-Za-z]:)/;

/** The form the resolver receives: leading `./` removed, `//` collapsed. */
export function normalizeFilePath(path: string): string {
  let p = path.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

// ---------------------------------------------------------------------------
// Service drafts
// ---------------------------------------------------------------------------

/** A `traefik.*` label collected by identity.ts for routing.ts. */
export interface RoutingLabel {
  /** label key as written, e.g. `traefik.http.routers.api.rule` */
  key: string;
  value: string;
  /** compose path of the label entry */
  path: string;
  /** `deploy.labels` win over `labels` per key (design-01 7.1) */
  source: 'labels' | 'deploy.labels';
}

/**
 * A service while the handlers fill it: every CanonicalService field holding its documented
 * default, so each handler runs on its own, plus the facts one handler hands to a later one that
 * the model does not carry. finalize() drops the draft-only fields (draftToService).
 */
export interface ServiceDraft extends CanonicalService {
  /** `ports` entries as written after interpolation, [] when absent: the injected-route trigger (7.5) */
  rawPorts: unknown[];
  /** `traefik.*` entries of `labels` then `deploy.labels`, in that order */
  routingLabels: RoutingLabel[];
  /** `traefik.enable` once routing.ts parsed it; null when not written */
  routingEnable: boolean | null;
  /** `healthcheck.disable: true` or `test: [NONE]` was written; the model stores null for absent and disabled alike */
  healthcheckDisabled: boolean;
}

/** Compose.DEFAULT_UPDATE_CONFIG in model units: the per-field fallback of role app. */
export const DOCKFLOW_UPDATE_DEFAULTS: Readonly<UpdateSpec> = Object.freeze({
  parallelism: 1,
  delayMs: 10_000,
  failureAction: 'rollback',
  monitorMs: 30_000,
  order: 'start-first',
  maxFailureRatio: 0,
  defaults: 'dockflow',
});

/** Docker's own update_config defaults: the per-field fallback of role accessory. */
export const DOCKER_UPDATE_DEFAULTS: Readonly<UpdateSpec> = Object.freeze({
  parallelism: 1,
  delayMs: 0,
  failureAction: 'pause',
  monitorMs: 5_000,
  order: 'stop-first',
  maxFailureRatio: 0,
  defaults: 'docker',
});

export function defaultUpdateSpec(role: StackRole): UpdateSpec {
  return { ...(role === 'app' ? DOCKFLOW_UPDATE_DEFAULTS : DOCKER_UPDATE_DEFAULTS) };
}

/** stop_grace_period default (D10) */
export const DEFAULT_STOP_GRACE_PERIOD_MS = 10_000;

/** Docker healthcheck timing defaults (D10), applied field by field to a written healthcheck. */
export const HEALTHCHECK_DEFAULTS: Readonly<Omit<HealthSpec, 'test' | 'path'>> = Object.freeze({
  intervalMs: 30_000,
  timeoutMs: 30_000,
  retries: 3,
  startPeriodMs: 0,
  startIntervalMs: 5_000,
});

/**
 * A CanonicalService holding every documented default. `image` is empty until identity.ts reads
 * it; everything else is the value the model takes when the compose key is absent.
 */
export function defaultService(composeName: string, path: string, role: StackRole): CanonicalService {
  return {
    composeName,
    name: serviceNameFor(composeName).value,
    role,
    path,
    mode: 'replicated',
    workloadKind: 'Deployment',
    replicas: 1,
    image: { ref: '', composeRef: '', origin: 'pulled', pullPolicy: 'IfNotPresent' },
    process: {
      entrypoint: null,
      command: null,
      workingDir: null,
      user: null,
      groupAdd: [],
      tty: false,
      stdinOpen: false,
      init: false,
      stopGracePeriodMs: DEFAULT_STOP_GRACE_PERIOD_MS,
      hostname: null,
      postStart: null,
      preStop: null,
    },
    environment: [],
    ports: [],
    expose: [],
    mounts: [],
    files: [],
    healthcheck: null,
    update: defaultUpdateSpec(role),
    restart: { condition: 'any', delayMs: null, maxAttempts: null, windowMs: null },
    resources: {
      limits: { cpu: null, memory: null, pids: null },
      reservations: { cpu: null, memory: null },
    },
    placement: { constraints: [], spreadLabels: [], maxReplicasPerNode: null },
    security: {
      privileged: false,
      capAdd: [],
      capDrop: [],
      readOnlyRootFilesystem: false,
      noNewPrivileges: false,
      seccomp: 'default',
      apparmor: 'default',
      sysctls: {},
      hostPid: false,
      hostIpc: false,
    },
    network: {
      networks: ['default'],
      aliases: [],
      endpointMode: 'vip',
      hostNetwork: false,
      dns: [],
      dnsSearch: [],
      dnsOptions: [],
      extraHosts: [],
    },
    routes: [],
    containerLabels: {},
    serviceLabels: {},
    podAnnotations: {},
    extension: {
      kind: null,
      publish: null,
      loadBalancerSourceRanges: [],
      probes: null,
      nodeSelector: {},
      tolerations: [],
      fsGroup: null,
      podLabels: {},
    },
  };
}

export function newServiceDraft(key: string, path: string, ctx: NormalizeContext): ServiceDraft {
  return {
    ...defaultService(key, path, ctx.input.role),
    rawPorts: [],
    routingLabels: [],
    routingEnable: null,
    healthcheckDisabled: false,
  };
}

/** The model part of a draft, nothing else (no sorting: finalize owns the orders). */
export function draftToService(draft: ServiceDraft): CanonicalService {
  const { rawPorts: _rawPorts, routingLabels: _labels, routingEnable: _enable, healthcheckDisabled: _disabled, ...service } = draft;
  return service;
}

// ---------------------------------------------------------------------------
// Top-level tables (design-01 1.1 rows 3-5)
// ---------------------------------------------------------------------------
// Built before the services, then passed to the service handlers, the stack checks and finalize.
// Declared here because those modules never import each other.

/** x-dockflow.size default (DESIGN-CORE 3) */
export const DEFAULT_VOLUME_SIZE = '1Gi';

/**
 * A declared top-level volume holding the model defaults of design-01 6.2: volumes.ts creates it,
 * extension.ts writes the `volumes.<key>.x-dockflow` fields, the stack checks fill `usedBy`, and
 * finalize keeps the volumes a service of the role mounts.
 */
export type VolumeDraft = CanonicalVolume;

/** Every declared top-level volume by compose key, unused ones included. */
export type VolumeTable = Map<string, VolumeDraft>;

export function newVolumeDraft(key: string, ctx: NormalizeContext): VolumeDraft {
  return {
    key,
    name: volumeClaimNameFor(key).value,
    role: ctx.input.role,
    external: false,
    size: DEFAULT_VOLUME_SIZE,
    storageClass: ctx.traits.defaultStorageClass,
    accessMode: 'ReadWriteOnce',
    perReplica: false,
    labels: {},
    usedBy: [],
    path: childPath('volumes', key),
  };
}

/**
 * A declared secret or config (design-01 6.3). Inline `content` is known at once; a `file` is read
 * only when a service of the role references the entry (an unused entry is never read), so until
 * then `data` and `checksum` are null and `objectName` is the key.
 */
export interface FileSourceDraft extends CanonicalFileSource {
  /** the `file:` path as written; null for `content`, external and invalid entries */
  file: string | null;
}

/** Every declared secret and config by compose key, unused ones included. */
export interface FileSourceTable {
  secrets: Map<string, FileSourceDraft>;
  configs: Map<string, FileSourceDraft>;
}

export function newFileSourceDraft(kind: FileSourceDraft['kind'], key: string, ctx: NormalizeContext): FileSourceDraft {
  return {
    kind,
    key,
    objectName: key,
    role: ctx.input.role,
    external: false,
    data: null,
    checksum: null,
    path: childPath(kind === 'secret' ? 'secrets' : 'configs', key),
    file: null,
  };
}

/** The model part of a file source draft. */
export function draftToFileSource(draft: FileSourceDraft): CanonicalFileSource {
  const { file: _file, ...source } = draft;
  return source;
}

/** A declared top-level network (design-01 6.1): informational, the pod network is flat. */
export interface NetworkDraft {
  key: string;
  external: boolean;
  /** `name ?? external.name ?? key` */
  name: string;
  path: string;
}

/** Every declared top-level network by compose key. */
export type NetworkTable = Map<string, NetworkDraft>;

export function newNetworkDraft(key: string): NetworkDraft {
  return { key, external: false, name: key, path: childPath('networks', key) };
}

// ---------------------------------------------------------------------------
// NormalizeContext (design-01 1.3)
// ---------------------------------------------------------------------------

export class NormalizeContext {
  readonly input: NormalizeInput;
  /** input.sink: the sink owned by render(), passed through; never listed here */
  readonly sink: DiagnosticSink;
  /** DESIGN-CORE 5.4, spaces service | volume | middleware | file */
  readonly names: NameRegistry;
  readonly traits: DistributionTraits;
  /** null ONLY when proxy.enabled is false, for both roles; route injection tests input.role */
  readonly proxy: ProxyIntent | null;
  /** servers.yml keys of the environment (placement `node.hostname` validation) */
  readonly serverNames: ReadonlySet<string>;

  private readonly reads = new Map<string, ReturnType<FileResolver>>();
  private readonly fatal = new Set<string>();

  constructor(input: NormalizeInput, sink: DiagnosticSink = input.sink) {
    this.input = input;
    this.sink = sink;
    this.names = new NameRegistry(sink);
    this.traits = input.traits;
    this.proxy = proxyIntentFor(input.proxy, input.role, input.identity.env);
    this.serverNames = new Set(input.serverNames);
  }

  /**
   * Reads a file referenced by `env_file`, `label_file`, `secrets.*.file` or `configs.*.file`.
   * Absolute and backslash paths are refused before the resolver is called; resolver calls are
   * memoized per normalized path. A failure is reported at `diagPath` (every caller's own path),
   * except a missing file read with `required: false`, which the caller reports itself. `what`
   * names the reading key for the caller; the diagnostics are the same for every kind.
   */
  readFile(path: string, diagPath: string, _what: FileReadKind, options: { required?: boolean } = {}): FileReadResult {
    const failure = (reason: FileReadFailure): FileReadResult => {
      if (!(reason === 'missing' && options.required === false)) {
        const d = fileReadDiagnostic(reason, path);
        this.sink.error(d.code, diagPath, d.message, d.hint);
      }
      return { ok: false, reason };
    };
    if (ABSOLUTE_PATH.test(path)) return failure('absolute-path');
    if (path.includes('\\')) return failure('backslash-path');
    const normalized = normalizeFilePath(path);
    let result = this.reads.get(normalized);
    if (result === undefined) {
      result = this.input.files(normalized);
      this.reads.set(normalized, result);
    }
    return result.ok ? { ok: true, bytes: result.bytes, rendered: result.rendered } : failure(result.reason);
  }

  /** first `error` for this path wins; later handlers skip fields of a service marked fatal */
  markFatal(servicePath: string): void {
    this.fatal.add(servicePath);
  }

  isFatal(servicePath: string): boolean {
    return this.fatal.has(servicePath);
  }
}

/** The result of a document that cannot be normalized at all (not a mapping). */
export function emptyStack(input: NormalizeInput): CanonicalStack {
  return {
    schema: 1,
    identity: input.identity,
    role: input.role,
    services: [],
    volumes: [],
    files: [],
    middlewares: [],
    proxy: proxyIntentFor(input.proxy, input.role, input.identity.env),
  };
}
