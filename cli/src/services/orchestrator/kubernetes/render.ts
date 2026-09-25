// The pure stack render (design-03 4 `renderInternal` without the memo, PD-1): normalize, translate
// and emit one role through ONE diagnostic sink, then the digest of DESIGN-CORE 4.2 rule 10 and a
// parse of the emitted text, so what apply sends is what the artifact stores. backends/stack.ts
// memoizes around it; `validate` and the goldens call it directly. Also the host ports reserved by
// configuration alone (SSH, nginx plugin), fixed before the render so it stays synchronous.
// Pure: no I/O except through input.files, no clock, never prints.

import { SERVER_DEFAULTS, type ServersConfig } from '../../../types/servers';
import type { DockflowConfig } from '../../../utils/config';
import { ComposeTranslationError, DiagnosticSink } from '../diagnostics';
import type { HelmReleaseRecord, ResolvedHelmRelease, StackArtifact, StackDeployInput, StackRole } from '../interfaces';
import { K8S_PROGRESS_DEADLINE_S } from './constants';
import type { DistributionTraits, ReservedHostPort } from './distribution';
import type { CanonicalStack, StackIdentity, UpdateSpec } from './model/types';
import { namespaceFor } from './naming';
import { type NormalizeInput, normalizeStack } from './normalize';
import type { ManifestObject } from './resources/registry';
import { translateStack } from './translate';
import { siblingPublishedReservations } from './translate/context';
import { artifactDigest, emitManifests, parseManifests } from './yaml';

/** `stack_management.keep_releases` when config.yml does not set it (the schema default). */
export const DEFAULT_KEEP_RELEASES = 3;

/** Reason of the servers.yml SSH port reservations (design-03 4). */
export const SSH_RESERVATION_REASON = 'SSH';
/** Reason of the nginx host plugin's listen port reservations (design-03 4). */
export const NGINX_PLUGIN_RESERVATION_REASON = 'nginx plugin';
/** Built-in plugin name and the default of its `listen` input (plugins/nginx/plugin.yml). */
const NGINX_PLUGIN = 'nginx';
const NGINX_DEFAULT_LISTEN = 80;

/** Everything a render needs besides the deploy input: fixed per bundle, read from configuration only. */
export interface RenderEnvironment {
  traits: DistributionTraits;
  /**
   * NormalizeInput.imageDelivery, from config.registry only (`usesRegistry`), never from
   * input.images.mode: `--skip-build` must not change the pod templates of a release.
   */
  imageDelivery: NormalizeInput['imageDelivery'];
  /** `stack_management.keep_releases`; DEFAULT_KEEP_RELEASES when absent */
  keepReleases?: number;
  /** reservedHostPortsFromConfig(): servers.yml SSH ports and nginx plugin ports */
  extraReservedHostPorts: readonly ReservedHostPort[];
}

/** One role rendered: the artifact plus what deploy() reads next to it (design-03 4 RenderInternal). */
export interface StackRender {
  artifact: StackArtifact;
  stack: CanonicalStack;
  /** the objects parsed back from `artifact.content`, emitter order */
  objects: ManifestObject[];
  /** `update.failureAction` by compose service name */
  failureActions: Record<string, UpdateSpec['failureAction']>;
}

export function composeFileFor(role: StackRole): string {
  return role === 'app' ? 'docker-compose.yml' : 'accessories.yml';
}

function siblingRoleOf(role: StackRole): StackRole {
  return role === 'app' ? 'accessory' : 'app';
}

/**
 * The old revisions a workload keeps: the releases retention keeps besides the current one, and at
 * least the one an automatic revert rolls back to. One more would keep a pruned release's image in
 * use when its release is cleaned up.
 */
export function revisionHistoryLimitFor(keepReleases: number | undefined): number {
  return Math.max(1, (keepReleases ?? DEFAULT_KEEP_RELEASES) - 1);
}

/** What `artifact.helm` stores: no credentials, and the pinned chart digest as `chartSha256`. */
function helmRecord(release: ResolvedHelmRelease): HelmReleaseRecord {
  const { auth: _auth, declaredDigest, ...record } = release;
  return { ...structuredClone(record), chartSha256: declaredDigest };
}

/**
 * Renders one role. Throws ComposeTranslationError when the normalizer or the translator reports
 * an error; otherwise the merged diagnostics, deduplicated by (code, path) and sorted by
 * (path, code) once, travel in the artifact.
 */
export function renderStackArtifact(input: StackDeployInput, env: RenderEnvironment): StackRender {
  const { project, env: envName, role } = input.ref;
  const identity: StackIdentity = {
    project,
    env: envName,
    stackName: `${project}-${envName}`,
    namespace: namespaceFor(project, envName),
    version: input.version,
  };
  const file = composeFileFor(role);
  const kind = env.traits.name;

  // ONE sink for the whole render: the two layers own disjoint code sets (DESIGN-CORE 8.2)
  const sink = new DiagnosticSink();
  const { stack } = normalizeStack({
    compose: input.compose,
    role,
    identity,
    proxy: input.proxy,
    sibling: input.sibling,
    serverNames: input.serverNames,
    imageDelivery: env.imageDelivery,
    files: input.files,
    traits: env.traits,
    sink,
  });
  if (sink.hasErrors()) throw ComposeTranslationError.fromDiagnostics(file, kind, sink.list());

  // Both roles share the nodes: the other role's published ports are reserved here (PD-2). Sorted
  // by key, so which reason wins for one port never depends on the order of the sibling detail.
  const siblings = [...input.sibling.services].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const { objects } = translateStack(stack, {
    pullSecretName: input.images.pullSecretName,
    revisionHistoryLimit: revisionHistoryLimitFor(env.keepReleases),
    progressDeadlineS: K8S_PROGRESS_DEADLINE_S,
    traits: env.traits,
    serverNames: input.serverNames,
    extraReservedHostPorts: [...env.extraReservedHostPorts, ...siblingPublishedReservations(siblingRoleOf(role), siblings)],
    traefikOnCluster: input.traefikOnCluster,
    sink,
  });
  const diagnostics = sink.list();
  if (sink.hasErrors()) throw ComposeTranslationError.fromDiagnostics(file, kind, diagnostics);

  // rule 9: the accessories digest must follow the accessories only, never the release version
  const content = emitManifests(objects, {
    format: 'k8s-manifests/1',
    stackName: identity.stackName,
    role,
    version: role === 'app' ? input.version : '-',
  });
  const helm = input.helm.map(helmRecord);
  return {
    artifact: { format: 'k8s-manifests/1', role, content, helm, diagnostics, digest: artifactDigest(content, helm) },
    stack,
    objects: parseManifests(content),
    failureActions: Object.fromEntries(stack.services.map((s) => [s.composeName, s.update.failureAction])),
  };
}

// ---------------------------------------------------------------------------
// Host ports reserved by configuration (design-03 4, PD-2)
// ---------------------------------------------------------------------------

function portNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * The reservations only configuration knows: the SSH port of every servers.yml server of `env`
 * (22/TCP is also a distribution trait), and the `listen` port of every nginx host plugin use
 * (80 when not set). One entry per port, ascending. 80/443 of Dockflow's Traefik are never here:
 * they come from `traefikOnCluster` (PD-2).
 */
export function reservedHostPortsFromConfig(config: DockflowConfig, servers: ServersConfig, env: string): ReservedHostPort[] {
  const reserved = new Map<number, ReservedHostPort>();
  const add = (port: number, reason: string): void => {
    if (!reserved.has(port)) reserved.set(port, { port, protocol: 'TCP', reason });
  };
  const defaultPort = servers.defaults?.port ?? SERVER_DEFAULTS.port;
  const sshPorts = Object.values(servers.servers ?? {})
    .filter((server) => server.tags.includes(env))
    .map((server) => server.port ?? defaultPort);
  for (const port of [...new Set(sshPorts)].sort((a, b) => a - b)) add(port, SSH_RESERVATION_REASON);

  const nginxPorts = (config.plugins ?? [])
    .filter((plugin) => plugin.use === NGINX_PLUGIN)
    .map((plugin) => (plugin.with?.listen === undefined ? NGINX_DEFAULT_LISTEN : portNumber(plugin.with.listen)))
    .filter((port): port is number => port !== null);
  for (const port of [...new Set(nginxPorts)].sort((a, b) => a - b)) add(port, NGINX_PLUGIN_RESERVATION_REASON);

  return [...reserved.values()].sort((a, b) => a.port - b.port);
}
