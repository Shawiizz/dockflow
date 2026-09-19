// The D3 key registry (design-01 1.4, DESIGN-CORE 8.2): one policy for every key of the Compose
// specification pinned below, the normalizer's code catalogue, and the walker that refuses keys
// the registry does not know. Entries are data (R-S1-01): the docs page of the compose support
// matrix is generated from them (design-07 19.4), and the coverage test checks them against the
// vendored schema in `__tests__/kubernetes/fixtures/compose-spec/`.

import type { DiagnosticSeverity, DiagnosticSink } from '../../diagnostics';
import { childPath, compareCodeUnits, indexPath, isPlainMap, sortedKeys } from './context';

/**
 * The vendored Compose specification (`fixtures/compose-spec/README.md`): the upstream commit and
 * its date, which `keys.unknown` prints. `cli/scripts/vendor-compose-keys.ts` reads this pin.
 */
export const COMPOSE_SPEC_PIN = Object.freeze({
  commit: '914ec15d1fa498969c0df5c1d672306db3256089',
  date: '2026-09-17',
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyPolicyKind = 'translate' | 'translate-with-warning' | 'reject';

/**
 * The design-01 rows the entry follows: `T` translated, `T0` translated to nothing, `W` warned,
 * `R` refused, a combination when the handler decides per value, or `IMG-09` for build keys whose
 * warning is printed by the builder (`build.key-ignored`, outside the render's sink).
 */
export type KeyTable = 'T' | 'T0' | 'W' | 'R' | 'T/W' | 'T/R' | 'T/W/R' | 'T0/W' | 'T0/W/R' | 'IMG-09';

/** The normalizer module that reads the key (design-01 1.1). */
export type KeyHandler =
  | 'index'
  | 'identity'
  | 'security'
  | 'env'
  | 'ports'
  | 'volumes'
  | 'files'
  | 'healthcheck'
  | 'deploy'
  | 'network'
  | 'extension'
  | 'routing';

/**
 * A normalizer file that emits codes for a key: a handler, or the stack checks (design-01 10),
 * which read no key of their own. Its tests are `__tests__/kubernetes/normalize/<emitter>.test.ts`.
 */
export type CodeEmitter = KeyHandler | 'stack-checks';

export const CODE_EMITTERS: readonly CodeEmitter[] = [
  'index',
  'identity',
  'security',
  'env',
  'ports',
  'volumes',
  'files',
  'healthcheck',
  'deploy',
  'network',
  'extension',
  'routing',
  'stack-checks',
];

/** Group of the generated compose support table (design-07 19.4). */
export type KeyArea =
  | 'identity-image'
  | 'process'
  | 'environment-files'
  | 'ports-networking'
  | 'volumes'
  | 'healthcheck'
  | 'deploy'
  | 'security'
  | 'top-level';

/** What Dockflow's Swarm backend does with the key (`docker stack deploy` plus Dockflow's own rewrites). */
export type SwarmSupport = 'supported' | 'ignored' | 'rejected';

export interface KeyPolicy {
  /** schema path: `*` = any map key, `[]` = the items of a list (`services.*.ports[].target`) */
  path: string;
  policy: KeyPolicyKind;
  table: KeyTable;
  /** subtree handled as a whole: the walker neither descends nor reports unknown keys below */
  whole: boolean;
  /** map whose keys are user data (environment, labels, driver_opts...): not descended either */
  freeform: boolean;
  handler: KeyHandler;
  /**
   * Every code `handler` may emit for this key (design-01 1.4): at the key or below it, or at
   * another path because of its value (`network.flat` at `networks`, `image.missing` at the
   * service). The value readers and file reads the handler calls count as the handler's. Translator
   * codes never appear here (DESIGN-CORE 8.2). Empty for IMG-09 entries, whose warning comes from
   * the builder.
   */
  codes: readonly string[];
  /**
   * The same for codes other normalizer files emit for this key, by emitting file: index.ts for
   * service keys, routing.ts for Traefik labels, the stack checks for names and references.
   * `codeEmitters` lists both; each code is asserted in its emitter's test file (1.4 step 3).
   */
  otherEmitters?: Readonly<Partial<Record<CodeEmitter, readonly string[]>>>;
  area: KeyArea;
  swarm: SwarmSupport;
  /** short k3s outcome for the docs table */
  k3s: string;
  note?: string;
  /** a translated key that changes no generated object (the docs note says why) */
  effect?: 'none';
  /** the `x-dockflow` keys that change how this key is translated */
  xDockflow?: readonly string[];
}

export const KEY_AREAS: readonly { area: KeyArea; title: string }[] = [
  { area: 'identity-image', title: 'Identity and image' },
  { area: 'process', title: 'Process' },
  { area: 'environment-files', title: 'Environment and files' },
  { area: 'ports-networking', title: 'Ports and networking' },
  { area: 'volumes', title: 'Volumes' },
  { area: 'healthcheck', title: 'Healthcheck' },
  { area: 'deploy', title: 'Deploy' },
  { area: 'security', title: 'Security' },
  { area: 'top-level', title: 'Top-level' },
];

// ---------------------------------------------------------------------------
// Normalizer code catalogue
// ---------------------------------------------------------------------------

/**
 * The normalizer file that emits the code; when several do, the one whose design-01 rows own it
 * (the registry's `codes` and `otherEmitters` name every emitter per key). `values` are the
 * value-layer codes of design-01 2.4-2.9 that every handler reports, `context` the file-read codes
 * of NormalizeContext.readFile.
 */
export type NormalizeModule =
  | 'index'
  | 'keys'
  | 'interpolate'
  | 'values'
  | 'context'
  | 'identity'
  | 'security'
  | 'env'
  | 'ports'
  | 'volumes'
  | 'files'
  | 'healthcheck'
  | 'deploy'
  | 'network'
  | 'extension'
  | 'routing'
  | 'stack-checks';

export interface NormalizeCode {
  code: string;
  severity: DiagnosticSeverity;
  module: NormalizeModule;
}

const E: DiagnosticSeverity = 'error';
const W: DiagnosticSeverity = 'warning';
const I: DiagnosticSeverity = 'info';

function codes(module: NormalizeModule, entries: Record<string, DiagnosticSeverity>): NormalizeCode[] {
  return Object.keys(entries).map((code) => ({ code, severity: entries[code], module }));
}

/**
 * Every code the normalizer emits (design-01 as settled by 1.6, plus PD-6). Disjoint from the
 * translator's TRANSLATOR_CODES; one severity per code.
 */
export const NORMALIZE_CODES: readonly NormalizeCode[] = [
  ...codes('index', {
    'yaml.not-a-mapping': E,
    'yaml.unsupported-value': E,
    'keys.version-ignored': I,
    'keys.name-ignored': W,
    'unsupported.include': E,
    'unsupported.models': E,
    'unsupported.jobs': E,
    'names.invalid-service-key': E,
    'services.not-a-mapping': E,
  }),
  ...codes('keys', {
    'keys.unknown': E,
    'extension.misplaced': E,
  }),
  ...codes('interpolate', {
    'interpolate.unset': E,
    'interpolate.required': E,
    'interpolate.invalid': E,
  }),
  ...codes('values', {
    'values.invalid-boolean': E,
    'values.yaml11-boolean': W,
    'values.invalid-integer': E,
    'values.invalid-number': E,
    'values.invalid-type': E,
    'values.empty': E,
    'values.empty-key': E,
    'values.duplicate-key': I,
    'values.invalid-duration': E,
    'values.negative-duration': E,
    'values.duration-too-large': E,
    'values.invalid-bytes': E,
    'values.invalid-cpus': E,
    'values.invalid-mode': E,
    'names.invalid-key': E,
  }),
  ...codes('context', {
    'files.not-found': E,
    'files.not-a-file': E,
    'files.outside-project': E,
    'files.unreadable': E,
    'files.absolute-path': E,
    'files.backslash-path': E,
  }),
  ...codes('identity', {
    'names.sanitized': W,
    'image.invalid-reference': E,
    'image.missing': E,
    'image.missing-for-build': E,
    'build.accessory-not-built': W,
    'image.pull-policy-imported': E,
    'image.pull-never': W,
    'image.pull-policy-build': E,
    'image.pull-policy-periodic': W,
    'image.invalid-pull-policy': E,
    'image.pull-refresh-ignored': W,
    'image.platform-constraint': I,
    'image.platform-variant-ignored': W,
    'image.invalid-platform': E,
    'image.unsupported-platform-os': E,
    'unsupported.container-name': W,
    'labels.reserved': E,
    'labels.invalid-key': W,
    'labels.too-large': E,
    'label_file.parse-error': E,
    'unsupported.profiles': E,
    'unsupported.provider': E,
    'unsupported.extends': E,
    'keys.develop-ignored': I,
    'keys.attach-ignored': I,
    'extension.ignored': I,
    'process.empty-program': E,
    'process.relative-working-dir': E,
    'process.stop-signal-ignored': W,
    'process.empty-entrypoint': E,
    'process.empty-command': E,
    'process.invalid-shell-words': E,
    'process.shell-syntax': W,
    'hooks.too-many': E,
    'hooks.option-unsupported': E,
    'unsupported.pre-start': E,
  }),
  ...codes('security', {
    'security.user-name': E,
    'security.group-name': E,
    'security.invalid-capability': E,
    'security.seccomp-localhost': W,
    'security.selinux-ignored': W,
    'security.option-unsupported': E,
    'security.invalid-option': E,
    'security.unsafe-sysctl': E,
    'security.host-sysctl': E,
    'security.invalid-sysctl': E,
    'security.host-namespace': W,
    'security.option-ignored': W,
    'security.shared-namespace-unsupported': E,
    'security.invalid-namespace-mode': E,
    'security.uts-host-unsupported': E,
    'security.userns-unsupported': E,
    'security.cgroup-host-unsupported': E,
    'security.devices-unsupported': E,
    'security.runtime-unsupported': E,
    'security.api-socket-unsupported': E,
    'security.ulimits-ignored': W,
    'resources.windows-only': E,
    'resources.oom-ignored': W,
    'resources.blkio-ignored': W,
    'resources.storage-opt-ignored': W,
    'logging.ignored': W,
  }),
  ...codes('env', {
    'env.unset-variable': W,
    'env.invalid-name': E,
    'env.too-large': E,
    'env.swarm-service-name': W,
    'env.renamed-service-name': W,
    'env_file.optional-missing': I,
    'env_file.unsupported-format': E,
    'env_file.parse-error': E,
  }),
  ...codes('ports', {
    'ports.dynamic-range': E,
    'ports.range-mismatch': E,
    'ports.range-too-large': E,
    'ports.invalid': E,
    'ports.host-ip-ignored': W,
    'ports.invalid-target': E,
    'ports.loopback-host-port': I,
    'ports.ipv6-loopback-host-port': E,
    'ports.host-mode-needs-published': E,
    'ports.invalid-mode': E,
    'ports.invalid-app-protocol': W,
    'ports.duplicate': E,
    'ports.with-host-network': E,
    'expose.invalid': E,
  }),
  ...codes('volumes', {
    'volumes.copy-up-not-emulated': I,
    'volumes.undeclared': E,
    'volumes.anonymous-emptydir': I,
    'mounts.relative-bind': E,
    'mounts.windows-path': E,
    'mounts.conflicting-options': E,
    'mounts.option-ignored': W,
    'mounts.propagation-recursive': I,
    'mounts.selinux-ignored': W,
    'mounts.consistency-ignored': I,
    'mounts.invalid-option': E,
    'mounts.invalid': E,
    'mounts.tmpfs-source': E,
    'mounts.image-unsupported': E,
    'mounts.npipe-unsupported': E,
    'mounts.cluster-unsupported': E,
    'mounts.invalid-type': E,
    'mounts.bind-recursive-needs-readonly': E,
    'mounts.bind-recursive-ignored': W,
    'mounts.invalid-subpath': E,
    'mounts.volume-labels-ignored': W,
    'mounts.tmpfs-mode-ignored': W,
    'mounts.invalid-target': E,
    'mounts.duplicate-target': E,
    'mounts.invalid-tmpfs-option': E,
    'mounts.tmpfs-owner-ignored': W,
    'mounts.tmpfs-flag-ignored': W,
    'unsupported.volumes-from': E,
    'names.volume-sanitized': I,
    'volumes.name-ignored': W,
    'volumes.invalid-external-name': E,
    'volumes.driver-unsupported': E,
    'volumes.driver-opts-unsupported': E,
    'labels.invalid-value': W,
  }),
  ...codes('files', {
    'files.undeclared': E,
    'files.invalid-target': E,
    'files.relative-config-target': E,
    'files.mode-decimal': W,
    'files.ownership-ignored': W,
    'files.external-key': I,
    'files.environment-unsupported': E,
    'files.invalid-external-name': E,
    'files.name-ignored': W,
    'files.labels-ignored': W,
    'files.driver-unsupported': E,
    'files.template-driver-unsupported': E,
    'files.no-source': E,
    'files.several-sources': E,
  }),
  ...codes('healthcheck', {
    'healthcheck.inherits-image': W,
    'healthcheck.empty-test': E,
    'healthcheck.cmd-shell-arity': E,
    'healthcheck.invalid-test': E,
  }),
  ...codes('deploy', {
    'depends_on.no-ordering': I,
    'depends_on.condition-ignored': W,
    'depends_on.restart-ignored': W,
    'depends_on.invalid-condition': E,
    'depends_on.unknown-service': W,
    'restart.on-failure': I,
    'restart.max-retries-ignored': W,
    'restart.no-ignored': W,
    'restart.invalid': E,
    'restart.overridden': I,
    'deploy.scale-conflict': E,
    'deploy.replicas-global': E,
    'deploy.global-job': E,
    'deploy.invalid-mode': E,
    'deploy.invalid-endpoint-mode': E,
    'deploy.statefulset-pacing': I,
    'deploy.update-delay': I,
    'deploy.failure-action': W,
    'deploy.invalid-failure-action': E,
    'deploy.max-failure-ratio': W,
    'deploy.invalid-order': E,
    'deploy.update-config-on-job': W,
    'deploy.rollback-config': I,
    'deploy.restart-none': W,
    'deploy.invalid-restart-condition': E,
    'resources.pids-unsupported': W,
    'resources.generic-unsupported': E,
    'resources.devices-unsupported': E,
    'resources.conflict': E,
    'resources.cpu-period-alone': I,
    'resources.cpu-shares-ignored': W,
    'resources.realtime-unsupported': E,
    'resources.cpuset-unsupported': E,
    'resources.cpu-rounded': I,
    'resources.swap-ignored': W,
    'placement.unknown-server': E,
    'placement.node-id': E,
    'placement.engine-labels': E,
    'placement.invalid-constraint': E,
    'placement.invalid-preference': E,
  }),
  ...codes('network', {
    'network.flat': I,
    'network.undeclared': E,
    'network.traefik-public': I,
    'network.static-ip-unsupported': E,
    'network.attachment-option-ignored': W,
    'network.mode-none-unsupported': E,
    'network.shared-namespace-unsupported': E,
    'network.mode-with-networks': E,
    'network.unknown-link': E,
    'network.external-links-ignored': W,
    'network.invalid-hostname': E,
    'network.swarm-template': E,
    'network.domainname-ignored': W,
    'network.invalid-dns': E,
    'network.too-many-dns': E,
    'network.invalid-dns-search': E,
    'network.too-many-dns-search': E,
    'network.invalid-extra-host': E,
    'network.host-gateway-unsupported': E,
    'networks.not-needed': I,
    'networks.external-cross-stack': W,
    'networks.option-ignored': I,
    'networks.internal-not-enforced': W,
    'networks.ipv6-ignored': W,
  }),
  ...codes('extension', {
    'extension.invalid': E,
    'extension.kind-mode': E,
    'extension.per-replica-kind': E,
    'extension.external-volume': E,
    'extension.lb-source-ranges-without-lb': E,
    'extension.publish-unused': W,
    'extension.probes-disabled-healthcheck': E,
    'extension.probes-without-check': W,
    'extension.probes-none': I,
    'volumes.size-not-enforced': I,
  }),
  ...codes('routing', {
    'routing.container-labels': I,
    'routing.proxy-disabled': W,
    'routing.not-enabled': W,
    'routing.swarm-label-ignored': I,
    'routing.tcp-udp-unsupported': E,
    'routing.unsupported-label': E,
    'routing.missing-rule': E,
    'routing.v2-rule': E,
    'routing.unknown-entrypoint': E,
    'routing.entrypoint-not-exposed': W,
    'routing.web-served-with-acme': W,
    'routing.middleware-provider': E,
    'routing.unknown-middleware': E,
    'routing.unknown-certresolver': E,
    'routing.tls-domains-ignored': W,
    'routing.tls-options-unsupported': E,
    'routing.option-ignored': W,
    'routing.duplicate-router': E,
    'routing.backend-scheme-unsupported': E,
    'routing.healthcheck-ignored': W,
    'routing.internal-service': E,
    'routing.unknown-service': E,
    'routing.port-ambiguous': E,
    'routing.middleware-unsupported': E,
    'routing.middleware-option-unknown': E,
    'routing.middleware-index-required': E,
    'routing.middleware-index-gap': E,
    'routing.middleware-option-type': E,
    'routing.middleware-escaped-comma': W,
    'routing.middleware-plugin-unsupported': E,
    'routing.middleware-duplicate-option': E,
    'routing.middleware-several-types': E,
    'routing.middleware-deprecated': W,
    'routing.middleware-external-secret': I,
    'routing.users-file': E,
    'routing.middleware-missing-users': E,
    'routing.service-undefined': E,
    'routing.injection-disabled': I,
    'routing.injected-first-port': W,
    'routing.duplicate-injected-host': W,
    'names.middleware-collision': E,
    'names.middleware-sanitized': I,
  }),
  ...codes('stack-checks', {
    'names.sanitize-collision': E,
    'names.role-collision': E,
    'names.derived-collision': E,
    'names.volume-collision': E,
    'volumes.role-collision': E,
    'names.file-collision': E,
    'volumes.unused': I,
    'files.unused': I,
  }),
];

const CODE_INDEX: ReadonlyMap<string, NormalizeCode> = new Map(NORMALIZE_CODES.map((entry) => [entry.code, entry]));

export function isNormalizeCode(code: string): boolean {
  return CODE_INDEX.has(code);
}

export function normalizeCode(code: string): NormalizeCode | null {
  return CODE_INDEX.get(code) ?? null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface EntryOptions {
  table?: KeyTable;
  whole?: boolean;
  freeform?: boolean;
  codes?: readonly string[];
  otherEmitters?: Partial<Record<CodeEmitter, readonly string[]>>;
  swarm?: SwarmSupport;
  k3s?: string;
  note?: string;
  effect?: 'none';
  xDockflow?: readonly string[];
}

interface Scope {
  handler: KeyHandler;
  area: KeyArea;
}

const K3S_OUTCOME: Record<KeyTable, string> = {
  T: 'Translated',
  T0: 'Ignored',
  W: 'Translated with warning',
  R: 'Rejected',
  'T/W': 'Translated; some values warn',
  'T/R': 'Translated; some values are rejected',
  'T/W/R': 'Translated; some values warn or are rejected',
  'T0/W': 'Ignored; some values warn',
  'T0/W/R': 'Ignored; some values warn or are rejected',
  'IMG-09': 'Ignored with warning',
};

function entry(path: string, policy: KeyPolicyKind, defaultTable: KeyTable, scope: Scope, options: EntryOptions): KeyPolicy {
  const table = options.table ?? defaultTable;
  const result: KeyPolicy = {
    path,
    policy,
    table,
    whole: options.whole ?? false,
    freeform: options.freeform ?? false,
    handler: scope.handler,
    codes: options.codes ?? [],
    area: scope.area,
    swarm: options.swarm ?? 'supported',
    k3s: options.k3s ?? K3S_OUTCOME[table],
  };
  if (options.otherEmitters !== undefined) result.otherEmitters = options.otherEmitters;
  if (options.note !== undefined) result.note = options.note;
  if (options.effect !== undefined) result.effect = options.effect;
  if (options.xDockflow !== undefined) result.xDockflow = options.xDockflow;
  return result;
}

/** translated */
const tr = (path: string, scope: Scope, options: EntryOptions = {}): KeyPolicy => entry(path, 'translate', 'T', scope, options);
/** translated to nothing: no Kubernetes field, nothing lost (design-01 0.2 `T0`) */
const none = (path: string, scope: Scope, note: string, options: EntryOptions = {}): KeyPolicy =>
  entry(path, 'translate', 'T0', scope, { ...options, note, effect: 'none' });
/** translated or ignored with a warning */
const warned = (path: string, scope: Scope, options: EntryOptions = {}): KeyPolicy =>
  entry(path, 'translate-with-warning', 'W', scope, options);
/** refused: an error diagnostic, the render throws */
const refused = (path: string, scope: Scope, options: EntryOptions = {}): KeyPolicy => entry(path, 'reject', 'R', scope, options);

const BOOLEAN = ['values.invalid-boolean', 'values.yaml11-boolean'] as const;
const DURATION = ['values.invalid-duration', 'values.negative-duration', 'values.duration-too-large'] as const;
/** a key read as a string: a wrong type, or `""` where a value is required */
const STRING = ['values.invalid-type', 'values.empty'] as const;
/** `list_or_dict` (design-01 2.9) */
const LIST_OR_DICT = ['values.invalid-type', 'values.empty-key', 'values.duplicate-key'] as const;
const FILE_READ = [
  'files.absolute-path',
  'files.backslash-path',
  'files.not-found',
  'files.not-a-file',
  'files.outside-project',
  'files.unreadable',
] as const;
const INTERPOLATION = ['interpolate.unset', 'interpolate.required', 'interpolate.invalid'] as const;
/** reading an env file, parsing it and checking the variables it sets (`env.too-large` is reported at the service) */
const ENV_FILE_CONTENT = [
  ...FILE_READ,
  'env_file.optional-missing',
  'env_file.parse-error',
  'env.invalid-name',
  'env.too-large',
  'env.swarm-service-name',
  'env.renamed-service-name',
  ...INTERPOLATION,
] as const;
const LABEL_KEYS = ['labels.reserved', 'labels.invalid-key', 'labels.too-large'] as const;
/** an alias Service name: sanitized by the network handler, its collisions found by the stack checks at the service */
const ALIAS_NAME = ['names.sanitized', 'values.empty', 'values.invalid-type'] as const;
const ALIAS_COLLISIONS = { 'stack-checks': ['names.sanitize-collision', 'names.derived-collision'] } as const;
const FILE_MOUNT = [
  'files.undeclared',
  'files.ownership-ignored',
  'files.mode-decimal',
  'files.external-key',
  'mounts.duplicate-target',
  'values.invalid-type',
  'values.empty',
  'values.invalid-mode',
] as const;
/** the `bind`, `volume` and `tmpfs` mappings of a long-syntax mount */
const SUB_MAPPING = ['mounts.option-ignored', 'values.invalid-type'] as const;
const NETWORK_OPTION = ['networks.option-ignored'] as const;
/** reported at `networks.<key>` for an external network (design-01 6.1) */
const EXTERNAL_NETWORK = ['networks.not-needed', 'networks.external-cross-stack'] as const;
const ATTACHMENT_OPTION = ['network.attachment-option-ignored'] as const;

/** reported by routing.ts at the service, not at a label */
const ROUTING_SERVICE_CODES = ['routing.proxy-disabled', 'routing.not-enabled', 'routing.injection-disabled', 'routing.duplicate-injected-host'];
/** the injected default route follows the published ports (design-01 7.5) */
const ROUTING_PORT_CODES = ['routing.injected-first-port', 'routing.duplicate-injected-host'];

/**
 * Traefik labels come from `labels`, `label_file` and `deploy.labels` (design-01 7.1); routing.ts
 * parses them and reports at the label paths and at the service, value errors included. Only the
 * injected route's port codes come from `ports`.
 */
const ROUTING_LABEL_CODES = [
  ...NORMALIZE_CODES.filter(
    (entry) =>
      (entry.module === 'routing' || entry.code.startsWith('names.middleware-')) &&
      entry.code !== 'routing.injected-first-port' &&
      entry.code !== 'routing.duplicate-injected-host',
  ).map((entry) => entry.code),
  'values.empty',
  'values.invalid-boolean',
  'values.invalid-integer',
];

const ID: Scope = { handler: 'identity', area: 'identity-image' };
const PROC: Scope = { handler: 'identity', area: 'process' };
const SEC: Scope = { handler: 'security', area: 'security' };
const SEC_PROC: Scope = { handler: 'security', area: 'process' };
const ENV: Scope = { handler: 'env', area: 'environment-files' };
const FILES: Scope = { handler: 'files', area: 'environment-files' };
const PORTS: Scope = { handler: 'ports', area: 'ports-networking' };
const NET: Scope = { handler: 'network', area: 'ports-networking' };
const VOL: Scope = { handler: 'volumes', area: 'volumes' };
const HC: Scope = { handler: 'healthcheck', area: 'healthcheck' };
const DEP: Scope = { handler: 'deploy', area: 'deploy' };
const EXT: Scope = { handler: 'extension', area: 'deploy' };
const EXT_VOL: Scope = { handler: 'extension', area: 'volumes' };
const TOP: Scope = { handler: 'index', area: 'top-level' };

const BUILD_NOTE = 'The Dockflow builder reads only `context`, `dockerfile` and `args`; it warns about this key (`build.key-ignored`) on both orchestrators';

function buildIgnored(key: string, options: EntryOptions = {}): KeyPolicy {
  return entry(`services.*.build.${key}`, 'translate-with-warning', 'IMG-09', ID, { swarm: 'ignored', note: BUILD_NOTE, ...options });
}

function fileMountKeys(kind: 'secrets' | 'configs'): KeyPolicy[] {
  const base = `services.*.${kind}`;
  const targetCode = kind === 'secrets' ? 'files.invalid-target' : 'files.relative-config-target';
  // the stack checks re-check every reference the model carries (design-01 10 S6)
  const undeclared = { 'stack-checks': ['files.undeclared'] };
  const owner: EntryOptions = {
    table: 'T/W',
    codes: ['files.ownership-ignored', 'values.invalid-type'],
    note: 'Files mounted from Secrets and ConfigMaps are owned by root; a non-zero id warns (use `x-dockflow.fs_group`)',
    xDockflow: ['fs_group'],
  };
  return [
    tr(base, FILES, {
      codes: [...FILE_MOUNT, targetCode],
      otherEmitters: undeclared,
      note: `Mounted from the ${kind === 'secrets' ? 'Secret' : 'ConfigMap'} Dockflow creates for the top-level entry`,
    }),
    warned(`${base}[].gid`, FILES, owner),
    tr(`${base}[].mode`, FILES, {
      codes: ['values.invalid-mode', 'files.mode-decimal'],
      note: 'Becomes `defaultMode`; write bits are cleared, as Compose ignores them',
    }),
    tr(`${base}[].source`, FILES, { codes: [...STRING, 'files.undeclared', 'files.external-key'], otherEmitters: undeclared }),
    tr(`${base}[].target`, FILES, {
      codes: [targetCode, 'mounts.duplicate-target', ...STRING],
      note: kind === 'secrets' ? 'Relative targets are placed under `/run/secrets/`' : 'Must be an absolute path',
    }),
    warned(`${base}[].uid`, FILES, owner),
  ];
}

function topLevelFileKeys(kind: 'secrets' | 'configs'): KeyPolicy[] {
  const object = kind === 'secrets' ? 'Secret' : 'ConfigMap';
  const entries: KeyPolicy[] = [
    tr(kind, FILES, { codes: ['values.invalid-type'] }),
    tr(`${kind}.*`, FILES, {
      codes: ['names.invalid-key', 'files.no-source', 'files.several-sources', 'extension.ignored', 'values.invalid-type'],
      otherEmitters: { 'stack-checks': ['files.unused', 'names.file-collision'] },
      note: `Becomes an immutable ${object} named from its content; unused entries are not created`,
    }),
    refused(`${kind}.*.environment`, FILES, {
      codes: ['files.environment-unsupported', ...STRING],
      swarm: kind === 'secrets' ? 'supported' : 'rejected',
      note: 'Dockflow passes no process environment; render the value into a file with Nunjucks instead',
    }),
    tr(`${kind}.*.external`, FILES, {
      codes: ['files.invalid-external-name', 'files.external-key', ...BOOLEAN],
      note: `Pods mount an existing ${object} that Dockflow neither creates nor prunes`,
    }),
    tr(`${kind}.*.external.name`, FILES, { codes: ['files.invalid-external-name', ...STRING], note: 'Deprecated object form of `name`' }),
    tr(`${kind}.*.file`, FILES, { codes: [...FILE_READ, ...STRING], note: 'Read relative to the compose file, inside the project' }),
    warned(`${kind}.*.labels`, FILES, { whole: true, codes: ['files.labels-ignored'] }),
    warned(`${kind}.*.name`, FILES, {
      table: 'T/W',
      codes: ['files.name-ignored', 'files.invalid-external-name', ...STRING],
      note: 'Names the existing object when `external: true`; otherwise ignored with a warning',
    }),
    refused(`${kind}.*.template_driver`, FILES, { codes: ['files.template-driver-unsupported'], note: 'Render the content with Nunjucks instead' }),
  ];
  if (kind === 'secrets') {
    entries.push(
      refused('secrets.*.driver', FILES, { codes: ['files.driver-unsupported'] }),
      refused('secrets.*.driver_opts', FILES, { whole: true, codes: ['files.driver-unsupported'] }),
    );
  } else {
    entries.push(tr('configs.*.content', FILES, { swarm: 'rejected', codes: ['values.invalid-type'], note: 'Becomes the data of the ConfigMap' }));
  }
  return entries;
}

function hookKeys(kind: 'post_start' | 'pre_stop'): KeyPolicy[] {
  const base = `services.*.${kind}`;
  const option = (key: string, extra: EntryOptions = {}): KeyPolicy =>
    refused(`${base}[].${key}`, PROC, {
      swarm: 'rejected',
      codes: ['hooks.option-unsupported'],
      note: "Kubernetes runs lifecycle hooks with the container's user, working directory and environment",
      ...extra,
    });
  return [
    tr(base, PROC, {
      swarm: 'rejected',
      codes: ['hooks.too-many', 'values.invalid-type', 'values.empty'],
      note: `Becomes the container's ${kind === 'post_start' ? '`postStart`' : '`preStop`'} exec handler; one hook per container`,
    }),
    tr(`${base}[].command`, PROC, {
      swarm: 'rejected',
      codes: ['values.empty', 'values.invalid-type', 'process.invalid-shell-words', 'process.shell-syntax', 'process.empty-program'],
    }),
    option('environment', { freeform: true }),
    option('privileged', {
      table: 'T/R',
      codes: ['hooks.option-unsupported', ...BOOLEAN],
      note: '`false` is accepted; `true` is refused',
    }),
    option('user'),
    option('working_dir'),
  ];
}

export const KEY_REGISTRY: readonly KeyPolicy[] = [
  // -- top level ------------------------------------------------------------------------------
  none('version', TOP, 'Obsolete; ignored', { codes: ['keys.version-ignored'] }),
  warned('name', TOP, {
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['keys.name-ignored'],
    note: 'The stack and namespace names come from `project_name` and the environment',
  }),
  refused('include', TOP, {
    whole: true,
    swarm: 'rejected',
    codes: ['unsupported.include'],
    note: 'Dockflow deploys one compose file; share fragments with YAML anchors or a Nunjucks `{% include %}`',
  }),
  refused('models', TOP, { whole: true, swarm: 'rejected', codes: ['unsupported.models'] }),
  refused('jobs', TOP, {
    whole: true,
    swarm: 'rejected',
    codes: ['unsupported.jobs'],
    note: 'Use a service with `deploy.mode: replicated-job` for a run-to-completion task',
  }),
  tr('services', TOP, { codes: ['values.invalid-type'] }),
  tr('services.*', ID, {
    codes: ['names.sanitized', 'image.missing', 'image.missing-for-build', 'labels.too-large', 'extension.ignored'],
    otherEmitters: {
      index: ['names.invalid-service-key', 'services.not-a-mapping'],
      env: ['env.too-large'],
      routing: ROUTING_SERVICE_CODES,
      'stack-checks': ['names.role-collision', 'names.sanitize-collision', 'names.derived-collision'],
    },
    note: 'The service key names the workload, its Services and its env Secret (sanitized to a DNS label)',
  }),

  // -- identity, image, metadata --------------------------------------------------------------
  tr('services.*.image', ID, {
    codes: ['image.invalid-reference', 'image.missing', ...STRING],
    note: 'Built images are imported into the nodes, or pulled from the registry when one is configured',
  }),
  tr('services.*.build', ID, {
    codes: ['image.missing-for-build', 'build.accessory-not-built', 'values.invalid-type'],
    note: 'Built by the Dockflow builder for `docker-compose.yml` services; accessories are pulled',
  }),
  tr('services.*.build.context', ID, { effect: 'none', note: 'Read by the Dockflow builder' }),
  tr('services.*.build.dockerfile', ID, { effect: 'none', note: 'Read by the Dockflow builder' }),
  tr('services.*.build.args', ID, { freeform: true, effect: 'none', note: 'Read by the Dockflow builder' }),
  buildIgnored('additional_contexts', { whole: true }),
  buildIgnored('cache_from'),
  buildIgnored('cache_to'),
  buildIgnored('dockerfile_inline'),
  buildIgnored('entitlements'),
  buildIgnored('extra_hosts', { whole: true }),
  buildIgnored('isolation'),
  buildIgnored('labels', { whole: true }),
  buildIgnored('network'),
  buildIgnored('no_cache'),
  buildIgnored('no_cache_filter'),
  buildIgnored('platforms'),
  buildIgnored('privileged'),
  buildIgnored('provenance'),
  buildIgnored('pull'),
  buildIgnored('sbom'),
  buildIgnored('secrets', { whole: true }),
  buildIgnored('shm_size'),
  buildIgnored('ssh', { whole: true }),
  buildIgnored('tags'),
  buildIgnored('target'),
  buildIgnored('ulimits', { whole: true }),
  tr('services.*.pull_policy', ID, {
    table: 'T/W/R',
    swarm: 'rejected',
    codes: [
      'image.pull-policy-imported',
      'image.pull-never',
      'image.pull-policy-build',
      'image.pull-policy-periodic',
      'image.invalid-pull-policy',
      'values.invalid-type',
    ],
    note: 'Becomes `imagePullPolicy`; periodic policies pull on every pod start',
  }),
  warned('services.*.pull_refresh_after', ID, {
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['image.pull-refresh-ignored'],
  }),
  tr('services.*.platform', ID, {
    table: 'T/W/R',
    swarm: 'rejected',
    codes: [
      'image.platform-constraint',
      'image.platform-variant-ignored',
      'image.invalid-platform',
      'image.unsupported-platform-os',
      'values.invalid-type',
    ],
    note: 'Schedules pods on nodes of that OS and architecture; the variant is ignored',
  }),
  warned('services.*.container_name', ID, {
    swarm: 'ignored',
    k3s: 'Ignored with warning',
    codes: ['unsupported.container-name'],
    note: 'Pod names are generated by Kubernetes',
  }),
  tr('services.*.labels', ID, {
    freeform: true,
    codes: [...LABEL_KEYS, ...LIST_OR_DICT],
    otherEmitters: { routing: ROUTING_LABEL_CODES },
    note: 'Become pod annotations; `traefik.*` labels become routes and middlewares',
  }),
  tr('services.*.label_file', ID, {
    swarm: 'rejected',
    codes: [...FILE_READ, 'label_file.parse-error', ...LABEL_KEYS, ...INTERPOLATION, ...STRING],
    otherEmitters: { routing: ROUTING_LABEL_CODES },
    note: 'Read relative to the compose file; `labels` win over the file',
  }),
  tr('services.*.annotations', ID, {
    freeform: true,
    swarm: 'rejected',
    codes: [...LABEL_KEYS, ...LIST_OR_DICT],
    note: 'Become pod annotations',
  }),
  tr('services.*.deploy.labels', ID, {
    freeform: true,
    // workload annotations are not part of the pod template's 256 KiB check
    codes: ['labels.reserved', 'labels.invalid-key', ...LIST_OR_DICT],
    otherEmitters: { routing: ROUTING_LABEL_CODES },
    note: 'Become workload annotations; `traefik.*` labels become routes and middlewares',
  }),
  refused('services.*.profiles', ID, {
    swarm: 'rejected',
    codes: ['unsupported.profiles'],
    note: 'No Compose profile is activated, so the service would never start',
  }),
  refused('services.*.provider', ID, { whole: true, swarm: 'rejected', codes: ['unsupported.provider'] }),
  refused('services.*.extends', ID, {
    whole: true,
    swarm: 'rejected',
    codes: ['unsupported.extends'],
    note: 'Share settings with a YAML anchor and a merge key (`<<: *common`)',
  }),
  refused('services.*.models', ID, { whole: true, swarm: 'rejected', codes: ['unsupported.models'] }),
  none('services.*.develop', ID, 'Only configures local development (compose watch)', {
    whole: true,
    swarm: 'rejected',
    codes: ['keys.develop-ignored'],
  }),
  none('services.*.attach', ID, 'Only affects local log output', { swarm: 'rejected', codes: ['keys.attach-ignored'] }),

  // -- process --------------------------------------------------------------------------------
  tr('services.*.command', PROC, {
    codes: ['process.empty-command', 'process.empty-program', 'process.invalid-shell-words', 'process.shell-syntax', 'values.invalid-type'],
    note: 'Becomes the container `args`; a string is split into words as `docker stack deploy` does',
  }),
  tr('services.*.entrypoint', PROC, {
    codes: ['process.empty-entrypoint', 'process.empty-program', 'process.invalid-shell-words', 'process.shell-syntax', 'values.invalid-type'],
    note: 'Becomes the container `command`',
  }),
  tr('services.*.working_dir', PROC, { codes: ['process.relative-working-dir', 'values.invalid-type'] }),
  tr('services.*.tty', PROC, { codes: [...BOOLEAN] }),
  tr('services.*.stdin_open', PROC, { codes: [...BOOLEAN] }),
  tr('services.*.init', PROC, { codes: [...BOOLEAN], note: 'Shares the pod process namespace so the pause container reaps zombies' }),
  tr('services.*.stop_grace_period', PROC, { codes: [...DURATION], note: 'Becomes `terminationGracePeriodSeconds`' }),
  warned('services.*.stop_signal', PROC, {
    table: 'T/W',
    codes: ['process.stop-signal-ignored', 'values.invalid-type'],
    note: '`SIGTERM` is the default; another signal cannot be set on Kubernetes',
  }),
  ...hookKeys('post_start'),
  ...hookKeys('pre_stop'),
  refused('services.*.pre_start', PROC, {
    whole: true,
    swarm: 'rejected',
    codes: ['unsupported.pre-start'],
    note: 'Run the step in the entrypoint, or as a service with `deploy.mode: replicated-job`',
  }),
  warned('services.*.logging', SEC_PROC, {
    whole: true,
    k3s: 'Ignored with warning',
    codes: ['logging.ignored'],
    note: 'Container logs are collected and rotated by the kubelet; read them with `dockflow logs`',
  }),

  // -- security -------------------------------------------------------------------------------
  tr('services.*.user', SEC, { codes: ['security.user-name', 'values.invalid-integer', ...STRING], note: 'Numeric user and group ids only' }),
  tr('services.*.group_add', SEC, {
    swarm: 'rejected',
    codes: ['security.group-name', 'values.invalid-integer', 'values.invalid-type'],
    note: 'Numeric group ids only',
  }),
  warned('services.*.privileged', SEC, {
    table: 'T/W',
    swarm: 'ignored',
    codes: [...BOOLEAN],
    note: '`privileged: true` is applied and warned about: the container gets full access to the node',
  }),
  tr('services.*.cap_add', SEC, { codes: ['security.invalid-capability', 'values.invalid-type'] }),
  tr('services.*.cap_drop', SEC, { codes: ['security.invalid-capability', 'values.invalid-type'] }),
  tr('services.*.read_only', SEC, { codes: [...BOOLEAN] }),
  tr('services.*.security_opt', SEC, {
    table: 'T/W/R',
    swarm: 'ignored',
    codes: ['security.seccomp-localhost', 'security.selinux-ignored', 'security.option-unsupported', 'security.invalid-option', 'values.invalid-type'],
    note: '`no-new-privileges`, `seccomp` and `apparmor` are translated; SELinux labels are ignored',
  }),
  tr('services.*.sysctls', SEC, {
    freeform: true,
    codes: ['security.unsafe-sysctl', 'security.host-sysctl', 'security.invalid-sysctl', 'values.empty', ...LIST_OR_DICT],
    note: 'Only the kubelet safe set is accepted',
  }),
  warned('services.*.pid', SEC, {
    table: 'T/W/R',
    swarm: 'ignored',
    codes: ['security.host-namespace', 'security.shared-namespace-unsupported', 'security.invalid-namespace-mode', 'values.invalid-type'],
    note: '`host` is applied with a warning; `service:` and `container:` are refused',
  }),
  warned('services.*.ipc', SEC, {
    table: 'T/W/R',
    swarm: 'ignored',
    codes: [
      'security.host-namespace',
      'security.option-ignored',
      'security.shared-namespace-unsupported',
      'security.invalid-namespace-mode',
      'values.invalid-type',
    ],
    note: '`host` is applied with a warning; `private` and `shareable` are the pod default',
  }),
  refused('services.*.uts', SEC, {
    table: 'T/R',
    swarm: 'rejected',
    codes: ['security.uts-host-unsupported', 'security.invalid-namespace-mode', 'values.invalid-type'],
    note: 'Only accepted together with `network_mode: host`',
  }),
  refused('services.*.userns_mode', SEC, {
    table: 'T/R',
    swarm: 'ignored',
    codes: ['security.userns-unsupported', 'values.invalid-type'],
    note: '`host` is the pod default and accepted',
  }),
  refused('services.*.cgroup', SEC, {
    table: 'T/R',
    swarm: 'ignored',
    codes: ['security.cgroup-host-unsupported', 'security.invalid-namespace-mode', 'values.invalid-type'],
    note: '`private` is the default and accepted; `host` is refused',
  }),
  warned('services.*.cgroup_parent', SEC, { swarm: 'ignored', k3s: 'Ignored with warning', codes: ['security.option-ignored'] }),
  refused('services.*.devices', SEC, { whole: true, swarm: 'ignored', codes: ['security.devices-unsupported'] }),
  refused('services.*.device_cgroup_rules', SEC, { swarm: 'rejected', codes: ['security.devices-unsupported'] }),
  refused('services.*.gpus', SEC, { whole: true, swarm: 'rejected', codes: ['resources.devices-unsupported'] }),
  refused('services.*.runtime', SEC, {
    table: 'T/R',
    swarm: 'rejected',
    codes: ['security.runtime-unsupported', 'values.invalid-type'],
    note: '`runc` is accepted; other runtimes are refused',
  }),
  refused('services.*.isolation', SEC, {
    table: 'T/R',
    codes: ['resources.windows-only', 'values.invalid-type'],
    note: 'Windows containers only; `default` is accepted',
  }),
  refused('services.*.credential_spec', SEC, { whole: true, codes: ['resources.windows-only'], note: 'Windows containers only' }),
  refused('services.*.use_api_socket', SEC, {
    table: 'T/R',
    swarm: 'rejected',
    codes: ['security.api-socket-unsupported', ...BOOLEAN],
    note: 'k3s nodes have no Docker API socket',
  }),
  warned('services.*.ulimits', SEC, {
    whole: true,
    k3s: 'Ignored with warning',
    codes: ['security.ulimits-ignored'],
    note: "Containers inherit the limits of the node's container runtime",
  }),
  warned('services.*.oom_score_adj', SEC, { swarm: 'rejected', k3s: 'Ignored with warning', codes: ['resources.oom-ignored'] }),
  warned('services.*.oom_kill_disable', SEC, { swarm: 'rejected', k3s: 'Ignored with warning', codes: ['resources.oom-ignored'] }),
  warned('services.*.blkio_config', SEC, {
    whole: true,
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['resources.blkio-ignored'],
  }),
  warned('services.*.storage_opt', SEC, {
    whole: true,
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['resources.storage-opt-ignored'],
  }),

  // -- environment and files ------------------------------------------------------------------
  tr('services.*.environment', ENV, {
    freeform: true,
    codes: ['env.unset-variable', 'env.invalid-name', 'env.too-large', 'env.swarm-service-name', 'env.renamed-service-name', ...LIST_OR_DICT],
    note: 'Stored in an immutable Secret read with `envFrom`',
  }),
  tr('services.*.env_file', ENV, {
    codes: [...ENV_FILE_CONTENT, 'env_file.unsupported-format', ...STRING],
    note: 'Read relative to the compose file with the Compose dotenv rules; `environment` wins',
  }),
  tr('services.*.env_file[].format', ENV, { codes: ['env_file.unsupported-format', 'values.invalid-type'], note: '`raw` reads the file verbatim' }),
  tr('services.*.env_file[].path', ENV, { codes: [...ENV_FILE_CONTENT, ...STRING] }),
  tr('services.*.env_file[].required', ENV, { codes: [...BOOLEAN, 'env_file.optional-missing'] }),
  ...fileMountKeys('secrets'),
  ...fileMountKeys('configs'),

  // -- ports and networking -------------------------------------------------------------------
  tr('services.*.ports', PORTS, {
    codes: [
      'ports.dynamic-range',
      'ports.range-mismatch',
      'ports.range-too-large',
      'ports.invalid',
      'ports.duplicate',
      'ports.with-host-network',
      'ports.host-ip-ignored',
      'ports.loopback-host-port',
      'ports.ipv6-loopback-host-port',
      'values.invalid-type',
    ],
    otherEmitters: { routing: ROUTING_PORT_CODES },
    note: 'Published ports become a LoadBalancer Service on every node; `x-dockflow.publish` changes the exposure',
    xDockflow: ['publish', 'lb_source_ranges'],
  }),
  tr('services.*.ports[].target', PORTS, { codes: ['ports.invalid-target', ...STRING] }),
  tr('services.*.ports[].published', PORTS, { codes: ['ports.dynamic-range', 'ports.invalid', 'ports.duplicate', 'values.invalid-type'] }),
  tr('services.*.ports[].host_ip', PORTS, {
    codes: ['ports.host-ip-ignored', 'ports.loopback-host-port', 'ports.ipv6-loopback-host-port', 'ports.invalid', 'values.invalid-type'],
    note: 'Honoured for node-bound ports (`mode: host`, `x-dockflow.publish: hostport`); refused on a load balancer',
    xDockflow: ['publish'],
  }),
  tr('services.*.ports[].protocol', PORTS, { codes: ['ports.invalid', 'values.invalid-type'] }),
  tr('services.*.ports[].mode', PORTS, {
    codes: ['ports.invalid-mode', 'ports.host-mode-needs-published'],
    note: '`host` binds the port on the node running the pod',
  }),
  tr('services.*.ports[].name', PORTS, { codes: ['values.invalid-type'], note: 'Names the container and Service ports when valid' }),
  tr('services.*.ports[].app_protocol', PORTS, { codes: ['ports.invalid-app-protocol', 'values.invalid-type'] }),
  tr('services.*.expose', PORTS, {
    swarm: 'ignored',
    codes: ['expose.invalid', 'ports.range-too-large', 'values.invalid-type'],
    note: 'Ports of the cluster-internal Service',
  }),
  none('services.*.networks', NET, 'Kubernetes has one flat pod network: membership does not isolate services', {
    codes: ['network.flat', 'network.undeclared', 'network.traefik-public', 'values.invalid-type'],
    otherEmitters: { 'stack-checks': ['network.undeclared'] },
  }),
  none('services.*.networks.*', NET, 'Informational; the network must be declared at top level', {
    codes: ['network.undeclared', 'network.traefik-public', 'values.invalid-type'],
    otherEmitters: { 'stack-checks': ['network.undeclared'] },
  }),
  tr('services.*.networks.*.aliases', NET, {
    codes: [...ALIAS_NAME],
    otherEmitters: ALIAS_COLLISIONS,
    note: 'Each alias becomes a Service with the same selector and ports',
  }),
  refused('services.*.networks.*.ipv4_address', NET, {
    swarm: 'ignored',
    codes: ['network.static-ip-unsupported'],
    note: 'Pod addresses are assigned by the cluster',
  }),
  refused('services.*.networks.*.ipv6_address', NET, {
    swarm: 'ignored',
    codes: ['network.static-ip-unsupported'],
    note: 'Pod addresses are assigned by the cluster',
  }),
  warned('services.*.networks.*.driver_opts', NET, { whole: true, swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.networks.*.gw_priority', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.networks.*.interface_name', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.networks.*.link_local_ips', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.networks.*.mac_address', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.networks.*.priority', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.network_mode', NET, {
    table: 'T/W/R',
    swarm: 'ignored',
    k3s: 'Translated / Rejected',
    codes: [
      'network.mode-none-unsupported',
      'network.shared-namespace-unsupported',
      'network.mode-with-networks',
      // any other value names the one network the container joins
      'network.undeclared',
      'network.flat',
      ...STRING,
    ],
    note: '`host` is supported (with a warning); `none`, `service:` and `container:` are rejected',
  }),
  tr('services.*.links', NET, {
    swarm: 'ignored',
    codes: ['network.unknown-link', ...ALIAS_NAME],
    otherEmitters: ALIAS_COLLISIONS,
    note: 'An alias becomes a Service name',
  }),
  warned('services.*.external_links', NET, {
    swarm: 'ignored',
    k3s: 'Ignored with warning',
    codes: ['network.external-links-ignored', 'values.invalid-type'],
  }),
  tr('services.*.hostname', NET, {
    codes: ['network.invalid-hostname', 'network.swarm-template', ...STRING],
    note: 'A single DNS label; every replica gets the same host name',
  }),
  warned('services.*.domainname', NET, {
    swarm: 'ignored',
    k3s: 'Ignored with warning',
    codes: ['network.domainname-ignored', 'values.invalid-type'],
  }),
  warned('services.*.mac_address', NET, { swarm: 'ignored', k3s: 'Ignored with warning', codes: [...ATTACHMENT_OPTION] }),
  warned('services.*.dns', NET, {
    codes: ['network.invalid-dns', 'network.too-many-dns', 'values.invalid-type'],
    note: 'Added after the cluster DNS, which answers first',
  }),
  tr('services.*.dns_search', NET, { codes: ['network.invalid-dns-search', 'network.too-many-dns-search', 'values.invalid-type'] }),
  tr('services.*.dns_opt', NET, { codes: [...STRING] }),
  tr('services.*.extra_hosts', NET, {
    freeform: true,
    // a malformed entry is `network.invalid-extra-host`; a host listed twice is a valid hosts file
    codes: ['network.invalid-extra-host', 'network.host-gateway-unsupported', 'values.invalid-type'],
    note: 'Become `hostAliases`; `host-gateway` has no fixed address on Kubernetes',
  }),

  // -- volumes --------------------------------------------------------------------------------
  tr('services.*.volumes', VOL, {
    codes: [
      'volumes.copy-up-not-emulated',
      'volumes.anonymous-emptydir',
      'volumes.undeclared',
      'mounts.invalid',
      'mounts.relative-bind',
      'mounts.windows-path',
      'mounts.conflicting-options',
      'mounts.option-ignored',
      'mounts.propagation-recursive',
      'mounts.selinux-ignored',
      'mounts.consistency-ignored',
      'mounts.invalid-option',
      'mounts.invalid-target',
      'mounts.duplicate-target',
      'mounts.invalid-type',
      'values.invalid-type',
    ],
    otherEmitters: {
      // run by the stack checks once every workload kind is known
      extension: ['extension.per-replica-kind'],
      'stack-checks': ['volumes.undeclared'],
    },
    note: 'Named volumes become PersistentVolumeClaims, absolute host paths `hostPath` mounts; relative binds are refused',
  }),
  tr('services.*.volumes[].type', VOL, {
    table: 'T/R',
    codes: ['mounts.image-unsupported', 'mounts.npipe-unsupported', 'mounts.cluster-unsupported', 'mounts.invalid-type'],
    note: '`volume`, `bind` and `tmpfs` are supported',
  }),
  tr('services.*.volumes[].source', VOL, {
    codes: ['volumes.undeclared', 'mounts.relative-bind', 'mounts.windows-path', 'mounts.tmpfs-source', ...STRING],
    otherEmitters: { 'stack-checks': ['volumes.undeclared'] },
  }),
  tr('services.*.volumes[].target', VOL, { codes: ['mounts.invalid-target', 'mounts.duplicate-target', ...STRING] }),
  tr('services.*.volumes[].read_only', VOL, {
    // ignored with a warning on an anonymous volume and on a tmpfs mount
    codes: [...BOOLEAN, 'mounts.option-ignored', 'mounts.tmpfs-flag-ignored'],
  }),
  none('services.*.volumes[].consistency', VOL, 'Only applies to Docker Desktop', { codes: ['mounts.consistency-ignored'] }),
  // a type-specific mapping on a mount of another type is ignored with a warning
  tr('services.*.volumes[].bind', VOL, { codes: [...SUB_MAPPING] }),
  tr('services.*.volumes[].bind.propagation', VOL, { codes: ['mounts.propagation-recursive', 'mounts.option-ignored', 'mounts.invalid-option'] }),
  warned('services.*.volumes[].bind.create_host_path', VOL, {
    table: 'T/W',
    codes: [...BOOLEAN],
    note: '`false` is not enforced: the container runtime creates a missing directory',
  }),
  tr('services.*.volumes[].bind.recursive', VOL, {
    table: 'T/W/R',
    codes: ['mounts.bind-recursive-needs-readonly', 'mounts.bind-recursive-ignored', 'mounts.invalid-option'],
    note: '`readonly` becomes `recursiveReadOnly: IfPossible`; `disabled` is ignored with a warning',
  }),
  warned('services.*.volumes[].bind.selinux', VOL, { k3s: 'Ignored with warning', codes: ['mounts.selinux-ignored'] }),
  tr('services.*.volumes[].volume', VOL, { codes: [...SUB_MAPPING] }),
  tr('services.*.volumes[].volume.nocopy', VOL, {
    effect: 'none',
    codes: [...BOOLEAN, 'mounts.option-ignored'],
    note: 'Kubernetes never copies image files into a volume; `nocopy` only silences that notice',
  }),
  tr('services.*.volumes[].volume.subpath', VOL, { codes: ['mounts.invalid-subpath', 'mounts.option-ignored', 'values.invalid-type'] }),
  warned('services.*.volumes[].volume.labels', VOL, {
    whole: true,
    k3s: 'Ignored with warning',
    codes: ['mounts.volume-labels-ignored'],
    note: 'Set `labels` on the top-level volume instead',
  }),
  tr('services.*.volumes[].tmpfs', VOL, { codes: [...SUB_MAPPING] }),
  tr('services.*.volumes[].tmpfs.size', VOL, { codes: ['values.invalid-bytes'] }),
  warned('services.*.volumes[].tmpfs.mode', VOL, {
    k3s: 'Ignored with warning',
    codes: ['mounts.tmpfs-mode-ignored'],
    note: 'Memory-backed volumes are world-writable',
  }),
  refused('services.*.volumes[].image', VOL, {
    whole: true,
    codes: ['mounts.image-unsupported', 'mounts.option-ignored'],
    note: 'Image mounts need Kubernetes 1.36; Dockflow supports clusters from 1.34',
  }),
  tr('services.*.tmpfs', VOL, {
    swarm: 'ignored',
    codes: [
      'mounts.invalid-tmpfs-option',
      'mounts.tmpfs-mode-ignored',
      'mounts.tmpfs-owner-ignored',
      'mounts.tmpfs-flag-ignored',
      'mounts.invalid-target',
      'mounts.duplicate-target',
      'values.invalid-bytes',
      ...STRING,
    ],
    note: 'Memory-backed `emptyDir` volumes',
  }),
  tr('services.*.shm_size', VOL, {
    swarm: 'ignored',
    codes: ['values.invalid-bytes', 'mounts.duplicate-target'],
    note: 'A memory-backed volume mounted at `/dev/shm`',
  }),
  refused('services.*.volumes_from', VOL, {
    swarm: 'rejected',
    codes: ['unsupported.volumes-from'],
    note: 'Mount a named volume in both services instead',
  }),
  tr('volumes', VOL, { codes: ['values.invalid-type'] }),
  tr('volumes.*', VOL, {
    codes: ['names.invalid-key', 'names.volume-sanitized', 'extension.ignored', 'values.invalid-type'],
    otherEmitters: { 'stack-checks': ['volumes.unused', 'names.volume-collision', 'volumes.role-collision'] },
    note: 'Becomes a PersistentVolumeClaim, never pruned; unmounted volumes are not created',
    xDockflow: ['size', 'storage_class', 'access_mode', 'per_replica'],
  }),
  tr('volumes.*.driver', VOL, { table: 'T/R', codes: ['volumes.driver-unsupported', 'values.invalid-type'], note: 'Only `local` is accepted' }),
  refused('volumes.*.driver_opts', VOL, {
    whole: true,
    table: 'T/R',
    codes: ['volumes.driver-opts-unsupported', 'values.invalid-type'],
    note: 'Mount a host path directly, or create the claim and use `external: true`; an empty map is accepted',
  }),
  tr('volumes.*.external', VOL, {
    codes: ['volumes.invalid-external-name', ...BOOLEAN],
    note: 'Pods mount an existing claim that Dockflow never creates or deletes',
  }),
  tr('volumes.*.external.name', VOL, { codes: ['volumes.invalid-external-name', ...STRING], note: 'Deprecated object form of `name`' }),
  warned('volumes.*.name', VOL, {
    table: 'T/W',
    codes: ['volumes.name-ignored', 'volumes.invalid-external-name', ...STRING],
    note: 'Names the existing claim when `external: true`; otherwise ignored with a warning',
  }),
  tr('volumes.*.labels', VOL, {
    freeform: true,
    codes: ['labels.invalid-key', 'labels.invalid-value', 'labels.reserved', ...LIST_OR_DICT],
    note: 'Become labels of the claim',
  }),
  tr('volumes.*.x-dockflow', EXT_VOL, {
    whole: true,
    swarm: 'ignored',
    codes: ['extension.invalid', 'extension.external-volume', 'extension.per-replica-kind', 'volumes.size-not-enforced', 'values.invalid-type'],
    note: 'Size, storage class, access mode and per-replica claims (see the `x-dockflow` reference)',
  }),

  // -- healthcheck ----------------------------------------------------------------------------
  tr('services.*.healthcheck', HC, {
    codes: ['healthcheck.inherits-image', 'values.invalid-type'],
    note: 'Becomes readiness and liveness probes (and a startup probe with `start_period`)',
    xDockflow: ['probes'],
  }),
  tr('services.*.healthcheck.test', HC, {
    codes: ['healthcheck.empty-test', 'healthcheck.cmd-shell-arity', 'healthcheck.invalid-test', 'healthcheck.inherits-image', 'values.invalid-type'],
  }),
  tr('services.*.healthcheck.disable', HC, { codes: [...BOOLEAN] }),
  tr('services.*.healthcheck.interval', HC, { codes: [...DURATION] }),
  tr('services.*.healthcheck.timeout', HC, { codes: [...DURATION] }),
  tr('services.*.healthcheck.retries', HC, { codes: ['values.invalid-integer'] }),
  tr('services.*.healthcheck.start_period', HC, { codes: [...DURATION] }),
  tr('services.*.healthcheck.start_interval', HC, { codes: [...DURATION] }),

  // -- deploy ---------------------------------------------------------------------------------
  tr('services.*.deploy', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.mode', DEP, {
    codes: ['deploy.global-job', 'deploy.invalid-mode', 'values.invalid-type'],
    note: '`replicated` becomes a Deployment (or StatefulSet), `global` a DaemonSet, `replicated-job` a Job',
    xDockflow: ['kind'],
  }),
  tr('services.*.deploy.replicas', DEP, { codes: ['values.invalid-integer', 'deploy.replicas-global', 'deploy.scale-conflict'] }),
  tr('services.*.deploy.endpoint_mode', DEP, {
    codes: ['deploy.invalid-endpoint-mode', 'values.invalid-type'],
    note: '`dnsrr` makes the Service headless',
  }),
  tr('services.*.deploy.update_config', DEP, {
    codes: ['deploy.update-config-on-job', 'values.invalid-type'],
    note: 'Becomes the rolling update strategy and `minReadySeconds`',
  }),
  tr('services.*.deploy.update_config.parallelism', DEP, {
    codes: ['values.invalid-integer', 'deploy.statefulset-pacing', 'deploy.update-config-on-job'],
  }),
  none('services.*.deploy.update_config.delay', DEP, 'Kubernetes has no pause between update batches', {
    codes: ['deploy.update-delay', 'deploy.update-config-on-job', ...DURATION],
  }),
  tr('services.*.deploy.update_config.failure_action', DEP, {
    table: 'T/W/R',
    codes: ['deploy.failure-action', 'deploy.invalid-failure-action', 'deploy.update-config-on-job', 'values.invalid-type'],
    note: 'A failed app rollout is always reverted; a failed accessory rollout stops the deploy',
  }),
  tr('services.*.deploy.update_config.monitor', DEP, {
    codes: [...DURATION, 'deploy.update-config-on-job'],
    note: 'Becomes `minReadySeconds`',
  }),
  warned('services.*.deploy.update_config.max_failure_ratio', DEP, {
    table: 'T/W/R',
    codes: ['deploy.max-failure-ratio', 'values.invalid-number', 'deploy.update-config-on-job'],
    note: 'Any failed pod fails the rollout',
  }),
  tr('services.*.deploy.update_config.order', DEP, {
    codes: ['deploy.invalid-order', 'deploy.update-config-on-job', 'values.invalid-type'],
    note: '`start-first` surges, `stop-first` replaces in place',
  }),
  none('services.*.deploy.rollback_config', DEP, 'A revert re-applies the previous objects with their own update settings', {
    whole: true,
    codes: ['deploy.rollback-config', 'values.invalid-type'],
  }),
  tr('services.*.deploy.restart_policy', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.restart_policy.condition', DEP, {
    table: 'T/W/R',
    codes: ['restart.on-failure', 'deploy.restart-none', 'deploy.invalid-restart-condition', 'restart.overridden', 'values.invalid-type'],
    note: 'Long-running workloads always restart; Jobs never restart a failed pod in place',
  }),
  warned('services.*.deploy.restart_policy.delay', DEP, {
    codes: [...DURATION],
    note: 'Kubernetes restarts containers with its own back-off',
  }),
  warned('services.*.deploy.restart_policy.window', DEP, {
    codes: [...DURATION],
    note: 'Kubernetes restarts containers with its own back-off',
  }),
  warned('services.*.deploy.restart_policy.max_attempts', DEP, {
    table: 'T/W',
    codes: ['values.invalid-integer'],
    note: 'The retry limit of a `replicated-job`; warned for long-running workloads',
  }),
  tr('services.*.deploy.resources', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.resources.limits', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.resources.limits.cpus', DEP, { codes: ['values.invalid-cpus', 'resources.cpu-rounded', 'resources.conflict'] }),
  tr('services.*.deploy.resources.limits.memory', DEP, { codes: ['values.invalid-bytes', 'resources.conflict'] }),
  warned('services.*.deploy.resources.limits.pids', DEP, {
    k3s: 'Ignored with warning',
    codes: ['resources.pids-unsupported', 'values.invalid-integer'],
    note: 'Kubernetes has no per-container process limit',
  }),
  tr('services.*.deploy.resources.reservations', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.resources.reservations.cpus', DEP, { codes: ['values.invalid-cpus', 'resources.cpu-rounded', 'resources.conflict'] }),
  tr('services.*.deploy.resources.reservations.memory', DEP, { codes: ['values.invalid-bytes', 'resources.conflict'] }),
  refused('services.*.deploy.resources.reservations.devices', DEP, {
    whole: true,
    swarm: 'rejected',
    codes: ['resources.devices-unsupported'],
    note: 'Device reservations (GPUs) are not supported yet',
  }),
  refused('services.*.deploy.resources.reservations.generic_resources', DEP, {
    whole: true,
    codes: ['resources.generic-unsupported'],
    note: 'Place the service with `x-dockflow.node_selector` instead',
  }),
  tr('services.*.deploy.placement', DEP, { codes: ['values.invalid-type'] }),
  tr('services.*.deploy.placement.constraints', DEP, {
    codes: ['placement.unknown-server', 'placement.node-id', 'placement.engine-labels', 'placement.invalid-constraint', 'values.invalid-type'],
    note: '`node.role`, `node.hostname` (servers.yml keys), `node.labels.*` and `node.platform.*` become node affinity',
  }),
  tr('services.*.deploy.placement.preferences', DEP, { codes: ['values.invalid-type'], note: 'Become topology spread constraints' }),
  tr('services.*.deploy.placement.preferences[].spread', DEP, { codes: ['placement.invalid-preference'] }),
  tr('services.*.deploy.placement.max_replicas_per_node', DEP, {
    codes: ['values.invalid-integer'],
    note: '`1` is exact (pod anti-affinity); a larger value is approximated with a warning',
  }),
  tr('services.*.scale', DEP, {
    swarm: 'rejected',
    codes: ['deploy.scale-conflict', 'deploy.replicas-global', 'values.invalid-integer'],
  }),
  tr('services.*.restart', DEP, {
    table: 'T/W/R',
    swarm: 'ignored',
    effect: 'none',
    codes: ['restart.on-failure', 'restart.max-retries-ignored', 'restart.no-ignored', 'restart.invalid', 'restart.overridden'],
    note: 'Long-running pods always restart on Kubernetes; on a `replicated-job` it sets the retry limit',
  }),
  none('services.*.depends_on', DEP, 'Containers start in any order and restart until their dependencies answer; accessories are deployed before the app', {
    codes: ['depends_on.no-ordering', 'depends_on.unknown-service', 'values.invalid-type'],
  }),
  none('services.*.depends_on.*', DEP, 'A service of either compose file', { codes: ['depends_on.unknown-service', 'values.invalid-type'] }),
  warned('services.*.depends_on.*.condition', DEP, {
    table: 'T0/W/R',
    swarm: 'rejected',
    codes: ['depends_on.condition-ignored', 'depends_on.invalid-condition'],
    note: 'Not enforced: `service_healthy` and `service_completed_successfully` warn',
  }),
  none('services.*.depends_on.*.required', DEP, 'Accepted; has no effect', { swarm: 'rejected', codes: [...BOOLEAN] }),
  warned('services.*.depends_on.*.restart', DEP, {
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['depends_on.restart-ignored', ...BOOLEAN],
  }),
  tr('services.*.cpus', DEP, {
    swarm: 'rejected',
    codes: ['values.invalid-cpus', 'resources.cpu-rounded', 'resources.conflict'],
    note: 'Same as `deploy.resources.limits.cpus`',
  }),
  tr('services.*.cpu_quota', DEP, {
    swarm: 'rejected',
    codes: ['resources.conflict', 'resources.cpu-rounded', 'values.invalid-integer'],
    note: 'With `cpu_period`, a CPU limit',
  }),
  tr('services.*.cpu_period', DEP, {
    swarm: 'rejected',
    codes: ['resources.cpu-period-alone', 'resources.conflict', 'values.invalid-integer'],
    note: 'Only used together with `cpu_quota`',
  }),
  warned('services.*.cpu_shares', DEP, {
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['resources.cpu-shares-ignored'],
    note: 'Set `deploy.resources.reservations.cpus` instead (1024 shares = 1 CPU)',
  }),
  refused('services.*.cpu_rt_runtime', DEP, { swarm: 'rejected', codes: ['resources.realtime-unsupported'] }),
  refused('services.*.cpu_rt_period', DEP, { swarm: 'rejected', codes: ['resources.realtime-unsupported'] }),
  refused('services.*.cpu_count', DEP, { swarm: 'rejected', codes: ['resources.windows-only'], note: 'Windows containers only' }),
  refused('services.*.cpu_percent', DEP, { swarm: 'rejected', codes: ['resources.windows-only'], note: 'Windows containers only' }),
  refused('services.*.cpuset', DEP, {
    swarm: 'rejected',
    codes: ['resources.cpuset-unsupported'],
    note: 'CPU pinning needs the kubelet static CPU manager',
  }),
  tr('services.*.mem_limit', DEP, {
    swarm: 'rejected',
    codes: ['values.invalid-bytes', 'resources.conflict'],
    note: 'Same as `deploy.resources.limits.memory`',
  }),
  tr('services.*.mem_reservation', DEP, {
    swarm: 'rejected',
    codes: ['values.invalid-bytes', 'resources.conflict'],
    note: 'Same as `deploy.resources.reservations.memory`',
  }),
  warned('services.*.mem_swappiness', DEP, { swarm: 'rejected', k3s: 'Ignored with warning', codes: ['resources.swap-ignored'] }),
  warned('services.*.memswap_limit', DEP, { swarm: 'rejected', k3s: 'Ignored with warning', codes: ['resources.swap-ignored'] }),
  warned('services.*.pids_limit', DEP, {
    swarm: 'rejected',
    k3s: 'Ignored with warning',
    codes: ['resources.pids-unsupported', 'values.invalid-integer'],
    note: 'Kubernetes has no per-container process limit',
  }),
  tr('services.*.x-dockflow', EXT, {
    whole: true,
    swarm: 'ignored',
    codes: [
      'extension.invalid',
      'extension.kind-mode',
      'extension.per-replica-kind',
      'extension.lb-source-ranges-without-lb',
      'extension.publish-unused',
      'extension.probes-disabled-healthcheck',
      'extension.probes-without-check',
      'extension.probes-none',
      'values.invalid-type',
    ],
    note: 'Kubernetes-only settings (see the `x-dockflow` reference)',
  }),

  // -- top-level networks, secrets and configs -------------------------------------------------
  none('networks', NET, 'Kubernetes has one flat pod network; declared networks are informational', {
    codes: ['network.flat', 'values.invalid-type'],
  }),
  none('networks.*', NET, 'Informational: network membership does not isolate services', {
    codes: ['names.invalid-key', 'extension.ignored', 'values.invalid-type', ...EXTERNAL_NETWORK],
  }),
  none('networks.*.name', NET, 'Names the external network; otherwise ignored', {
    codes: [...NETWORK_OPTION, ...EXTERNAL_NETWORK, 'values.invalid-type'],
  }),
  none('networks.*.driver', NET, 'The pod network is managed by the cluster', { codes: [...NETWORK_OPTION] }),
  none('networks.*.driver_opts', NET, 'The pod network is managed by the cluster', { whole: true, codes: [...NETWORK_OPTION] }),
  none('networks.*.ipam', NET, 'The pod network is managed by the cluster', { whole: true, codes: [...NETWORK_OPTION] }),
  none('networks.*.attachable', NET, 'The pod network is managed by the cluster', { codes: [...NETWORK_OPTION] }),
  none('networks.*.enable_ipv4', NET, 'The pod network is managed by the cluster', { codes: [...NETWORK_OPTION] }),
  none('networks.*.labels', NET, 'The pod network is managed by the cluster', { whole: true, codes: [...NETWORK_OPTION] }),
  warned('networks.*.enable_ipv6', NET, { k3s: 'Ignored with warning', codes: ['networks.ipv6-ignored', ...BOOLEAN] }),
  warned('networks.*.internal', NET, {
    k3s: 'Ignored with warning',
    codes: ['networks.internal-not-enforced', ...BOOLEAN],
    note: 'Not enforced: network policies are not generated',
  }),
  warned('networks.*.external', NET, {
    table: 'T0/W',
    codes: [...EXTERNAL_NETWORK, ...BOOLEAN, 'values.invalid-type'],
    note: 'Stacks run in separate namespaces; reach another stack with `<service>.<namespace>.svc.cluster.local`',
  }),
  warned('networks.*.external.name', NET, { table: 'T0/W', codes: [...EXTERNAL_NETWORK, 'values.invalid-type'] }),
  ...topLevelFileKeys('secrets'),
  ...topLevelFileKeys('configs'),
];

/** R-S1-01: the registry as data, for the docs generator and the coverage tests. */
export const KEY_POLICIES: readonly KeyPolicy[] = KEY_REGISTRY;

export interface EmittedCodes {
  emitter: CodeEmitter;
  codes: readonly string[];
}

/**
 * The codes of an entry by the file that emits them, the handler first and the others in
 * CODE_EMITTERS order: design-01 1.4 step 3 finds each code in `<emitter>.test.ts`.
 */
export function codeEmitters(policy: KeyPolicy): EmittedCodes[] {
  const groups: EmittedCodes[] = [];
  if (policy.codes.length > 0) groups.push({ emitter: policy.handler, codes: policy.codes });
  for (const emitter of CODE_EMITTERS) {
    const codes = policy.otherEmitters?.[emitter];
    if (codes !== undefined && codes.length > 0) groups.push({ emitter, codes });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const ITEM = '[]';
const ANY = '*';
const EXTENSION_KEY = 'x-dockflow';

interface TrieNode {
  policy: KeyPolicy | null;
  /** literal keys and `*` */
  children: Map<string, TrieNode>;
  /** the items of a list */
  item: TrieNode | null;
}

function newNode(): TrieNode {
  return { policy: null, children: new Map(), item: null };
}

/** `services.*.volumes[].bind` -> `['services', '*', 'volumes', '[]', 'bind']` */
function patternTokens(path: string): string[] {
  const tokens: string[] = [];
  for (const part of path.split('.')) {
    let key = part;
    let items = 0;
    while (key.endsWith(ITEM)) {
      key = key.slice(0, -ITEM.length);
      items++;
    }
    if (key !== '') tokens.push(key);
    for (let i = 0; i < items; i++) tokens.push(ITEM);
  }
  return tokens;
}

const TRIES = new WeakMap<readonly KeyPolicy[], TrieNode>();

function trieFor(registry: readonly KeyPolicy[]): TrieNode {
  const cached = TRIES.get(registry);
  if (cached !== undefined) return cached;
  const root = newNode();
  for (const policy of registry) {
    let node = root;
    for (const token of patternTokens(policy.path)) {
      if (token === ITEM) {
        node.item ??= newNode();
        node = node.item;
      } else {
        let child = node.children.get(token);
        if (child === undefined) {
          child = newNode();
          node.children.set(token, child);
        }
        node = child;
      }
    }
    if (node.policy !== null) throw new Error(`KEY_REGISTRY declares ${policy.path} twice`);
    node.policy = policy;
  }
  TRIES.set(registry, root);
  return root;
}

function stopsWalk(policy: KeyPolicy | null): boolean {
  return policy !== null && (policy.whole || policy.freeform);
}

/**
 * The policy of a key. `path` is a registry pattern (`services.*.ports[].target`) or document
 * segments (`['services', 'web', 'ports', 0, 'target']`, a number or `'[]'` for a list item). A
 * key below a `whole` or `freeform` entry gets that entry; a key the registry does not know, null.
 */
export function lookupPolicy(path: string | readonly (string | number)[], registry: readonly KeyPolicy[] = KEY_REGISTRY): KeyPolicy | null {
  const tokens = typeof path === 'string' ? patternTokens(path) : path.map((segment) => (typeof segment === 'number' ? ITEM : segment));
  let node: TrieNode = trieFor(registry);
  for (const token of tokens) {
    if (stopsWalk(node.policy)) return node.policy;
    const next: TrieNode | null | undefined = token === ITEM ? node.item : (node.children.get(token) ?? node.children.get(ANY));
    if (next === null || next === undefined) return null;
    node = next;
  }
  return node.policy;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

const UNKNOWN_KEY_HINT =
  'Check the spelling; if the key was added to the Compose specification after that date, upgrade Dockflow, and put Kubernetes-only settings under `x-dockflow` (see the Kubernetes page of the docs).';

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
export function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[rows - 1][cols - 1];
}

/** The closest candidate within distance 2 (ties: code-unit order), or null. */
export function suggestKey(key: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of [...candidates].sort(compareCodeUnits)) {
    const distance = damerauLevenshtein(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function reportUnknown(key: string, path: string, node: TrieNode, sink: DiagnosticSink): void {
  const suggestion = suggestKey(
    key,
    [...node.children.keys()].filter((candidate) => candidate !== ANY),
  );
  sink.error(
    'keys.unknown',
    path,
    `is not known to this Dockflow release, which follows the Compose specification of ${COMPOSE_SPEC_PIN.date}`,
    suggestion === null ? UNKNOWN_KEY_HINT : `Did you mean \`${suggestion}\`? ${UNKNOWN_KEY_HINT}`,
  );
}

function reportMisplaced(path: string, sink: DiagnosticSink): void {
  sink.error(
    'extension.misplaced',
    path,
    'x-dockflow is not allowed here',
    'Put `x-dockflow` under a service (`services.<name>.x-dockflow`) or a volume (`volumes.<name>.x-dockflow`).',
  );
}

function visit(value: unknown, node: TrieNode, path: string, sink: DiagnosticSink): void {
  if (Array.isArray(value)) {
    const item = node.item;
    if (item === null) return;
    value.forEach((element, index) => {
      if (!stopsWalk(item.policy)) visit(element, item, indexPath(path, index), sink);
    });
    return;
  }
  // A scalar, or a mapping where the schema has none: the handler reports the type.
  if (!isPlainMap(value) || node.children.size === 0) return;
  const named = node.children.has(ANY);
  for (const key of sortedKeys(value)) {
    const keyPath = childPath(path, key);
    const literal = node.children.get(key);
    // Where the keys are names (services, volumes...), `x-foo` is a name; elsewhere an extension field.
    if (literal === undefined && !named && key.startsWith('x-')) {
      if (key === EXTENSION_KEY) reportMisplaced(keyPath, sink);
      continue;
    }
    const child = literal ?? node.children.get(ANY);
    if (child === undefined) {
      reportUnknown(key, keyPath, node, sink);
      continue;
    }
    if (!stopsWalk(child.policy)) visit(value[key], child, keyPath, sink);
  }
}

/**
 * Visits every mapping reachable through registered paths (design-01 1.4): an unregistered key is
 * `keys.unknown`, `x-dockflow` anywhere but under a service or a top-level volume is
 * `extension.misplaced`, other `x-*` extension fields are skipped, and `whole` and `freeform`
 * subtrees are left to their handler. Values of the wrong type are not reported here.
 */
export function walkKeys(raw: unknown, registry: readonly KeyPolicy[], sink: DiagnosticSink): void {
  visit(raw, trieFor(registry), '', sink);
}
