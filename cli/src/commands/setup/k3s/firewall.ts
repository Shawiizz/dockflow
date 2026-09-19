// Host firewall of k3s nodes (design-05 14, DV4, PD-9): the pure rule set (peer-sourced cluster
// ports, pod/service CIDRs bound to cni0 and the flannel interface, 80 on control-plane nodes, 443
// only with ACME), the choice between ufw and firewalld (only an active tool is managed), their
// reconcilers, the removal used by reset, and the flows printed when no firewall is managed.

import { err, ok, type Result } from '../../../types/result';
import {
  CNI_BRIDGE_IFACE,
  FLANNEL_IFACE,
  K3S_API_PORT,
  K3S_DOCKFLOW_DIR,
  K3S_DOCKFLOW_DIR_MODE,
  K3S_FIREWALL_STATE_FILE,
  K3S_SECRET_FILE_MODE,
  POD_CIDR,
  SERVICE_CIDR,
} from './constants';
import { fileMatches, firstLineOf, type HostRunner, type HostRunResult, SetupStepError, writeFileAtomic } from './host-runner';
import { type SetupProblem, setupMessages } from './messages';
import type { Datastore, FirewallTool, FlannelBackend, K3sNodeRole, K3sResolvedCluster } from './plan';

// ---------------------------------------------------------------------------
// Rule set (14.1, pure)
// ---------------------------------------------------------------------------

export type FirewallRuleId = 'apiserver' | 'kubelet' | 'vxlan' | 'wireguard' | 'etcd' | 'pods' | 'services' | 'http' | 'https';

export interface FirewallRule {
  id: FirewallRuleId;
  proto: 'tcp' | 'udp' | 'any';
  /** single port or 'from:to'; null = all ports */
  ports: string | null;
  /** CIDRs/addresses; ['any'] = every source */
  sources: string[];
  /** inbound interfaces the rule is restricted to; [] = any interface (K55b) */
  inInterfaces: string[];
}

export const FIREWALL_COMMENT_PREFIX = 'dockflow-k3s:';
export const KUBELET_PORT = 10250;
export const VXLAN_PORT = 8472;
export const WIREGUARD_PORT = 51820;
export const ETCD_PORTS = '2379:2380';
export const HTTP_PORT = 80;
export const HTTPS_PORT = 443;
export const ANY_SOURCE = 'any';

/** What the rule set of one node depends on: a subset of K3sNodePlan.cluster. */
export interface FirewallCluster {
  flannelBackend: FlannelBackend;
  datastore: Datastore;
  /** http = proxy.enabled, https = proxy.enabled && proxy.acme !== false */
  proxyPorts: { http: boolean; https: boolean };
  network: { peerSources: readonly string[]; serverPeerSources: readonly string[] };
}

function isServer(role: K3sNodeRole): boolean {
  return role !== 'agent';
}

/** `cni0` for pods of this node, the flannel interface for pods of the others after decapsulation (F33) */
export function cniInterfacesFor(backend: FlannelBackend): string[] {
  return [CNI_BRIDGE_IFACE, FLANNEL_IFACE[backend]];
}

/** The rules of one node, in the order of 14.1. SSH is never touched. */
export function buildFirewallRules(node: { role: K3sNodeRole }, cluster: FirewallCluster): FirewallRule[] {
  const server = isServer(node.role);
  const peers = [...cluster.network.peerSources];
  const serverPeers = [...cluster.network.serverPeerSources];
  const interfaces = cniInterfacesFor(cluster.flannelBackend);
  const rules: FirewallRule[] = [];
  if (peers.length > 0) {
    if (server) rules.push({ id: 'apiserver', proto: 'tcp', ports: String(K3S_API_PORT), sources: peers, inInterfaces: [] });
    rules.push({ id: 'kubelet', proto: 'tcp', ports: String(KUBELET_PORT), sources: [...peers], inInterfaces: [] });
    if (cluster.flannelBackend === 'vxlan') {
      rules.push({ id: 'vxlan', proto: 'udp', ports: String(VXLAN_PORT), sources: [...peers], inInterfaces: [] });
    } else {
      rules.push({ id: 'wireguard', proto: 'udp', ports: String(WIREGUARD_PORT), sources: [...peers], inInterfaces: [] });
    }
  }
  if (server && cluster.datastore === 'etcd' && serverPeers.length > 0) {
    rules.push({ id: 'etcd', proto: 'tcp', ports: ETCD_PORTS, sources: serverPeers, inInterfaces: [] });
  }
  rules.push({ id: 'pods', proto: 'any', ports: null, sources: [POD_CIDR], inInterfaces: [...interfaces] });
  rules.push({ id: 'services', proto: 'any', ports: null, sources: [SERVICE_CIDR], inInterfaces: [...interfaces] });
  // Traefik binds hostPorts on control-plane nodes only, and 443 only with ACME (K55c)
  if (server && cluster.proxyPorts.http) {
    rules.push({ id: 'http', proto: 'tcp', ports: String(HTTP_PORT), sources: [ANY_SOURCE], inInterfaces: [] });
  }
  if (server && cluster.proxyPorts.https) {
    rules.push({ id: 'https', proto: 'tcp', ports: String(HTTPS_PORT), sources: [ANY_SOURCE], inInterfaces: [] });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Choosing the tool (14.0, pure)
// ---------------------------------------------------------------------------

export interface FirewallStatus {
  ufw: 'active' | 'inactive' | 'absent';
  firewalld: 'running' | 'stopped' | 'absent';
}

/**
 * Only an active ufw or a running firewalld is managed: an installed but idle one filters nothing,
 * so writing rules into it would claim a firewall that does not exist. Both active is refused.
 */
export function chooseFirewallTool(
  status: FirewallStatus,
  options: { skipFirewall: boolean; key: string },
): Result<FirewallTool | null, SetupProblem> {
  if (options.skipFirewall) return ok(null);
  const ufw = status.ufw === 'active';
  const firewalld = status.firewalld === 'running';
  if (ufw && firewalld) return err(setupMessages.bothFirewalls(options.key));
  if (ufw) return ok('ufw');
  if (firewalld) return ok('firewalld');
  return ok(null);
}

/** The parenthesis of 14.4 naming why no firewall is managed on a node. */
export function firewallReason(status: FirewallStatus, skipFirewall: boolean): string {
  if (skipFirewall) return '--skip-firewall';
  const idle: string[] = [];
  if (status.ufw === 'inactive') idle.push('ufw is installed but inactive');
  if (status.firewalld === 'stopped') idle.push('firewalld is stopped');
  if (idle.length > 0) return idle.join(', ');
  return 'ufw and firewalld are absent';
}

/** The FIREWALL column of the summary (17.1). */
export function firewallColumn(status: FirewallStatus, tool: FirewallTool | null, skipFirewall: boolean): string {
  if (skipFirewall) return 'skipped';
  if (tool !== null) return tool;
  const idle: string[] = [];
  if (status.ufw === 'inactive') idle.push('ufw inactive');
  if (status.firewalld === 'stopped') idle.push('firewalld stopped');
  return idle.length > 0 ? `none (${idle.join(', ')})` : 'none';
}

const PROBE_TIMEOUT_MS = 30_000;

/**
 * `ufw status` (first line), and firewalld's unit state plus the presence of firewall-cmd (4.1).
 * A stopped firewalld is never asked anything: firewall-cmd only runs against a running daemon.
 */
export async function probeFirewall(runner: HostRunner): Promise<FirewallStatus> {
  const ufw = await runner.run(['ufw', 'status'], { timeoutMs: PROBE_TIMEOUT_MS });
  const ufwState: FirewallStatus['ufw'] =
    ufw.exitCode === 127 ? 'absent' : /^Status:\s*active\b/i.test(firstLineOf(ufw.stdout)) ? 'active' : 'inactive';
  const active = await runner.run(['systemctl', 'is-active', 'firewalld'], { timeoutMs: PROBE_TIMEOUT_MS });
  let firewalld: FirewallStatus['firewalld'];
  if (active.exitCode === 0 && active.stdout.trim() === 'active') {
    firewalld = 'running';
  } else {
    const present = await runner.run(['which', 'firewall-cmd'], { timeoutMs: PROBE_TIMEOUT_MS });
    firewalld = present.exitCode === 0 ? 'stopped' : 'absent';
  }
  return { ufw: ufwState, firewalld };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function protoLabel(rule: Pick<FirewallRule, 'proto'>): string {
  return rule.proto === 'any' ? 'any' : rule.proto.toUpperCase();
}

function portsLabel(ports: string | null): string {
  return ports === null ? '' : ports.replace(':', '-');
}

/** The allowed flows of one node, appended to executor failures so they can be applied by hand. */
export function formatRuleFlows(rules: readonly FirewallRule[]): string {
  return rules
    .map((rule) => {
      const label = `${protoLabel(rule)} ${portsLabel(rule.ports)}`.trim().padEnd(17);
      const from = rule.sources.includes(ANY_SOURCE) ? 'from anywhere' : `from ${rule.sources.join(', ')}`;
      const on = rule.inInterfaces.length > 0 ? ` on ${rule.inInterfaces.join(', ')}` : '';
      return `  ${label}${from}${on}`;
    })
    .join('\n');
}

export const firewallMessages = {
  rejected: (tool: FirewallTool, key: string, detail: string, rules: readonly FirewallRule[]): SetupProblem => ({
    message: `${tool} rejected a rule on ${key}: ${detail}`,
    suggestion: `Fix ${tool} on ${key}, or re-run with --skip-firewall and apply the flows listed below manually.\n${formatRuleFlows(rules)}`,
  }),
  unrecognisedUfwRule: (key: string, line: string): string => `Unrecognised Dockflow ufw rule on ${key}: ${line}`,
  interfaceBound: (iface: string, zone: string, key: string): SetupProblem => ({
    message: `${iface} is bound to firewalld zone ${zone} on ${key}`,
    suggestion: `Move it to the trusted zone (\`firewall-cmd --permanent --zone=trusted --change-interface=${iface}\`) or allow pod traffic in ${zone}, then run setup again.`,
  }),
  noZone: (key: string, detail: string): SetupProblem => ({
    message: `Could not determine the firewalld zone of ${key} (${detail})`,
    suggestion: `Check \`firewall-cmd --get-default-zone\` on ${key}, or re-run with --skip-firewall and open the flows yourself.`,
  }),
} as const;

function rejected(tool: FirewallTool, key: string, result: HostRunResult, rules: readonly FirewallRule[]): SetupStepError {
  const detail = result.timedOut ? 'timed out' : firstLineOf(result.stderr) || firstLineOf(result.stdout) || `exit ${result.exitCode}`;
  const problem = firewallMessages.rejected(tool, key, detail, rules);
  return new SetupStepError(problem.message, problem.suggestion);
}

// ---------------------------------------------------------------------------
// ufw (14.2)
// ---------------------------------------------------------------------------

/** One ufw rule: a rule of 14.1 expanded per source and per interface. */
export interface UfwRuleKey {
  id: FirewallRuleId;
  proto: 'tcp' | 'udp' | 'any';
  ports: string | null;
  source: string;
  iface: string | null;
}

/** canonical key `<id>|<proto>|<ports>|<source>|<iface or ->` */
export function ufwKeyString(rule: UfwRuleKey): string {
  return `${rule.id}|${rule.proto}|${rule.ports ?? '-'}|${rule.source}|${rule.iface ?? '-'}`;
}

export function desiredUfwRules(rules: readonly FirewallRule[]): UfwRuleKey[] {
  const keys: UfwRuleKey[] = [];
  for (const rule of rules) {
    for (const source of rule.sources) {
      const interfaces: (string | null)[] = rule.inInterfaces.length > 0 ? rule.inInterfaces : [null];
      for (const iface of interfaces) keys.push({ id: rule.id, proto: rule.proto, ports: rule.ports, source, iface });
    }
  }
  return keys;
}

/** the arguments after `ufw allow` (and after `ufw delete allow`, without the comment, F23) */
export function ufwRuleArgs(rule: UfwRuleKey, withComment: boolean): string[] {
  let args: string[];
  if (rule.iface !== null) {
    args = ['in', 'on', rule.iface, 'from', rule.source];
  } else if (rule.ports === null) {
    // the un-scoped CIDR form of earlier Dockflow versions: parsed and deleted, never desired
    args = ['from', rule.source];
  } else if (rule.source === ANY_SOURCE) {
    args = ['proto', rule.proto, 'to', 'any', 'port', rule.ports];
  } else {
    args = ['proto', rule.proto, 'from', rule.source, 'to', 'any', 'port', rule.ports];
  }
  // one argv element, no shell quotes
  return withComment ? [...args, 'comment', `${FIREWALL_COMMENT_PREFIX}${rule.id}`] : args;
}

/** `ufw allow ...` argv of every desired rule */
export function renderUfwCommands(rules: readonly FirewallRule[]): string[][] {
  return desiredUfwRules(rules).map((rule) => ['ufw', 'allow', ...ufwRuleArgs(rule, true)]);
}

const PORT_RULE_IDS: readonly FirewallRuleId[] = ['apiserver', 'kubelet', 'vxlan', 'wireguard', 'etcd'];
const UFW_PORT_RULE = /^allow from (\S+) to any port (\S+) proto (tcp|udp) comment 'dockflow-k3s:([a-z]+)'$/;
const UFW_SCOPED_CIDR_RULE = /^allow in on (\S+) from (\S+) comment 'dockflow-k3s:(pods|services)'$/;
const UFW_LEGACY_CIDR_RULE = /^allow from (\S+) comment 'dockflow-k3s:(pods|services)'$/;
const UFW_OPEN_PORT_RULE = /^allow (\d+)\/tcp comment 'dockflow-k3s:(http|https)'$/;

/**
 * Dockflow's rules in `ufw show added` (F23, F34). Rules without the tag are the operator's and are
 * ignored; tagged lines no pattern recognises are returned for a warning and left in place.
 */
export function parseUfwShowAdded(output: string): { rules: UfwRuleKey[]; unrecognised: string[] } {
  const rules: UfwRuleKey[] = [];
  const unrecognised: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes(FIREWALL_COMMENT_PREFIX)) continue;
    const body = line.startsWith('ufw ') ? line.slice(4) : line;
    let match = UFW_PORT_RULE.exec(body);
    if (match && PORT_RULE_IDS.includes(match[4] as FirewallRuleId)) {
      rules.push({ id: match[4] as FirewallRuleId, proto: match[3] as 'tcp' | 'udp', ports: match[2], source: match[1], iface: null });
      continue;
    }
    match = UFW_SCOPED_CIDR_RULE.exec(body);
    if (match) {
      rules.push({ id: match[3] as FirewallRuleId, proto: 'any', ports: null, source: match[2], iface: match[1] });
      continue;
    }
    match = UFW_LEGACY_CIDR_RULE.exec(body);
    if (match) {
      rules.push({ id: match[2] as FirewallRuleId, proto: 'any', ports: null, source: match[1], iface: null });
      continue;
    }
    match = UFW_OPEN_PORT_RULE.exec(body);
    if (match) {
      rules.push({ id: match[2] as FirewallRuleId, proto: 'tcp', ports: match[1], source: ANY_SOURCE, iface: null });
      continue;
    }
    unrecognised.push(line);
  }
  return { rules, unrecognised };
}

/** existing - desired to delete, desired - existing to add, by canonical key */
export function diffFirewall<T>(existing: readonly T[], desired: readonly T[], keyOf: (item: T) => string): { add: T[]; remove: T[] } {
  const have = new Set(existing.map(keyOf));
  const want = new Set(desired.map(keyOf));
  const add: T[] = [];
  const remove: T[] = [];
  const seen = new Set<string>();
  for (const item of desired) {
    const key = keyOf(item);
    if (!have.has(key) && !seen.has(key)) add.push(item);
    seen.add(key);
  }
  seen.clear();
  for (const item of existing) {
    const key = keyOf(item);
    if (!want.has(key) && !seen.has(key)) remove.push(item);
    seen.add(key);
  }
  return { add, remove };
}

export interface UfwState {
  schema: 1;
  tool: 'ufw';
  /** a firewalld record kept while firewalld is stopped (14.0): reconciled when it runs again */
  retired?: FirewalldState;
}

export interface FirewalldState {
  schema: 1;
  tool: 'firewalld';
  zone: string;
  /** only items Dockflow added itself (14.3) */
  ipsets: string[];
  richRules: string[];
  trustedInterfaces: string[];
  trustedSources: string[];
  ports: string[];
}

export type FirewallState = UfwState | FirewalldState;

export interface FirewallApplyResult<S extends FirewallState = FirewallState> {
  added: number;
  removed: number;
  warnings: string[];
  state: S;
}

const FIREWALL_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Reconciles ufw with the rule set (14.2). Missing rules are added before stale ones are deleted, so
 * allowed traffic has no gap; the un-scoped CIDR rules of earlier versions are always stale. Dockflow
 * never enables, disables or reloads ufw.
 */
export async function applyUfw(runner: HostRunner, rules: readonly FirewallRule[], options: { key: string }): Promise<FirewallApplyResult> {
  const shown = await runner.run(['ufw', 'show', 'added'], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
  if (shown.exitCode !== 0 || shown.timedOut) throw rejected('ufw', options.key, shown, rules);
  const existing = parseUfwShowAdded(shown.stdout);
  const { add, remove } = diffFirewall(existing.rules, desiredUfwRules(rules), ufwKeyString);
  for (const rule of add) {
    const result = await runner.run(['ufw', 'allow', ...ufwRuleArgs(rule, true)], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.timedOut) throw rejected('ufw', options.key, result, rules);
  }
  for (const rule of remove) {
    const result = await runner.run(['ufw', 'delete', 'allow', ...ufwRuleArgs(rule, false)], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
    if (result.exitCode !== 0 || result.timedOut) throw rejected('ufw', options.key, result, rules);
  }
  return {
    added: add.length,
    removed: remove.length,
    warnings: existing.unrecognised.map((line) => firewallMessages.unrecognisedUfwRule(options.key, line)),
    state: { schema: 1, tool: 'ufw' },
  };
}

// ---------------------------------------------------------------------------
// firewalld (14.3)
// ---------------------------------------------------------------------------

export const FIREWALLD_PEERS_IPSET = 'dockflow-k3s-peers';
export const FIREWALLD_SERVERS_IPSET = 'dockflow-k3s-servers';
export const FIREWALLD_TRUSTED_ZONE = 'trusted';

export function firewalldRichRule(ipset: string, ports: string, proto: 'tcp' | 'udp'): string {
  return `rule family="ipv4" source ipset="${ipset}" port port="${ports.replace(':', '-')}" protocol="${proto}" accept`;
}

/** What firewalld must hold for a rule set: ipsets with their entries, rich rules, CNI interfaces, open ports. */
export interface FirewalldPlan {
  ipsets: { name: string; entries: string[] }[];
  richRules: string[];
  trustedInterfaces: string[];
  ports: string[];
}

export function planFirewalld(rules: readonly FirewallRule[]): FirewalldPlan {
  const ipsets = new Map<string, Set<string>>();
  const richRules: string[] = [];
  const interfaces = new Set<string>();
  const ports: string[] = [];
  for (const rule of rules) {
    if (rule.id === 'pods' || rule.id === 'services') {
      for (const iface of rule.inInterfaces) interfaces.add(iface);
    } else if (rule.id === 'http' || rule.id === 'https') {
      ports.push(`${rule.ports}/tcp`);
    } else if (rule.ports !== null && rule.proto !== 'any') {
      const ipset = rule.id === 'etcd' ? FIREWALLD_SERVERS_IPSET : FIREWALLD_PEERS_IPSET;
      const entries = ipsets.get(ipset) ?? new Set<string>();
      for (const source of rule.sources) entries.add(source);
      ipsets.set(ipset, entries);
      richRules.push(firewalldRichRule(ipset, rule.ports, rule.proto));
    }
  }
  return {
    ipsets: [...ipsets].map(([name, entries]) => ({ name, entries: [...entries].sort() })),
    richRules,
    trustedInterfaces: [...interfaces],
    ports,
  };
}

/** `firewall-cmd --permanent` argv adding everything of a plan (the commands of 14.3, before reconciliation) */
export function renderFirewalldCommands(plan: FirewalldPlan, zone: string): string[][] {
  const commands: string[][] = [];
  for (const ipset of plan.ipsets) {
    commands.push(['firewall-cmd', '--permanent', `--new-ipset=${ipset.name}`, '--type=hash:ip', '--option=family=inet']);
    for (const entry of ipset.entries) commands.push(['firewall-cmd', '--permanent', `--ipset=${ipset.name}`, `--add-entry=${entry}`]);
  }
  for (const rule of plan.richRules) commands.push(['firewall-cmd', '--permanent', `--zone=${zone}`, `--add-rich-rule=${rule}`]);
  for (const iface of plan.trustedInterfaces) {
    commands.push(['firewall-cmd', '--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--add-interface=${iface}`]);
  }
  for (const port of plan.ports) commands.push(['firewall-cmd', '--permanent', `--zone=${zone}`, `--add-port=${port}`]);
  commands.push(['firewall-cmd', '--reload']);
  return commands;
}

function emptyFirewalldState(zone: string): FirewalldState {
  return { schema: 1, tool: 'firewalld', zone, ipsets: [], richRules: [], trustedInterfaces: [], trustedSources: [], ports: [] };
}

/** The interface holding `nodeIp`, else the one of the default route. */
async function nodeInterface(runner: HostRunner, nodeIp: string | null): Promise<string | null> {
  if (nodeIp !== null) {
    const addresses = await runner.run(['ip', '-o', '-4', 'addr', 'show'], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
    for (const line of addresses.stdout.split(/\r?\n/)) {
      const match = /^\d+:\s+(\S+)\s+inet\s+([\d.]+)\//.exec(line.trim());
      if (match && match[2] === nodeIp) return match[1];
    }
  }
  const route = await runner.run(['ip', '-4', 'route', 'get', '1.1.1.1'], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
  return /\bdev\s+(\S+)/.exec(route.stdout)?.[1] ?? null;
}

/** `--get-zone-of-interface=<iface holding nodeIp or default route>`, else `--get-default-zone` */
export async function firewalldZone(runner: HostRunner, nodeIp: string | null, key: string): Promise<string> {
  const iface = await nodeInterface(runner, nodeIp);
  if (iface !== null) {
    const zone = await runner.run(['firewall-cmd', `--get-zone-of-interface=${iface}`], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
    if (zone.exitCode === 0 && zone.stdout.trim() !== '') return zone.stdout.trim();
  }
  const fallback = await runner.run(['firewall-cmd', '--get-default-zone'], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
  if (fallback.exitCode !== 0 || fallback.stdout.trim() === '') {
    const problem = firewallMessages.noZone(key, firstLineOf(fallback.stderr) || `exit ${fallback.exitCode}`);
    throw new SetupStepError(problem.message, problem.suggestion);
  }
  return fallback.stdout.trim();
}

/** firewall-cmd through one place: queries answer yes (0) or no (1), anything else is a failure */
class FirewallCmd {
  changed = false;

  constructor(
    private readonly runner: HostRunner,
    private readonly key: string,
    private readonly rules: readonly FirewallRule[],
  ) {}

  async read(args: string[]): Promise<HostRunResult> {
    return this.runner.run(['firewall-cmd', ...args], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
  }

  async query(args: string[]): Promise<boolean> {
    const result = await this.read(args);
    if (result.exitCode === 0 && !result.timedOut) return true;
    if (result.exitCode === 1 && !result.timedOut) return false;
    throw rejected('firewalld', this.key, result, this.rules);
  }

  async change(args: string[]): Promise<void> {
    const result = await this.read(args);
    if (result.exitCode !== 0 || result.timedOut) throw rejected('firewalld', this.key, result, this.rules);
    this.changed = true;
  }

  async lines(args: string[]): Promise<string[]> {
    const result = await this.read(args);
    if (result.exitCode !== 0 || result.timedOut) throw rejected('firewalld', this.key, result, this.rules);
    return result.stdout.split(/\s+/).filter((word) => word.length > 0);
  }
}

/**
 * Reconciles firewalld (14.3): every add is preceded by its query and recorded only when Dockflow
 * added it; recorded items no longer desired are removed; the pod and service CIDRs reach the node
 * through the trusted zone bound to the CNI interfaces, never as zone sources (a CIDR source from an
 * earlier version is removed). Permanent configuration only, then one reload when something changed.
 */
export async function applyFirewalld(
  runner: HostRunner,
  rules: readonly FirewallRule[],
  previous: FirewalldState | null,
  options: { key: string; nodeIp: string | null },
): Promise<FirewallApplyResult<FirewalldState>> {
  const cmd = new FirewallCmd(runner, options.key, rules);
  const zone = await firewalldZone(runner, options.nodeIp, options.key);
  const plan = planFirewalld(rules);
  const recorded = previous ?? emptyFirewalldState(zone);
  const next = emptyFirewalldState(zone);
  let added = 0;
  let removed = 0;

  // an interface bound to another zone is refused before anything changes
  for (const iface of plan.trustedInterfaces) {
    const bound = await cmd.read(['--permanent', `--get-zone-of-interface=${iface}`]);
    const boundZone = bound.exitCode === 0 ? bound.stdout.trim() : '';
    if (boundZone !== '' && boundZone !== FIREWALLD_TRUSTED_ZONE) {
      const problem = firewallMessages.interfaceBound(iface, boundZone, options.key);
      throw new SetupStepError(problem.message, problem.suggestion);
    }
  }

  const existingSets = new Set(await cmd.lines(['--permanent', '--get-ipsets']));
  for (const ipset of plan.ipsets) {
    if (!existingSets.has(ipset.name)) {
      await cmd.change(['--permanent', `--new-ipset=${ipset.name}`, '--type=hash:ip', '--option=family=inet']);
      next.ipsets.push(ipset.name);
      added += 1;
    } else if (recorded.ipsets.includes(ipset.name)) {
      next.ipsets.push(ipset.name);
    }
    // the set is Dockflow's by name: its entries are exactly the peers
    const entries = new Set(await cmd.lines(['--permanent', `--ipset=${ipset.name}`, '--get-entries']));
    for (const entry of ipset.entries) {
      if (entries.has(entry)) continue;
      await cmd.change(['--permanent', `--ipset=${ipset.name}`, `--add-entry=${entry}`]);
      added += 1;
    }
    for (const entry of [...entries].sort()) {
      if (ipset.entries.includes(entry)) continue;
      await cmd.change(['--permanent', `--ipset=${ipset.name}`, `--remove-entry=${entry}`]);
      removed += 1;
    }
  }

  const sameZone = recorded.zone === zone;
  for (const rule of plan.richRules) {
    if (!(await cmd.query(['--permanent', `--zone=${zone}`, `--query-rich-rule=${rule}`]))) {
      await cmd.change(['--permanent', `--zone=${zone}`, `--add-rich-rule=${rule}`]);
      next.richRules.push(rule);
      added += 1;
    } else if (sameZone && recorded.richRules.includes(rule)) {
      next.richRules.push(rule);
    }
  }
  for (const iface of plan.trustedInterfaces) {
    if (!(await cmd.query(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--query-interface=${iface}`]))) {
      await cmd.change(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--add-interface=${iface}`]);
      next.trustedInterfaces.push(iface);
      added += 1;
    } else if (recorded.trustedInterfaces.includes(iface)) {
      next.trustedInterfaces.push(iface);
    }
  }
  for (const port of plan.ports) {
    if (!(await cmd.query(['--permanent', `--zone=${zone}`, `--query-port=${port}`]))) {
      await cmd.change(['--permanent', `--zone=${zone}`, `--add-port=${port}`]);
      next.ports.push(port);
      added += 1;
    } else if (sameZone && recorded.ports.includes(port)) {
      next.ports.push(port);
    }
  }

  // recorded items no longer desired (a CIDR source is never desired any more)
  for (const source of recorded.trustedSources) {
    if (await cmd.query(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--query-source=${source}`])) {
      await cmd.change(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--remove-source=${source}`]);
      removed += 1;
    }
  }
  for (const rule of recorded.richRules) {
    if (sameZone && plan.richRules.includes(rule)) continue;
    if (await cmd.query(['--permanent', `--zone=${recorded.zone}`, `--query-rich-rule=${rule}`])) {
      await cmd.change(['--permanent', `--zone=${recorded.zone}`, `--remove-rich-rule=${rule}`]);
      removed += 1;
    }
  }
  for (const port of recorded.ports) {
    if (sameZone && plan.ports.includes(port)) continue;
    if (await cmd.query(['--permanent', `--zone=${recorded.zone}`, `--query-port=${port}`])) {
      await cmd.change(['--permanent', `--zone=${recorded.zone}`, `--remove-port=${port}`]);
      removed += 1;
    }
  }
  for (const iface of recorded.trustedInterfaces) {
    if (plan.trustedInterfaces.includes(iface)) continue;
    if (await cmd.query(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--query-interface=${iface}`])) {
      await cmd.change(['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--remove-interface=${iface}`]);
      removed += 1;
    }
  }
  for (const name of recorded.ipsets) {
    if (plan.ipsets.some((ipset) => ipset.name === name) || !existingSets.has(name)) continue;
    await cmd.change(['--permanent', `--delete-ipset=${name}`]);
    removed += 1;
  }

  if (cmd.changed) await cmd.change(['--reload']);
  return { added, removed, warnings: [], state: next };
}

// ---------------------------------------------------------------------------
// State file, removal, reconcile
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toFirewalldState(value: Record<string, unknown>): FirewalldState | null {
  const { zone, ipsets, richRules, trustedInterfaces, trustedSources, ports } = value;
  if (typeof zone !== 'string' || !isStringArray(ipsets) || !isStringArray(richRules)) return null;
  if (!isStringArray(trustedInterfaces) || !isStringArray(trustedSources) || !isStringArray(ports)) return null;
  return { schema: 1, tool: 'firewalld', zone, ipsets, richRules, trustedInterfaces, trustedSources, ports };
}

/** Parses firewall.json; anything unreadable counts as no record. */
export function parseFirewallState(text: string): FirewallState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) return null;
  if (record.tool === 'firewalld') return toFirewalldState(record);
  if (record.tool !== 'ufw') return null;
  const retired =
    typeof record.retired === 'object' && record.retired !== null && !Array.isArray(record.retired)
      ? toFirewalldState(record.retired as Record<string, unknown>)
      : null;
  return retired === null ? { schema: 1, tool: 'ufw' } : { schema: 1, tool: 'ufw', retired };
}

export async function readFirewallState(runner: HostRunner): Promise<FirewallState | null> {
  const bytes = await runner.readFile(K3S_FIREWALL_STATE_FILE);
  return bytes === null ? null : parseFirewallState(bytes.toString('utf8'));
}

export function renderFirewallState(state: FirewallState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** firewall.json, root 0600 in the root 0700 Dockflow directory; not rewritten when unchanged */
export async function writeFirewallState(runner: HostRunner, state: FirewallState): Promise<'written' | 'unchanged'> {
  const content = renderFirewallState(state);
  const options = { mode: K3S_SECRET_FILE_MODE, uid: 0, gid: 0 };
  if (await fileMatches(runner, K3S_FIREWALL_STATE_FILE, content, options)) return 'unchanged';
  if ((await runner.stat(K3S_DOCKFLOW_DIR)) === null) {
    await runner.mkdir(K3S_DOCKFLOW_DIR, { mode: K3S_DOCKFLOW_DIR_MODE, uid: 0, gid: 0 });
  }
  await writeFileAtomic(runner, K3S_FIREWALL_STATE_FILE, content, options);
  return 'written';
}

/**
 * Removes every rule Dockflow wrote (reset, 18.3, and a tool switch, 14.0): ufw rules carrying the
 * tag, firewalld items listed in the record. Returns the number removed.
 */
export async function removeDockflowRules(runner: HostRunner, state: FirewallState, options: { key: string }): Promise<number> {
  if (state.tool === 'ufw') {
    const shown = await runner.run(['ufw', 'show', 'added'], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
    if (shown.exitCode !== 0 || shown.timedOut) throw rejected('ufw', options.key, shown, []);
    const { rules } = parseUfwShowAdded(shown.stdout);
    for (const rule of rules) {
      const result = await runner.run(['ufw', 'delete', 'allow', ...ufwRuleArgs(rule, false)], { timeoutMs: FIREWALL_COMMAND_TIMEOUT_MS });
      if (result.exitCode !== 0 || result.timedOut) throw rejected('ufw', options.key, result, []);
    }
    return rules.length;
  }
  const cmd = new FirewallCmd(runner, options.key, []);
  let removed = 0;
  const removeIf = async (query: string[], change: string[]): Promise<void> => {
    if (!(await cmd.query(query))) return;
    await cmd.change(change);
    removed += 1;
  };
  for (const rule of state.richRules) {
    await removeIf(['--permanent', `--zone=${state.zone}`, `--query-rich-rule=${rule}`], ['--permanent', `--zone=${state.zone}`, `--remove-rich-rule=${rule}`]);
  }
  for (const port of state.ports) {
    await removeIf(['--permanent', `--zone=${state.zone}`, `--query-port=${port}`], ['--permanent', `--zone=${state.zone}`, `--remove-port=${port}`]);
  }
  for (const iface of state.trustedInterfaces) {
    await removeIf(
      ['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--query-interface=${iface}`],
      ['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--remove-interface=${iface}`],
    );
  }
  for (const source of state.trustedSources) {
    await removeIf(
      ['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--query-source=${source}`],
      ['--permanent', `--zone=${FIREWALLD_TRUSTED_ZONE}`, `--remove-source=${source}`],
    );
  }
  if (state.ipsets.length > 0) {
    const existing = new Set(await cmd.lines(['--permanent', '--get-ipsets']));
    for (const name of state.ipsets) {
      if (!existing.has(name)) continue;
      await cmd.change(['--permanent', `--delete-ipset=${name}`]);
      removed += 1;
    }
  }
  if (cmd.changed) await cmd.change(['--reload']);
  return removed;
}

function toolActive(tool: FirewallTool, status: FirewallStatus): boolean {
  return tool === 'ufw' ? status.ufw === 'active' : status.firewalld === 'running';
}

export interface ReconcileFirewallOptions {
  key: string;
  /** chosen by the coordinator (cluster.firewallTool); null: nothing is managed */
  tool: FirewallTool | null;
  rules: readonly FirewallRule[];
  /** the node's current tool states, to leave a stopped tool alone */
  status: FirewallStatus;
  nodeIp: string | null;
  skipFirewall: boolean;
}

export interface FirewallReport {
  tool: FirewallTool | null;
  added: number;
  removed: number;
  warnings: string[];
  state: FirewallState | null;
}

/**
 * The `firewall` step (4.3, 14.0): nothing at all without a chosen tool; otherwise the rules of a
 * previously recorded tool that is still active are removed first, a stopped one is left alone (its
 * firewalld record is kept), and the chosen tool is reconciled.
 */
export async function reconcileFirewall(runner: HostRunner, options: ReconcileFirewallOptions): Promise<FirewallReport> {
  if (options.skipFirewall || options.tool === null) {
    return { tool: null, added: 0, removed: 0, warnings: [], state: null };
  }
  const tool = options.tool;
  const recorded = await readFirewallState(runner);
  let removed = 0;
  let retired: FirewalldState | null = recorded?.tool === 'ufw' ? (recorded.retired ?? null) : null;
  if (recorded !== null && recorded.tool !== tool) {
    if (toolActive(recorded.tool, options.status)) {
      removed += await removeDockflowRules(runner, recorded, { key: options.key });
    } else if (recorded.tool === 'firewalld') {
      retired = recorded;
    }
  }
  let result: FirewallApplyResult;
  if (tool === 'ufw') {
    result = await applyUfw(runner, options.rules, { key: options.key });
    if (retired !== null) result.state = { schema: 1, tool: 'ufw', retired };
  } else {
    const previous = recorded?.tool === 'firewalld' ? recorded : retired;
    result = await applyFirewalld(runner, options.rules, previous, { key: options.key, nodeIp: options.nodeIp });
  }
  await writeFirewallState(runner, result.state);
  return { tool, added: result.added, removed: removed + result.removed, warnings: result.warnings, state: result.state };
}

// ---------------------------------------------------------------------------
// No manageable firewall (14.4)
// ---------------------------------------------------------------------------

export interface ManualFlowNode {
  key: string;
  role: K3sNodeRole;
  /** the addresses the other nodes reach it on (private and/or public) */
  addresses: string[];
}

export interface ManualFlowCluster {
  nodes: ManualFlowNode[];
  flannelBackend: FlannelBackend;
  datastore: Datastore;
  proxyPorts: { http: boolean; https: boolean };
}

/** The flows view of a resolved cluster. */
export function manualFlowClusterOf(cluster: K3sResolvedCluster): ManualFlowCluster {
  return {
    nodes: cluster.plan.nodes.map((node) => {
      const network = cluster.network[node.key];
      const addresses = [network?.privateIp ?? null, network?.publicIp ?? null].filter((a): a is string => a !== null);
      return { key: node.key, role: node.role, addresses: [...new Set(addresses)] };
    }),
    flannelBackend: cluster.flannelBackend,
    datastore: cluster.datastore,
    proxyPorts: { ...cluster.plan.proxyPorts },
  };
}

const FLOW_LABEL_WIDTH = 17;
const FLOW_FROM_WIDTH = 49;
const FLOW_RULE_ORDER: readonly FirewallRuleId[] = ['apiserver', 'kubelet', 'vxlan', 'wireguard', 'etcd', 'http', 'https'];

/** The deny statement: always the four canonical ports, plus 51820 with WireGuard (14.4). */
export function denyStatement(backend: FlannelBackend): string {
  const ports = backend === 'wireguard-native' ? '6443, 10250, 2379-2380, 8472 and 51820' : '6443, 10250, 2379-2380 and 8472';
  return [
    `Deny ${ports} from every address outside this list. They are authenticated,`,
    'but they must not be exposed: 6443 and 10250 are administrative APIs and UDP 8472 carries',
    'unencrypted pod traffic. Dockflow cannot verify this for you when no host firewall is managed.',
  ].join('\n');
}

/**
 * The block printed once per environment when nodes have no managed firewall (14.4): the flows to
 * allow, rendered from the same buildFirewallRules the executors apply, and the deny statement.
 */
export function formatManualFlows(cluster: ManualFlowCluster, unmanaged: readonly { key: string; reason: string }[]): string {
  const byAddress = new Map<string, string>();
  for (const node of cluster.nodes) for (const address of node.addresses) byAddress.set(address, node.key);
  const label = (key: string): string => {
    const node = cluster.nodes.find((candidate) => candidate.key === key);
    return node && node.addresses.length > 0 ? `${key} ${node.addresses.join('/')}` : key;
  };
  const addressesOf = (nodes: readonly ManualFlowNode[]): string[] => nodes.flatMap((node) => node.addresses);
  const rulesOf = new Map<string, FirewallRule[]>();
  for (const node of cluster.nodes) {
    const others = cluster.nodes.filter((other) => other.key !== node.key);
    rulesOf.set(
      node.key,
      buildFirewallRules(node, {
        flannelBackend: cluster.flannelBackend,
        datastore: cluster.datastore,
        proxyPorts: cluster.proxyPorts,
        network: {
          peerSources: addressesOf(others),
          serverPeerSources: addressesOf(others.filter((other) => isServer(other.role))),
        },
      }),
    );
  }

  const lines: string[] = [];
  for (const id of FLOW_RULE_ORDER) {
    const destinations = cluster.nodes.filter((node) => rulesOf.get(node.key)?.some((rule) => rule.id === id));
    if (destinations.length === 0) continue;
    const sample = rulesOf.get(destinations[0].key)?.find((rule) => rule.id === id) as FirewallRule;
    const head = `${protoLabel(sample)} ${portsLabel(sample.ports)}`.padEnd(FLOW_LABEL_WIDTH);
    if (id === 'http' || id === 'https') {
      const note = id === 'http' ? '(control-plane, proxy.enabled)' : '(proxy.enabled, ACME on)';
      lines.push(`  ${head}${'from anywhere'.padEnd(FLOW_FROM_WIDTH)}to ${destinations.map((node) => node.key).join(', ')} ${note}`);
      continue;
    }
    const sourceKeys = new Set<string>();
    for (const node of destinations) {
      for (const source of rulesOf.get(node.key)?.find((rule) => rule.id === id)?.sources ?? []) {
        const key = byAddress.get(source);
        if (key !== undefined) sourceKeys.add(key);
      }
    }
    const sources = cluster.nodes.filter((node) => sourceKeys.has(node.key)).map((node) => node.key);
    const targets = destinations.map((node) => node.key);
    if (sources.length === targets.length && sources.every((key) => targets.includes(key))) {
      lines.push(`  ${head}between ${targets.map(label).join(', ')}`);
    } else {
      const from = `from ${sources.map(label).join(', ')}`;
      lines.push(`  ${head}${from.length < FLOW_FROM_WIDTH ? from.padEnd(FLOW_FROM_WIDTH) : `${from} `}to ${targets.map(label).join(', ')}`);
    }
  }

  const reasons = [...new Set(unmanaged.map((entry) => entry.reason))];
  const reason = reasons.length === 1 ? reasons[0] : unmanaged.map((entry) => `${entry.key}: ${entry.reason}`).join('; ');
  return [
    `No host firewall is managed on ${unmanaged.map((entry) => entry.key).join(', ')} (${reason}).`,
    'Allow exactly these flows in your provider firewall:',
    ...lines,
    denyStatement(cluster.flannelBackend),
  ].join('\n');
}
