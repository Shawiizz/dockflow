// Normalizer handlers for top-level `networks` (design-01 6.1) and the service networking keys
// (5.11): network membership, aliases and links, network_mode, hostname, DNS and extra hosts. Pure.
// The pod network is flat, so membership is informational; `network.host-network` and
// `network.dns-secondary` are decidable from the model and belong to the translator (1.6).

import type { NetworkSpec } from '../model/types';
import { isDnsLabel, isDnsSubdomain, isIp, isServiceKey, parseBool } from '../model/units';
import { serviceNameFor } from '../naming';
import {
  childPath,
  compareCodeUnits,
  indexPath,
  isPlainMap,
  type NetworkDraft,
  type NetworkTable,
  type NormalizeContext,
  newNetworkDraft,
  type ServiceDraft,
  sortedKeys,
  sortedUnique,
} from './context';

/** kubelet limits on dnsConfig once merged with the cluster DNS (design-01 0.1) */
const KUBELET_MAX_NAMESERVERS = 3;
const KUBELET_MAX_DNS_SEARCH = 32;
const KUBELET_MAX_DNS_SEARCH_CHARS = 2048;

const TRAEFIK_PUBLIC = 'traefik-public';
const DEFAULT_NETWORK = 'default';

/** Top-level network options with no Kubernetes counterpart (`name` only when not external). */
const IGNORED_NETWORK_OPTIONS = ['driver', 'driver_opts', 'ipam', 'attachable', 'enable_ipv4', 'labels'] as const;

/** Per-service attachment options that have no effect on a flat pod network. */
const IGNORED_ATTACHMENT_OPTIONS = ['link_local_ips', 'mac_address', 'driver_opts', 'priority', 'gw_priority', 'interface_name'] as const;

// ---------------------------------------------------------------------------
// Shared value helpers
// ---------------------------------------------------------------------------

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

/** A written list or mapping with at least one entry (Compose ignores an empty one). */
function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isPlainMap(value) && Object.keys(value).length > 0;
}

/** compose-go toBoolean with the YAML 1.1 warning; null after an error */
function readBool(value: unknown, path: string, ctx: NormalizeContext): boolean | null {
  const parsed = parseBool(value);
  if (parsed === null) {
    ctx.sink.error('values.invalid-boolean', path, `expected true or false, got ${String(value)}`, 'Write `true` or `false`.');
    return null;
  }
  if (parsed.yaml11) {
    ctx.sink.warn(
      'values.yaml11-boolean',
      path,
      `${String(value)} is read as ${parsed.value}; YAML 1.2 only knows true and false`,
      `Write \`${parsed.value}\`.`,
    );
  }
  return parsed.value;
}

interface WrittenString {
  value: string;
  path: string;
}

/** `string_or_list` (design-01 2.9); null when absent or not usable */
function stringOrList(value: unknown, path: string, ctx: NormalizeContext): WrittenString[] | null {
  if (isAbsent(value)) return null;
  if (typeof value === 'string') return [{ value, path }];
  if (!Array.isArray(value)) {
    invalidType(ctx, path, 'string or list', value);
    return null;
  }
  return stringItems(value, path, ctx);
}

/** Items of a list that must be strings; the others are reported and skipped. */
function stringItems(list: unknown[], path: string, ctx: NormalizeContext): WrittenString[] {
  const items: WrittenString[] = [];
  list.forEach((item, i) => {
    const itemPath = indexPath(path, i);
    if (typeof item === 'string') items.push({ value: item, path: itemPath });
    else invalidType(ctx, itemPath, 'string', item);
  });
  return items;
}

function stringList(value: unknown, path: string, ctx: NormalizeContext): WrittenString[] | null {
  if (isAbsent(value)) return null;
  if (!Array.isArray(value)) {
    invalidType(ctx, path, 'list', value);
    return null;
  }
  return stringItems(value, path, ctx);
}

/** Once per stack, whether a top-level declaration or a service membership triggers it. */
function flatNetworkInfo(ctx: NormalizeContext): void {
  ctx.sink.info('network.flat', 'networks', 'Kubernetes has one flat pod network: network membership does not isolate services');
}

// ---------------------------------------------------------------------------
// Top-level networks (design-01 6.1)
// ---------------------------------------------------------------------------

/** `external` in its boolean and deprecated `{name}` forms; null after an error. */
function readExternal(value: unknown, path: string, ctx: NormalizeContext): { external: boolean; name: string | null } | null {
  if (isAbsent(value)) return { external: false, name: null };
  if (isPlainMap(value)) {
    const name = value.name;
    if (isAbsent(name)) return { external: true, name: null };
    if (typeof name !== 'string') {
      invalidType(ctx, childPath(path, 'name'), 'string', name);
      return null;
    }
    return { external: true, name };
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    const external = readBool(value, path, ctx);
    return external === null ? null : { external, name: null };
  }
  invalidType(ctx, path, 'boolean', value);
  return null;
}

function readNetworkEntry(draft: NetworkDraft, entry: Record<string, unknown>, ctx: NormalizeContext): void {
  const external = readExternal(entry.external, childPath(draft.path, 'external'), ctx);
  const namePath = childPath(draft.path, 'name');
  let name: string | null = null;
  if (typeof entry.name === 'string') name = entry.name;
  else if (!isAbsent(entry.name)) invalidType(ctx, namePath, 'string', entry.name);

  draft.external = external?.external ?? false;
  draft.name = name ?? external?.name ?? draft.key;
  const { stackName, namespace } = ctx.input.identity;
  if (draft.external) {
    if (draft.name === `${stackName}-accessories_default` || draft.name === TRAEFIK_PUBLIC) {
      ctx.sink.info(
        'networks.not-needed',
        draft.path,
        `${draft.name} is not needed on Kubernetes: services and accessories share the namespace ${namespace} and resolve each other by name`,
      );
    } else {
      ctx.sink.warn(
        'networks.external-cross-stack',
        draft.path,
        `external network ${draft.name} cannot connect stacks on Kubernetes: other Dockflow stacks run in other namespaces`,
        'Reach a service of another stack with `<service>.<namespace>.svc.cluster.local`.',
      );
    }
  } else if (name !== null) {
    ctx.sink.info('networks.option-ignored', namePath, 'name is ignored: the pod network is managed by the cluster');
  }

  for (const option of IGNORED_NETWORK_OPTIONS) {
    if (isAbsent(entry[option])) continue;
    ctx.sink.info('networks.option-ignored', childPath(draft.path, option), `${option} is ignored: the pod network is managed by the cluster`);
  }
  if (!isAbsent(entry.internal) && readBool(entry.internal, childPath(draft.path, 'internal'), ctx) === true) {
    ctx.sink.warn(
      'networks.internal-not-enforced',
      childPath(draft.path, 'internal'),
      'internal: true is not enforced: pods can reach the internet and every other pod',
      'Remove `internal: true`, or restrict the traffic outside Dockflow: network policies are not generated in this Dockflow version.',
    );
  }
  if (!isAbsent(entry.enable_ipv6) && readBool(entry.enable_ipv6, childPath(draft.path, 'enable_ipv6'), ctx) === true) {
    ctx.sink.warn('networks.ipv6-ignored', childPath(draft.path, 'enable_ipv6'), 'enable_ipv6 is ignored: the pod network is managed by the cluster');
  }
  for (const key of sortedKeys(entry)) {
    // x-dockflow here is extension.misplaced, reported by the extension handler
    if (!key.startsWith('x-') || key === 'x-dockflow') continue;
    ctx.sink.info('extension.ignored', childPath(draft.path, key), `${key} is an extension field and is ignored`);
  }
}

/** Every declared top-level network by key (design-01 1.1 step 5); informational. */
export function normalizeTopLevelNetworks(networks: unknown, ctx: NormalizeContext): NetworkTable {
  const table: NetworkTable = new Map();
  if (isAbsent(networks)) return table;
  if (!isPlainMap(networks)) {
    invalidType(ctx, 'networks', 'mapping', networks);
    return table;
  }
  const keys = sortedKeys(networks);
  if (keys.length > 0) flatNetworkInfo(ctx);
  for (const key of keys) {
    const draft = newNetworkDraft(key);
    // kept in the table even when refused, so service references do not report it a second time
    table.set(key, draft);
    if (!isServiceKey(key)) {
      ctx.sink.error('names.invalid-key', draft.path, `${key} is not a valid network name`, 'Use letters, digits, `.`, `_` and `-` only.');
      continue;
    }
    const entry = networks[key];
    if (isAbsent(entry)) continue;
    if (!isPlainMap(entry)) {
      invalidType(ctx, draft.path, 'mapping', entry);
      continue;
    }
    readNetworkEntry(draft, entry, ctx);
  }
  return table;
}

// ---------------------------------------------------------------------------
// Service networking (design-01 5.11)
// ---------------------------------------------------------------------------

function isDeclared(name: string, networks: NetworkTable): boolean {
  return name === DEFAULT_NETWORK || networks.has(name);
}

function undeclaredNetwork(name: string, path: string, ctx: NormalizeContext): void {
  ctx.sink.error('network.undeclared', path, `network ${name} is not declared under top-level networks`, 'Declare it, or remove it from the service.');
}

/**
 * Adds an alias sanitized like a service name. An alias equal to the service's own name adds
 * nothing; collisions with other names are the stack checks'.
 */
function addAlias(written: WrittenString, draft: ServiceDraft, aliases: string[], ctx: NormalizeContext): void {
  if (written.value === '') {
    ctx.sink.error('values.empty', written.path, 'must not be empty');
    return;
  }
  const sanitized = serviceNameFor(written.value);
  if (sanitized.value === draft.name) return;
  if (sanitized.changed) {
    ctx.sink.warn(
      'names.sanitized',
      written.path,
      `alias ${written.value} is deployed as Service ${sanitized.value}; clients using ${written.value} will not resolve it`,
      `Rename the alias to \`${sanitized.value}\` (lowercase letters, digits and \`-\`).`,
    );
  }
  aliases.push(sanitized.value);
}

function readAttachment(
  network: string,
  attachment: unknown,
  path: string,
  draft: ServiceDraft,
  aliases: string[],
  ctx: NormalizeContext,
): void {
  if (isAbsent(attachment)) return;
  if (!isPlainMap(attachment)) {
    invalidType(ctx, path, 'mapping', attachment);
    return;
  }
  for (const written of stringList(attachment.aliases, childPath(path, 'aliases'), ctx) ?? []) addAlias(written, draft, aliases, ctx);
  for (const option of ['ipv4_address', 'ipv6_address']) {
    if (isAbsent(attachment[option])) continue;
    ctx.sink.error(
      'network.static-ip-unsupported',
      childPath(path, option),
      'static IP addresses are not supported: pod addresses are assigned by the cluster',
      `Reach the service by its name \`${draft.name}\`.`,
    );
  }
  for (const option of IGNORED_ATTACHMENT_OPTIONS) {
    if (isAbsent(attachment[option])) continue;
    const relative = childPath(childPath('networks', network), option);
    ctx.sink.warn('network.attachment-option-ignored', childPath(path, option), `${relative} is ignored on Kubernetes`);
  }
}

/** `networks` list or map: the attached keys, sorted; undeclared ones are refused and left out. */
function readServiceNetworks(
  node: Record<string, unknown>,
  networks: NetworkTable,
  draft: ServiceDraft,
  aliases: string[],
  ctx: NormalizeContext,
): void {
  const path = childPath(draft.path, 'networks');
  const value = node.networks;
  if (isAbsent(value)) return;
  const members: WrittenString[] = [];
  if (Array.isArray(value)) {
    members.push(...stringItems(value, path, ctx));
  } else if (isPlainMap(value)) {
    for (const key of sortedKeys(value)) {
      const memberPath = childPath(path, key);
      members.push({ value: key, path: memberPath });
      readAttachment(key, value[key], memberPath, draft, aliases, ctx);
    }
  } else {
    invalidType(ctx, path, 'list or mapping', value);
    return;
  }
  // an empty membership is no membership: Compose attaches the service to `default`
  if (members.length === 0) return;
  const names: string[] = [];
  for (const member of members) {
    if (!isDeclared(member.value, networks)) {
      undeclaredNetwork(member.value, member.path, ctx);
      continue;
    }
    if (member.value === TRAEFIK_PUBLIC) {
      ctx.sink.info(
        'network.traefik-public',
        member.path,
        'traefik-public is not needed on Kubernetes: Traefik reaches services directly',
      );
    }
    names.push(member.value);
  }
  flatNetworkInfo(ctx);
  draft.network.networks = sortedUnique(names);
}

function readNetworkMode(node: Record<string, unknown>, networks: NetworkTable, draft: ServiceDraft, ctx: NormalizeContext): void {
  const mode = node.network_mode;
  if (isAbsent(mode)) return;
  const path = childPath(draft.path, 'network_mode');
  if (typeof mode !== 'string') {
    invalidType(ctx, path, 'string', mode);
    return;
  }
  if (hasEntries(node.networks)) ctx.sink.error('network.mode-with-networks', path, 'network_mode and networks cannot be combined');
  if (mode === 'host') {
    draft.network.hostNetwork = true;
    return;
  }
  if (mode === 'bridge') return;
  if (mode === 'none') {
    ctx.sink.error('network.mode-none-unsupported', path, 'network_mode: none is not supported', 'Remove `network_mode`.');
    return;
  }
  const shared = /^(service|container):(.*)$/.exec(mode);
  if (shared) {
    ctx.sink.error(
      'network.shared-namespace-unsupported',
      path,
      `network_mode ${mode} is not supported: services run in separate pods`,
      `Remove \`network_mode\` and reach \`${shared[2]}\` by its service name.`,
    );
    return;
  }
  if (mode === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return;
  }
  // any other value names the one network the container joins, as the Docker engine reads it
  if (!isDeclared(mode, networks)) {
    undeclaredNetwork(mode, path, ctx);
    return;
  }
  flatNetworkInfo(ctx);
  draft.network.networks = [mode];
}

/** Keys of both compose files: a link may name a service of the other role. */
function knownServiceKeys(ctx: NormalizeContext): Set<string> {
  const services = ctx.input.compose.raw.services;
  const keys = new Set(isPlainMap(services) ? Object.keys(services) : []);
  for (const sibling of ctx.input.sibling.services) keys.add(sibling.key);
  return keys;
}

/**
 * `links: [svc]` adds nothing (the target already resolves by its own name); `[svc:alias]` adds
 * `alias` to this service's aliases (DESIGN-CORE 3 NetworkSpec.aliases).
 */
function readLinks(node: Record<string, unknown>, draft: ServiceDraft, aliases: string[], ctx: NormalizeContext): void {
  const links = stringList(node.links, childPath(draft.path, 'links'), ctx);
  if (links === null || links.length === 0) return;
  const services = knownServiceKeys(ctx);
  for (const link of links) {
    const colon = link.value.indexOf(':');
    const target = colon === -1 ? link.value : link.value.slice(0, colon);
    if (!services.has(target)) {
      ctx.sink.error('network.unknown-link', link.path, `link target ${target} is not a service`);
      continue;
    }
    if (colon === -1) continue;
    const alias = link.value.slice(colon + 1);
    if (alias !== target) addAlias({ value: alias, path: link.path }, draft, aliases, ctx);
  }
}

function readIgnoredServiceKeys(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const externalLinks = stringList(node.external_links, childPath(draft.path, 'external_links'), ctx);
  if (externalLinks !== null && externalLinks.length > 0) {
    ctx.sink.warn(
      'network.external-links-ignored',
      childPath(draft.path, 'external_links'),
      'external_links is ignored: use the name of the target service directly',
    );
  }
  const domainname = node.domainname;
  if (typeof domainname === 'string') {
    if (domainname !== '') ctx.sink.warn('network.domainname-ignored', childPath(draft.path, 'domainname'), 'domainname is ignored');
  } else if (!isAbsent(domainname)) {
    invalidType(ctx, childPath(draft.path, 'domainname'), 'string', domainname);
  }
  if (!isAbsent(node.mac_address)) {
    ctx.sink.warn('network.attachment-option-ignored', childPath(draft.path, 'mac_address'), 'mac_address is ignored on Kubernetes');
  }
}

function readHostname(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const hostname = node.hostname;
  if (isAbsent(hostname)) return;
  const path = childPath(draft.path, 'hostname');
  if (typeof hostname !== 'string') {
    invalidType(ctx, path, 'string', hostname);
    return;
  }
  if (hostname === '') {
    ctx.sink.error('values.empty', path, 'must not be empty');
    return;
  }
  if (hostname.includes('{{') || hostname.includes('}}')) {
    ctx.sink.error(
      'network.swarm-template',
      path,
      'hostname contains a Swarm template placeholder, which Kubernetes does not expand',
      'Remove the placeholder.',
    );
    return;
  }
  if (!isDnsLabel(hostname)) {
    ctx.sink.error(
      'network.invalid-hostname',
      path,
      `hostname ${hostname} must be a single DNS label on Kubernetes (lowercase letters, digits and '-', at most 63 characters)`,
      'Use a short host name without dots.',
    );
    return;
  }
  draft.process.hostname = hostname;
}

/**
 * Never truncated: sending name resolution to other servers than the file names is a silent
 * behaviour change (D3), and the translator throws on a list over the limit.
 */
function readDns(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const path = childPath(draft.path, 'dns');
  const servers = stringOrList(node.dns, path, ctx);
  if (servers === null) return;
  let ok = true;
  for (const server of servers) {
    if (isIp(server.value)) continue;
    ctx.sink.error('network.invalid-dns', server.path, `${server.value} is not an IP address`);
    ok = false;
  }
  const limit = Math.max(0, KUBELET_MAX_NAMESERVERS - ctx.traits.clusterDnsNameservers);
  if (servers.length > limit) {
    ctx.sink.error(
      'network.too-many-dns',
      path,
      `at most ${limit} nameservers can be added next to the cluster DNS (Kubernetes allows ${KUBELET_MAX_NAMESERVERS} in total)`,
      `Keep the ${limit} most important servers, or resolve the other names through the cluster DNS.`,
    );
    ok = false;
  }
  if (ok) draft.network.dns = servers.map((s) => s.value);
}

/** A trailing dot marks a fully qualified name and is allowed by the kubelet. */
function isDnsSearchDomain(domain: string): boolean {
  return isDnsSubdomain(domain.endsWith('.') ? domain.slice(0, -1) : domain);
}

function readDnsSearch(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const path = childPath(draft.path, 'dns_search');
  const domains = stringOrList(node.dns_search, path, ctx);
  if (domains === null) return;
  let ok = true;
  for (const domain of domains) {
    if (isDnsSearchDomain(domain.value)) continue;
    ctx.sink.error(
      'network.invalid-dns-search',
      domain.path,
      `${domain.value} is not a valid DNS search domain`,
      'Write a lowercase domain name, for example `example.internal`.',
    );
    ok = false;
  }
  // the kubelet counts the search line as written: domains joined by one space
  const chars = domains.map((d) => d.value).join(' ').length;
  if (domains.length > KUBELET_MAX_DNS_SEARCH || chars > KUBELET_MAX_DNS_SEARCH_CHARS) {
    ctx.sink.error(
      'network.too-many-dns-search',
      path,
      `${domains.length} search domains of ${chars} characters exceed the Kubernetes limits of ${KUBELET_MAX_DNS_SEARCH} domains and ${KUBELET_MAX_DNS_SEARCH_CHARS} characters`,
      'Keep fewer search domains.',
    );
    ok = false;
  }
  if (ok) draft.network.dnsSearch = domains.map((d) => d.value);
}

/** `name[:value]`, kept as written in declaration order */
function readDnsOptions(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const options = stringList(node.dns_opt, childPath(draft.path, 'dns_opt'), ctx);
  if (options === null) return;
  const kept: string[] = [];
  for (const option of options) {
    if (option.value === '' || option.value.startsWith(':')) {
      ctx.sink.error('values.empty', option.path, 'must not be empty');
      continue;
    }
    kept.push(option.value);
  }
  draft.network.dnsOptions = kept;
}

type ExtraHost = NetworkSpec['extraHosts'][number];

function readExtraHost(host: string, ip: string, written: string, path: string, hosts: ExtraHost[], ctx: NormalizeContext): void {
  const address = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (address === 'host-gateway') {
    ctx.sink.error(
      'network.host-gateway-unsupported',
      path,
      'host-gateway has no fixed address on Kubernetes',
      'Write the node address, for example `{{ servers.<name>.private_host }}`, when the service runs on that node.',
    );
    return;
  }
  const hostname = host.toLowerCase();
  if (!isDnsSubdomain(hostname) || !isIp(address)) {
    ctx.sink.error(
      'network.invalid-extra-host',
      path,
      `${written} is not a valid host entry`,
      'Write `host=ip`, for example `db.internal=10.0.0.5`.',
    );
    return;
  }
  hosts.push({ hostname, ip: address.toLowerCase() });
}

/** List `host=ip` / `host:ip` (first `=`, else first `:`), or map `{host: ip | [ip, ...]}`. */
function readExtraHosts(node: Record<string, unknown>, draft: ServiceDraft, ctx: NormalizeContext): void {
  const value = node.extra_hosts;
  if (isAbsent(value)) return;
  const path = childPath(draft.path, 'extra_hosts');
  const hosts: ExtraHost[] = [];
  if (Array.isArray(value)) {
    for (const entry of stringItems(value, path, ctx)) {
      const eq = entry.value.indexOf('=');
      const sep = eq === -1 ? entry.value.indexOf(':') : eq;
      if (sep === -1) {
        ctx.sink.error(
          'network.invalid-extra-host',
          entry.path,
          `${entry.value} is not a valid host entry`,
          'Write `host=ip`, for example `db.internal=10.0.0.5`.',
        );
        continue;
      }
      readExtraHost(entry.value.slice(0, sep), entry.value.slice(sep + 1), entry.value, entry.path, hosts, ctx);
    }
  } else if (isPlainMap(value)) {
    for (const host of sortedKeys(value)) {
      const hostPath = childPath(path, host);
      const ips = value[host];
      if (typeof ips === 'string') {
        readExtraHost(host, ips, `${host}=${ips}`, hostPath, hosts, ctx);
      } else if (Array.isArray(ips)) {
        for (const ip of stringItems(ips, hostPath, ctx)) readExtraHost(host, ip.value, `${host}=${ip.value}`, ip.path, hosts, ctx);
      } else {
        invalidType(ctx, hostPath, 'string or list', ips);
      }
    }
  } else {
    invalidType(ctx, path, 'list or mapping', value);
    return;
  }
  const unique = new Map(hosts.map((h) => [`${h.ip} ${h.hostname}`, h]));
  draft.network.extraHosts = [...unique.values()].sort(
    (a, b) => compareCodeUnits(a.ip, b.ip) || compareCodeUnits(a.hostname, b.hostname),
  );
}

/** The service networking keys (design-01 1.1 step 14): `network` and `process.hostname`. */
export function serviceNetwork(draft: ServiceDraft, node: Record<string, unknown>, networks: NetworkTable, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const aliases: string[] = [];
  readServiceNetworks(node, networks, draft, aliases, ctx);
  readNetworkMode(node, networks, draft, ctx);
  readLinks(node, draft, aliases, ctx);
  readIgnoredServiceKeys(node, draft, ctx);
  readHostname(node, draft, ctx);
  readDns(node, draft, ctx);
  readDnsSearch(node, draft, ctx);
  readDnsOptions(node, draft, ctx);
  readExtraHosts(node, draft, ctx);
  draft.network.aliases = sortedUnique(aliases);
}
