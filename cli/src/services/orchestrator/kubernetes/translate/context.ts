// Translator contracts shared by every translate module (design-02 1.1, PD-1, PD-2): options and
// result of translateStack, the per-render TranslateContext, the parameter types translate/index.ts
// passes from one module to the next (modules never import each other), and the one function that
// computes the reserved host ports. Pure: no clock, no randomness, no environment (T2).

import { DeployError, ErrorCode } from '../../../../utils/errors';
import type { DiagnosticSink } from '../../diagnostics';
import type { DistributionTraits, ReservedHostPort } from '../distribution';
import type {
  CanonicalFileSource,
  CanonicalStack,
  CanonicalVolume,
  MiddlewareSpec,
  Protocol,
  StackRole,
} from '../model/types';
import type { PersistentVolumeClaimTemplate } from '../resources/apps';
import type { PodTemplateSpec, Secret } from '../resources/core';
import type { ManifestObject } from '../resources/registry';

// ---------------------------------------------------------------------------
// Entry point contract (DESIGN-CORE 4.1)
// ---------------------------------------------------------------------------

export interface TranslateOptions {
  /** Secret name referenced in imagePullSecrets; null = none */
  pullSecretName: string | null;
  /** max(2, stack_management.keep_releases) */
  revisionHistoryLimit: number;
  /** K8S_PROGRESS_DEADLINE_S; the per-workload value follows progressDeadlineFor (PD-5) */
  progressDeadlineS: number;
  traits: DistributionTraits;
  /**
   * Everything reserved on top of traits.reservedHostPorts, as (port, protocol, reason): the SSH
   * port of every server of the environment, the ports the nginx host plugin binds when that plugin
   * is configured, and the sibling role's published ports. Never 80/443 of Dockflow's Traefik: that
   * reservation comes from traefikOnCluster only (PD-2).
   */
  extraReservedHostPorts: ReservedHostPort[];
  /**
   * True when a Dockflow-owned Traefik exists ON THE CLUSTER, which is what makes 80/TCP and
   * 443/TCP unavailable to published ports, not whether this stack has proxy.enabled. Derived from
   * the dockflow-system/dockflow-proxy ConfigMap at deploy time, and from config.proxy?.enabled
   * offline.
   */
  traefikOnCluster: boolean;
  /** servers.yml keys of the environment; nodeNameFor() is applied here, as in the normalizer */
  serverNames: string[];
  /** the same sink the normalizer received (DESIGN-CORE 8.2); the translator never creates its own */
  sink: DiagnosticSink;
}

export interface TranslateResult {
  /** not yet ordered; the emitter orders */
  objects: ManifestObject[];
}

// ---------------------------------------------------------------------------
// Reserved host ports (DESIGN-CORE 6.3, PD-2)
// ---------------------------------------------------------------------------

export const TRAEFIK_RESERVATION_REASON = 'Dockflow Traefik';

/** Key of the reservation and published-port maps. */
export function hostPortKey(port: number, protocol: Protocol): string {
  return `${port}/${protocol}`;
}

/**
 * The reservation set, computed here and nowhere else: traits.reservedHostPorts, then
 * options.extraReservedHostPorts, then 80/TCP and 443/TCP when a Dockflow-owned Traefik runs on
 * the cluster. One entry per (port, protocol); the first reason listed wins.
 */
export function reservedHostPortsFor(
  traits: Pick<DistributionTraits, 'reservedHostPorts'>,
  options: Pick<TranslateOptions, 'extraReservedHostPorts' | 'traefikOnCluster'>,
): Map<string, ReservedHostPort> {
  const traefik: ReservedHostPort[] = options.traefikOnCluster
    ? [
        { port: 80, protocol: 'TCP', reason: TRAEFIK_RESERVATION_REASON },
        { port: 443, protocol: 'TCP', reason: TRAEFIK_RESERVATION_REASON },
      ]
    : [];
  const reserved = new Map<string, ReservedHostPort>();
  for (const entry of [...traits.reservedHostPorts, ...options.extraReservedHostPorts, ...traefik]) {
    const key = hostPortKey(entry.port, entry.protocol);
    if (!reserved.has(key)) reserved.set(key, { port: entry.port, protocol: entry.protocol, reason: entry.reason });
  }
  return reserved;
}

/**
 * The entries render() appends to extraReservedHostPorts for the other role's published ports:
 * both roles share the nodes, and a second `-lb` Service on a taken port stays Pending for ever.
 */
export function siblingPublishedReservations(
  siblingRole: StackRole,
  services: readonly { key: string; published: readonly { port: number; protocol: Protocol }[] }[],
): ReservedHostPort[] {
  const owner = siblingRole === 'accessory' ? 'accessories' : 'app';
  return services.flatMap((service) =>
    service.published.map((p) => ({ port: p.port, protocol: p.protocol, reason: `published by ${owner} service ${service.key}` })),
  );
}

// ---------------------------------------------------------------------------
// TranslateContext (design-02 1.1)
// ---------------------------------------------------------------------------

export interface TranslateContext {
  stack: CanonicalStack;
  options: TranslateOptions;
  traits: DistributionTraits;
  /** options.sink */
  sink: DiagnosticSink;
  /** stack.identity.namespace */
  namespace: string;
  /** by compose key */
  volumes: Map<string, CanonicalVolume>;
  /** by fileSourceKey(kind, key) */
  files: Map<string, CanonicalFileSource>;
  /** by sanitized name */
  middlewares: Map<string, MiddlewareSpec>;
  /** by hostPortKey(port, protocol) */
  reservedHostPorts: Map<string, ReservedHostPort>;
  /** hostPortKey(port, protocol) -> compose path of the first entry publishing it */
  publishedOwners: Map<string, string>;
}

export function fileSourceKey(kind: CanonicalFileSource['kind'], key: string): string {
  return `${kind}:${key}`;
}

export function createContext(stack: CanonicalStack, options: TranslateOptions): TranslateContext {
  return {
    stack,
    options,
    traits: options.traits,
    sink: options.sink,
    namespace: stack.identity.namespace,
    volumes: new Map(stack.volumes.map((v) => [v.key, v])),
    files: new Map(stack.files.map((f) => [fileSourceKey(f.kind, f.key), f])),
    middlewares: new Map(stack.middlewares.map((m) => [m.name, m])),
    reservedHostPorts: reservedHostPortsFor(options.traits, options),
    publishedOwners: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Parameters passed between modules by translate/index.ts (PD-1)
// ---------------------------------------------------------------------------

/** config-objects.ts -> pod.ts: the service's env Secret (null when its environment is empty). */
export interface EnvSecretResult {
  secret: Secret;
  /** sha256Hex(canonicalJson(svc.environment)): named in the Secret and the env term of P/config-hash */
  checksum: string;
}

/** storage.ts -> workloads.ts: one template per per-replica volume, sorted by name; [] except for StatefulSets. */
export type ClaimTemplates = PersistentVolumeClaimTemplate[];

/** pod.ts -> workloads.ts */
export type PodTemplate = PodTemplateSpec;

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** Kubernetes reduces `$$` and expands `$(VAR)` in command, args and exec probes; doubling every `$` keeps the string verbatim. */
export function escapeKubeExpansion(value: string): string {
  return value.replace(/\$/g, () => '$$');
}

/**
 * Defensive re-check failed (T6): the normalizer refuses this input, so reaching it is a Dockflow
 * bug and never a second diagnostic.
 */
export function translatorBug(what: string): never {
  throw new DeployError(what, ErrorCode.DEPLOY_FAILED, 'Report this as a Dockflow bug.');
}
