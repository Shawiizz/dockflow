// The translator's diagnostic catalogue (design-02 11.2): every code translate/* emits, with its
// severity, compose path template, message and hint. It is the only place translator message text
// lives; the normalizer's codes (normalize/keys.ts) are a disjoint set (DESIGN-CORE 8.2).
// Messages are one sentence without a trailing period; hints are imperative sentences with keys,
// values and commands in backticks (DESIGN-CORE 8.1). No message ever carries a Secret value, a
// data payload or an env value (T7).

import { CONVERGENCE_TIMEOUT_S } from '../../../../constants';
import type { Diagnostic, DiagnosticSeverity, DiagnosticSink } from '../../diagnostics';
import { MAX_LOAD_BALANCER_PORTS, MAX_MIN_READY_S } from '../constants';
import type { AccessMode, Protocol } from '../model/types';

/** `default-aware`: info when the value equals the injected default of its UpdateSpec, otherwise warning. */
export type TranslatorSeverity = DiagnosticSeverity | 'default-aware';

interface EntrySpec<P> {
  severity: TranslatorSeverity;
  /** compose path template, e.g. `services.<s>.deploy.replicas` (documentation; callers pass the real path) */
  path: string;
  message: (params: P) => string;
  /** null: the code carries no hint */
  hint: ((params: P) => string) | null;
}

function entry<C extends string, P>(code: C, spec: EntrySpec<P>): EntrySpec<P> & { code: C } {
  return { code, ...spec };
}

const proto = (protocol: Protocol): string => protocol.toLowerCase();
const list = (names: readonly string[]): string => names.join(', ');

interface ServiceParams {
  /** compose service key */
  service: string;
}

export const TRANSLATOR_CODES = [
  // -- volumes ------------------------------------------------------------------------------
  entry('volumes.rwo-replicas', {
    severity: 'error',
    path: 'services.<s>.deploy.replicas',
    message: (p: { service: string; volume: string; accessMode: AccessMode; replicas: number }) =>
      `Service ${p.service} mounts volume ${p.volume} (${p.accessMode}) and cannot run ${p.replicas} replicas`,
    hint: (p) =>
      `Set \`deploy.replicas: 1\`, or set \`x-dockflow.kind: statefulset\` and \`volumes.${p.volume}.x-dockflow.per_replica: true\`.`,
  }),
  entry('volumes.rwo-global', {
    severity: 'error',
    path: 'services.<s>.deploy.mode',
    message: (p: { service: string; volume: string; accessMode: AccessMode }) =>
      `Global service ${p.service} runs on every node and cannot share volume ${p.volume} (${p.accessMode})`,
    hint: () => 'Use a bind mount for per-node data, or a `ReadWriteMany` storage class.',
  }),
  entry('volumes.rwo-shared', {
    severity: 'warning',
    path: 'volumes.<key>',
    message: (p: { volume: string; services: readonly string[] }) =>
      `Volume ${p.volume} (ReadWriteOnce) is used by ${list(p.services)}; all of them run on the node that holds it`,
    hint: () => 'Give each service its own volume if they may run on different nodes.',
  }),
  entry('volumes.rwop-shared', {
    severity: 'error',
    path: 'volumes.<key>',
    message: (p: { volume: string; services: readonly string[] }) =>
      `Volume ${p.volume} (ReadWriteOncePod) is used by ${list(p.services)}, but only one pod can mount it`,
    hint: () => 'Give each service its own volume, or set `x-dockflow.access_mode: ReadWriteOnce`.',
  }),
  entry('volumes.per-replica-shared', {
    severity: 'error',
    path: 'volumes.<key>',
    message: (p: { volume: string; services: readonly string[] }) =>
      `Volume ${p.volume} has per_replica: true and is mounted by ${list(p.services)}; a claim template belongs to one StatefulSet`,
    hint: () => 'Declare one per-replica volume per service.',
  }),
  entry('volumes.access-mode-unsupported', {
    severity: 'error',
    path: 'volumes.<key>.x-dockflow.access_mode',
    message: (p: { volume: string; accessMode: AccessMode; storageClass: string }) =>
      `Volume ${p.volume} asks for ${p.accessMode}, which storage class ${p.storageClass} cannot provision`,
    hint: (p) => `Use \`ReadWriteOnce\`, or set \`x-dockflow.storage_class\` to a class that supports \`${p.accessMode}\`.`,
  }),
  entry('volumes.bind-node-local', {
    severity: 'info',
    path: 'services.<s>.volumes[i]',
    message: (p: { service: string; source: string }) => `Bind source ${p.source} must exist on every node that may run ${p.service}`,
    hint: null,
  }),
  entry('volumes.bind-create-host-path', {
    severity: 'warning',
    path: 'services.<s>.volumes[i]',
    message: (p: { source: string }) =>
      `create_host_path: false of bind ${p.source} is not enforced; the node creates a missing directory`,
    hint: () => 'Create the path on every node that may run the service, for example with `uploads` in config.yml.',
  }),
  entry('volumes.propagation-bidirectional', {
    severity: 'error',
    path: 'services.<s>.volumes[i]',
    message: (p: { service: string; source: string }) =>
      `Bind ${p.source} of service ${p.service} uses shared propagation, which Kubernetes allows only for privileged containers`,
    hint: () => 'Use `rslave` propagation, or set `privileged: true`.',
  }),
  entry('volumes.recursive-readonly-propagation', {
    severity: 'error',
    path: 'services.<s>.volumes[i]',
    message: (p: { service: string; source: string; propagation: string }) =>
      `Bind ${p.source} of service ${p.service} asks for bind.recursive: readonly with ${p.propagation} propagation, which Kubernetes cannot combine`,
    hint: () => 'Use private propagation, or `bind.recursive: enabled`.',
  }),
  entry('volumes.tmpfs-memory', {
    severity: 'info',
    path: 'services.<s>.tmpfs[i]',
    message: (p: { service: string; target: string }) => `tmpfs ${p.target} of service ${p.service} counts against its memory limit`,
    hint: null,
  }),
  entry('volumes.docker-socket', {
    severity: 'error',
    path: 'services.<s>.volumes[i]',
    message: (p: { service: string; source: string }) =>
      `Service ${p.service} mounts the container engine socket ${p.source}, which does not exist on Kubernetes nodes`,
    hint: () => 'Remove the mount; use the Kubernetes API from a sidecar instead.',
  }),
  entry('volumes.pod-volume-name-collision', {
    severity: 'error',
    path: 'volumes.<key>',
    message: (p: { service: string; volume: string; other: string }) =>
      `Volumes ${p.volume} and ${p.other} of service ${p.service} need the same pod volume name`,
    hint: () => 'Rename one of the volumes.',
  }),

  // -- update strategy ----------------------------------------------------------------------
  entry('update.strategy-recreate', {
    severity: 'info',
    path: 'services.<s>.deploy.update_config',
    message: (p: { service: string; volume: string; accessMode: AccessMode }) =>
      `Service ${p.service} is updated with Recreate because it mounts volume ${p.volume} (${p.accessMode})`,
    hint: null,
  }),
  entry('update.surge-disabled', {
    severity: 'default-aware',
    path: 'services.<s>.deploy.update_config.order',
    message: (p: ServiceParams) =>
      `Service ${p.service} binds node ports, so replicas are replaced stop-first (brief downtime per replica)`,
    hint: () =>
      'Publish through the load balancer (remove `mode: host` or `x-dockflow.publish: hostport`) to keep start-first updates.',
  }),
  entry('update.statefulset-order', {
    severity: 'default-aware',
    path: 'services.<s>.deploy.update_config.order',
    message: (p: ServiceParams) => `Service ${p.service} is a StatefulSet; replicas are replaced one at a time, stop-first`,
    hint: null,
  }),
  entry('update.global-all-at-once', {
    severity: 'warning',
    path: 'services.<s>.deploy.update_config.parallelism',
    message: (p: ServiceParams) =>
      `Global service ${p.service} sets update_config.parallelism: 0, so every node loses it at the same time during an update`,
    hint: () => 'Set `update_config.parallelism: 1` to replace it node by node.',
  }),
  entry('update.monitor-too-long', {
    severity: 'error',
    path: 'services.<s>.deploy.update_config.monitor',
    /** monitorS: ceil(update_config.monitor) in seconds (minReadySecondsFor) */
    message: (p: { service: string; monitorS: number }) =>
      `update_config.monitor of service ${p.service} is ${p.monitorS}s, which leaves no time to observe a rollout inside the ${CONVERGENCE_TIMEOUT_S}s convergence deadline`,
    hint: () => `Set \`update_config.monitor\` to at most ${MAX_MIN_READY_S}s.`,
  }),

  // -- restart and Jobs ---------------------------------------------------------------------
  entry('deploy.restart-policy-unsupported', {
    severity: 'warning',
    path: 'services.<s>.deploy.restart_policy',
    message: (p: { service: string; field: string }) =>
      `restart_policy.${p.field} of service ${p.service} cannot be expressed; Kubernetes retries with exponential backoff`,
    hint: null,
  }),
  entry('deploy.job-zero-replicas', {
    severity: 'info',
    path: 'services.<s>.deploy.replicas',
    message: (p: ServiceParams) => `Job service ${p.service} has 0 replicas and is not created`,
    hint: null,
  }),

  // -- ports and exposure (design-02 6) -----------------------------------------------------
  entry('ports.reserved-host-port', {
    severity: 'error',
    path: 'services.<s>.ports[i]',
    /** entry: compose path of the port entry; reason: the ReservedHostPort reason */
    message: (p: { entry: string; port: number; protocol: Protocol; reason: string }) =>
      `${p.entry} publishes ${p.port}/${proto(p.protocol)}, which is reserved on the nodes (${p.reason})`,
    hint: (p) =>
      p.protocol === 'TCP' && (p.port === 80 || p.port === 443)
        ? 'Route the service through the proxy with traefik labels, or publish another port.'
        : `Publish another port; ${p.reason} uses this one on every node.`,
  }),
  entry('ports.published-conflict', {
    severity: 'error',
    path: 'services.<s>.ports[i]',
    /** owner: compose path of the entry that published the port first */
    message: (p: { entry: string; port: number; protocol: Protocol; owner: string }) =>
      `${p.entry} publishes ${p.port}/${proto(p.protocol)}, already published by ${p.owner}`,
    hint: () => 'Publish each node port from one service only.',
  }),
  entry('ports.host-ip-unsupported', {
    severity: 'error',
    path: 'services.<s>.ports[i]',
    message: (p: { entry: string; hostIp: string }) =>
      `${p.entry} binds ${p.hostIp}, which a load balancer publishing on every node cannot honour`,
    hint: () =>
      'Remove the address to publish on every node, use `expose` for in-cluster access only, or set `x-dockflow.publish: hostport` to bind it on the node running the pod.',
  }),
  entry('ports.host-duplicate-target', {
    severity: 'error',
    path: 'services.<s>.ports[i]',
    message: (p: { entry: string; target: number; protocol: Protocol }) =>
      `${p.entry} binds container port ${p.target}/${proto(p.protocol)} on the node a second time`,
    hint: () => 'Bind the container port once in `mode: host`, or use the default ingress mode.',
  }),
  entry('ports.host-port-replicas', {
    severity: 'error',
    path: 'services.<s>.deploy.replicas',
    message: (p: { service: string; port: number; protocol: Protocol; replicas: number }) =>
      `${p.service} binds node port ${p.port}/${proto(p.protocol)} and runs ${p.replicas} replicas, but two pods cannot bind one port on one node`,
    hint: () =>
      'Publish through the load balancer (`x-dockflow.publish: loadbalancer`), or run one pod per node with `deploy.mode: global`.',
  }),
  entry('ports.too-many-published', {
    severity: 'error',
    path: 'services.<s>.ports',
    message: (p: { service: string; count: number }) =>
      `Service ${p.service} publishes ${p.count} ports through its load balancer; ServiceLB runs one container per port on every node, so at most ${MAX_LOAD_BALANCER_PORTS} are accepted`,
    hint: () => 'Publish fewer ports, or set `x-dockflow.publish: hostport`.',
  }),
  entry('ports.sctp-loadbalancer', {
    severity: 'error',
    path: 'services.<s>.ports[i]',
    message: (p: { entry: string; port: number }) =>
      `${p.entry} publishes ${p.port}/sctp through the load balancer, which forwards only TCP and UDP`,
    hint: () =>
      'Set `x-dockflow.publish: hostport` to bind the port on the node running the pod, or use `expose` for in-cluster access only.',
  }),
  entry('ports.no-published-port', {
    severity: 'warning',
    path: 'services.<s>.ports[i]',
    message: (p: { service: string; target: number }) =>
      `Port ${p.target} of service ${p.service} has no published port; Swarm published a random node port, Kubernetes exposes it inside the cluster only`,
    hint: (p) => `Write \`"${p.target}:${p.target}"\` to publish it on the nodes, or use \`expose\`.`,
  }),
  entry('ports.publish-none', {
    severity: 'info',
    path: 'services.<s>.x-dockflow.publish',
    message: (p: ServiceParams) => `Published ports of service ${p.service} are not exposed on the nodes`,
    hint: null,
  }),
  entry('ports.name-conflict', {
    severity: 'warning',
    path: 'services.<s>.ports[i]',
    message: (p: { service: string; target: number; protocol: Protocol }) =>
      `Port ${p.target}/${proto(p.protocol)} of service ${p.service} has two different names or app_protocol values; the first is used`,
    hint: null,
  }),

  // -- network ------------------------------------------------------------------------------
  entry('network.host-network', {
    severity: 'warning',
    path: 'services.<s>.network_mode',
    message: (p: ServiceParams) => `Service ${p.service} uses the node network (Swarm ignored network_mode: host)`,
    hint: null,
  }),
  entry('network.dns-secondary', {
    severity: 'warning',
    path: 'services.<s>.dns',
    message: (p: ServiceParams) => `DNS servers of service ${p.service} are used only when cluster DNS does not answer`,
    hint: null,
  }),
  entry('network.hostname-host-network', {
    severity: 'warning',
    path: 'services.<s>.hostname',
    message: (p: ServiceParams) => `hostname of service ${p.service} is ignored with the node network`,
    hint: null,
  }),
  entry('network.hostname-statefulset', {
    severity: 'warning',
    path: 'services.<s>.hostname',
    message: (p: ServiceParams) => `hostname of StatefulSet service ${p.service} is ignored; each replica is named after its pod`,
    hint: null,
  }),

  // -- files, security, resources, placement ------------------------------------------------
  entry('files.too-large', {
    severity: 'error',
    path: 'secrets.<k> / configs.<k>',
    message: (p: { kind: 'secret' | 'config'; key: string; sizeBytes: number }) =>
      `${p.kind === 'secret' ? 'Secret' : 'Config'} ${p.key} is ${p.sizeBytes} bytes; Kubernetes limits it to 1 MiB`,
    hint: () => 'Mount large files with a bind mount or bake them into the image.',
  }),
  entry('security.privileged', {
    severity: 'warning',
    path: 'services.<s>.privileged',
    message: (p: ServiceParams) => `Service ${p.service} runs privileged (Swarm ignored privileged)`,
    hint: null,
  }),
  entry('security.no-new-privileges-privileged', {
    severity: 'error',
    path: 'services.<s>.security_opt',
    message: (p: ServiceParams) => `Service ${p.service} cannot combine no-new-privileges with privileged`,
    hint: () => 'Remove one of them.',
  }),
  entry('security.init-host-pid', {
    severity: 'error',
    path: 'services.<s>.init',
    message: (p: ServiceParams) => `Service ${p.service} cannot combine init: true with pid: host`,
    hint: () => 'Remove `init: true`.',
  }),
  entry('resources.request-exceeds-limit', {
    severity: 'error',
    path: 'services.<s>.deploy.resources',
    message: (p: { service: string; resource: 'cpu' | 'memory' }) =>
      `Service ${p.service} reserves more ${p.resource === 'cpu' ? 'CPU' : 'memory'} than its limit`,
    hint: () => 'Lower the reservation or raise the limit.',
  }),
  entry('placement.conflict', {
    severity: 'error',
    path: 'services.<s>.deploy.placement.constraints[i]',
    /** constraint and other: the two constraints as written */
    message: (p: { service: string; constraint: string; other: string }) =>
      `Constraint ${p.constraint} of service ${p.service} contradicts ${p.other}`,
    hint: () => 'Remove one of the two constraints.',
  }),
  entry('placement.max-replicas-approximate', {
    severity: 'warning',
    path: 'services.<s>.deploy.placement.max_replicas_per_node',
    message: (p: { service: string; maxReplicas: number }) =>
      `max_replicas_per_node: ${p.maxReplicas} of service ${p.service} cannot be enforced; replicas are spread across nodes instead`,
    hint: () => 'Use 1 for a strict one-per-node limit.',
  }),
  entry('placement.global-ignored', {
    severity: 'warning',
    path: 'services.<s>.deploy.placement',
    message: (p: ServiceParams) => `Spread preferences of global service ${p.service} are ignored`,
    hint: null,
  }),

  // -- probes, process, labels --------------------------------------------------------------
  entry('probes.override-defaults', {
    severity: 'info',
    path: 'services.<s>.x-dockflow.probes',
    message: (p: ServiceParams) => `Probes of service ${p.service} use Docker's default timings (no healthcheck)`,
    hint: null,
  }),
  entry('probes.routed-without-healthcheck', {
    severity: 'info',
    path: 'services.<s>',
    message: (p: ServiceParams) =>
      `Service ${p.service} is routed by Traefik but has no healthcheck; traffic starts as soon as the container starts`,
    hint: () => 'Add a healthcheck.',
  }),
  entry('process.init-shared-pid', {
    severity: 'info',
    path: 'services.<s>.init',
    message: (p: ServiceParams) =>
      `init: true of service ${p.service} becomes a shared process namespace, where the pod's pause container is PID 1 and reaps zombies`,
    hint: null,
  }),
  entry('labels.annotation-conflict', {
    severity: 'warning',
    path: 'services.<s>.annotations.<k>',
    message: (p: { service: string; key: string }) =>
      `Key ${p.key} of service ${p.service} is set by labels and annotations with different values; annotations win`,
    hint: null,
  }),

  // -- routing ------------------------------------------------------------------------------
  entry('routing.middleware-unused', {
    severity: 'info',
    path: 'middleware path',
    message: (p: { middleware: string }) => `Middleware ${p.middleware} is not used by any router`,
    hint: null,
  }),
  entry('routing.middleware-invalid', {
    severity: 'error',
    path: 'middleware path',
    message: (p: { middleware: string }) => `Middleware ${p.middleware}: addPrefix.prefix must start with /`,
    hint: () => 'Start the prefix with `/`.',
  }),
  entry('routing.port-added', {
    severity: 'info',
    path: 'route path',
    message: (p: { service: string; port: number; router: string }) =>
      `Port ${p.port} of service ${p.service} is added to its Service for router ${p.router}`,
    hint: null,
  }),
  entry('routing.router-duplicate-rule', {
    severity: 'warning',
    path: 'route path',
    message: (p: { first: string; second: string }) => `Routers ${p.first} and ${p.second} have the same rule and entry points`,
    hint: () => 'Give one of them a different rule or a `priority`.',
  }),
] as const;

type CatalogueEntry = (typeof TRANSLATOR_CODES)[number];

export type TranslatorCode = CatalogueEntry['code'];

/** The parameters the message and hint of `C` take. */
export type TranslatorParams<C extends TranslatorCode> = Parameters<Extract<CatalogueEntry, { code: C }>['message']>[0];

interface UntypedEntry {
  code: string;
  severity: TranslatorSeverity;
  path: string;
  message: (params: never) => string;
  hint: ((params: never) => string) | null;
}

const BY_CODE: ReadonlyMap<string, UntypedEntry> = new Map(TRANSLATOR_CODES.map((e): [string, UntypedEntry] => [e.code, e]));

export function isTranslatorCode(code: string): code is TranslatorCode {
  return BY_CODE.has(code);
}

export function translatorEntry(code: TranslatorCode): UntypedEntry {
  const found = BY_CODE.get(code);
  if (found === undefined) throw new Error(`Unknown translator diagnostic code ${code}`);
  return found;
}

export interface TranslatorDiagnosticOptions {
  /** required for `default-aware` codes: the value equals the injected default of its UpdateSpec */
  equalsDefault?: boolean;
}

/** Builds the diagnostic of `code` at `path` without reporting it. */
export function translatorDiagnostic<C extends TranslatorCode>(
  code: C,
  path: string,
  params: TranslatorParams<C>,
  options: TranslatorDiagnosticOptions = {},
): Diagnostic {
  const e = translatorEntry(code);
  let severity: DiagnosticSeverity;
  if (e.severity === 'default-aware') {
    if (options.equalsDefault === undefined) throw new Error(`${code} is default-aware: pass equalsDefault`);
    severity = options.equalsDefault ? 'info' : 'warning';
  } else {
    severity = e.severity;
  }
  const message = (e.message as (p: unknown) => string)(params);
  const hint = e.hint === null ? undefined : (e.hint as (p: unknown) => string)(params);
  return hint === undefined ? { severity, code, path, message } : { severity, code, path, message, hint };
}

/** Reports `code` into the render's sink; every `ctx.sink.*` call of translate/* goes through here. */
export function reportTranslator<C extends TranslatorCode>(
  sink: DiagnosticSink,
  code: C,
  path: string,
  params: TranslatorParams<C>,
  options: TranslatorDiagnosticOptions = {},
): void {
  const d = translatorDiagnostic(code, path, params, options);
  switch (d.severity) {
    case 'error':
      sink.error(d.code, d.path, d.message, d.hint);
      return;
    case 'warning':
      sink.warn(d.code, d.path, d.message, d.hint);
      return;
    case 'info':
      sink.info(d.code, d.path, d.message, d.hint);
      return;
  }
}
