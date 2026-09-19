// Pod template of one service (design-02 5): pod-level constants, the container (identity, image,
// environment, ports, mounts, probes, lifecycle, security, resources), pod volumes, placement and
// DNS. The template is the same for every workload kind except where design-02 ties a field to
// the kind (restartPolicy of Jobs, implicit spread, matchLabelKeys, StatefulSet hostnames).
// Pure: no clock, no randomness (T2); problems a user can cause are diagnostics (T1), model
// states the normalizer refuses throw (T6).

import { canonicalJson, sha256Hex } from '../../../../utils/hash';
import { ANNOTATIONS, K8S_IMPORTED_IMAGE_REGISTRY, KUBE_KEYS } from '../constants';
import { podTemplateLabels, selectorLabels } from '../labels';
import type {
  BindMountSpec,
  CanonicalFileSource,
  CanonicalService,
  CanonicalVolume,
  FileMountSpec,
  PlacementConstraint,
  PortSpec,
  Protocol,
  SecuritySpec,
} from '../model/types';
import { ARCH, ceilSeconds, cpuQuantity, isArchName, memoryQuantity } from '../model/units';
import { assignPortNames, nodeNameFor, sanitizeDnsLabel } from '../naming';
import { childPath, compareCodeUnits } from '../normalize/context';
import type {
  Affinity,
  AppArmorProfile,
  Container,
  ContainerPort,
  HostAlias,
  Lifecycle,
  NodeSelectorRequirement,
  PodAffinityTerm,
  PodDNSConfig,
  PodSecurityContext,
  PodSpec,
  ResourceList,
  ResourceRequirements,
  SeccompProfile,
  SecurityContext,
  Toleration,
  TopologySpreadConstraint,
  Volume,
  VolumeMount,
} from '../resources/core';
import type { TemplateMetadata } from '../resources/meta';
import { type EnvSecretResult, escapeKubeExpansion, fileSourceKey, type PodTemplate, type TranslateContext, translatorBug } from './context';
import { reportTranslator } from './diagnostics';
import { buildProbes } from './probes';

/** Container engine sockets a bind may not mount (design-01 VOL-07): no Kubernetes node has one to offer. */
export const ENGINE_SOCKETS: readonly string[] = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run/podman/podman.sock',
  '/run/podman/podman.sock',
];

/** Kubernetes allows 3 nameservers in a pod's resolv.conf, cluster DNS included (design-02 5.11). */
const MAX_RESOLV_NAMESERVERS = 3;

function sha8(value: string): string {
  return sha256Hex(value).slice(0, 8);
}

/** The pod template of `svc` (design-02 5); `envResult` is its env Secret, null when its environment is empty. */
export function buildPodTemplate(svc: CanonicalService, envResult: EnvSecretResult | null, ctx: TranslateContext): PodTemplate {
  const { volumes, mounts } = podVolumes(svc, ctx);
  const spec: PodSpec = {
    automountServiceAccountToken: false,
    containers: [container(svc, envResult, mounts, ctx)],
    enableServiceLinks: false,
    securityContext: podSecurityContext(svc),
    terminationGracePeriodSeconds: ceilSeconds(svc.process.stopGracePeriodMs, 0),
    ...placement(svc, ctx),
    ...networkFields(svc, ctx),
  };
  if (volumes.length > 0) spec.volumes = volumes;
  if (ctx.options.pullSecretName !== null) spec.imagePullSecrets = [{ name: ctx.options.pullSecretName }];
  // Each failed attempt keeps its pod for logs and diagnose, and backoffLimit counts pod failures (K35).
  if (svc.workloadKind === 'Job') spec.restartPolicy = 'Never';
  if (svc.security.hostPid) spec.hostPID = true;
  if (svc.security.hostIpc) spec.hostIPC = true;
  if (svc.process.init) {
    spec.shareProcessNamespace = true;
    if (svc.security.hostPid) reportTranslator(ctx.sink, 'security.init-host-pid', `${svc.path}.init`, { service: svc.composeName });
    else reportTranslator(ctx.sink, 'process.init-shared-pid', `${svc.path}.init`, { service: svc.composeName });
  }
  return { metadata: templateMetadata(svc, envResult, ctx), spec };
}

// ---------------------------------------------------------------------------
// Template metadata (design-02 1.3, 5.3; DESIGN-CORE 5.3)
// ---------------------------------------------------------------------------

function fileSource(svc: CanonicalService, file: FileMountSpec, ctx: TranslateContext): CanonicalFileSource {
  return (
    ctx.files.get(fileSourceKey(file.kind, file.source)) ??
    translatorBug(`${file.kind === 'secret' ? 'Secret' : 'Config'} ${file.source} of service ${svc.composeName} is not in the stack`)
  );
}

/**
 * `P/config-hash`: the env checksum and one [target, checksum] pair per file mount (external
 * sources contribute null, so their content never rolls the pods). Null when the service has no
 * environment and no file mounts: a constant hash of empty input carries no information (K68).
 */
export function configHash(svc: CanonicalService, envResult: EnvSecretResult | null, ctx: TranslateContext): string | null {
  if (envResult === null && svc.files.length === 0) return null;
  const files = svc.files.map((file) => {
    const source = fileSource(svc, file, ctx);
    return [file.target, source.external ? null : source.checksum];
  });
  return sha256Hex(canonicalJson({ env: envResult?.checksum ?? null, files }));
}

function templateMetadata(svc: CanonicalService, envResult: EnvSecretResult | null, ctx: TranslateContext): TemplateMetadata {
  const annotations: Record<string, string> = { ...svc.containerLabels };
  for (const key of Object.keys(svc.podAnnotations).sort(compareCodeUnits)) {
    const value = svc.podAnnotations[key];
    if (Object.hasOwn(svc.containerLabels, key) && svc.containerLabels[key] !== value) {
      reportTranslator(ctx.sink, 'labels.annotation-conflict', childPath(`${svc.path}.annotations`, key), { service: svc.composeName, key });
    }
    annotations[key] = value;
  }
  annotations[ANNOTATIONS.composeService] = svc.composeName;
  annotations[ANNOTATIONS.defaultContainer] = svc.name;
  const hash = configHash(svc, envResult, ctx);
  if (hash !== null) annotations[ANNOTATIONS.configHash] = hash;
  return {
    annotations,
    labels: podTemplateLabels(ctx.stack.identity, svc.role, svc.name, svc.extension.podLabels),
  };
}

// ---------------------------------------------------------------------------
// Container (design-02 5.2-5.4, 5.7-5.9)
// ---------------------------------------------------------------------------

function container(svc: CanonicalService, envResult: EnvSecretResult | null, mounts: VolumeMount[], ctx: TranslateContext): Container {
  const { image, process } = svc;
  if (image.ref.startsWith(`${K8S_IMPORTED_IMAGE_REGISTRY}/`) && image.pullPolicy === 'Always') {
    translatorBug(`Image ${image.ref} of service ${svc.composeName} is imported to the nodes but has pull policy Always`);
  }
  // Kubernetes reads an empty list as "image default", the opposite of compose.
  if (process.entrypoint !== null && process.entrypoint.length === 0) {
    translatorBug(`Service ${svc.composeName} reached the translator with an empty entrypoint`);
  }
  if (process.command !== null && process.command.length === 0) {
    translatorBug(`Service ${svc.composeName} reached the translator with an empty command`);
  }

  const c: Container = { name: svc.name, image: image.ref, imagePullPolicy: image.pullPolicy };
  if (process.entrypoint !== null) c.command = process.entrypoint.map(escapeKubeExpansion);
  if (process.command !== null) c.args = process.command.map(escapeKubeExpansion);
  if (process.workingDir !== null) c.workingDir = process.workingDir;
  // Values travel through envFrom, which the kubelet does not expand: no escaping (D11).
  if (envResult !== null) c.envFrom = [{ secretRef: { name: envResult.secret.metadata.name } }];
  const ports = containerPorts(svc, ctx);
  if (ports.length > 0) c.ports = ports;
  if (mounts.length > 0) c.volumeMounts = mounts;
  const resources = containerResources(svc, ctx);
  if (resources !== null) c.resources = resources;
  Object.assign(c, buildProbes(svc, ctx));
  const lifecycle = containerLifecycle(svc);
  if (lifecycle !== null) c.lifecycle = lifecycle;
  const security = containerSecurityContext(svc, ctx);
  if (security !== null) c.securityContext = security;
  if (process.stdinOpen) c.stdin = true;
  if (process.tty) c.tty = true;
  return c;
}

/** Lifecycle hooks run unexpanded (design-02 0), so they are never escaped. */
function containerLifecycle(svc: CanonicalService): Lifecycle | null {
  const { postStart, preStop } = svc.process;
  if (postStart === null && preStop === null) return null;
  const lifecycle: Lifecycle = {};
  if (postStart !== null) lifecycle.postStart = { exec: { command: [...postStart] } };
  if (preStop !== null) lifecycle.preStop = { exec: { command: [...preStop] } };
  return lifecycle;
}

interface PortEntry {
  port: number;
  protocol: Protocol;
  /** first compose long-syntax `name` requested for this (target, protocol) */
  requested: string | null;
  hostPort: number | null;
  hostIp: string | null;
}

function portKey(port: number, protocol: Protocol): string {
  return `${port}/${protocol}`;
}

/** `mode: host`, or an ingress port bound on the node by `x-dockflow.publish: hostport` (design-02 6.3). */
function bindsNodePort(p: PortSpec, svc: CanonicalService): boolean {
  return p.published !== null && (p.mode === 'host' || svc.extension.publish === 'hostport');
}

/** `0.0.0.0` and `::` mean every address, which is what an absent hostIP says. */
function specificHostIp(hostIp: string | null): string | null {
  return hostIp === null || hostIp === '0.0.0.0' || hostIp === '::' ? null : hostIp;
}

/**
 * Container ports (design-02 5.4): the union of `ports`, `expose` and route ports keyed by
 * (target, protocol), sorted by (port, protocol), named after the target port with the first
 * claimant keeping a requested name. The SSA key `[containerPort, protocol]` holds one
 * hostPort/hostIP pair, so a second node binding of one target is an error (K36).
 */
function containerPorts(svc: CanonicalService, ctx: TranslateContext): ContainerPort[] {
  const entries = new Map<string, PortEntry>();
  const entryFor = (port: number, protocol: Protocol): PortEntry => {
    const key = portKey(port, protocol);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { port, protocol, requested: null, hostPort: null, hostIp: null };
      entries.set(key, entry);
    }
    return entry;
  };

  let firstBinding: { port: number; protocol: Protocol } | null = null;
  for (const p of svc.ports) {
    const entry = entryFor(p.target, p.protocol);
    if (entry.requested === null && p.name !== null) entry.requested = p.name;
    if (p.published === null || !bindsNodePort(p, svc)) continue;
    if (entry.hostPort !== null) {
      reportTranslator(ctx.sink, 'ports.host-duplicate-target', p.path, { entry: p.path, target: p.target, protocol: p.protocol });
      continue;
    }
    entry.hostPort = p.published;
    entry.hostIp = specificHostIp(p.hostIp);
    firstBinding ??= { port: p.published, protocol: p.protocol };
  }
  for (const e of svc.expose) entryFor(e.target, e.protocol);
  for (const route of svc.routes) entryFor(route.port, 'TCP');

  const sorted = [...entries.values()].sort((a, b) => a.port - b.port || compareCodeUnits(a.protocol, b.protocol));

  // Two pods of one workload cannot bind one node port; global services run one pod per node. The
  // port named is the one services.ts names for the same check: the first binding in model order,
  // or the lowest container port on the node network.
  const hostNetworkFirst = sorted[0];
  const bound = svc.network.hostNetwork && hostNetworkFirst !== undefined ? { port: hostNetworkFirst.port, protocol: hostNetworkFirst.protocol } : firstBinding;
  if (bound !== null && svc.mode !== 'global' && svc.replicas > 1) {
    reportTranslator(ctx.sink, 'ports.host-port-replicas', `${svc.path}.deploy.replicas`, {
      service: svc.composeName,
      port: bound.port,
      protocol: bound.protocol,
      replicas: svc.replicas,
    });
  }

  const names = assignPortNames(sorted.map((entry) => ({ port: entry.port, protocol: entry.protocol, requested: entry.requested })));
  return sorted.map((entry, index) => {
    const port: ContainerPort = { name: names[index], containerPort: entry.port, protocol: entry.protocol };
    // The node network needs hostPort == containerPort (design-02 0).
    if (svc.network.hostNetwork) port.hostPort = entry.port;
    else if (entry.hostPort !== null) {
      port.hostPort = entry.hostPort;
      if (entry.hostIp !== null) port.hostIP = entry.hostIp;
    }
    return port;
  });
}

/** Limits without a reservation request "0": Swarm reserves nothing, and it blocks limit->request defaulting. */
function containerResources(svc: CanonicalService, ctx: TranslateContext): ResourceRequirements | null {
  const { limits, reservations } = svc.resources;
  const limitList: ResourceList = {};
  const requestList: ResourceList = {};
  const rows = [
    { resource: 'cpu', limit: limits.cpu, reservation: reservations.cpu, quantity: cpuQuantity },
    { resource: 'memory', limit: limits.memory, reservation: reservations.memory, quantity: memoryQuantity },
  ] as const;
  for (const { resource, limit, reservation, quantity } of rows) {
    if (limit !== null) limitList[resource] = quantity(limit);
    if (reservation !== null) requestList[resource] = quantity(reservation);
    else if (limit !== null) requestList[resource] = '0';
    if (limit !== null && reservation !== null && reservation > limit) {
      reportTranslator(ctx.sink, 'resources.request-exceeds-limit', `${svc.path}.deploy.resources`, { service: svc.composeName, resource });
    }
  }
  const out: ResourceRequirements = {};
  if (Object.keys(limitList).length > 0) out.limits = limitList;
  if (Object.keys(requestList).length > 0) out.requests = requestList;
  return out.limits === undefined && out.requests === undefined ? null : out;
}

function containerSecurityContext(svc: CanonicalService, ctx: TranslateContext): SecurityContext | null {
  const { security, process } = svc;
  const context: SecurityContext = {};
  if (security.privileged) {
    context.privileged = true;
    reportTranslator(ctx.sink, 'security.privileged', `${svc.path}.privileged`, { service: svc.composeName });
  }
  if (security.capAdd.length > 0 || security.capDrop.length > 0) {
    context.capabilities = {};
    if (security.capAdd.length > 0) context.capabilities.add = [...new Set(security.capAdd)].sort(compareCodeUnits);
    if (security.capDrop.length > 0) context.capabilities.drop = [...new Set(security.capDrop)].sort(compareCodeUnits);
  }
  if (security.readOnlyRootFilesystem) context.readOnlyRootFilesystem = true;
  if (security.noNewPrivileges) {
    context.allowPrivilegeEscalation = false;
    if (security.privileged) {
      reportTranslator(ctx.sink, 'security.no-new-privileges-privileged', `${svc.path}.security_opt`, { service: svc.composeName });
    }
  }
  if (process.user !== null) {
    context.runAsUser = process.user.uid;
    if (process.user.gid !== null) context.runAsGroup = process.user.gid;
  }
  return Object.keys(context).length === 0 ? null : context;
}

// ---------------------------------------------------------------------------
// Pod security context (design-02 5.8)
// ---------------------------------------------------------------------------

function seccompProfile(seccomp: SecuritySpec['seccomp']): SeccompProfile {
  if (seccomp === 'default') return { type: 'RuntimeDefault' };
  if (seccomp === 'unconfined') return { type: 'Unconfined' };
  return { type: 'Localhost', localhostProfile: seccomp.localhostProfile };
}

function appArmorProfile(apparmor: SecuritySpec['apparmor']): AppArmorProfile | null {
  if (apparmor === 'default') return null;
  if (apparmor === 'unconfined') return { type: 'Unconfined' };
  return { type: 'Localhost', localhostProfile: apparmor.localhostProfile };
}

function podSecurityContext(svc: CanonicalService): PodSecurityContext {
  const { security, process, extension } = svc;
  const context: PodSecurityContext = { seccompProfile: seccompProfile(security.seccomp) };
  const apparmor = appArmorProfile(security.apparmor);
  if (apparmor !== null) context.appArmorProfile = apparmor;
  const sysctls = Object.keys(security.sysctls).sort(compareCodeUnits);
  if (sysctls.length > 0) context.sysctls = sysctls.map((name) => ({ name, value: security.sysctls[name] }));
  if (process.groupAdd.length > 0) context.supplementalGroups = [...new Set(process.groupAdd)].sort((a, b) => a - b);
  if (extension.fsGroup !== null) {
    context.fsGroup = extension.fsGroup;
    context.fsGroupChangePolicy = 'OnRootMismatch';
  }
  return context;
}

// ---------------------------------------------------------------------------
// Volumes and mounts (design-02 5.5, 8.4)
// ---------------------------------------------------------------------------

interface VolumeClaimant {
  /** equal identities share one pod volume */
  identity: string;
  /** what the user wrote: a volume key, a bind source, a tmpfs target or a secret/config key */
  label: string;
  /** where a name collision is reported */
  path: string;
}

class PodVolumeSet {
  private readonly byName = new Map<string, { claimant: VolumeClaimant; volume: Volume | null }>();

  constructor(
    private readonly svc: CanonicalService,
    private readonly ctx: TranslateContext,
  ) {}

  /** Records `name` for `claimant`; `volume` is null for a claim template (mounted by name, no pod volume). */
  claim(name: string, claimant: VolumeClaimant, volume: Volume | null): void {
    const existing = this.byName.get(name);
    if (existing === undefined) {
      this.byName.set(name, { claimant, volume });
      return;
    }
    if (existing.claimant.identity === claimant.identity) return;
    reportTranslator(this.ctx.sink, 'volumes.pod-volume-name-collision', claimant.path, {
      service: this.svc.composeName,
      volume: claimant.label,
      other: existing.claimant.label,
    });
  }

  volumes(): Volume[] {
    return [...this.byName.entries()]
      .flatMap(([, entry]) => (entry.volume === null ? [] : [entry.volume]))
      .sort((a, b) => compareCodeUnits(a.name, b.name));
  }
}

function stackVolume(svc: CanonicalService, key: string, ctx: TranslateContext): CanonicalVolume {
  return ctx.volumes.get(key) ?? translatorBug(`Volume ${key} of service ${svc.composeName} is not in the stack`);
}

function mountPropagation(bind: BindMountSpec): VolumeMount['mountPropagation'] | undefined {
  switch (bind.propagation) {
    case 'slave':
    case 'rslave':
      return 'HostToContainer';
    case 'shared':
    case 'rshared':
      return 'Bidirectional';
    default:
      return undefined;
  }
}

/** A bind mount: hostPath without `type` (design-02 5.5), propagation and recursive read-only per the K72 table. */
function bindMount(svc: CanonicalService, bind: BindMountSpec, set: PodVolumeSet, ctx: TranslateContext): VolumeMount | null {
  if (ENGINE_SOCKETS.includes(bind.source)) {
    reportTranslator(ctx.sink, 'volumes.docker-socket', bind.path, { service: svc.composeName, source: bind.source });
    return null;
  }
  reportTranslator(ctx.sink, 'volumes.bind-node-local', bind.path, { service: svc.composeName, source: bind.source });
  if (!bind.createHostPath) reportTranslator(ctx.sink, 'volumes.bind-create-host-path', bind.path, { source: bind.source });

  const name = `host-${sha8(bind.source)}`;
  set.claim(name, { identity: `bind:${bind.source}`, label: bind.source, path: bind.path }, { name, hostPath: { path: bind.source } });
  const mount: VolumeMount = { name, mountPath: bind.target };
  const propagation = mountPropagation(bind);
  if (propagation !== undefined) mount.mountPropagation = propagation;
  if (propagation === 'Bidirectional' && !svc.security.privileged) {
    reportTranslator(ctx.sink, 'volumes.propagation-bidirectional', bind.path, { service: svc.composeName, source: bind.source });
  }

  if (!bind.readOnly) {
    // Kubernetes requires readOnly for recursiveReadOnly; the normalizer refuses the combination.
    if (bind.recursive === 'readonly') translatorBug(`Bind ${bind.source} of service ${svc.composeName} asks for recursive read-only on a writable mount`);
    return mount;
  }
  mount.readOnly = true;
  if (bind.recursive === 'readonly') {
    // Recursive read-only requires private propagation; dropping a guarantee asked for by name is refused (D3).
    if (propagation !== undefined) {
      reportTranslator(ctx.sink, 'volumes.recursive-readonly-propagation', bind.path, {
        service: svc.composeName,
        source: bind.source,
        propagation: bind.propagation ?? 'private',
      });
    } else mount.recursiveReadOnly = 'Enabled';
  } else if (bind.recursive === 'enabled' && propagation === undefined) {
    // Docker's default: recursive when the kernel supports it, as IfPossible.
    mount.recursiveReadOnly = 'IfPossible';
  }
  return mount;
}

function fileMount(svc: CanonicalService, file: FileMountSpec, set: PodVolumeSet, ctx: TranslateContext): VolumeMount {
  const source = fileSource(svc, file, ctx);
  // The mode is part of the name: two mounts of one source with two modes need two volumes (8.4).
  const name = sanitizeDnsLabel(`${file.kind}-${file.source}-${file.mode.toString(8)}`, { max: 63, mustStartWithLetter: true }).value;
  const items = [{ key: file.source, path: file.source }];
  const volume: Volume =
    file.kind === 'secret'
      ? { name, secret: { defaultMode: file.mode, items, secretName: source.objectName } }
      : { name, configMap: { defaultMode: file.mode, items, name: source.objectName } };
  set.claim(name, { identity: `${file.kind}:${source.objectName}:${file.mode}`, label: file.source, path: source.path }, volume);
  return { name, mountPath: file.target, readOnly: true, subPath: file.source };
}

function podVolumes(svc: CanonicalService, ctx: TranslateContext): { volumes: Volume[]; mounts: VolumeMount[] } {
  const set = new PodVolumeSet(svc, ctx);
  const mounts: VolumeMount[] = [];
  for (const m of svc.mounts) {
    switch (m.type) {
      case 'volume': {
        const volume = stackVolume(svc, m.volume, ctx);
        const mount: VolumeMount = { name: '', mountPath: m.target };
        if (volume.perReplica) {
          // The normalizer refuses per_replica outside a StatefulSet (extension.per-replica-kind).
          if (svc.workloadKind !== 'StatefulSet') translatorBug(`Per-replica volume ${volume.key} of service ${svc.composeName} reached a ${svc.workloadKind}`);
          mount.name = volume.name;
          set.claim(volume.name, { identity: `template:${volume.name}`, label: volume.key, path: volume.path }, null);
        } else {
          mount.name = sanitizeDnsLabel(`pvc-${volume.name}`, { max: 63, mustStartWithLetter: true }).value;
          set.claim(
            mount.name,
            { identity: `claim:${volume.name}`, label: volume.key, path: volume.path },
            { name: mount.name, persistentVolumeClaim: { claimName: volume.name } },
          );
        }
        if (m.readOnly) mount.readOnly = true;
        if (m.subpath !== null) mount.subPath = m.subpath;
        mounts.push(mount);
        break;
      }
      case 'bind': {
        const mount = bindMount(svc, m, set, ctx);
        if (mount !== null) mounts.push(mount);
        break;
      }
      case 'tmpfs': {
        const name = `tmpfs-${sha8(m.target)}`;
        // Docker reads a zero size as unlimited.
        const emptyDir: NonNullable<Volume['emptyDir']> = m.sizeBytes !== null && m.sizeBytes > 0 ? { medium: 'Memory', sizeLimit: memoryQuantity(m.sizeBytes) } : { medium: 'Memory' };
        set.claim(name, { identity: `tmpfs:${m.target}`, label: m.target, path: m.path }, { name, emptyDir });
        reportTranslator(ctx.sink, 'volumes.tmpfs-memory', m.path, { service: svc.composeName, target: m.target });
        mounts.push({ name, mountPath: m.target });
        break;
      }
      case 'anonymous': {
        const name = `anon-${sha8(m.target)}`;
        set.claim(name, { identity: `anonymous:${m.target}`, label: m.target, path: m.path }, { name, emptyDir: {} });
        mounts.push({ name, mountPath: m.target });
        break;
      }
    }
  }
  for (const file of svc.files) mounts.push(fileMount(svc, file, set, ctx));
  mounts.sort((a, b) => compareCodeUnits(a.mountPath, b.mountPath));
  return { volumes: set.volumes(), mounts };
}

// ---------------------------------------------------------------------------
// Placement (design-02 5.10)
// ---------------------------------------------------------------------------

type Requirement = { key: string; kind: 'equals' | 'not-in'; value: string } | { key: string; kind: 'absent' };

function constraintText(c: PlacementConstraint): string {
  const attribute = c.attribute === 'node.labels' ? `node.labels.${c.key}` : c.attribute;
  return `${attribute} ${c.operator} ${c.value}`;
}

function requirementFor(svc: CanonicalService, c: PlacementConstraint, ctx: TranslateContext): Requirement {
  const equals = c.operator === '==';
  switch (c.attribute) {
    case 'node.role': {
      const { key } = ctx.traits.controlPlaneNodeLabel;
      const onControlPlane = (c.value === 'manager') === equals;
      return onControlPlane ? { key, kind: 'equals', value: ctx.traits.controlPlaneNodeLabel.value } : { key, kind: 'absent' };
    }
    case 'node.hostname': {
      // A servers.yml key, never an OS hostname (D19); the normalizer refuses unknown keys (K27).
      const node = nodeNameFor(c.value);
      if (!ctx.options.serverNames.some((server) => nodeNameFor(server) === node)) {
        translatorBug(`Service ${svc.composeName} reached the translator with node.hostname ${c.value}, which is not a server of the environment`);
      }
      return { key: KUBE_KEYS.hostname, kind: equals ? 'equals' : 'not-in', value: node };
    }
    case 'node.labels':
      return { key: c.key, kind: equals ? 'equals' : 'not-in', value: c.value };
    case 'node.platform.os':
      return { key: KUBE_KEYS.os, kind: equals ? 'equals' : 'not-in', value: c.value };
    case 'node.platform.arch': {
      if (!isArchName(c.value)) translatorBug(`Service ${svc.composeName} reached the translator with the unknown architecture ${c.value}`);
      return { key: KUBE_KEYS.arch, kind: equals ? 'equals' : 'not-in', value: ARCH[c.value] };
    }
  }
}

/** nodeSelector and required node affinity; contradictions are `placement.conflict`. */
function nodePlacement(svc: CanonicalService, ctx: TranslateContext): Pick<PodSpec, 'nodeSelector'> & { expressions: NodeSelectorRequirement[] } {
  const equals = new Map<string, { value: string; text: string }>();
  const notIn = new Map<string, Map<string, string>>();
  const absent = new Map<string, string>();

  for (const key of Object.keys(svc.extension.nodeSelector).sort(compareCodeUnits)) {
    const value = svc.extension.nodeSelector[key];
    equals.set(key, { value, text: `x-dockflow.node_selector.${key}: ${value}` });
  }

  for (const c of svc.placement.constraints) {
    const text = constraintText(c);
    const r = requirementFor(svc, c, ctx);
    let other: string | undefined;
    const set = equals.get(r.key);
    if (r.kind === 'equals') {
      if (set !== undefined && set.value !== r.value) other = set.text;
      other ??= notIn.get(r.key)?.get(r.value) ?? absent.get(r.key);
    } else if (r.kind === 'not-in') {
      if (set !== undefined && set.value === r.value) other = set.text;
    } else if (set !== undefined) other = set.text;
    if (other !== undefined) {
      reportTranslator(ctx.sink, 'placement.conflict', c.path, { service: svc.composeName, constraint: text, other });
      continue;
    }
    if (r.kind === 'equals') {
      if (set === undefined) equals.set(r.key, { value: r.value, text });
    } else if (r.kind === 'not-in') {
      let values = notIn.get(r.key);
      if (values === undefined) {
        values = new Map();
        notIn.set(r.key, values);
      }
      if (!values.has(r.value)) values.set(r.value, text);
    } else if (!absent.has(r.key)) absent.set(r.key, text);
  }

  const expressions: NodeSelectorRequirement[] = [
    ...[...notIn].map(([key, values]): NodeSelectorRequirement => ({ key, operator: 'NotIn', values: [...values.keys()].sort(compareCodeUnits) })),
    ...[...absent.keys()].map((key): NodeSelectorRequirement => ({ key, operator: 'DoesNotExist' })),
  ].sort((a, b) => compareCodeUnits(a.key, b.key) || compareCodeUnits(a.operator, b.operator));
  const out: Pick<PodSpec, 'nodeSelector'> & { expressions: NodeSelectorRequirement[] } = { expressions };
  if (equals.size > 0) out.nodeSelector = Object.fromEntries([...equals].map(([key, { value }]) => [key, value]));
  return out;
}

function toleration(t: CanonicalService['extension']['tolerations'][number]): Toleration {
  const out: Toleration = {};
  if (t.key !== null) out.key = t.key;
  if (t.operator === 'Exists') out.operator = 'Exists';
  if (t.value !== null) out.value = t.value;
  if (t.effect !== null) out.effect = t.effect;
  if (t.tolerationSeconds !== null && t.effect === 'NoExecute') out.tolerationSeconds = t.tolerationSeconds;
  return out;
}

type PlacementFields = Pick<PodSpec, 'nodeSelector' | 'affinity' | 'tolerations' | 'topologySpreadConstraints'>;

function placement(svc: CanonicalService, ctx: TranslateContext): PlacementFields {
  const out: PlacementFields = {};
  const { nodeSelector, expressions } = nodePlacement(svc, ctx);
  if (nodeSelector !== undefined) out.nodeSelector = nodeSelector;
  const affinity: Affinity = {};
  if (expressions.length > 0) {
    affinity.nodeAffinity = { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: expressions }] } };
  }
  if (svc.extension.tolerations.length > 0) out.tolerations = svc.extension.tolerations.map(toleration);

  const { spreadLabels, maxReplicasPerNode } = svc.placement;
  if (svc.workloadKind === 'DaemonSet') {
    // One pod per node by construction: spreading and per-node caps mean nothing.
    if (spreadLabels.length > 0 || maxReplicasPerNode !== null) {
      reportTranslator(ctx.sink, 'placement.global-ignored', `${svc.path}.deploy.placement`, { service: svc.composeName });
    }
  } else {
    const matchLabels = selectorLabels(ctx.stack.identity, svc.name);
    // pod-template-hash exists on Deployment pods only; it scopes spreading to the new ReplicaSet,
    // so a surge pod may land next to an old one and a one-per-node rollout never deadlocks.
    const labelKeys = (): { matchLabelKeys?: string[] } =>
      svc.workloadKind === 'Deployment' ? { matchLabelKeys: [KUBE_KEYS.podTemplateHash] } : {};
    const spread = (topologyKey: string): TopologySpreadConstraint => ({
      labelSelector: { matchLabels: { ...matchLabels } },
      ...labelKeys(),
      maxSkew: 1,
      topologyKey,
      whenUnsatisfiable: 'ScheduleAnyway',
    });
    const keys: string[] = [];
    // Swarm spreads replicas across nodes; emitted for every replica count so scaling never changes the template.
    if (svc.workloadKind === 'Deployment' || svc.workloadKind === 'StatefulSet') keys.push(KUBE_KEYS.hostname);
    for (const label of spreadLabels) if (!keys.includes(label)) keys.push(label);
    if (keys.length > 0) out.topologySpreadConstraints = keys.map(spread);

    if (maxReplicasPerNode === 1) {
      const term: PodAffinityTerm = { labelSelector: { matchLabels: { ...matchLabels } }, ...labelKeys(), topologyKey: KUBE_KEYS.hostname };
      affinity.podAntiAffinity = { requiredDuringSchedulingIgnoredDuringExecution: [term] };
    } else if (maxReplicasPerNode !== null && maxReplicasPerNode > 1) {
      reportTranslator(ctx.sink, 'placement.max-replicas-approximate', `${svc.path}.deploy.placement.max_replicas_per_node`, {
        service: svc.composeName,
        maxReplicas: maxReplicasPerNode,
      });
    }
  }
  if (affinity.nodeAffinity !== undefined || affinity.podAntiAffinity !== undefined) out.affinity = affinity;
  return out;
}

// ---------------------------------------------------------------------------
// DNS, hosts, hostname, node network (design-02 5.11)
// ---------------------------------------------------------------------------

type NetworkFields = Pick<PodSpec, 'dnsConfig' | 'dnsPolicy' | 'hostAliases' | 'hostname' | 'hostNetwork'>;

/** `name:value` -> {name, value}, `name` -> {name}; a repeated name keeps its first position and its last value. */
function dnsOptions(options: readonly string[]): NonNullable<PodDNSConfig['options']> {
  const byName = new Map<string, string | null>();
  for (const option of options) {
    const colon = option.indexOf(':');
    if (colon === -1) byName.set(option, null);
    else byName.set(option.slice(0, colon), option.slice(colon + 1));
  }
  return [...byName].map(([name, value]) => (value === null ? { name } : { name, value }));
}

function hostAliases(extraHosts: CanonicalService['network']['extraHosts']): HostAlias[] {
  const byIp = new Map<string, Set<string>>();
  for (const { ip, hostname } of extraHosts) {
    let names = byIp.get(ip);
    if (names === undefined) {
      names = new Set();
      byIp.set(ip, names);
    }
    names.add(hostname.toLowerCase());
  }
  return [...byIp.keys()].sort(compareCodeUnits).map((ip) => ({ ip, hostnames: [...(byIp.get(ip) ?? [])].sort(compareCodeUnits) }));
}

function networkFields(svc: CanonicalService, ctx: TranslateContext): NetworkFields {
  const { network } = svc;
  const out: NetworkFields = {};
  if (network.hostNetwork) {
    out.hostNetwork = true;
    out.dnsPolicy = 'ClusterFirstWithHostNet';
    reportTranslator(ctx.sink, 'network.host-network', `${svc.path}.network_mode`, { service: svc.composeName });
  }

  // The kubelet writes 3 nameservers at most and cluster DNS takes its share; the normalizer refuses more (K38).
  const room = MAX_RESOLV_NAMESERVERS - ctx.traits.clusterDnsNameservers;
  if (network.dns.length > room) {
    translatorBug(`Service ${svc.composeName} reached the translator with ${network.dns.length} nameservers, more than the ${room} that fit next to the cluster DNS`);
  }
  const dnsConfig: PodDNSConfig = {};
  if (network.dns.length > 0) {
    dnsConfig.nameservers = [...network.dns];
    reportTranslator(ctx.sink, 'network.dns-secondary', `${svc.path}.dns`, { service: svc.composeName });
  }
  if (network.dnsSearch.length > 0) dnsConfig.searches = [...network.dnsSearch];
  if (network.dnsOptions.length > 0) dnsConfig.options = dnsOptions(network.dnsOptions);
  if (Object.keys(dnsConfig).length > 0) out.dnsConfig = dnsConfig;

  if (network.extraHosts.length > 0) out.hostAliases = hostAliases(network.extraHosts);

  const hostname = svc.process.hostname;
  if (hostname !== null) {
    let dropped = false;
    if (network.hostNetwork) {
      reportTranslator(ctx.sink, 'network.hostname-host-network', `${svc.path}.hostname`, { service: svc.composeName });
      dropped = true;
    }
    // One fixed hostname would give every ordinal the same name and break per-pod DNS.
    if (svc.workloadKind === 'StatefulSet') {
      reportTranslator(ctx.sink, 'network.hostname-statefulset', `${svc.path}.hostname`, { service: svc.composeName });
      dropped = true;
    }
    if (!dropped) out.hostname = hostname;
  }
  return out;
}
