/**
 * Public ports — the published container ports the internet may reach on Swarm hosts.
 *
 * Docker publishes ports with DNAT rules that ufw and firewalld never see. `dockflow setup`
 * installs dockflow-public-ports (public-ports.sh) on each host: a chain at the top of Docker's
 * DOCKER-USER that drops the connections the internet opens to a published port no project
 * declared. Each deploy records the project's public ports on every node: firewall.public_ports,
 * plus Traefik's ports when the proxy is on.
 */

import script from './public-ports.sh' with { type: 'text' };
import type { DockflowConfig, PublicPort } from '../utils/config';
import type { ParsedCompose } from './compose';
import { shellQuote } from '../utils/ssh';
import { parsePortSpec, type PortRange } from '../utils/port-spec';
import { PUBLIC_PORTS_BIN, PUBLIC_PORTS_OFF_MARKER } from '../constants';

/** The script setup installs as PUBLIC_PORTS_BIN */
export const PUBLIC_PORTS_SCRIPT: string = script;

export interface PortRule extends PortRange {
  /** addresses or CIDR ranges the port answers; empty: anyone */
  sources: string[];
}

export interface PublishedPort extends PortRange {
  service: string;
}

/** Whether the rule opens the whole range */
function covers(rule: PortRange, range: PortRange): boolean {
  return rule.protocol === range.protocol && rule.from <= range.from && range.to <= rule.to;
}

/**
 * The ports a project opens to the internet: firewall.public_ports, then the ports Traefik
 * publishes when the proxy is on (80, and 443 with ACME), unless the project declares them
 * itself, to keep them to a CDN for instance.
 */
export function publicPortRules(config: Pick<DockflowConfig, 'firewall' | 'proxy'>): PortRule[] {
  const declared = (config.firewall?.public_ports ?? []).flatMap((entry: PublicPort) => {
    const { port, from } = typeof entry === 'object' ? entry : { port: entry, from: undefined };
    const range = parsePortSpec(port);
    return range ? [{ ...range, sources: from ?? [] }] : [];
  });
  if (!config.proxy?.enabled) return declared;

  const traefik = (config.proxy.acme === false ? [80] : [80, 443])
    .map((port): PortRule => ({ from: port, to: port, protocol: 'tcp', sources: [] }))
    .filter((rule) => !declared.some((own) => covers(own, rule)));
  return [...declared, ...traefik];
}

/** A rule as dockflow-public-ports takes it: `8000-8010/udp`, `443/tcp@173.245.48.0/20,2400:cb00::/32` */
export function ruleSpec(rule: PortRule): string {
  const ports = rule.from === rule.to ? `${rule.from}` : `${rule.from}-${rule.to}`;
  return `${ports}/${rule.protocol}${rule.sources.length > 0 ? `@${rule.sources.join(',')}` : ''}`;
}

/** `443/tcp`, `8000-8010/udp`, `443/tcp (from 2 addresses)` */
export function describeRule(rule: PortRule): string {
  const ports = rule.from === rule.to ? `${rule.from}` : `${rule.from}-${rule.to}`;
  const n = rule.sources.length;
  return `${ports}/${rule.protocol}${n > 0 ? ` (from ${n} address${n > 1 ? 'es' : ''})` : ''}`;
}

/** The host side of a `ports` entry published on every interface; null for a random or an address-bound one */
function publishedRange(entry: unknown): PortRange | null {
  if (entry && typeof entry === 'object') {
    const long = entry as Record<string, unknown>;
    if (long.host_ip || long.published === undefined || long.published === null || long.published === '') return null;
    return parsePortSpec(`${long.published}/${String(long.protocol ?? 'tcp').toLowerCase()}`);
  }
  // a bare container port is published on a random host port
  if (typeof entry !== 'string') return null;
  const [mapping, protocol = 'tcp'] = entry.split('/');
  const parts = mapping.split(':');
  return parts.length === 2 ? parsePortSpec(`${parts[0]}/${protocol.toLowerCase()}`) : null;
}

/** The host ports the services of a compose publish on every interface */
export function publishedPorts(compose: ParsedCompose): PublishedPort[] {
  return Object.entries(compose.services).flatMap(([service, svc]) =>
    (Array.isArray(svc.ports) ? svc.ports : []).flatMap((entry) => {
      const range = publishedRange(entry);
      return range ? [{ service, ...range }] : [];
    }),
  );
}

/** The published ports no rule opens to the internet */
export function closedPorts(published: readonly PublishedPort[], rules: readonly PortRule[]): PublishedPort[] {
  return published.filter((port) => !rules.some((rule) => covers(rule, port)));
}

/** `web 8080/tcp` */
export function describePublished(port: PublishedPort): string {
  return `${port.service} ${port.from === port.to ? port.from : `${port.from}-${port.to}`}/${port.protocol}`;
}

/**
 * The program a node runs to record the project's public ports and apply them. It prints `off`
 * on a node set up with --no-port-filter, `missing` on one set up before the filter existed.
 */
export function recordCommand(project: string, rules: readonly PortRule[], user: string): string {
  const sudo = user === 'root' ? '' : 'sudo -n ';
  const args = [project, ...rules.map(ruleSpec)].map(shellQuote).join(' ');
  return (
    `if [ -x ${PUBLIC_PORTS_BIN} ]; then ${sudo}${PUBLIC_PORTS_BIN} set ${args}; ` +
    `elif [ -e ${PUBLIC_PORTS_OFF_MARKER} ]; then echo off; else echo missing; fi`
  );
}

/** Whether a host address only answers locally */
function isLoopback(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  return bare === '::1' || bare.startsWith('127.');
}

/**
 * The ports published right now, by project, for the first install of the filter on a host that
 * already runs containers: they stay open until their project's next deploy records its own.
 * Reads the lines of
 *   docker service inspect --format '{{index .Spec.Labels "com.docker.stack.namespace"}}|{{range .Endpoint.Ports}}{{.PublishedPort}}/{{.Protocol}} {{end}}'
 *   docker container ls --format '{{.Label "com.docker.swarm.service.id"}}|{{.Ports}}'
 * A stack's accessories belong to its project (`<stack>-accessories`); services outside stacks
 * group as `services`, standalone containers as `containers`.
 */
export function currentPublicPorts(serviceLines: string, containerLines: string): Map<string, string[]> {
  const byProject = new Map<string, Set<string>>();
  const add = (project: string, spec: string) => {
    const range = parsePortSpec(spec);
    if (!range) return;
    const specs = byProject.get(project) ?? new Set<string>();
    specs.add(ruleSpec({ ...range, sources: [] }));
    byProject.set(project, specs);
  };

  for (const line of serviceLines.split('\n')) {
    const separator = line.indexOf('|');
    if (separator === -1) continue;
    const stack = line.slice(0, separator).trim().replace(/-accessories$/, '');
    // a file name dockflow-public-ports accepts
    const project = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(stack) ? stack : 'services';
    for (const spec of line.slice(separator + 1).trim().split(/\s+/).filter(Boolean)) add(project, spec);
  }

  for (const line of containerLines.split('\n')) {
    const separator = line.indexOf('|');
    // Swarm tasks are counted with their service
    if (separator === -1 || line.slice(0, separator).trim() !== '') continue;
    for (const mapping of line.slice(separator + 1).split(',')) {
      const match = /^(.+):(\d+(?:-\d+)?)->\d+(?:-\d+)?\/(tcp|udp)$/.exec(mapping.trim());
      if (match && !isLoopback(match[1])) add('containers', `${match[2]}/${match[3]}`);
    }
  }

  return new Map([...byProject].map(([project, specs]) => [project, [...specs].sort()]));
}
