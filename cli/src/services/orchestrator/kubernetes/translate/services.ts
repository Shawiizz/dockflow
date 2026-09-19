// Services of one compose service (design-02 6, D9): `<svc>` (ClusterIP, or headless for port-less
// and dnsrr services), one Service per network alias, the `<svc>-lb` LoadBalancer that publishes
// ingress-mode ports on every node, and the StatefulSet's governing `<svc>-hl`. Also the
// render-wide published-port checks (6.6, DESIGN-CORE 6.3, C2): what a render binds on the nodes
// is compared with the reservations of reservedHostPortsFor (PD-2) and with itself.
// Pure: every problem is a diagnostic in ctx.sink; the sink deduplicates by (code, path), so the
// helpers below report whenever they run and the two entry points may share them.

import { ANNOTATIONS, MAX_LOAD_BALANCER_PORTS } from '../constants';
import { selectorLabels, serviceObjectLabels } from '../labels';
import type { CanonicalService, PortSpec, Protocol } from '../model/types';
import { assignPortNames, headlessServiceName, isIanaSvcName, loadBalancerServiceName, portNameFor } from '../naming';
import type { Service, ServicePort, ServiceSpec } from '../resources/core';
import { hostPortKey, type TranslateContext } from './context';
import { reportTranslator } from './diagnostics';

/** Name of the port a headless Service carries while traits.headlessServiceNeedsPort (C9). */
export const HEADLESS_PLACEHOLDER_PORT_NAME = 'placeholder';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Port of `<svc>`, its aliases and `<svc>-hl`: the Service port equals the container port. */
interface ClusterPort {
  port: number;
  protocol: Protocol;
  name: string;
  appProtocol: string | null;
  /** compose path of the first source (ports, expose or route) */
  path: string;
}

/** Port of `<svc>-lb`. */
interface LoadBalancerPort {
  name: string;
  /** the published (node) port */
  port: number;
  protocol: Protocol;
  targetPort: number;
  appProtocol: string | null;
  path: string;
  /** position of the source PortSpec in svc.ports (model order) */
  index: number;
}

/** A PortSpec bound on the node running the pod (`mode: host`, or `x-dockflow.publish: hostport`). */
interface HostBinding {
  /** the published (node) port */
  port: number;
  protocol: Protocol;
  path: string;
  index: number;
}

/** A node-side port the render binds: `-lb` ports, host bindings, container ports of hostNetwork pods. */
interface NodeExposure {
  port: number;
  protocol: Protocol;
  path: string;
}

// ---------------------------------------------------------------------------
// Port names (design-02 6.7, DESIGN-CORE 5.4)
// ---------------------------------------------------------------------------

/**
 * Names of the `-lb` ports, in model order, from the target port. Several published ports can
 * target one container port, and assignPortNames gives each repeat of a (target, protocol) that
 * key's generated name, which a Service cannot hold twice. A repeat takes
 * `<protocol>-<target>-<published>`, else a counter, never a name another entry holds, so the
 * first entry of a target keeps its name when only a published port changes (K30).
 */
function loadBalancerPortNames(sources: readonly { spec: PortSpec; published: number }[]): string[] {
  const assigned = assignPortNames(sources.map(({ spec }) => ({ port: spec.target, protocol: spec.protocol, requested: spec.name })));
  const taken = new Set(assigned);
  const used = new Set<string>();
  return assigned.map((name, index) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const { spec, published } = sources[index];
    const generated = portNameFor(spec.target, spec.protocol, null);
    let candidate = `${generated}-${published}`;
    for (let n = 2; !isIanaSvcName(candidate) || taken.has(candidate); n += 1) candidate = `${generated}-${n}`;
    taken.add(candidate);
    used.add(candidate);
    return candidate;
  });
}

// ---------------------------------------------------------------------------
// Port sets
// ---------------------------------------------------------------------------

/**
 * Union of `ports` (every mode, published or not), `expose` and route ports keyed by
 * (target, protocol), sorted by (port, protocol) (design-02 5.4). A route port the service does not
 * declare is added as TCP, since Traefik reaches pods through the Service.
 */
function clusterPorts(svc: CanonicalService, ctx: TranslateContext): ClusterPort[] {
  interface Draft {
    port: number;
    protocol: Protocol;
    requested: string | null;
    appProtocol: string | null;
    path: string;
  }
  const byKey = new Map<string, Draft>();
  for (const spec of svc.ports) {
    const key = hostPortKey(spec.target, spec.protocol);
    const draft = byKey.get(key);
    if (draft === undefined) {
      byKey.set(key, { port: spec.target, protocol: spec.protocol, requested: spec.name, appProtocol: spec.appProtocol, path: spec.path });
      continue;
    }
    const nameClash = spec.name !== null && draft.requested !== null && spec.name !== draft.requested;
    const appProtocolClash = spec.appProtocol !== null && draft.appProtocol !== null && spec.appProtocol !== draft.appProtocol;
    if (nameClash || appProtocolClash) {
      reportTranslator(ctx.sink, 'ports.name-conflict', spec.path, { service: svc.composeName, target: spec.target, protocol: spec.protocol });
    }
    draft.requested ??= spec.name;
    draft.appProtocol ??= spec.appProtocol;
  }
  for (const expose of svc.expose) {
    const key = hostPortKey(expose.target, expose.protocol);
    if (!byKey.has(key)) byKey.set(key, { port: expose.target, protocol: expose.protocol, requested: null, appProtocol: null, path: expose.path });
  }
  for (const route of svc.routes) {
    const key = hostPortKey(route.port, 'TCP');
    if (byKey.has(key)) continue;
    byKey.set(key, { port: route.port, protocol: 'TCP', requested: null, appProtocol: null, path: route.path });
    reportTranslator(ctx.sink, 'routing.port-added', route.path, { service: svc.composeName, port: route.port, router: route.router });
  }
  const drafts = [...byKey.values()].sort((a, b) => a.port - b.port || compareCodeUnits(a.protocol, b.protocol));
  const names = assignPortNames(drafts.map((d) => ({ port: d.port, protocol: d.protocol, requested: d.requested })));
  return drafts.map((d, i) => ({ port: d.port, protocol: d.protocol, name: names[i], appProtocol: d.appProtocol, path: d.path }));
}

function isWildcardAddress(hostIp: string): boolean {
  return hostIp === '0.0.0.0' || hostIp === '::';
}

function usesLoadBalancer(svc: CanonicalService): boolean {
  const publish = svc.extension.publish ?? 'loadbalancer';
  return publish === 'loadbalancer' && !svc.network.hostNetwork;
}

/**
 * Ports of `<svc>-lb` (design-02 6.3): ingress-mode published ports, one per (published, protocol),
 * sorted by (port, protocol). SCTP is refused and left out: ServiceLB forwards TCP and UDP only.
 */
function loadBalancerPorts(svc: CanonicalService, ctx: TranslateContext): LoadBalancerPort[] {
  if (!usesLoadBalancer(svc)) return [];
  const owners = new Map<string, { spec: PortSpec; published: number; index: number }>();
  svc.ports.forEach((spec, index) => {
    const published = spec.published;
    if (spec.mode !== 'ingress' || published === null) return;
    if (spec.hostIp !== null && !isWildcardAddress(spec.hostIp)) {
      reportTranslator(ctx.sink, 'ports.host-ip-unsupported', spec.path, { entry: spec.path, hostIp: spec.hostIp });
    }
    if (spec.protocol === 'SCTP') {
      reportTranslator(ctx.sink, 'ports.sctp-loadbalancer', spec.path, { entry: spec.path, port: published });
      return;
    }
    const key = hostPortKey(published, spec.protocol);
    const owner = owners.get(key);
    if (owner === undefined) {
      owners.set(key, { spec, published, index });
    } else if (owner.spec.target !== spec.target) {
      reportTranslator(ctx.sink, 'ports.published-conflict', spec.path, {
        entry: spec.path,
        port: published,
        protocol: spec.protocol,
        owner: owner.spec.path,
      });
    }
  });
  const sources = [...owners.values()];
  const names = loadBalancerPortNames(sources);
  const entries = sources.map(
    ({ spec, published, index }, i): LoadBalancerPort => ({
      name: names[i],
      port: published,
      protocol: spec.protocol,
      targetPort: spec.target,
      appProtocol: spec.appProtocol,
      path: spec.path,
      index,
    }),
  );
  if (entries.length > MAX_LOAD_BALANCER_PORTS) {
    reportTranslator(ctx.sink, 'ports.too-many-published', `${svc.path}.ports`, { service: svc.composeName, count: entries.length });
  }
  return entries.sort((a, b) => a.port - b.port || compareCodeUnits(a.protocol, b.protocol));
}

/**
 * PortSpecs the pod binds on its node, one per (target, protocol): the container port list-map
 * holds a single hostPort per key, so a second binding cannot be expressed (K36).
 */
function hostBindings(svc: CanonicalService, ctx: TranslateContext): HostBinding[] {
  if (svc.network.hostNetwork) return [];
  const hostport = svc.extension.publish === 'hostport';
  const byTarget = new Map<string, HostBinding>();
  svc.ports.forEach((spec, index) => {
    const published = spec.published;
    if (published === null || (spec.mode !== 'host' && !hostport)) return;
    const key = hostPortKey(spec.target, spec.protocol);
    if (byTarget.has(key)) {
      reportTranslator(ctx.sink, 'ports.host-duplicate-target', spec.path, { entry: spec.path, target: spec.target, protocol: spec.protocol });
      return;
    }
    byTarget.set(key, { port: published, protocol: spec.protocol, path: spec.path, index });
  });
  return [...byTarget.values()];
}

/** Ports a hostNetwork pod binds on its node: every container port (hostPort = containerPort). */
function hostNetworkPorts(svc: CanonicalService, ctx: TranslateContext): NodeExposure[] {
  if (!svc.network.hostNetwork) return [];
  return clusterPorts(svc, ctx).map((p) => ({ port: p.port, protocol: p.protocol, path: p.path }));
}

/** What the service binds on the nodes, in model order; the compared number is always the node port (C2). */
function nodeExposures(svc: CanonicalService, ctx: TranslateContext): NodeExposure[] {
  if (svc.network.hostNetwork) return hostNetworkPorts(svc, ctx);
  return [...loadBalancerPorts(svc, ctx), ...hostBindings(svc, ctx)]
    .sort((a, b) => a.index - b.index)
    .map((e) => ({ port: e.port, protocol: e.protocol, path: e.path }));
}

// ---------------------------------------------------------------------------
// Published-port checks (design-02 6.6)
// ---------------------------------------------------------------------------

function checkServiceExposure(svc: CanonicalService, ctx: TranslateContext): void {
  for (const spec of svc.ports) {
    if (spec.published === null) {
      reportTranslator(ctx.sink, 'ports.no-published-port', spec.path, { service: svc.composeName, target: spec.target });
    }
  }
  const publishedIngress = svc.ports.some((spec) => spec.mode === 'ingress' && spec.published !== null);
  if (svc.extension.publish === 'none' && publishedIngress && !svc.network.hostNetwork) {
    reportTranslator(ctx.sink, 'ports.publish-none', `${svc.path}.x-dockflow.publish`, { service: svc.composeName });
  }
  // Global services run one pod per node by construction. Several pods of any other kind cannot
  // bind one node port, and the surplus stays Pending until the progress deadline (K36). The port
  // named is the first node binding in model order, or the lowest port on the node network, as
  // pod.ts names it for the same (code, path): the message the sink keeps does not depend on
  // which module reported first.
  const first = svc.network.hostNetwork ? hostNetworkPorts(svc, ctx)[0] : hostBindings(svc, ctx)[0];
  if (first !== undefined && svc.mode !== 'global' && svc.replicas > 1) {
    reportTranslator(ctx.sink, 'ports.host-port-replicas', `${svc.path}.deploy.replicas`, {
      service: svc.composeName,
      port: first.port,
      protocol: first.protocol,
      replicas: svc.replicas,
    });
  }
}

/**
 * Render-wide checks of every node port the stack binds: against the reservation set (the
 * distribution's ports, servers.yml SSH ports, nginx plugin ports, the sibling role's published
 * ports, 80/443 of a Dockflow-owned Traefik) and against the ports other entries of this render
 * already publish. Services are visited in code-unit order of their compose keys, so which entry
 * owns a port does not depend on the order of the stack's service list. A reserved port is not
 * recorded as published: the refusal already names it.
 */
export function checkPublishedPorts(ctx: TranslateContext): void {
  const services = [...ctx.stack.services].sort((a, b) => compareCodeUnits(a.composeName, b.composeName));
  for (const svc of services) {
    checkServiceExposure(svc, ctx);
    for (const exposure of nodeExposures(svc, ctx)) {
      const key = hostPortKey(exposure.port, exposure.protocol);
      const reserved = ctx.reservedHostPorts.get(key);
      if (reserved !== undefined) {
        reportTranslator(ctx.sink, 'ports.reserved-host-port', exposure.path, {
          entry: exposure.path,
          port: exposure.port,
          protocol: exposure.protocol,
          reason: reserved.reason,
        });
        continue;
      }
      const owner = ctx.publishedOwners.get(key);
      if (owner === undefined) {
        ctx.publishedOwners.set(key, exposure.path);
      } else if (owner !== exposure.path) {
        reportTranslator(ctx.sink, 'ports.published-conflict', exposure.path, {
          entry: exposure.path,
          port: exposure.port,
          protocol: exposure.protocol,
          owner,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Service objects (design-02 6.1-6.5)
// ---------------------------------------------------------------------------

function serviceObject(name: string, svc: CanonicalService, spec: ServiceSpec, ctx: TranslateContext): Service {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: ctx.namespace,
      labels: serviceObjectLabels(ctx.stack.identity, svc.role, svc.name),
      annotations: { [ANNOTATIONS.composeService]: svc.composeName },
    },
    spec,
  };
}

/** `targetPort` is omitted: it equals `port` (numeric targetPort semantics). */
function clusterServicePorts(ports: readonly ClusterPort[]): ServicePort[] {
  return ports.map((p) => {
    const entry: ServicePort = { name: p.name, port: p.port, protocol: p.protocol };
    if (p.appProtocol !== null) entry.appProtocol = p.appProtocol;
    return entry;
  });
}

/** `<svc>`, an alias or `<svc>-hl`; a fresh spec per object, so no two objects share arrays. */
function clusterService(name: string, svc: CanonicalService, ports: readonly ClusterPort[], headless: boolean, ctx: TranslateContext): Service {
  const spec: ServiceSpec = { selector: selectorLabels(ctx.stack.identity, svc.name) };
  if (headless) spec.clusterIP = 'None';
  if (ports.length > 0) {
    spec.ports = clusterServicePorts(ports);
  } else if (ctx.traits.headlessServiceNeedsPort) {
    // Only reachable headless: a declared port makes `ports` non-empty. Without a port the
    // EndpointSlice stays empty and the pods get no DNS record (C9).
    const placeholder = ctx.traits.headlessPlaceholderPort;
    spec.ports = [{ name: HEADLESS_PLACEHOLDER_PORT_NAME, port: placeholder.port, protocol: placeholder.protocol }];
  }
  return serviceObject(name, svc, spec, ctx);
}

function loadBalancerService(svc: CanonicalService, ports: readonly LoadBalancerPort[], ctx: TranslateContext): Service {
  const spec: ServiceSpec = {
    type: 'LoadBalancer',
    ports: ports.map((p) => {
      const entry: ServicePort = { name: p.name, port: p.port, protocol: p.protocol, targetPort: p.targetPort };
      if (p.appProtocol !== null) entry.appProtocol = p.appProtocol;
      return entry;
    }),
    selector: selectorLabels(ctx.stack.identity, svc.name),
  };
  // NodePorts would only open 30000-32767 on every node: ServiceLB DNATs to the ClusterIP (K27).
  if (!ctx.traits.loadBalancerNodePorts) spec.allocateLoadBalancerNodePorts = false;
  if (svc.extension.loadBalancerSourceRanges.length > 0) spec.loadBalancerSourceRanges = [...svc.extension.loadBalancerSourceRanges];
  return serviceObject(loadBalancerServiceName(svc.name), svc, spec, ctx);
}

/**
 * Every Service of one compose service, in the order `<svc>`, aliases, `<svc>-lb`, `<svc>-hl`.
 * The main Service exists for every kind, Jobs included; it is headless for `endpoint_mode: dnsrr`
 * and for services that declare neither `ports` nor `expose` (route ports still appear on it).
 */
export function buildServices(svc: CanonicalService, ctx: TranslateContext): Service[] {
  const ports = clusterPorts(svc, ctx);
  const declared = svc.ports.length > 0 || svc.expose.length > 0;
  const headless = svc.network.endpointMode === 'dnsrr' || !declared;
  const out: Service[] = [clusterService(svc.name, svc, ports, headless, ctx)];
  for (const alias of svc.network.aliases) {
    if (alias !== svc.name) out.push(clusterService(alias, svc, ports, headless, ctx));
  }
  const lbPorts = loadBalancerPorts(svc, ctx);
  if (lbPorts.length > 0) out.push(loadBalancerService(svc, lbPorts, ctx));
  if (svc.workloadKind === 'StatefulSet') out.push(clusterService(headlessServiceName(svc.name), svc, ports, true, ctx));
  return out;
}
