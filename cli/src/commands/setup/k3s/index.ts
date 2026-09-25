// The k3s setup coordinator (design-05 3): runs on the operator's machine, never on a node. It
// turns servers.yml into a plan (plan.ts, P36), connects to every node over a dedicated,
// host-key-verified SSH channel (transport.ts, host-keys.ts), and drives each node through the
// `--k3s-plan` protocol (node.ts, P56) in the order of 3.1. `runK3sReset` is the same coordinator
// for `--reset` (18): scope rules, confirmation and the drain-before-reset steps are this file's;
// the node-side removal (18.3) is P56's `reset.ts`.

import { createConnection } from 'node:net';
import { DOCKFLOW_VERSION } from '../../../constants';
import { HELM_PIN } from '../../../services/orchestrator/kubernetes/versions';
import { K8S_KUBECONFIG_DIR } from '../../../services/orchestrator/kubernetes/constants';
import type { ResolvedServer } from '../../../types/servers';
import { type DockflowConfig, getProjectRoot, loadConfig } from '../../../utils/config';
import { CLIError, ConnectionError, ErrorCode, ValidationError } from '../../../utils/errors';
import { printBlank, printDim, printError, printInfo } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { getServerPrivateKey } from '../../../utils/servers/ci-secrets';
import { resolveServersForEnvironment } from '../../../utils/servers/resolver';
import { loadSecrets } from '../../../utils/secrets';
import { confirm, prompt } from '../prompts';
import { chooseFirewallTool, firewallColumn, type FirewallStatus } from './firewall';
import { HostKeyStore, type HostKeyDecision, type HostKeyVerification } from './host-keys';
import { installMessages, type NodeBinary, resolveNodeBinary } from './install';
import { type SetupProblem, setupMessages } from './messages';
import type { NodeStepResult } from './node';
import {
  buildClusterPlan,
  buildNodePlan,
  finalizeClusterPlan,
  installSequence,
  type FirewallTool,
  type K3sClusterPlan,
  type K3sNodeInspection,
  type K3sNodeRole,
  type K3sNodeSpec,
  type K3sResolvedCluster,
  type K3sSetupOptions,
  type NodeAction,
  type NodeArch,
  type NodeOperation,
  type PlanWarning,
  type Refusal,
} from './plan';
import type { ClusterTokens } from './tokens';
import {
  createSshSetupTransport,
  type BootstrapIdentity,
  type BinaryResolver,
  type SetupTransport,
} from './transport';
import { NODE_STEP_GUARD_S, SETUP_PARALLEL_NODES } from './constants';
import {
  evaluateDeployIdentityChecks,
  runExposureProbe,
  type ConnectOutcome,
  type ConnectProbe,
  type DeployIdentityProbe,
  type ExposureProbeNode,
  type StatResult,
} from './verify';

export type { BootstrapIdentity } from './transport';

// ---------------------------------------------------------------------------
// Reset options (design-05 18.1)
// ---------------------------------------------------------------------------

export interface K3sResetOptions {
  sshUser: string;
  /** empty = whole environment */
  nodes: readonly string[];
  deleteVolumes: boolean;
  yes: boolean;
  /** non-TTY confirmation: must equal `env` */
  confirm: string | null;
  sharedCluster: boolean;
  insecureHostKey: boolean;
  requireHostKey: boolean;
  binary: string | null;
  dev: boolean;
  interactive: boolean;
}

// ---------------------------------------------------------------------------
// Injectable seams (design-07 R-S6-06/07): every real dependency the coordinator opens itself
// (SSH transport, host-key store, the SHA256SUMS fetch, the exposure probe's sockets) can be
// substituted, the same way `node.ts`'s `NodeStepDeps` lets `runK3sNodeStep` run against a fake
// host. Every field defaults to the real implementation, so a caller that passes none behaves
// exactly as before this seam existed.
// ---------------------------------------------------------------------------

export interface K3sClusterSetupDeps {
  transport?: SetupTransport;
  hostKeys?: HostKeyVerification;
  resolveBinary?: BinaryResolver;
  connectProbe?: ConnectProbe;
  /** bypasses `loadConfig()` (project config.yml); `null` is a valid override (no config.yml) */
  config?: DockflowConfig | null;
  /** bypasses `resolveServersForEnvironment(env)` (project servers.yml) */
  servers?: readonly ResolvedServer[];
  /** bypasses `getServerPrivateKey` per server (CI secrets / .env.dockflow) */
  deployKeys?: Readonly<Record<string, string | undefined>>;
}

// ---------------------------------------------------------------------------
// Small local errors
// ---------------------------------------------------------------------------

/** thrown when the operator declines a prompt: caught at the top, exits 0 (15.5, 18.1) */
class SetupCancelled extends Error {}

class ServerStepFailed extends Error {
  constructor(readonly key: string) {
    super(`setup step failed on ${key}`);
  }
}

// ---------------------------------------------------------------------------
// forEachLimit: bounded concurrency, fail-fast (3.1 "parallel 4")
// ---------------------------------------------------------------------------

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  let firstError: unknown;
  let stop = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (stop) return;
      const current = index++;
      if (current >= items.length) return;
      try {
        await fn(items[current]);
      } catch (error) {
        if (!stop) {
          stop = true;
          firstError = error;
        }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (stop) throw firstError;
}

// ---------------------------------------------------------------------------
// Summary report (17.1) and node ordering
// ---------------------------------------------------------------------------

interface ReportRow {
  key: string;
  role: K3sNodeRole;
  action: string;
  result: 'ok' | 'failed' | 'pending';
  firewall: string;
  hostKey: string;
  detail: string;
}

class SetupReport {
  readonly rows = new Map<string, ReportRow>();
  readonly warnings: { node: string | null; message: string }[] = [];
  exposure: string[] = [];

  constructor(plan: K3sClusterPlan) {
    for (const node of plan.nodes) {
      this.rows.set(node.key, { key: node.key, role: node.role, action: 'noop', result: 'pending', firewall: '', hostKey: '', detail: '' });
    }
  }

  setAction(key: string, action: string): void {
    const row = this.rows.get(key);
    if (row) row.action = action;
  }

  setFirewall(key: string, text: string): void {
    const row = this.rows.get(key);
    if (row) row.firewall = text;
  }

  setHostKey(key: string, decision: HostKeyDecision | undefined): void {
    const row = this.rows.get(key);
    if (!row || decision === undefined) return;
    row.hostKey = decision.outcome === 'matched' ? `${decision.fingerprint} ok` : decision.outcome === 'recorded' ? `${decision.fingerprint} new` : `${decision.fingerprint} off`;
  }

  recordResult(key: string, result: NodeStepResult): void {
    const row = this.rows.get(key);
    if (!row) return;
    row.result = result.status === 'ok' ? 'ok' : 'failed';
    if (result.error !== null) row.detail = result.error.message;
    for (const warning of result.warnings) this.addWarning(key, warning);
  }

  addWarning(node: string | null, message: string): void {
    this.warnings.push({ node, message });
  }

  get failedNodes(): string[] {
    return [...this.rows.values()].filter((r) => r.result === 'failed').map((r) => r.key);
  }

  render(): string {
    const lines: string[] = [];
    lines.push('  NODE       ROLE          ACTION     RESULT   FIREWALL    HOST KEY            DETAIL');
    for (const row of this.rows.values()) {
      lines.push(
        `  ${row.key.padEnd(10)} ${row.role.padEnd(13)} ${row.action.padEnd(10)} ${row.result.padEnd(8)} ${row.firewall.padEnd(11)} ${row.hostKey.padEnd(19)} ${row.detail}`,
      );
    }
    if (this.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const warning of this.warnings) lines.push(`  ${warning.node ?? 'cluster'}  ${warning.message}`);
    }
    if (this.exposure.length > 0) {
      lines.push('');
      for (const line of this.exposure) lines.push(`  ${line}`);
    }
    return lines.join('\n');
  }
}

function printSummaryTable(report: SetupReport): void {
  printBlank();
  for (const line of report.render().split('\n')) printDim(line);
}

// ---------------------------------------------------------------------------
// Token handling (3.4, K76): runOp is the only place that sees result.tokens
// ---------------------------------------------------------------------------

interface OpOutcome {
  result: NodeStepResult;
  tokens: { server: string; agent: string } | null;
}

function baseFailedResult(node: K3sNodeSpec, operation: NodeOperation, message: string, suggestion: string, logTail: string[] = []): NodeStepResult {
  return {
    schema: 1,
    node: node.key,
    operation,
    status: 'failed',
    steps: [],
    warnings: [],
    error: { step: operation, message, suggestion, logTail },
    inspection: null,
    tokens: null,
    controlPlane: null,
    verification: null,
    reset: null,
  };
}

async function runOp(
  transport: SetupTransport,
  node: K3sNodeSpec,
  operation: NodeOperation,
  plan: ReturnType<typeof buildNodePlan>,
  guardS: number,
  redactor: Redactor,
  report: SetupReport,
  onEvent: (step: string, status: string, detail?: string) => void,
): Promise<OpOutcome> {
  const outcome = await transport.runNodeStep(node.key, plan, { onEvent: (event) => onEvent(event.step, event.status, event.detail) }, guardS);
  let result: NodeStepResult;
  if (outcome.kind === 'result') {
    result = outcome.result as unknown as NodeStepResult;
  } else if (outcome.kind === 'timeout') {
    result = baseFailedResult(node, operation, `The setup step on ${node.key} timed out after ${guardS}s`, 'Increase network reliability to the node, or run setup again.');
  } else {
    const tail = outcome.stderrTail.map((line) => redactor.redact(line));
    result = baseFailedResult(
      node,
      operation,
      `The setup step on ${node.key} stopped unexpectedly (exit ${outcome.exitCode}): ${tail.join(' ') || 'no output'}`,
      'Run with --debug and try again.',
      tail,
    );
  }
  const tokens = result.tokens;
  const stripped: NodeStepResult = { ...result, tokens: null };
  report.recordResult(node.key, stripped);
  if (stripped.status !== 'ok') {
    printError(`${node.key}: ${stripped.error?.message ?? 'setup step failed'}`);
  }
  // The step error only says verification failed: each failing check is in the verification itself.
  for (const problem of stripped.verification?.problems ?? []) {
    if (problem.severity === 'error') {
      printError(`${node.key}: ${problem.message}${problem.suggestion ? ` — ${problem.suggestion}` : ''}`);
    } else {
      report.addWarning(node.key, problem.suggestion ? `${problem.message} (${problem.suggestion})` : problem.message);
    }
  }
  return { result: stripped, tokens };
}

// ---------------------------------------------------------------------------
// Binary resolution (3.3, K57c): release mode fetches SHA256SUMS once, before any SSH;
// --binary/--dev resolve lazily per architecture (no network fetch to gate on).
// ---------------------------------------------------------------------------

function makeBinaryResolver(options: { binary: string | null; dev: boolean }, resolved: Partial<Record<NodeArch, NodeBinary>> | null, nodeCount: number): BinaryResolver {
  if (resolved !== null) {
    return async (arch) => {
      const binary = resolved[arch];
      if (binary === undefined) {
        const problem = installMessages.noSha256Sums(DOCKFLOW_VERSION, nodeCount, null);
        throw new CLIError(problem.message, ErrorCode.COMMAND_FAILED, problem.suggestion);
      }
      return binary;
    };
  }
  const cache = new Map<NodeArch, Promise<NodeBinary>>();
  return (arch) => {
    let cached = cache.get(arch);
    if (cached === undefined) {
      cached = resolveNodeBinary({ localBinaries: { [arch]: options.binary ?? '' }, arches: [arch], nodeCount }).then((map) => {
        const binary = map[arch];
        if (binary === undefined) throw new Error(`no local binary resolved for ${arch}`);
        return binary;
      });
      cache.set(arch, cached);
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------
// Node readiness (16.1)
// ---------------------------------------------------------------------------

interface NodeReadyCondition {
  ready: boolean;
  kubeletVersion: string | null;
}

function parseNodeReadiness(stdout: string): NodeReadyCondition | null {
  try {
    const parsed = JSON.parse(stdout) as { status?: { conditions?: { type?: string; status?: string }[]; nodeInfo?: { kubeletVersion?: string } } };
    const ready = (parsed.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    return { ready, kubeletVersion: parsed.status?.nodeInfo?.kubeletVersion ?? null };
  } catch {
    return null;
  }
}

async function waitNodeReady(transport: SetupTransport, queryServer: string, node: K3sNodeSpec, expectedVersion: string, timeoutS: number): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const result = await transport.execAsRoot(queryServer, `k3s kubectl get node ${node.nodeName} -o json`, 15);
    const condition = result.exitCode === 0 ? parseNodeReadiness(result.stdout) : null;
    if (condition?.ready && (condition.kubeletVersion === null || condition.kubeletVersion === expectedVersion)) return;
    if (Date.now() >= deadline) {
      throw new CLIError(`${node.key} did not become Ready within ${timeoutS}s`, ErrorCode.COMMAND_FAILED, `Run \`journalctl -u ${node.role === 'agent' ? 'k3s-agent' : 'k3s'}\` on ${node.key}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// ---------------------------------------------------------------------------
// Deploy identity checks (16.3) and the exposure probe (16.5)
// ---------------------------------------------------------------------------

function parseStat(stdout: string): StatResult | null {
  const [owner, group, mode] = stdout.trim().split(/\s+/);
  if (owner === undefined || group === undefined || mode === undefined) return null;
  return { owner, group, mode };
}

async function statVia(transport: SetupTransport, key: string, path: string): Promise<StatResult | null> {
  const result = await transport.execAsDeployUser(key, `stat -c '%U %G %a' ${path} 2>/dev/null`, 15);
  return result.exitCode === 0 ? parseStat(result.stdout) : null;
}

async function checkDeployIdentity(transport: SetupTransport, node: K3sNodeSpec): Promise<void> {
  const server = node.role !== 'agent';
  const whoamiResult = await transport.execAsDeployUser(node.key, 'whoami', 15);
  const kubeconfigStat = server ? await statVia(transport, node.key, `${K8S_KUBECONFIG_DIR}/config`) : null;
  const kubeconfigDirStat = server ? await statVia(transport, node.key, K8S_KUBECONFIG_DIR) : null;
  const tokenDirStat = await statVia(transport, node.key, '/etc/rancher/k3s/dockflow');
  let authCanI: string | null = null;
  let readyz: string | null = null;
  let adminKubeconfigUnreadable: boolean | null = null;
  if (server) {
    const kubectlPrefix = `KUBECONFIG=${K8S_KUBECONFIG_DIR}/config k3s kubectl`;
    authCanI = (await transport.execAsDeployUser(node.key, `${kubectlPrefix} auth can-i '*' '*' --all-namespaces`, 15)).stdout.trim();
    readyz = (await transport.execAsDeployUser(node.key, `${kubectlPrefix} get --raw=/readyz`, 15)).stdout.trim();
    adminKubeconfigUnreadable = (await transport.execAsDeployUser(node.key, 'test ! -r /etc/rancher/k3s/k3s.yaml', 15)).exitCode === 0;
  }
  const tokenFileUnreadable = (await transport.execAsDeployUser(node.key, 'test ! -r /etc/rancher/k3s/dockflow/token', 15)).exitCode === 0;

  const probe: DeployIdentityProbe = {
    key: node.key,
    deployUser: node.deployUser,
    server,
    sudoUser: node.deployUser !== 'root',
    whoami: whoamiResult.stdout.trim(),
    kubeconfigStat,
    kubeconfigDirStat,
    tokenDirStat,
    authCanI,
    readyz,
    adminKubeconfigUnreadable,
    helmVersion: null,
    expectedHelmVersion: HELM_PIN.version,
    sudoImagesOk: null,
    tokenFileUnreadable,
  };
  const problems = evaluateDeployIdentityChecks(probe);
  if (problems.length > 0) {
    throw new CLIError(problems[0].message, ErrorCode.COMMAND_FAILED, problems[0].suggestion);
  }
}

function defaultConnectProbe(): ConnectProbe {
  return (host, port, timeoutS) =>
    new Promise<ConnectOutcome>((resolve) => {
      const socket = createConnection({ host, port, timeout: timeoutS * 1000 });
      const finish = (outcome: ConnectOutcome): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(outcome);
      };
      socket.once('connect', () => finish('open'));
      socket.once('timeout', () => finish('timeout'));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED') finish('refused');
        else if (error.code === 'EPERM' || error.code === 'EACCES') finish('eperm');
        else finish('timeout');
      });
    });
}

async function probeExposure(cluster: K3sResolvedCluster, options: K3sSetupOptions, connectProbe: ConnectProbe = defaultConnectProbe()): Promise<string[]> {
  if (options.skipReachabilityCheck) return [];
  const nodes: ExposureProbeNode[] = cluster.plan.nodes.map((node) => {
    const network = cluster.network[node.key];
    const managed = chooseFirewallTool({ ufw: 'absent', firewalld: 'absent' }, { skipFirewall: options.skipFirewall, key: node.key });
    void managed;
    return {
      key: node.key,
      addr: network?.publicIp ?? network?.nodeExternalIp ?? null,
      role: node.role === 'agent' ? 'agent' : 'server',
      etcdMember: cluster.datastore === 'etcd' && node.role !== 'agent',
    };
  });
  const problems = await runExposureProbe(nodes, connectProbe, { env: cluster.plan.env, isPrivate: (addr) => isPrivateAddress(addr) });
  return problems.map((p) => p.message);
}

function isPrivateAddress(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

// ---------------------------------------------------------------------------
// Confirmation (15.5, 18.1)
// ---------------------------------------------------------------------------

async function confirmDisruptive(cluster: K3sResolvedCluster, options: K3sSetupOptions): Promise<void> {
  const convertNodes = cluster.plan.nodes.filter((n) => cluster.actions[n.key]?.kind === 'convert-to-etcd');
  if (convertNodes.length > 0) {
    if (!options.interactive) return; // refused earlier during preflight without --convert-datastore
    for (const node of convertNodes) {
      const path = `/var/lib/rancher/k3s/server/db-dockflow-pre-<slug>`;
      const accepted = await confirm(
        `${node.key} converts from SQLite to embedded etcd. This cannot be undone without resetting the node. A copy of the datastore is kept at ${path}. Continue?`,
        false,
      );
      if (!accepted) {
        printInfo(setupMessages.setupCancelled);
        throw new SetupCancelled();
      }
    }
  }

  const disruptive = cluster.plan.nodes.filter((n) => {
    const kind = cluster.actions[n.key]?.kind;
    return kind === 'upgrade' || kind === 'reconfigure';
  });
  if ((disruptive.length > 0 || options.rotateDeployToken) && options.interactive && !options.yes && !options.upgrade) {
    const keys = disruptive.map((n) => n.key);
    const reasonSet = new Set<string>();
    for (const n of disruptive) reasonSet.add(cluster.actions[n.key].kind);
    const reasons = [...reasonSet];
    const accepted = await confirm(setupMessages.restartConfirm(keys.length > 0 ? keys : ['this cluster'], reasons.length > 0 ? reasons : ['--rotate-deploy-token']), true);
    if (!accepted) {
      printInfo(setupMessages.setupCancelled);
      throw new SetupCancelled();
    }
  }
}

// ---------------------------------------------------------------------------
// Upgrade failure (15.3): a dedicated message naming how far the sequential server upgrade got
// ---------------------------------------------------------------------------

function upgradeStoppedProblem(env: string, failedKey: string, detail: string, done: number, remaining: number, pin: string, from: string): SetupProblem {
  return {
    message: `Upgrade stopped at ${failedKey}: ${detail}. ${done} ${done === 1 ? 'node runs' : 'nodes run'} ${pin}, ${remaining} still ${remaining === 1 ? 'runs' : 'run'} ${from}`,
    suggestion: `Fix ${failedKey}, then re-run dockflow setup k3s ${env}; completed nodes are skipped.`,
  };
}

// ---------------------------------------------------------------------------
// runK3sClusterSetup (3.1, 3.2)
// ---------------------------------------------------------------------------

function isReadyServer(inspection: K3sNodeInspection | undefined): boolean {
  return inspection !== undefined && inspection.k3s.managed && inspection.k3s.activeState === 'active' && inspection.k3s.apiReady === true;
}

function firstReadyServer(cluster: K3sResolvedCluster, inspections: Readonly<Record<string, K3sNodeInspection | undefined>>, fallback: string): string {
  const servers = installSequence(cluster.plan).servers;
  const ready = servers.find((s) => isReadyServer(inspections[s.key]));
  return ready?.key ?? fallback;
}

async function collectDeployKeys(env: string, servers: readonly { name: string }[]): Promise<Record<string, string | undefined>> {
  const keys: Record<string, string | undefined> = {};
  for (const server of servers) keys[server.name] = getServerPrivateKey(env, server.name);
  return keys;
}

/**
 * The binary resolver of the real transport (3.3, K57c): `SHA256SUMS` is fetched once, eagerly,
 * before any SSH call (I7: a missing file is a `CLIError` with zero connections opened). A test that
 * injects `deps.resolveBinary` skips this fetch entirely and is never called when `deps.transport`
 * is also injected, thanks to `??`'s short-circuiting in the caller.
 */
async function resolveBinaryFor(options: Pick<K3sSetupOptions, 'binary' | 'dev'>, nodeCount: number, injected?: BinaryResolver): Promise<BinaryResolver> {
  if (injected !== undefined) return injected;
  const resolvedBinaries =
    options.binary === null && !options.dev ? await resolveNodeBinary({ localBinaries: null, arches: ['amd64', 'arm64'], nodeCount }) : null;
  return makeBinaryResolver(options, resolvedBinaries, nodeCount);
}

export async function runK3sClusterSetup(env: string, bootstrap: BootstrapIdentity, options: K3sSetupOptions, deps: K3sClusterSetupDeps = {}): Promise<void> {
  loadSecrets();
  const config = deps.config !== undefined ? deps.config : loadConfig();
  const servers = deps.servers ?? resolveServersForEnvironment(env);
  const deployKeys = deps.deployKeys ?? (await collectDeployKeys(env, servers));

  const plan = buildClusterPlan({ env, config, servers, deployKeys, options, dockflowVersion: DOCKFLOW_VERSION });
  const report = new SetupReport(plan);

  const hostKeys =
    deps.hostKeys ??
    new HostKeyStore(getProjectRoot(), env, {
      insecureHostKey: options.insecureHostKey,
      requireHostKey: options.requireHostKey,
      interactive: options.interactive,
      onWarning: (message) => report.addWarning(null, message),
    });

  const transport =
    deps.transport ?? createSshSetupTransport(bootstrap, await resolveBinaryFor(options, plan.nodes.length, deps.resolveBinary), hostKeys, { deployKeys });
  const redactor = new Redactor([bootstrap.password, ...Object.values(deployKeys)].filter((v): v is string => typeof v === 'string' && v.length >= 6));

  let tokens: ClusterTokens | null = null;
  // visible to the catch block, which needs it to report an upgrade failure precisely (15.3); a
  // plain summary rather than `cluster` itself, so every closure below keeps narrowing `cluster` on
  // its own (a `let cluster` reassigned once loses that narrowing inside every arrow function).
  let upgradeInfo: { actions: Readonly<Record<string, NodeAction>>; totalUpgrading: number } | undefined;
  let upgradedServers = 0;
  try {
    await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, (node) => transport.prepareNode(node));
    for (const node of plan.nodes) report.setHostKey(node.key, hostKeys.decisions.filter((d) => d.key === node.key).at(-1));

    const inspections: Record<string, K3sNodeInspection> = {};
    await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, async (node) => {
      const nodePlan = buildNodePlan({ operation: 'inspect', node: node.key, arch: transport.archOf(node.key), plan });
      const { result } = await runOp(transport, node, 'inspect', nodePlan, NODE_STEP_GUARD_S.inspect, redactor, report, () => {});
      if (result.inspection !== null) inspections[node.key] = result.inspection;
      if (result.status !== 'ok') throw new ServerStepFailed(node.key);
    });

    const cluster = finalizeClusterPlan(plan, inspections);
    upgradeInfo = { actions: cluster.actions, totalUpgrading: installSequence(plan).servers.filter((s) => cluster.actions[s.key]?.kind === 'upgrade').length };
    const firewallTools = new Map<string, FirewallTool | null>();
    const refusals: Refusal[] = [...cluster.refusals];
    for (const node of plan.nodes) {
      const inspection = inspections[node.key];
      const status: FirewallStatus = inspection?.firewall ?? { ufw: 'absent', firewalld: 'absent' };
      const chosen = chooseFirewallTool(status, { skipFirewall: options.skipFirewall, key: node.key });
      if (chosen.success) {
        firewallTools.set(node.key, chosen.data);
        report.setFirewall(node.key, firewallColumn(status, chosen.data, options.skipFirewall));
      } else {
        refusals.push({ node: node.key, message: chosen.error.message, suggestion: chosen.error.suggestion });
      }
      report.setAction(node.key, cluster.actions[node.key]?.kind ?? 'noop');
    }
    for (const warning of cluster.warnings as readonly PlanWarning[]) report.addWarning(warning.node, warning.message);

    printBlank();
    for (const node of plan.nodes) printDim(`${node.key}  ${node.role}  ${cluster.actions[node.key]?.kind ?? 'noop'}`);

    if (refusals.length > 0) {
      const problem = setupMessages.refusals(env, refusals);
      throw new CLIError(problem.message, ErrorCode.VALIDATION_FAILED, problem.suggestion);
    }
    if (options.dryRun) {
      printInfo(`k3s setup of ${env}: dry run, no changes made`);
      return;
    }

    await confirmDisruptive(cluster, options);

    if (!cluster.fresh && plan.nodes.length > 1) {
      const source = firstReadyServer(cluster, inspections, installSequence(plan).servers[0].key);
      const sourceNode = plan.nodes.find((n) => n.key === source);
      if (sourceNode !== undefined) {
        const readTokensPlan = buildNodePlan({ operation: 'read-tokens', node: source, arch: transport.archOf(source), plan, cluster, firewallTool: firewallTools.get(source) ?? null });
        const { tokens: read } = await runOp(transport, sourceNode, 'read-tokens', readTokensPlan, NODE_STEP_GUARD_S['read-tokens'], redactor, report, () => {});
        if (read === null) throw new ServerStepFailed(source);
        tokens = read;
        redactor.add([read.server, read.agent]);
      }
    }

    await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, async (node) => {
      const preparePlan = buildNodePlan({ operation: 'prepare', node: node.key, arch: transport.archOf(node.key), plan, cluster, firewallTool: firewallTools.get(node.key) ?? null });
      const { result } = await runOp(transport, node, 'prepare', preparePlan, NODE_STEP_GUARD_S.prepare, redactor, report, () => {});
      if (result.status !== 'ok') throw new ServerStepFailed(node.key);
    });

    const { servers: orderedServers, agents } = installSequence(plan);
    for (const server of orderedServers) {
      const installPlan = buildNodePlan({ operation: 'install', node: server.key, arch: transport.archOf(server.key), plan, cluster, tokens, firewallTool: firewallTools.get(server.key) ?? null });
      const { result: installResult, tokens: issued } = await runOp(transport, server, 'install', installPlan, NODE_STEP_GUARD_S.install, redactor, report, () => {});
      if (installResult.status !== 'ok') throw new ServerStepFailed(server.key);
      if (server.role === 'server-init' && cluster.fresh) {
        if (issued === null) throw new CLIError(`${server.key} bootstrapped the cluster but issued no tokens`, ErrorCode.COMMAND_FAILED);
        tokens = issued;
        redactor.add([issued.server, issued.agent]);
      }

      const controlPlanePlan = buildNodePlan({ operation: 'control-plane', node: server.key, arch: transport.archOf(server.key), plan, cluster, firewallTool: firewallTools.get(server.key) ?? null });
      const { result: cpResult } = await runOp(transport, server, 'control-plane', controlPlanePlan, NODE_STEP_GUARD_S['control-plane'], redactor, report, () => {});
      if (cpResult.status !== 'ok') throw new ServerStepFailed(server.key);

      await waitNodeReady(transport, firstReadyServer(cluster, inspections, server.key), server, cluster.actions[server.key]?.toVersion ?? '', 300);
      if (cluster.actions[server.key]?.kind === 'upgrade') upgradedServers += 1;
    }

    await forEachLimit(agents, SETUP_PARALLEL_NODES, async (agent) => {
      const installPlan = buildNodePlan({ operation: 'install', node: agent.key, arch: transport.archOf(agent.key), plan, cluster, tokens, firewallTool: firewallTools.get(agent.key) ?? null });
      const { result } = await runOp(transport, agent, 'install', installPlan, NODE_STEP_GUARD_S.install, redactor, report, () => {});
      if (result.status !== 'ok') throw new ServerStepFailed(agent.key);
      await waitNodeReady(transport, firstReadyServer(cluster, inspections, orderedServers[0].key), agent, cluster.actions[agent.key]?.toVersion ?? '', 180);
    });

    const finalizeSource = firstReadyServer(cluster, inspections, orderedServers[0].key);
    const finalizeNode = plan.nodes.find((n) => n.key === finalizeSource);
    if (finalizeNode !== undefined) {
      const finalizePlan = buildNodePlan({ operation: 'finalize', node: finalizeSource, arch: transport.archOf(finalizeSource), plan, cluster, firewallTool: firewallTools.get(finalizeSource) ?? null });
      await runOp(transport, finalizeNode, 'finalize', finalizePlan, NODE_STEP_GUARD_S.finalize, redactor, report, () => {});
    }

    await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, async (node) => {
      try {
        await checkDeployIdentity(transport, node);
      } catch (error) {
        report.addWarning(node.key, error instanceof Error ? error.message : String(error));
      }
    });

    report.exposure = await probeExposure(cluster, options, deps.connectProbe);
    for (const line of report.exposure) report.addWarning('cluster', line);

    if (report.failedNodes.length > 0) {
      throw new CLIError(`k3s setup of ${env} failed on ${report.failedNodes.join(', ')}`, ErrorCode.COMMAND_FAILED, 'See the node rows above for the failing step.');
    }
    printInfo(`k3s cluster ${env} is ready (${plan.nodes.length} nodes, k3s ${cluster.actions[orderedServers[0]?.key ?? plan.nodes[0].key]?.toVersion ?? DOCKFLOW_VERSION})`);
    printInfo(`Deploy with: dockflow deploy ${env}`);
  } catch (error) {
    if (error instanceof SetupCancelled) return;
    if (error instanceof ServerStepFailed) {
      const failed = report.failedNodes;
      const failedKey = failed[0] ?? error.key;
      const action = upgradeInfo?.actions[failedKey];
      if (upgradeInfo !== undefined && action?.kind === 'upgrade') {
        const problem = upgradeStoppedProblem(env, failedKey, report.rows.get(failedKey)?.detail || 'the setup step failed', upgradedServers, upgradeInfo.totalUpgrading - upgradedServers, action.toVersion, action.fromVersion ?? 'an earlier version');
        throw new CLIError(problem.message, ErrorCode.COMMAND_FAILED, problem.suggestion);
      }
      throw new CLIError(
        `k3s setup of ${env} failed${failed.length > 0 ? ` on ${failed.join(', ')}` : ` on ${error.key}`}`,
        ErrorCode.COMMAND_FAILED,
        'See the node rows above for the failing step.',
      );
    }
    throw error;
  } finally {
    tokens = null;
    hostKeys.persistRecorded();
    await transport.cleanup();
    printSummaryTable(report);
  }
}

// ---------------------------------------------------------------------------
// runK3sReset (18)
// ---------------------------------------------------------------------------

interface ResetPlanNode {
  spec: K3sNodeSpec;
  envs: string[];
}

async function inspectForReset(transport: SetupTransport, plan: K3sClusterPlan, redactor: Redactor, report: SetupReport): Promise<Record<string, K3sNodeInspection>> {
  await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, (node) => transport.prepareNode(node));
  const inspections: Record<string, K3sNodeInspection> = {};
  await forEachLimit(plan.nodes, SETUP_PARALLEL_NODES, async (node) => {
    const nodePlan = buildNodePlan({ operation: 'inspect', node: node.key, arch: transport.archOf(node.key), plan });
    const { result } = await runOp(transport, node, 'inspect', nodePlan, NODE_STEP_GUARD_S.inspect, redactor, report, () => {});
    if (result.inspection !== null) inspections[node.key] = result.inspection;
  });
  return inspections;
}

export async function runK3sReset(env: string, bootstrap: BootstrapIdentity, options: K3sResetOptions, deps: K3sClusterSetupDeps = {}): Promise<void> {
  loadSecrets();
  const config = deps.config !== undefined ? deps.config : loadConfig();
  const servers = deps.servers ?? resolveServersForEnvironment(env);
  const deployKeys = deps.deployKeys ?? (await collectDeployKeys(env, servers));

  const planOptions: K3sSetupOptions = {
    sshUser: options.sshUser,
    dryRun: false,
    yes: options.yes,
    upgrade: false,
    convertDatastore: false,
    sharedCluster: options.sharedCluster,
    flannelBackend: null,
    skipFirewall: true,
    skipNetworkCheck: true,
    skipReachabilityCheck: true,
    insecureHostKey: options.insecureHostKey,
    requireHostKey: options.requireHostKey,
    rotateDeployToken: false,
    binary: options.binary,
    dev: options.dev,
    interactive: options.interactive,
  };
  const plan = buildClusterPlan({ env, config, servers, deployKeys, options: planOptions, dockflowVersion: DOCKFLOW_VERSION });
  const report = new SetupReport(plan);
  const hostKeys =
    deps.hostKeys ??
    new HostKeyStore(getProjectRoot(), env, {
      insecureHostKey: options.insecureHostKey,
      requireHostKey: options.requireHostKey,
      interactive: options.interactive,
      onWarning: (message) => report.addWarning(null, message),
    });
  const transport =
    deps.transport ?? createSshSetupTransport(bootstrap, await resolveBinaryFor(options, plan.nodes.length, deps.resolveBinary), hostKeys, { deployKeys });
  const redactor = new Redactor(Object.values(deployKeys).filter((v): v is string => typeof v === 'string' && v.length >= 6));

  try {
    const inspections = await inspectForReset(transport, plan, redactor, report);

    const requested = options.nodes.length > 0 ? options.nodes : plan.nodes.map((n) => n.key);
    const unknown = requested.filter((key) => !plan.nodes.some((n) => n.key === key));
    if (unknown.length > 0) throw new ValidationError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in servers.yml for ${env}`, 'Check the --node value against servers.yml.');

    const targets = plan.nodes.filter((n) => requested.includes(n.key));
    const servers = plan.nodes.filter((n) => n.role !== 'agent');
    const agents = plan.nodes.filter((n) => n.role === 'agent');
    const wholeEnvironment = options.nodes.length === 0;

    // shared-cluster scope rule (18.2, 12.5)
    const shared = targets.filter((n) => {
      const envs = inspections[n.key]?.k3s.state?.envs ?? [];
      return envs.some((e) => e !== env && e !== '');
    });
    if (shared.length > 0 && !options.sharedCluster) {
      const otherEnvs = [...new Set(shared.flatMap((n) => (inspections[n.key]?.k3s.state?.envs ?? []).filter((e) => e !== env)))];
      throw new ConnectionError(
        `${shared.map((n) => n.key).join(', ')} also serves Dockflow environment ${otherEnvs.join(', ')}, whose workloads and volumes on it are removed by this reset`,
        'Reset it from a checkout that owns every environment on it, or re-run with --shared-cluster to reset it for all of them.',
      );
    }

    // only-server-while-agents-remain refusal (18.2)
    if (!wholeEnvironment) {
      const targetsAgentsOnly = targets.every((n) => n.role === 'agent');
      const remainingServers = servers.filter((s) => !requested.includes(s.key));
      if (!targetsAgentsOnly && remainingServers.length === 0 && agents.some((a) => !requested.includes(a.key))) {
        const strandedAgents = agents.filter((a) => !requested.includes(a.key)).map((a) => a.key);
        throw new ValidationError(
          `Resetting ${targets.map((n) => n.key).join(', ')} would leave agents ${strandedAgents.join(', ')} without a control plane`,
          'Include them with --node, or reset the whole environment.',
        );
      }
    }

    // confirmation (18.1); a shared-cluster reset (12.5) names the other environments it also affects
    const names = targets.map((n) => n.key).join(', ');
    const sharedEnvs = [...new Set(shared.flatMap((n) => (inspections[n.key]?.k3s.state?.envs ?? []).filter((e) => e !== env)))];
    const sharedNote =
      sharedEnvs.length > 0
        ? `\n${shared.map((n) => n.key).join(', ')} also ${shared.length === 1 ? 'serves' : 'serve'} Dockflow environment ${sharedEnvs.join(', ')}; this reset affects its workloads and volumes too.`
        : '';
    if (options.interactive) {
      const text = options.deleteVolumes
        ? `This uninstalls k3s from ${names} of ${env}. Workloads on those nodes stop.\nNOTHING is preserved: volume data, the etcd snapshots and SQLite copies Dockflow made, and the cluster token are DELETED with the k3s data directory. Backups you copied off-host are unaffected.${sharedNote}\nType the environment name to confirm:`
        : `This uninstalls k3s from ${names} of ${env}. Workloads on those nodes stop.\nMoved aside to /var/lib/dockflow-preserved/<timestamp>/ (root, 0700) before the uninstall:\n  volume data (local-path storage), etcd snapshots and SQLite pre-upgrade copies Dockflow made,\n  and a copy of the cluster token, which is required to restore any of those snapshots.\nEverything else under /var/lib/rancher/k3s is deleted by the k3s uninstall script.${sharedNote}\nType the environment name to confirm:`;
      const typed = await prompt(text);
      if (typed !== env) throw new SetupCancelled();
    } else if (options.confirm !== env) {
      throw new ValidationError('Reset needs --confirm <env> when not running in a terminal', `Pass --confirm ${env}.`);
    }

    // scope order (18.2): agents (parallel 4), non-init servers (servers.yml order), cluster-init last
    const orderedTargets = wholeEnvironment
      ? [...targets.filter((n) => n.role === 'agent'), ...targets.filter((n) => n.role === 'server'), ...targets.filter((n) => n.role === 'server-init')]
      : targets;

    // drain and delete each targeted node from a ready server first (18.3), for partial resets
    if (!wholeEnvironment) {
      const readyServer = servers.find((s) => isReadyServer(inspections[s.key]))?.key;
      if (readyServer !== undefined) {
        for (const node of targets) {
          await transport.execAsRoot(readyServer, `k3s kubectl cordon ${node.nodeName}`, 30);
          await transport.execAsRoot(readyServer, `k3s kubectl drain ${node.nodeName} --ignore-daemonsets --delete-emptydir-data --timeout=300s`, 320);
          await transport.execAsRoot(readyServer, `k3s kubectl delete node ${node.nodeName} --wait=true`, 60);
        }
      }
    }

    const agentTargets = orderedTargets.filter((n) => n.role === 'agent');
    const serverTargets = orderedTargets.filter((n) => n.role !== 'agent');

    await forEachLimit(agentTargets, SETUP_PARALLEL_NODES, (node) => runResetOp(transport, node, plan, options, redactor, report));
    for (const node of serverTargets) await runResetOp(transport, node, plan, options, redactor, report);

    if (report.failedNodes.length > 0) {
      throw new CLIError(`k3s reset of ${env} failed on ${report.failedNodes.join(', ')}`, ErrorCode.COMMAND_FAILED, 'See the node rows above for the failing step.');
    }
    printInfo(`k3s reset of ${env} complete (${orderedTargets.length} nodes)`);
  } catch (error) {
    if (error instanceof SetupCancelled) {
      printInfo(setupMessages.setupCancelled);
      return;
    }
    throw error;
  } finally {
    await transport.cleanup();
    printSummaryTable(report);
  }
}

async function runResetOp(
  transport: SetupTransport,
  node: K3sNodeSpec,
  plan: K3sClusterPlan,
  options: K3sResetOptions,
  redactor: Redactor,
  report: SetupReport,
): Promise<void> {
  const resetPlan = buildNodePlan({ operation: 'reset', node: node.key, arch: transport.archOf(node.key), plan, cluster: unresolvedForReset(plan), deleteVolumes: options.deleteVolumes });
  report.setAction(node.key, 'reset');
  const { result } = await runOp(transport, node, 'reset', resetPlan, NODE_STEP_GUARD_S.reset, redactor, report, () => {});
  if (result.status !== 'ok') throw new ServerStepFailed(node.key);
}

/** `reset` plans need a `cluster` section (buildNodePlan requires one for every non-inspect op) but read none of its fields beyond identity; this is the same shape finalizeClusterPlan builds when nothing was inspected. */
function unresolvedForReset(plan: K3sClusterPlan): K3sResolvedCluster {
  const network: K3sResolvedCluster['network'] = {};
  const joinUrls: K3sResolvedCluster['joinUrls'] = {};
  const actions: K3sResolvedCluster['actions'] = {};
  for (const node of plan.nodes) {
    network[node.key] = { privateIp: null, publicIp: null, nodeIp: null, nodeExternalIp: null, peerSources: [], serverPeerSources: [], cniInterfaces: [] };
    joinUrls[node.key] = null;
    actions[node.key] = { kind: 'noop', changedKeys: [], fromVersion: null, toVersion: plan.dockflowVersion };
  }
  return { plan, addressMode: 'private', flannelBackend: plan.requestedBackend ?? 'vxlan', datastore: 'sqlite', fresh: true, clusterInitNode: null, network, joinUrls, actions, refusals: [], warnings: [] };
}
