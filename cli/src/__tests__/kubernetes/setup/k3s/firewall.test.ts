import { afterEach, describe, expect, it } from 'bun:test';
import { K3S_DOCKFLOW_DIR, K3S_FIREWALL_STATE_FILE } from '../../../../commands/setup/k3s/constants';
import {
  applyFirewalld,
  applyUfw,
  buildFirewallRules,
  chooseFirewallTool,
  denyStatement,
  type FirewallCluster,
  type FirewalldState,
  type FirewallRule,
  type FirewallStatus,
  firewallColumn,
  firewalldRichRule,
  firewallReason,
  formatManualFlows,
  type ManualFlowCluster,
  manualFlowClusterOf,
  parseFirewallState,
  parseUfwShowAdded,
  planFirewalld,
  probeFirewall,
  readFirewallState,
  reconcileFirewall,
  removeDockflowRules,
  renderFirewalldCommands,
  renderUfwCommands,
  writeFirewallState,
} from '../../../../commands/setup/k3s/firewall';
import { SetupStepError } from '../../../../commands/setup/k3s/host-runner';
import { setupMessages } from '../../../../commands/setup/k3s/messages';
import type { K3sResolvedCluster } from '../../../../commands/setup/k3s/plan';
import { Redactor } from '../../../../utils/redact';
import { FakeHostRunner } from '../../fakes/fake-host-runner';
import { assertExecutorInvariants } from '../../support/invariants';

const KEY = 'server_1';
const PEERS = ['10.0.0.11', '10.0.0.21'];
const SERVER_PEERS = ['10.0.0.11'];

function cluster(overrides: Partial<FirewallCluster> = {}): FirewallCluster {
  return {
    flannelBackend: 'vxlan',
    datastore: 'etcd',
    proxyPorts: { http: true, https: true },
    network: { peerSources: PEERS, serverPeerSources: SERVER_PEERS },
    ...overrides,
  };
}

const ids = (rules: readonly FirewallRule[]): string[] => rules.map((rule) => rule.id);

let runners: FakeHostRunner[] = [];

function host(): FakeHostRunner {
  const runner = new FakeHostRunner();
  runners.push(runner);
  return runner;
}

function ufwHost(active = true): FakeHostRunner {
  const runner = host();
  runner.ufw.installed = true;
  runner.ufw.active = active;
  return runner;
}

function firewalldHost(running = true): FakeHostRunner {
  const runner = host();
  runner.firewalld.installed = true;
  runner.firewalld.running = running;
  runner.firewalld.zones.get('public')?.interfaces.add('eth0');
  return runner;
}

function mutatingFirewallCmds(runner: FakeHostRunner): string[][] {
  return runner
    .commandsStartingWith('firewall-cmd')
    .filter((argv) => argv.some((arg) => /^--(add|remove|new|delete)-|^--reload$/.test(arg)));
}

async function failure(promise: Promise<unknown>): Promise<SetupStepError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SetupStepError) return error;
    throw error;
  }
  throw new Error('expected a SetupStepError');
}

afterEach(() => {
  const hostRunner = runners;
  runners = [];
  assertExecutorInvariants({ hostRunner, redactor: new Redactor() });
});

describe('FW1 rule set (14.1, U-SETUP-FW-01..04)', () => {
  const rows: { name: string; role: 'server-init' | 'server' | 'agent'; cluster: FirewallCluster; expected: string[] }[] = [
    { name: 'server, vxlan, etcd, proxy with ACME', role: 'server-init', cluster: cluster(), expected: ['apiserver', 'kubelet', 'vxlan', 'etcd', 'pods', 'services', 'http', 'https'] },
    { name: 'joining server, proxy without ACME', role: 'server', cluster: cluster({ proxyPorts: { http: true, https: false } }), expected: ['apiserver', 'kubelet', 'vxlan', 'etcd', 'pods', 'services', 'http'] },
    { name: 'server, sqlite, no proxy', role: 'server-init', cluster: cluster({ datastore: 'sqlite', proxyPorts: { http: false, https: false } }), expected: ['apiserver', 'kubelet', 'vxlan', 'pods', 'services'] },
    { name: 'agent never gets 80/443 nor etcd', role: 'agent', cluster: cluster(), expected: ['kubelet', 'vxlan', 'pods', 'services'] },
    { name: 'wireguard-native', role: 'agent', cluster: cluster({ flannelBackend: 'wireguard-native' }), expected: ['kubelet', 'wireguard', 'pods', 'services'] },
    { name: 'single node: no peer rules', role: 'server-init', cluster: cluster({ datastore: 'sqlite', network: { peerSources: [], serverPeerSources: [] } }), expected: ['pods', 'services', 'http', 'https'] },
    { name: 'etcd without server peers', role: 'server-init', cluster: cluster({ network: { peerSources: PEERS, serverPeerSources: [] } }), expected: ['apiserver', 'kubelet', 'vxlan', 'pods', 'services', 'http', 'https'] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      expect(ids(buildFirewallRules({ role: row.role }, row.cluster))).toEqual(row.expected);
    });
  }

  it('sources are the node addresses only; pods/services are bound to cni0 and the flannel interface', () => {
    const rules = buildFirewallRules({ role: 'server-init' }, cluster());
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    expect(byId.get('apiserver')).toEqual({ id: 'apiserver', proto: 'tcp', ports: '6443', sources: PEERS, inInterfaces: [] });
    expect(byId.get('kubelet')).toEqual({ id: 'kubelet', proto: 'tcp', ports: '10250', sources: PEERS, inInterfaces: [] });
    expect(byId.get('vxlan')).toEqual({ id: 'vxlan', proto: 'udp', ports: '8472', sources: PEERS, inInterfaces: [] });
    expect(byId.get('etcd')).toEqual({ id: 'etcd', proto: 'tcp', ports: '2379:2380', sources: SERVER_PEERS, inInterfaces: [] });
    expect(byId.get('pods')).toEqual({ id: 'pods', proto: 'any', ports: null, sources: ['10.42.0.0/16'], inInterfaces: ['cni0', 'flannel.1'] });
    expect(byId.get('services')).toEqual({ id: 'services', proto: 'any', ports: null, sources: ['10.43.0.0/16'], inInterfaces: ['cni0', 'flannel.1'] });
    expect(byId.get('http')).toEqual({ id: 'http', proto: 'tcp', ports: '80', sources: ['any'], inInterfaces: [] });
    expect(byId.get('https')).toEqual({ id: 'https', proto: 'tcp', ports: '443', sources: ['any'], inInterfaces: [] });
    for (const id of ['apiserver', 'kubelet', 'vxlan', 'etcd'] as const) expect(byId.get(id)?.sources).not.toContain('any');
    const wireguard = buildFirewallRules({ role: 'agent' }, cluster({ flannelBackend: 'wireguard-native' }));
    expect(wireguard.find((rule) => rule.id === 'wireguard')).toEqual({ id: 'wireguard', proto: 'udp', ports: '51820', sources: PEERS, inInterfaces: [] });
    expect(wireguard.find((rule) => rule.id === 'pods')?.inInterfaces).toEqual(['cni0', 'flannel-wg']);
  });
});

describe('FW8 choosing the tool (14.0)', () => {
  const rows: { status: FirewallStatus; skip: boolean; expected: 'ufw' | 'firewalld' | null | 'refused' }[] = [
    { status: { ufw: 'active', firewalld: 'running' }, skip: true, expected: null },
    { status: { ufw: 'active', firewalld: 'running' }, skip: false, expected: 'refused' },
    { status: { ufw: 'active', firewalld: 'absent' }, skip: false, expected: 'ufw' },
    { status: { ufw: 'active', firewalld: 'stopped' }, skip: false, expected: 'ufw' },
    { status: { ufw: 'absent', firewalld: 'running' }, skip: false, expected: 'firewalld' },
    { status: { ufw: 'inactive', firewalld: 'running' }, skip: false, expected: 'firewalld' },
    { status: { ufw: 'inactive', firewalld: 'absent' }, skip: false, expected: null },
    { status: { ufw: 'absent', firewalld: 'stopped' }, skip: false, expected: null },
    { status: { ufw: 'inactive', firewalld: 'stopped' }, skip: false, expected: null },
    { status: { ufw: 'absent', firewalld: 'absent' }, skip: false, expected: null },
  ];
  for (const row of rows) {
    it(`${row.status.ufw}/${row.status.firewalld}${row.skip ? ' --skip-firewall' : ''} -> ${row.expected}`, () => {
      const chosen = chooseFirewallTool(row.status, { skipFirewall: row.skip, key: KEY });
      if (row.expected === 'refused') {
        expect(chosen).toEqual({ success: false, error: setupMessages.bothFirewalls(KEY) });
      } else {
        expect(chosen).toEqual({ success: true, data: row.expected });
      }
    });
  }

  it('names the reason and the FIREWALL column', () => {
    expect(firewallReason({ ufw: 'absent', firewalld: 'absent' }, false)).toBe('ufw and firewalld are absent');
    expect(firewallReason({ ufw: 'inactive', firewalld: 'absent' }, false)).toBe('ufw is installed but inactive');
    expect(firewallReason({ ufw: 'absent', firewalld: 'stopped' }, false)).toBe('firewalld is stopped');
    expect(firewallReason({ ufw: 'active', firewalld: 'absent' }, true)).toBe('--skip-firewall');
    expect(firewallColumn({ ufw: 'inactive', firewalld: 'absent' }, null, false)).toBe('none (ufw inactive)');
    expect(firewallColumn({ ufw: 'absent', firewalld: 'absent' }, null, false)).toBe('none');
    expect(firewallColumn({ ufw: 'active', firewalld: 'absent' }, null, true)).toBe('skipped');
    expect(firewallColumn({ ufw: 'active', firewalld: 'absent' }, 'ufw', false)).toBe('ufw');
  });

  it('a recorded tool different from the chosen one and still active loses its rules before the first rule of the new one', async () => {
    const runner = firewalldHost();
    runner.ufw.installed = true;
    runner.ufw.active = true;
    const rules = buildFirewallRules({ role: 'server-init' }, cluster());
    const recorded = (await applyFirewalld(runner, rules, null, { key: KEY, nodeIp: '10.0.0.10' })).state;
    await writeFirewallState(runner, recorded);
    runner.calls.length = 0;
    runner.firewalld.reloads = 0;
    const report = await reconcileFirewall(runner, { key: KEY, tool: 'ufw', rules, status: { ufw: 'active', firewalld: 'running' }, nodeIp: '10.0.0.10', skipFirewall: false });
    const argvs = runner.calls.map((call) => call.argv.join(' '));
    const removals = argvs.map((argv, index) => (argv.startsWith('firewall-cmd') && /--remove-|--delete-ipset/.test(argv) ? index : -1));
    const lastRemoval = Math.max(...removals);
    const firstAllow = argvs.findIndex((argv) => argv.startsWith('ufw allow'));
    expect(lastRemoval).toBeGreaterThanOrEqual(0);
    expect(lastRemoval).toBeLessThan(firstAllow);
    expect(runner.firewalld.ipsets.size).toBe(0);
    expect([...(runner.firewalld.zones.get('trusted')?.interfaces ?? [])]).toEqual([]);
    expect(report.tool).toBe('ufw');
    expect(await readFirewallState(runner)).toEqual({ schema: 1, tool: 'ufw' });
    runner.assertDone();
  });

  it('a recorded tool that is now inactive receives no call; a stopped firewalld record is kept', async () => {
    const runner = firewalldHost();
    runner.ufw.installed = true;
    runner.ufw.active = false;
    runner.seedDir(K3S_DOCKFLOW_DIR, { mode: 0o700 });
    runner.seedFile(K3S_FIREWALL_STATE_FILE, JSON.stringify({ schema: 1, tool: 'ufw' }), { mode: 0o600 });
    const rules = buildFirewallRules({ role: 'agent' }, cluster());
    await reconcileFirewall(runner, { key: KEY, tool: 'firewalld', rules, status: { ufw: 'inactive', firewalld: 'running' }, nodeIp: '10.0.0.10', skipFirewall: false });
    expect(runner.commandsStartingWith('ufw')).toEqual([]);
    runner.assertDone();

    const stopped = ufwHost();
    const retired: FirewalldState = {
      schema: 1,
      tool: 'firewalld',
      zone: 'public',
      ipsets: ['dockflow-k3s-peers'],
      richRules: [firewalldRichRule('dockflow-k3s-peers', '6443', 'tcp')],
      trustedInterfaces: ['cni0'],
      trustedSources: [],
      ports: [],
    };
    stopped.seedDir(K3S_DOCKFLOW_DIR, { mode: 0o700 });
    stopped.seedFile(K3S_FIREWALL_STATE_FILE, JSON.stringify(retired), { mode: 0o600 });
    const report = await reconcileFirewall(stopped, { key: KEY, tool: 'ufw', rules, status: { ufw: 'active', firewalld: 'stopped' }, nodeIp: null, skipFirewall: false });
    expect(stopped.commandsStartingWith('firewall-cmd')).toEqual([]);
    expect(report.state).toEqual({ schema: 1, tool: 'ufw', retired });
    expect(await readFirewallState(stopped)).toEqual({ schema: 1, tool: 'ufw', retired });
    stopped.assertDone();
  });
});

describe('ufw (14.2)', () => {
  const RULES = buildFirewallRules({ role: 'server-init' }, cluster());

  it('U-SETUP-FW-05 renders the exact commands, one per source and interface, the comment as one argv element', () => {
    expect(renderUfwCommands(RULES)).toEqual([
      ['ufw', 'allow', 'proto', 'tcp', 'from', '10.0.0.11', 'to', 'any', 'port', '6443', 'comment', 'dockflow-k3s:apiserver'],
      ['ufw', 'allow', 'proto', 'tcp', 'from', '10.0.0.21', 'to', 'any', 'port', '6443', 'comment', 'dockflow-k3s:apiserver'],
      ['ufw', 'allow', 'proto', 'tcp', 'from', '10.0.0.11', 'to', 'any', 'port', '10250', 'comment', 'dockflow-k3s:kubelet'],
      ['ufw', 'allow', 'proto', 'tcp', 'from', '10.0.0.21', 'to', 'any', 'port', '10250', 'comment', 'dockflow-k3s:kubelet'],
      ['ufw', 'allow', 'proto', 'udp', 'from', '10.0.0.11', 'to', 'any', 'port', '8472', 'comment', 'dockflow-k3s:vxlan'],
      ['ufw', 'allow', 'proto', 'udp', 'from', '10.0.0.21', 'to', 'any', 'port', '8472', 'comment', 'dockflow-k3s:vxlan'],
      ['ufw', 'allow', 'proto', 'tcp', 'from', '10.0.0.11', 'to', 'any', 'port', '2379:2380', 'comment', 'dockflow-k3s:etcd'],
      ['ufw', 'allow', 'in', 'on', 'cni0', 'from', '10.42.0.0/16', 'comment', 'dockflow-k3s:pods'],
      ['ufw', 'allow', 'in', 'on', 'flannel.1', 'from', '10.42.0.0/16', 'comment', 'dockflow-k3s:pods'],
      ['ufw', 'allow', 'in', 'on', 'cni0', 'from', '10.43.0.0/16', 'comment', 'dockflow-k3s:services'],
      ['ufw', 'allow', 'in', 'on', 'flannel.1', 'from', '10.43.0.0/16', 'comment', 'dockflow-k3s:services'],
      ['ufw', 'allow', 'proto', 'tcp', 'to', 'any', 'port', '80', 'comment', 'dockflow-k3s:http'],
      ['ufw', 'allow', 'proto', 'tcp', 'to', 'any', 'port', '443', 'comment', 'dockflow-k3s:https'],
    ]);
  });

  it('FW2 parses full, short, interface-scoped and legacy forms, ignores foreign rules, reports unknown tagged rules', () => {
    const output = [
      "Added user rules (see 'ufw status' for running firewall):",
      'ufw allow 22/tcp',
      "ufw allow from 10.0.0.11 to any port 6443 proto tcp comment 'dockflow-k3s:apiserver'",
      "ufw allow from 10.0.0.11 to any port 2379:2380 proto tcp comment 'dockflow-k3s:etcd'",
      "ufw allow in on cni0 from 10.42.0.0/16 comment 'dockflow-k3s:pods'",
      "ufw allow from 10.43.0.0/16 comment 'dockflow-k3s:services'",
      "ufw allow 443/tcp comment 'dockflow-k3s:https'",
      "ufw allow from 10.0.0.9 to any port 9999 proto tcp comment 'dockflow-k3s:mystery'",
      "ufw allow from 192.0.2.1 comment 'office'",
      '',
    ].join('\n');
    expect(parseUfwShowAdded(output)).toEqual({
      rules: [
        { id: 'apiserver', proto: 'tcp', ports: '6443', source: '10.0.0.11', iface: null },
        { id: 'etcd', proto: 'tcp', ports: '2379:2380', source: '10.0.0.11', iface: null },
        { id: 'pods', proto: 'any', ports: null, source: '10.42.0.0/16', iface: 'cni0' },
        { id: 'services', proto: 'any', ports: null, source: '10.43.0.0/16', iface: null },
        { id: 'https', proto: 'tcp', ports: '443', source: 'any', iface: null },
      ],
      unrecognised: ["ufw allow from 10.0.0.9 to any port 9999 proto tcp comment 'dockflow-k3s:mystery'"],
    });
    expect(parseUfwShowAdded("Added user rules (see 'ufw status' for running firewall):\n(None)\n")).toEqual({ rules: [], unrecognised: [] });
  });

  it('FW3 adds everything once, then a re-run changes nothing (U-SETUP-FW-05: no duplicate)', async () => {
    const runner = ufwHost();
    const first = await applyUfw(runner, RULES, { key: KEY });
    expect(first).toMatchObject({ added: 13, removed: 0, warnings: [], state: { schema: 1, tool: 'ufw' } });
    expect(runner.commandsStartingWith('ufw', 'allow')).toEqual(renderUfwCommands(RULES));
    runner.calls.length = 0;
    const second = await applyUfw(runner, RULES, { key: KEY });
    expect(second.added + second.removed).toBe(0);
    expect(runner.calls.map((call) => call.argv)).toEqual([['ufw', 'show', 'added']]);
    expect(runner.ufw.added).toHaveLength(13);
    runner.assertDone();
  });

  it('FW3 deletes a removed node address and the legacy un-scoped CIDR rule, adds the scoped ones; unknown tagged rules stay with a warning', async () => {
    const runner = ufwHost();
    runner.ufw.added = [
      "ufw allow from 10.0.0.99 to any port 6443 proto tcp comment 'dockflow-k3s:apiserver'",
      "ufw allow from 10.42.0.0/16 comment 'dockflow-k3s:pods'",
      "ufw allow from 10.0.0.9 to any port 9999 proto tcp comment 'dockflow-k3s:mystery'",
      'ufw allow 22/tcp',
    ];
    const result = await applyUfw(runner, RULES, { key: KEY });
    expect(runner.commandsStartingWith('ufw', 'delete')).toEqual([
      ['ufw', 'delete', 'allow', 'proto', 'tcp', 'from', '10.0.0.99', 'to', 'any', 'port', '6443'],
      ['ufw', 'delete', 'allow', 'from', '10.42.0.0/16'],
    ]);
    const allowed = runner.commandsStartingWith('ufw', 'allow').map((argv) => argv.join(' '));
    expect(allowed).toContain('ufw allow in on cni0 from 10.42.0.0/16 comment dockflow-k3s:pods');
    expect(allowed).toContain('ufw allow in on flannel.1 from 10.42.0.0/16 comment dockflow-k3s:pods');
    expect(result.warnings).toEqual(["Unrecognised Dockflow ufw rule on server_1: ufw allow from 10.0.0.9 to any port 9999 proto tcp comment 'dockflow-k3s:mystery'"]);
    expect(runner.ufw.added).toContain('ufw allow 22/tcp');
    expect(runner.ufw.added).toContain("ufw allow from 10.0.0.9 to any port 9999 proto tcp comment 'dockflow-k3s:mystery'");
    expect(runner.ufw.added.some((line) => line.startsWith('ufw allow from 10.42.0.0/16'))).toBe(false);
    expect(runner.commandsStartingWith('ufw', 'enable')).toEqual([]);
    runner.assertDone();
  });

  it('FW7 a rejected rule stops with the message and the flow table, never `|| true`', async () => {
    const runner = ufwHost();
    runner.on(['ufw', 'allow'], { exitCode: 1, stderr: 'ERROR: Bad port\n' });
    const error = await failure(applyUfw(runner, RULES, { key: KEY }));
    expect(error.message).toBe('ufw rejected a rule on server_1: ERROR: Bad port');
    expect(error.suggestion?.split('\n')[0]).toBe('Fix ufw on server_1, or re-run with --skip-firewall and apply the flows listed below manually.');
    expect(error.suggestion).toContain('  TCP 6443         from 10.0.0.11, 10.0.0.21');
    expect(error.suggestion).toContain('  any              from 10.42.0.0/16 on cni0, flannel.1');
    expect(error.suggestion).toContain('  TCP 80           from anywhere');
    expect(runner.commandsStartingWith('ufw', 'allow')).toHaveLength(1);
    expect(runner.calls.some((call) => call.argv.includes('||') || call.argv.includes('true'))).toBe(false);
    runner.assertDone();
  });

  it('removeDockflowRules deletes every tagged rule, legacy ones included, and nothing else', async () => {
    const runner = ufwHost();
    await applyUfw(runner, RULES, { key: KEY });
    runner.ufw.added.push("ufw allow from 10.43.0.0/16 comment 'dockflow-k3s:services'", 'ufw allow 22/tcp');
    expect(await removeDockflowRules(runner, { schema: 1, tool: 'ufw' }, { key: KEY })).toBe(14);
    expect(runner.ufw.added).toEqual(['ufw allow 22/tcp']);
    runner.assertDone();
  });
});

describe('FW4 installed but inactive ufw (R-S6-03, E-71-07)', () => {
  it('is no firewall: only `ufw status` runs, nothing is written, ufw is never enabled', async () => {
    const runner = ufwHost(false);
    const status = await probeFirewall(runner);
    expect(status).toEqual({ ufw: 'inactive', firewalld: 'absent' });
    const chosen = chooseFirewallTool(status, { skipFirewall: false, key: KEY });
    expect(chosen).toEqual({ success: true, data: null });
    const report = await reconcileFirewall(runner, {
      key: KEY,
      tool: null,
      rules: buildFirewallRules({ role: 'server-init' }, cluster()),
      status,
      nodeIp: '10.0.0.10',
      skipFirewall: false,
    });
    expect(report).toEqual({ tool: null, added: 0, removed: 0, warnings: [], state: null });
    expect(runner.commandsStartingWith('ufw')).toEqual([['ufw', 'status']]);
    expect(runner.ufw.added).toEqual([]);
    expect(runner.ufw.active).toBe(false);
    expect(runner.files.has(K3S_FIREWALL_STATE_FILE)).toBe(false);
    expect(firewallColumn(status, null, false)).toBe('none (ufw inactive)');
    expect(setupMessages.noFirewall(KEY, 'production', firewallReason(status, false)).message).toBe(
      'No host firewall is managed on server_1, so 6443, 10250, 2379-2380 and 8472 stay open unless your provider firewall blocks them (ufw is installed but inactive)',
    );
    runner.assertDone();
  });
});

describe('FW5 firewalld (14.3)', () => {
  const RULES = buildFirewallRules({ role: 'server-init' }, cluster({ proxyPorts: { http: true, https: false } }));
  const PEERS_RULES = ['6443/tcp', '10250/tcp', '8472/udp'].map((item) => {
    const [port, proto] = item.split('/');
    return firewalldRichRule('dockflow-k3s-peers', port, proto as 'tcp' | 'udp');
  });
  const ETCD_RULE = firewalldRichRule('dockflow-k3s-servers', '2379:2380', 'tcp');

  it('plans ipsets, rich rules, the trusted CNI interfaces and ports; renders the 14.3 commands', () => {
    const plan = planFirewalld(RULES);
    expect(plan).toEqual({
      ipsets: [
        { name: 'dockflow-k3s-peers', entries: PEERS },
        { name: 'dockflow-k3s-servers', entries: SERVER_PEERS },
      ],
      richRules: [...PEERS_RULES, ETCD_RULE],
      trustedInterfaces: ['cni0', 'flannel.1'],
      ports: ['80/tcp'],
    });
    expect(ETCD_RULE).toBe('rule family="ipv4" source ipset="dockflow-k3s-servers" port port="2379-2380" protocol="tcp" accept');
    const commands = renderFirewalldCommands(plan, 'public').map((argv) => argv.join(' '));
    expect(commands).toContain('firewall-cmd --permanent --new-ipset=dockflow-k3s-peers --type=hash:ip --option=family=inet');
    expect(commands).toContain('firewall-cmd --permanent --zone=trusted --add-interface=cni0');
    expect(commands).toContain('firewall-cmd --permanent --zone=public --add-port=80/tcp');
    expect(commands.at(-1)).toBe('firewall-cmd --reload');
    expect(commands.some((command) => command.includes('--add-source='))).toBe(false);
  });

  it('adds once, records what it added, reloads once; a re-run with the record changes nothing', async () => {
    const runner = firewalldHost();
    const first = await applyFirewalld(runner, RULES, null, { key: KEY, nodeIp: '10.0.0.10' });
    expect(first.state).toEqual({
      schema: 1,
      tool: 'firewalld',
      zone: 'public',
      ipsets: ['dockflow-k3s-peers', 'dockflow-k3s-servers'],
      richRules: [...PEERS_RULES, ETCD_RULE],
      trustedInterfaces: ['cni0', 'flannel.1'],
      trustedSources: [],
      ports: ['80/tcp'],
    });
    expect(runner.firewalld.reloads).toBe(1);
    expect([...(runner.firewalld.ipsets.get('dockflow-k3s-peers') ?? [])].sort()).toEqual(PEERS);
    expect([...(runner.firewalld.zones.get('trusted')?.interfaces ?? [])]).toEqual(['cni0', 'flannel.1']);
    expect(runner.commandsStartingWith('firewall-cmd', '--get-zone-of-interface=eth0')).toHaveLength(1);
    expect(runner.commandsStartingWith('firewall-offline-cmd')).toEqual([]);
    const adds = mutatingFirewallCmds(runner).filter((argv) => argv.some((arg) => arg.startsWith('--add-rich-rule')));
    expect(adds).toHaveLength(4);
    for (const argv of adds) {
      expect(runner.calls.some((call) => call.argv.join(' ') === argv.join(' ').replace('--add-rich-rule', '--query-rich-rule'))).toBe(true);
    }

    runner.calls.length = 0;
    const second = await applyFirewalld(runner, RULES, first.state, { key: KEY, nodeIp: '10.0.0.10' });
    expect(second.state).toEqual(first.state);
    expect(mutatingFirewallCmds(runner)).toEqual([]);
    expect(runner.firewalld.reloads).toBe(1);
    runner.assertDone();
  });

  it('records only items Dockflow added; removes a stale entry and a previously added CIDR source', async () => {
    const runner = firewalldHost();
    runner.firewalld.zones.get('public')?.richRules.add(PEERS_RULES[0]);
    runner.firewalld.ipsets.set('dockflow-k3s-peers', new Set(['10.0.0.11', '10.0.0.99']));
    runner.firewalld.zones.get('trusted')?.sources.add('10.42.0.0/16');
    const previous: FirewalldState = {
      schema: 1,
      tool: 'firewalld',
      zone: 'public',
      ipsets: ['dockflow-k3s-peers'],
      richRules: [],
      trustedInterfaces: [],
      trustedSources: ['10.42.0.0/16'],
      ports: [],
    };
    const result = await applyFirewalld(runner, RULES, previous, { key: KEY, nodeIp: '10.0.0.10' });
    expect(result.state).toMatchObject({ richRules: [...PEERS_RULES.slice(1), ETCD_RULE], trustedSources: [], ipsets: ['dockflow-k3s-peers', 'dockflow-k3s-servers'] });
    expect([...(runner.firewalld.ipsets.get('dockflow-k3s-peers') ?? [])].sort()).toEqual(PEERS);
    expect(runner.firewalld.zones.get('trusted')?.sources.size).toBe(0);
    expect(runner.commandsStartingWith('firewall-cmd', '--permanent', '--zone=trusted', '--remove-source=10.42.0.0/16')).toHaveLength(1);
    runner.assertDone();
  });

  it('removes recorded rules that are no longer desired (proxy disabled)', async () => {
    const runner = firewalldHost();
    const first = await applyFirewalld(runner, RULES, null, { key: KEY, nodeIp: '10.0.0.10' });
    const withoutProxy = buildFirewallRules({ role: 'server-init' }, cluster({ proxyPorts: { http: false, https: false } }));
    const second = await applyFirewalld(runner, withoutProxy, first.state, { key: KEY, nodeIp: '10.0.0.10' });
    expect(second.state).toMatchObject({ ports: [] });
    expect(runner.firewalld.zones.get('public')?.ports.size).toBe(0);
    expect(second.removed).toBe(1);
    runner.assertDone();
  });

  it('refuses a CNI interface bound to another zone before changing anything', async () => {
    const runner = firewalldHost();
    runner.firewalld.zones.get('internal')?.interfaces.add('cni0');
    const error = await failure(applyFirewalld(runner, RULES, null, { key: KEY, nodeIp: '10.0.0.10' }));
    expect(error.message).toBe('cni0 is bound to firewalld zone internal on server_1');
    expect(error.suggestion).toBe(
      'Move it to the trusted zone (`firewall-cmd --permanent --zone=trusted --change-interface=cni0`) or allow pod traffic in internal, then run setup again.',
    );
    expect(mutatingFirewallCmds(runner)).toEqual([]);
    runner.assertDone();
  });

  it('falls back to the default zone when the node interface has none', async () => {
    const runner = firewalldHost();
    runner.firewalld.zones.get('public')?.interfaces.delete('eth0');
    runner.firewalld.defaultZone = 'internal';
    const result = await applyFirewalld(runner, RULES, null, { key: KEY, nodeIp: '10.0.0.10' });
    expect(result.state).toMatchObject({ zone: 'internal' });
    runner.assertDone();
  });

  it('a stopped firewalld is never called: no firewall-cmd, no firewall-offline-cmd', async () => {
    const runner = firewalldHost(false);
    const status = await probeFirewall(runner);
    expect(status).toEqual({ ufw: 'absent', firewalld: 'stopped' });
    const chosen = chooseFirewallTool(status, { skipFirewall: false, key: KEY });
    expect(chosen).toEqual({ success: true, data: null });
    await reconcileFirewall(runner, { key: KEY, tool: null, rules: RULES, status, nodeIp: '10.0.0.10', skipFirewall: false });
    expect(runner.commandsStartingWith('firewall-cmd')).toEqual([]);
    expect(runner.commandsStartingWith('firewall-offline-cmd')).toEqual([]);
    runner.assertDone();
  });

  it('reconcile writes firewall.json root 0600 in the 0700 directory, and does not rewrite it unchanged', async () => {
    const runner = firewalldHost();
    const options = { key: KEY, tool: 'firewalld' as const, rules: RULES, status: { ufw: 'absent' as const, firewalld: 'running' as const }, nodeIp: '10.0.0.10', skipFirewall: false };
    const report = await reconcileFirewall(runner, options);
    expect(runner.files.get(K3S_DOCKFLOW_DIR)).toMatchObject({ type: 'directory', mode: 0o700, uid: 0, gid: 0 });
    expect(runner.files.get(K3S_FIREWALL_STATE_FILE)).toMatchObject({ type: 'file', mode: 0o600, uid: 0, gid: 0 });
    expect(await readFirewallState(runner)).toEqual(report.state);
    expect(await writeFirewallState(runner, report.state as FirewalldState)).toBe('unchanged');
    runner.calls.length = 0;
    const again = await reconcileFirewall(runner, options);
    expect(again.added + again.removed).toBe(0);
    expect(mutatingFirewallCmds(runner)).toEqual([]);
    runner.assertDone();
  });

  it('removeDockflowRules removes the recorded items only', async () => {
    const runner = firewalldHost();
    runner.firewalld.zones.get('public')?.ports.add('22/tcp');
    const { state } = await applyFirewalld(runner, RULES, null, { key: KEY, nodeIp: '10.0.0.10' });
    expect(await removeDockflowRules(runner, state, { key: KEY })).toBe(9);
    expect([...(runner.firewalld.zones.get('public')?.ports ?? [])]).toEqual(['22/tcp']);
    expect(runner.firewalld.zones.get('public')?.richRules.size).toBe(0);
    expect(runner.firewalld.ipsets.size).toBe(0);
    runner.assertDone();
  });

  it('parses only valid state files', () => {
    expect(parseFirewallState('not json')).toBeNull();
    expect(parseFirewallState(JSON.stringify({ schema: 2, tool: 'ufw' }))).toBeNull();
    expect(parseFirewallState(JSON.stringify({ schema: 1, tool: 'firewalld', zone: 'public' }))).toBeNull();
    expect(parseFirewallState(JSON.stringify({ schema: 1, tool: 'ufw' }))).toEqual({ schema: 1, tool: 'ufw' });
  });
});

describe('FW6 no manageable firewall (14.4)', () => {
  const HA: ManualFlowCluster = {
    nodes: [
      { key: 'srv-1', role: 'server-init', addresses: ['10.0.0.10'] },
      { key: 'srv-2', role: 'server', addresses: ['10.0.0.11'] },
      { key: 'worker-1', role: 'agent', addresses: ['10.0.0.21'] },
    ],
    flannelBackend: 'vxlan',
    datastore: 'etcd',
    proxyPorts: { http: true, https: true },
  };
  const unmanaged = (reason: string) => HA.nodes.map((node) => ({ key: node.key, reason }));

  it('vxlan HA with the proxy: flows from the same rule set, then the deny paragraph', () => {
    expect(formatManualFlows(HA, unmanaged('ufw is installed but inactive'))).toBe(
      [
        'No host firewall is managed on srv-1, srv-2, worker-1 (ufw is installed but inactive).',
        'Allow exactly these flows in your provider firewall:',
        '  TCP 6443         from srv-1 10.0.0.10, srv-2 10.0.0.11, worker-1 10.0.0.21 to srv-1 10.0.0.10, srv-2 10.0.0.11',
        '  TCP 10250        between srv-1 10.0.0.10, srv-2 10.0.0.11, worker-1 10.0.0.21',
        '  UDP 8472         between srv-1 10.0.0.10, srv-2 10.0.0.11, worker-1 10.0.0.21',
        '  TCP 2379-2380    between srv-1 10.0.0.10, srv-2 10.0.0.11',
        '  TCP 80           from anywhere                                    to srv-1, srv-2 (control-plane, proxy.enabled)',
        '  TCP 443          from anywhere                                    to srv-1, srv-2 (proxy.enabled, ACME on)',
        'Deny 6443, 10250, 2379-2380 and 8472 from every address outside this list. They are authenticated,',
        'but they must not be exposed: 6443 and 10250 are administrative APIs and UDP 8472 carries',
        'unencrypted pod traffic. Dockflow cannot verify this for you when no host firewall is managed.',
      ].join('\n'),
    );
  });

  it('wireguard-native single server: 51820 flows, no etcd, and 51820 added to the four canonical ports', () => {
    const publicCluster: ManualFlowCluster = {
      nodes: [
        { key: 'srv-1', role: 'server-init', addresses: ['203.0.113.10'] },
        { key: 'worker-1', role: 'agent', addresses: ['203.0.113.21'] },
      ],
      flannelBackend: 'wireguard-native',
      datastore: 'sqlite',
      proxyPorts: { http: false, https: false },
    };
    expect(formatManualFlows(publicCluster, [{ key: 'srv-1', reason: '--skip-firewall' }, { key: 'worker-1', reason: '--skip-firewall' }])).toBe(
      [
        'No host firewall is managed on srv-1, worker-1 (--skip-firewall).',
        'Allow exactly these flows in your provider firewall:',
        '  TCP 6443         from worker-1 203.0.113.21                       to srv-1 203.0.113.10',
        '  TCP 10250        between srv-1 203.0.113.10, worker-1 203.0.113.21',
        '  UDP 51820        between srv-1 203.0.113.10, worker-1 203.0.113.21',
        'Deny 6443, 10250, 2379-2380, 8472 and 51820 from every address outside this list. They are authenticated,',
        'but they must not be exposed: 6443 and 10250 are administrative APIs and UDP 8472 carries',
        'unencrypted pod traffic. Dockflow cannot verify this for you when no host firewall is managed.',
      ].join('\n'),
    );
  });

  it('names each reason, per node when they differ; the deny sentence is never omitted', () => {
    for (const reason of ['ufw and firewalld are absent', 'ufw is installed but inactive', 'firewalld is stopped', '--skip-firewall']) {
      const text = formatManualFlows(HA, unmanaged(reason));
      expect(text.split('\n')[0]).toBe(`No host firewall is managed on srv-1, srv-2, worker-1 (${reason}).`);
      expect(text.endsWith(denyStatement('vxlan'))).toBe(true);
    }
    const mixed = formatManualFlows(HA, [
      { key: 'srv-1', reason: 'ufw is installed but inactive' },
      { key: 'worker-1', reason: 'ufw and firewalld are absent' },
    ]);
    expect(mixed.split('\n')[0]).toBe(
      'No host firewall is managed on srv-1, worker-1 (srv-1: ufw is installed but inactive; worker-1: ufw and firewalld are absent).',
    );
    const single: ManualFlowCluster = { ...HA, nodes: [HA.nodes[0]], datastore: 'sqlite', proxyPorts: { http: false, https: false } };
    expect(formatManualFlows(single, [{ key: 'srv-1', reason: 'ufw and firewalld are absent' }])).toBe(
      ['No host firewall is managed on srv-1 (ufw and firewalld are absent).', 'Allow exactly these flows in your provider firewall:', denyStatement('vxlan')].join('\n'),
    );
  });

  it('reads the addresses of a resolved cluster', () => {
    const resolved = {
      plan: { nodes: HA.nodes.map((node) => ({ key: node.key, role: node.role })), proxyPorts: { http: true, https: false } },
      flannelBackend: 'vxlan',
      datastore: 'etcd',
      network: {
        'srv-1': { privateIp: '10.0.0.10', publicIp: '203.0.113.10' },
        'srv-2': { privateIp: '10.0.0.11', publicIp: null },
        'worker-1': { privateIp: '10.0.0.21', publicIp: null },
      },
    } as unknown as K3sResolvedCluster;
    expect(manualFlowClusterOf(resolved)).toEqual({
      nodes: [
        { key: 'srv-1', role: 'server-init', addresses: ['10.0.0.10', '203.0.113.10'] },
        { key: 'srv-2', role: 'server', addresses: ['10.0.0.11'] },
        { key: 'worker-1', role: 'agent', addresses: ['10.0.0.21'] },
      ],
      flannelBackend: 'vxlan',
      datastore: 'etcd',
      proxyPorts: { http: true, https: false },
    });
  });
});
