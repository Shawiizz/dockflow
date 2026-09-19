// Normalizer handler for `ports` and `expose` (design-01 5.4, D9, C7). Pure.
// Everything decidable from the model alone is the translator's (design-01 1.6) and is not checked
// here: reserved and conflicting host ports, a host IP on a load-balanced port, SCTP or too many
// ports behind a load balancer, node-bound duplicates of one target, host ports with replicas.

import { PORTS_EXPANSION_MAX } from '../constants';
import type { ExposeSpec, PortSpec, Protocol } from '../model/types';
import { isIp, isLabelKey, parseIntStrict } from '../model/units';
import { childPath, compareCodeUnits, indexPath, isPlainMap, type NormalizeContext, type ServiceDraft } from './context';

/** One port of a short-syntax entry after range expansion. */
export interface PortEntry {
  target: number;
  /** null = container-only (`"3000"`, or host port 0) */
  published: number | null;
  protocol: Protocol;
  /** null for absent, `0.0.0.0` and `::` */
  hostIp: string | null;
}

export type PortParseError =
  | { error: 'invalid'; detail: string }
  /** `example` is the fixed-port form the hint proposes, quoted: `"8000:80"` */
  | { error: 'dynamic-range'; example: string }
  | { error: 'range-mismatch' }
  | { error: 'range-too-large'; count: number };

interface PortRange {
  start: number;
  end: number;
}

const PORT_MAX = 65535;
const PORT_RANGE_RE = /^([0-9]+)(?:-([0-9]+))?$/;
const PROTOCOLS: ReadonlySet<string> = new Set(['tcp', 'udp', 'sctp']);

/** `/^[0-9]+(-[0-9]+)?$/`, both ends in min..65535, end >= start */
function parsePortRange(text: string, min: number): PortRange | null {
  const m = PORT_RANGE_RE.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < min || end > PORT_MAX || end < start) return null;
  return { start, end };
}

/** Eight 16-bit groups of an IPv6 address; null for IPv4 and embedded-IPv4 forms. */
function ipv6Groups(ip: string): number[] | null {
  if (!ip.includes(':') || ip.includes('.')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 1 ? null : halves[1] === '' ? [] : halves[1].split(':');
  const groups = tail === null ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  return groups.length === 8 ? groups.map((g) => Number.parseInt(g, 16)) : null;
}

function isUnspecifiedIp(ip: string): boolean {
  if (ip === '0.0.0.0') return true;
  const groups = ipv6Groups(ip);
  return groups !== null && groups.every((g) => g === 0);
}

function isIpv4Loopback(ip: string): boolean {
  return !ip.includes(':') && ip.startsWith('127.');
}

function isIpv6Loopback(ip: string): boolean {
  const groups = ipv6Groups(ip);
  return groups !== null && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

/** Brackets stripped; the unspecified addresses mean "every address" and become null. */
function normalizeHostIp(ip: string): string | null {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  return bare === '' || isUnspecifiedIp(bare) ? null : bare.toLowerCase();
}

function unbracketed(ip: string): string {
  return ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
}

/**
 * `[ip:](port|range):(port|range)[/protocol]` with nat.ParsePortSpec semantics (design-01 0.1),
 * stricter where commented: container port 0 is refused, and a host range onto one container port
 * (Docker's "any free port in the range") is refused because Kubernetes needs a fixed port.
 */
export function parsePortShort(spec: string | number): PortEntry[] | PortParseError {
  const raw = String(spec);
  const parts = raw.split(':');
  let ip = '';
  let host = '';
  let container: string;
  if (parts.length === 1) container = parts[0];
  else if (parts.length === 2) [host, container] = parts;
  else {
    // more than three parts: an unbracketed IPv6 address joined back
    ip = parts.slice(0, -2).join(':');
    host = parts[parts.length - 2];
    container = parts[parts.length - 1];
  }
  const containerWritten = container;
  let protocol = 'tcp';
  const slash = container.indexOf('/');
  if (slash !== -1) {
    protocol = container.slice(slash + 1).toLowerCase();
    container = container.slice(0, slash);
  }
  if (container === '') return { error: 'invalid', detail: 'no container port' };
  if (!PROTOCOLS.has(protocol)) {
    return { error: 'invalid', detail: protocol === '' ? 'no protocol after /' : `unknown protocol ${protocol}` };
  }
  ip = unbracketed(ip);
  if (ip !== '' && !isIp(ip)) return { error: 'invalid', detail: `invalid IP address ${ip}` };
  const c = parsePortRange(container, 1);
  if (!c) return { error: 'invalid', detail: `invalid container port ${container}` };
  const h = host === '' ? null : parsePortRange(host, 0);
  if (host !== '' && !h) return { error: 'invalid', detail: `invalid host port ${host}` };
  if (h && h.end - h.start !== c.end - c.start) {
    return c.end === c.start ? { error: 'dynamic-range', example: `"${h.start}:${containerWritten}"` } : { error: 'range-mismatch' };
  }
  const count = c.end - c.start + 1;
  if (count > PORTS_EXPANSION_MAX) return { error: 'range-too-large', count };
  const hostIp = normalizeHostIp(ip);
  const upper = protocol.toUpperCase() as Protocol;
  return Array.from({ length: count }, (_, i) => ({
    target: c.start + i,
    // host port 0 asks Docker for a random port: not published
    published: h === null || h.start === 0 ? null : h.start + i,
    protocol: upper,
    hostIp,
  }));
}

export type ExposeParseResult =
  | { ok: true; ports: { target: number; protocol: Protocol }[] }
  | { ok: false; error: 'invalid' }
  | { ok: false; error: 'range-too-large'; count: number };

/** `port[/protocol]` or `start-end[/protocol]` */
export function parseExposeEntry(spec: string | number): ExposeParseResult {
  const raw = String(spec);
  const slash = raw.indexOf('/');
  const protocol = slash === -1 ? 'tcp' : raw.slice(slash + 1).toLowerCase();
  if (!PROTOCOLS.has(protocol)) return { ok: false, error: 'invalid' };
  const range = parsePortRange(slash === -1 ? raw : raw.slice(0, slash), 1);
  if (!range) return { ok: false, error: 'invalid' };
  const count = range.end - range.start + 1;
  if (count > PORTS_EXPANSION_MAX) return { ok: false, error: 'range-too-large', count };
  const upper = protocol.toUpperCase() as Protocol;
  return { ok: true, ports: Array.from({ length: count }, (_, i) => ({ target: range.start + i, protocol: upper })) };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type Publish = 'loadbalancer' | 'hostport' | 'none';

/** A PortSpec with the entry as written, which messages quote. */
interface ParsedPort {
  spec: PortSpec;
  text: string;
}

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'mapping';
  return typeof value;
}

function invalidType(ctx: NormalizeContext, path: string, expected: string, value: unknown): void {
  ctx.sink.error('values.invalid-type', path, `expected ${expected}, got ${typeName(value)}`, 'See the Compose specification for the accepted forms.');
}

function isAbsent(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * `x-dockflow.publish` as written. extension.ts runs after this handler and reports an invalid
 * value; until then anything but `hostport` and `none` is the model default, load-balancer exposure.
 */
function writtenPublish(node: Record<string, unknown>): Publish {
  const extension = node['x-dockflow'];
  const publish = isPlainMap(extension) ? extension.publish : undefined;
  return publish === 'hostport' || publish === 'none' ? publish : 'loadbalancer';
}

function reportParseError(error: PortParseError, text: string, path: string, ctx: NormalizeContext): void {
  switch (error.error) {
    case 'invalid':
      ctx.sink.error(
        'ports.invalid',
        path,
        `${text} is not a valid port mapping: ${error.detail}`,
        'Use `[ip:]host:container[/protocol]`, for example `"8080:80"`.',
      );
      return;
    case 'dynamic-range':
      ctx.sink.error(
        'ports.dynamic-range',
        path,
        `${text} asks for any free host port in a range; Kubernetes needs a fixed port`,
        `Publish one fixed port, for example \`${error.example}\`.`,
      );
      return;
    case 'range-mismatch':
      ctx.sink.error('ports.range-mismatch', path, `${text} maps port ranges of different sizes`, 'Use ranges of the same length.');
      return;
    case 'range-too-large':
      reportRangeTooLarge(text, error.count, path, ctx);
      return;
  }
}

function reportRangeTooLarge(text: string, count: number, path: string, ctx: NormalizeContext): void {
  ctx.sink.error(
    'ports.range-too-large',
    path,
    `${text} expands to ${count} ports; at most ${PORTS_EXPANSION_MAX} are supported per entry`,
    'Publish fewer ports, or use `network_mode: host`.',
  );
}

function shortPort(entry: string | number, path: string, ctx: NormalizeContext): ParsedPort[] {
  const text = String(entry);
  const result = parsePortShort(entry);
  if (!Array.isArray(result)) {
    reportParseError(result, text, path, ctx);
    return [];
  }
  return result.map((p) => ({
    spec: { target: p.target, published: p.published, protocol: p.protocol, mode: 'ingress', hostIp: p.hostIp, name: null, appProtocol: null, path },
    text,
  }));
}

/** The short form equivalent of a long entry, as messages quote it: `127.0.0.1:8080:80/udp`. */
function longText(entry: Record<string, unknown>): string {
  const target = scalarText(entry.target) ?? '';
  const published = scalarText(entry.published);
  const hostIp = scalarText(entry.host_ip);
  const protocol = scalarText(entry.protocol);
  let text = target;
  if (published !== null || (hostIp !== null && hostIp !== '')) text = `${published ?? ''}:${text}`;
  if (hostIp !== null && hostIp !== '') text = `${hostIp.includes(':') && !hostIp.startsWith('[') ? `[${hostIp}]` : hostIp}:${text}`;
  if (protocol !== null && protocol !== '') text = `${text}/${protocol}`;
  return text;
}

/** `undefined` = an error was reported */
function longTarget(value: unknown, path: string, ctx: NormalizeContext): number | undefined {
  if (isAbsent(value) || value === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    invalidType(ctx, path, 'number', value);
    return undefined;
  }
  const target = parseIntStrict(value, 1, PORT_MAX);
  if (target === null) {
    ctx.sink.error('ports.invalid-target', path, `target ${value} is not a port number`, 'Write a port between 1 and 65535.');
    return undefined;
  }
  return target;
}

function longPublished(value: unknown, targetText: string, text: string, path: string, ctx: NormalizeContext): number | null | undefined {
  if (isAbsent(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    invalidType(ctx, path, 'number', value);
    return undefined;
  }
  const range = typeof value === 'number' ? (Number.isSafeInteger(value) ? parsePortRange(String(value), 0) : null) : parsePortRange(value, 0);
  if (range === null) {
    reportParseError({ error: 'invalid', detail: `invalid host port ${value}` }, text, path, ctx);
    return undefined;
  }
  if (range.end !== range.start) {
    reportParseError({ error: 'dynamic-range', example: `"${range.start}:${targetText}"` }, text, path, ctx);
    return undefined;
  }
  return range.start === 0 ? null : range.start;
}

function longHostIp(value: unknown, text: string, path: string, ctx: NormalizeContext): string | null | undefined {
  if (isAbsent(value)) return null;
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return undefined;
  }
  const bare = unbracketed(value);
  if (bare !== '' && !isIp(bare)) {
    reportParseError({ error: 'invalid', detail: `invalid IP address ${bare}` }, text, path, ctx);
    return undefined;
  }
  return normalizeHostIp(bare);
}

function longProtocol(value: unknown, text: string, path: string, ctx: NormalizeContext): Protocol | undefined {
  if (isAbsent(value)) return 'TCP';
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return undefined;
  }
  const lower = value.toLowerCase();
  if (!PROTOCOLS.has(lower)) {
    reportParseError({ error: 'invalid', detail: `unknown protocol ${value}` }, text, path, ctx);
    return undefined;
  }
  return lower.toUpperCase() as Protocol;
}

function longMode(value: unknown, path: string, ctx: NormalizeContext): PortSpec['mode'] | undefined {
  if (isAbsent(value)) return 'ingress';
  if (value === 'ingress' || value === 'host') return value;
  ctx.sink.error('ports.invalid-mode', path, `mode ${scalarText(value) ?? typeName(value)} must be ingress or host`);
  return undefined;
}

/** A Compose port name is documentation only: the translator falls back to `<proto>-<port>` without a diagnostic. */
function longName(value: unknown, path: string, ctx: NormalizeContext): string | null | undefined {
  if (isAbsent(value)) return null;
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return undefined;
  }
  return value === '' ? null : value;
}

function longAppProtocol(value: unknown, path: string, ctx: NormalizeContext): string | null | undefined {
  if (isAbsent(value)) return null;
  if (typeof value !== 'string') {
    invalidType(ctx, path, 'string', value);
    return undefined;
  }
  // Service ports validate appProtocol as a qualified name
  if (!isLabelKey(value)) {
    ctx.sink.warn('ports.invalid-app-protocol', path, `app_protocol ${value} is not a valid Kubernetes appProtocol and is dropped`);
    return null;
  }
  return value;
}

function longPort(entry: Record<string, unknown>, path: string, ctx: NormalizeContext): ParsedPort[] {
  const text = longText(entry);
  const target = longTarget(entry.target, childPath(path, 'target'), ctx);
  const published = longPublished(entry.published, scalarText(entry.target) ?? '', text, childPath(path, 'published'), ctx);
  const hostIp = longHostIp(entry.host_ip, text, childPath(path, 'host_ip'), ctx);
  const protocol = longProtocol(entry.protocol, text, childPath(path, 'protocol'), ctx);
  const mode = longMode(entry.mode, childPath(path, 'mode'), ctx);
  const name = longName(entry.name, childPath(path, 'name'), ctx);
  const appProtocol = longAppProtocol(entry.app_protocol, childPath(path, 'app_protocol'), ctx);
  if (mode === 'host' && published === null) {
    ctx.sink.error('ports.host-mode-needs-published', path, 'mode host requires published', 'Set `published:` to the host port.');
    return [];
  }
  if (
    target === undefined ||
    published === undefined ||
    hostIp === undefined ||
    protocol === undefined ||
    mode === undefined ||
    name === undefined ||
    appProtocol === undefined
  ) {
    return [];
  }
  return [{ spec: { target, published, protocol, mode, hostIp, name, appProtocol, path }, text }];
}

function portEntry(entry: unknown, path: string, ctx: NormalizeContext): ParsedPort[] {
  if (typeof entry === 'string' || typeof entry === 'number') return shortPort(entry, path, ctx);
  if (isPlainMap(entry)) return longPort(entry, path, ctx);
  invalidType(ctx, path, 'string or mapping', entry);
  return [];
}

/** (target, protocol, published ?? -1): the model order (DESIGN-CORE 3) */
function comparePorts(a: PortSpec, b: PortSpec): number {
  return a.target - b.target || compareCodeUnits(a.protocol, b.protocol) || (a.published ?? -1) - (b.published ?? -1);
}

/**
 * The second of two entries publishing one (published, protocol, hostIp), in model order, is
 * reported and dropped, so the translator never sees the pair (design-01 1.6).
 */
function dropDuplicates(parsed: ParsedPort[], ctx: NormalizeContext): ParsedPort[] {
  const seen = new Set<string>();
  return parsed.filter(({ spec }) => {
    if (spec.published === null) return true;
    const key = `${spec.published}/${spec.protocol}/${spec.hostIp ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      return true;
    }
    ctx.sink.error(
      'ports.duplicate',
      spec.path,
      `host port ${spec.published}/${spec.protocol.toLowerCase()} is published twice`,
      'Remove one of the entries.',
    );
    return false;
  });
}

/**
 * Host IPs of published ports. A node-bound port (`mode: host`, or ingress with `publish: hostport`)
 * becomes `hostPort` + `hostIP`, which the CNI portmap plugin honours for 127.0.0.0/8 (it enables
 * route_localnet itself) but never for ::1. The load-balanced case is the translator's.
 */
function checkHostIps(parsed: ParsedPort[], publish: Publish, ctx: NormalizeContext): void {
  for (const { spec, text } of parsed) {
    if (spec.hostIp === null || spec.published === null) continue;
    const nodeBound = spec.mode === 'host' || publish === 'hostport';
    if (nodeBound && isIpv4Loopback(spec.hostIp)) {
      ctx.sink.info(
        'ports.loopback-host-port',
        spec.path,
        `${text} binds the host port to ${spec.hostIp}, so only the node that runs the pod can reach it`,
        'Remove the address to bind the port on every address of that node.',
      );
    } else if (nodeBound && isIpv6Loopback(spec.hostIp)) {
      ctx.sink.error(
        'ports.ipv6-loopback-host-port',
        spec.path,
        `${text} binds a host port to ::1, which the CNI portmap plugin never forwards (there is no IPv6 equivalent of route_localnet)`,
        'Use `127.0.0.1`, or keep the port inside the cluster with `x-dockflow.publish: none`.',
      );
    } else if (!nodeBound && publish === 'none') {
      ctx.sink.warn(
        'ports.host-ip-ignored',
        spec.path,
        `the address ${spec.hostIp} of ${text} is ignored because \`x-dockflow.publish\` is \`none\``,
        'Remove the address.',
      );
    }
  }
}

function normalizePortList(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): PortSpec[] {
  const path = childPath(draft.path, 'ports');
  const value = node.ports;
  if (isAbsent(value)) return [];
  if (!Array.isArray(value)) {
    invalidType(ctx, path, 'list', value);
    return [];
  }
  draft.rawPorts = [...value];
  const parsed = value.flatMap((entry, i) => portEntry(entry, indexPath(path, i), ctx));
  if (value.length > 0 && node.network_mode === 'host') {
    ctx.sink.error(
      'ports.with-host-network',
      path,
      'ports cannot be combined with network_mode: host: the container already listens on the node',
      'Remove `ports`.',
    );
    return [];
  }
  const kept = dropDuplicates(
    parsed.sort((a, b) => comparePorts(a.spec, b.spec)),
    ctx,
  );
  checkHostIps(kept, writtenPublish(node), ctx);
  return kept.map((p) => p.spec);
}

/** Entries already in `ports` and repeated entries are merged. */
function normalizeExpose(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): ExposeSpec[] {
  const path = childPath(draft.path, 'expose');
  const value = node.expose;
  if (isAbsent(value)) return [];
  if (!Array.isArray(value)) {
    invalidType(ctx, path, 'list', value);
    return [];
  }
  const taken = new Set(draft.ports.map((p) => `${p.target}/${p.protocol}`));
  const expose: ExposeSpec[] = [];
  value.forEach((entry, i) => {
    const entryPath = indexPath(path, i);
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      invalidType(ctx, entryPath, 'string', entry);
      return;
    }
    const result = parseExposeEntry(entry);
    if (!result.ok) {
      if (result.error === 'range-too-large') reportRangeTooLarge(String(entry), result.count, entryPath, ctx);
      else ctx.sink.error('expose.invalid', entryPath, `${entry} is not a port or port range`, 'Write `port[/protocol]` or `start-end[/protocol]`.');
      return;
    }
    for (const port of result.ports) {
      const key = `${port.target}/${port.protocol}`;
      if (taken.has(key)) continue;
      taken.add(key);
      expose.push({ target: port.target, protocol: port.protocol, path: entryPath });
    }
  });
  return expose.sort((a, b) => a.target - b.target || compareCodeUnits(a.protocol, b.protocol));
}

/** `ports` and `expose` of one service (design-01 1.1 step 9). */
export function ports(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  draft.ports = normalizePortList(draft, node, ctx);
  draft.expose = normalizeExpose(draft, node, ctx);
}
