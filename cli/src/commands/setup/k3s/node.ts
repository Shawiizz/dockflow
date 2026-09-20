// The k3s node step (design-05 3.4, 4): the JSON-line protocol every operation speaks, the lock that
// keeps two runs from overlapping, `inspect` (read-only, 4.1) and the six operations that change a
// node (`prepare`, `install`, `control-plane`, `read-tokens`, `finalize`, `reset`). Runs as root on
// the node; every in-cluster call goes through `hostKubeExecutor`, every host call through the
// injected `HostRunner`.

import { DOCKFLOW_VERSION } from '../../../constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import { systemClock } from '../../../services/orchestrator/kubernetes/deps';
import { CLIError } from '../../../utils/errors';
import { sha256Hex } from '../../../utils/hash';
import { printError, printRaw } from '../../../utils/output';
import { Redactor } from '../../../utils/redact';
import { ensureDockflowDir } from '../provision';
import { configureServiceAccess, ensureDeployUser, findLegacySudoRules, keyBlobOf, userMessages } from '../user';
import {
  K3S_AGENT_TOKEN_FILE,
  K3S_BINARY,
  K3S_CONFIG_DROPIN,
  K3S_CONFIG_DROPIN_DIR,
  K3S_CONFIG_DROPIN_MODE,
  K3S_DOCKFLOW_DIR,
  K3S_DOCKFLOW_DIR_MODE,
  K3S_ETCD_DIR,
  K3S_NODE_STATE_FILE,
  K3S_SERVER_AGENT_TOKEN,
  K3S_SERVER_CA,
  K3S_SERVER_TOKEN,
  K3S_SQLITE_DB_DIR,
  K3S_TOKEN_FILE,
  NETCHECK_DAEMONSET,
  NODE_STATE_MANAGED_BY,
  NODE_STATE_SCHEMA,
  SETUP_LOCK_FILE,
} from './constants';
import { parseK3sConfig, renderK3sConfig, restartSha256Of } from './config';
import { buildFirewallRules, probeFirewall, reconcileFirewall } from './firewall';
import { cacheTraefikChart, ensureHelmDirectories, helmComponent, installHelm } from './helm';
import { type HostRunner, fileMatches, firstLineOf, localHostRunner, runChecked, SetupStepError, writeFileAtomic } from './host-runner';
import { applyIdentityObjects, rotateDeployToken, waitForDeployerToken, writeKubeconfig } from './identity';
import {
  downloadToCache,
  installK3sBinary,
  installScriptComponent,
  k3sBinaryComponent,
  k3sUnitFor,
  nodeArch,
  runInstallScript,
  waitForService,
} from './install';
import { hostKubeExecutor } from './kube';
import type { SetupProblem } from './messages';
import type { Datastore, K3sNodeInspection, K3sNodePlan, K3sNodeRole, NodeOperation, NodeStateFile } from './plan';
import { runNodeReset, type ResetReport } from './reset';
import { parseNodePlan, parseNodeState } from './schema';
import { applySystemObjects, assertSingleDefaultStorageClass, reconcileNodeLabels, type StorageDefaultResult } from './system';
import { checkClusterTokens, generateAgentToken, TOKEN_DIRECTORY, tokenFilesFor, tokenFingerprint } from './tokens';
import {
  applyNetcheckDaemonSet,
  buildClusterVerification,
  type ClusterVerification,
  type EncryptionStatus,
  evaluateEncryptionStatus,
  type ExpectedNode,
  type NetworkCheckResult,
  removeNetcheckDaemonSet,
  runNetworkCheck,
} from './verify';

const NODE_PLAN_MAX_READ_BYTES = 1024 * 1024;
const PROC_DIR = '/proc';
const REQUIRED_COMMANDS: readonly string[] = ['curl', 'tar', 'sha256sum', 'ip', 'systemctl'];
const PACKAGE_MANAGERS: readonly string[] = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'];

// The 4.3 `packages` step: which package provides each command `inspect` (4.1) may report missing.
// `visudo` (the `sudo` package) is only relevant when the deploy user is not root.
const PACKAGE_OF_COMMAND: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  curl: { 'apt-get': 'curl', dnf: 'curl', yum: 'curl', pacman: 'curl', zypper: 'curl', apk: 'curl' },
  tar: { 'apt-get': 'tar', dnf: 'tar', yum: 'tar', pacman: 'tar', zypper: 'tar', apk: 'tar' },
  sha256sum: { 'apt-get': 'coreutils', dnf: 'coreutils', yum: 'coreutils', pacman: 'coreutils', zypper: 'coreutils', apk: 'coreutils' },
  ip: { 'apt-get': 'iproute2', dnf: 'iproute', yum: 'iproute', pacman: 'iproute2', zypper: 'iproute2', apk: 'iproute2' },
  visudo: { 'apt-get': 'sudo', dnf: 'sudo', yum: 'sudo', pacman: 'sudo', zypper: 'sudo', apk: 'sudo' },
};
const INSTALL_ARGS_OF: Readonly<Record<string, readonly string[]>> = {
  'apt-get': ['apt-get', 'install', '-y'],
  dnf: ['dnf', 'install', '-y'],
  yum: ['yum', 'install', '-y'],
  pacman: ['pacman', '-S', '--noconfirm'],
  zypper: ['zypper', 'install', '-y'],
  apk: ['apk', 'add'],
};

const nodeMessages = {
  lockHeld: (key: string, pid: number): SetupProblem => ({
    message: `Another dockflow setup is running on ${key} (pid ${pid})`,
    suggestion: `Wait for it to finish, or remove ${SETUP_LOCK_FILE} on ${key} if it crashed.`,
  }),
  versionMismatch: (key: string, planVersion: string): SetupProblem => ({
    message: `The plan for ${key} was built by Dockflow ${planVersion}, but this node step is Dockflow ${DOCKFLOW_VERSION}`,
    suggestion: 'Run the coordinator and the node step from the same Dockflow release.',
  }),
} as const;

// ---------------------------------------------------------------------------
// Protocol (3.4)
// ---------------------------------------------------------------------------

export interface StepResult {
  id: string;
  status: 'ok' | 'skip' | 'warn' | 'failed';
  detail?: string;
}

export interface ControlPlaneReport {
  helmVersion: string;
  kubeconfig: 'written' | 'unchanged';
  encryption: EncryptionStatus;
  traefikBundled: boolean;
  storageDefault: StorageDefaultResult;
}

export interface NodeStepResult {
  schema: 1;
  node: string;
  operation: NodeOperation;
  status: 'ok' | 'failed' | 'refused';
  steps: StepResult[];
  warnings: string[];
  error: { step: string; message: string; suggestion: string; logTail: string[] } | null;
  inspection: K3sNodeInspection | null;
  tokens: { server: string; agent: string } | null;
  controlPlane: ControlPlaneReport | null;
  verification: ClusterVerification | null;
  reset: ResetReport | null;
}

function baseResult(plan: K3sNodePlan): NodeStepResult {
  return {
    schema: 1,
    node: plan.node.key,
    operation: plan.operation,
    status: 'ok',
    steps: [],
    warnings: [],
    error: null,
    inspection: null,
    tokens: null,
    controlPlane: null,
    verification: null,
    reset: null,
  };
}

function emit(result: NodeStepResult): void {
  printRaw(JSON.stringify({ dockflowNodeResult: result }));
}

/** Live per-step progress (3.4): one line per step, `start` before the work and the outcome after. */
function emitEvent(step: string, status: 'start' | 'ok' | 'skip' | 'warn', detail?: string): void {
  printRaw(JSON.stringify({ dockflowNodeEvent: detail === undefined ? { step, status } : { step, status, detail } }));
}

/** Records a step in the result and mirrors it as a progress event; `failed` is reported only in the final result (3.4 status enum has no `failed`). */
function finishStep(steps: StepResult[], entry: StepResult): void {
  steps.push(entry);
  if (entry.status !== 'failed') emitEvent(entry.id, entry.status, entry.detail);
}

function describeError(error: unknown, redactor: Redactor): { message: string; suggestion: string; logTail: string[] } {
  if (error instanceof SetupStepError) {
    return { message: redactor.redact(error.message), suggestion: redactor.redact(error.suggestion ?? ''), logTail: error.logTail.map((line) => redactor.redact(line)) };
  }
  if (error instanceof CLIError) {
    return { message: redactor.redact(error.message), suggestion: redactor.redact(error.suggestion ?? ''), logTail: [] };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message: redactor.redact(message), suggestion: '', logTail: [] };
}

function addPlanSecrets(redactor: Redactor, plan: K3sNodePlan): void {
  const secrets = [plan.tokens.server, plan.tokens.agent].filter((token): token is string => token !== null);
  if (secrets.length > 0) redactor.add(secrets);
}

async function readAll(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (total > maxBytes) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Lock (4.0)
// ---------------------------------------------------------------------------

async function acquireLock(runner: HostRunner): Promise<boolean> {
  const content = `${runner.pid()}\n`;
  if (await runner.createExclusive(SETUP_LOCK_FILE, content, 0o600)) return true;
  const existing = (await runner.readFile(SETUP_LOCK_FILE))?.toString('utf8').trim() ?? '';
  const pid = Number.parseInt(existing, 10);
  if (Number.isInteger(pid) && (await runner.stat(`${PROC_DIR}/${pid}`)) !== null) return false;
  // left by an interrupted run: removed once, then the normal path retries
  await runner.remove(SETUP_LOCK_FILE);
  return runner.createExclusive(SETUP_LOCK_FILE, content, 0o600);
}

async function releaseLock(runner: HostRunner): Promise<void> {
  await runner.remove(SETUP_LOCK_FILE);
}

// ---------------------------------------------------------------------------
// inspect (4.1): read-only, writes only the lock (taken by the caller)
// ---------------------------------------------------------------------------

function parseKeyValueFile(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    values.set(line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, ''));
  }
  return values;
}

async function probeUnit(runner: HostRunner, unit: 'k3s' | 'k3s-agent'): Promise<{ loadState: string; activeState: string; subState: string }> {
  const result = await runner.run(['systemctl', 'show', unit, '-p', 'LoadState,ActiveState,SubState']);
  const values = parseKeyValueFile(result.stdout);
  return { loadState: values.get('LoadState') ?? 'not-found', activeState: values.get('ActiveState') ?? 'inactive', subState: values.get('SubState') ?? 'dead' };
}

async function sha256OfLocalFile(runner: HostRunner, path: string): Promise<string | null> {
  const bytes = await runner.readFile(path);
  return bytes === null ? null : sha256Hex(bytes);
}

/** design-05 4.1: every probe is a read (or, for `netcheck`/StorageClasses, a `getJson`). */
export async function inspect(runner: HostRunner, plan: K3sNodePlan): Promise<K3sNodeInspection> {
  const node = plan.node;
  const os = parseKeyValueFile((await runner.readFile('/etc/os-release'))?.toString('utf8') ?? '');
  const kernel = (await runner.run(['uname', '-r'])).stdout.trim();
  const arch = await nodeArch(runner, node.key);
  const systemd = (await runner.stat('/run/systemd/system'))?.type === 'directory';
  const enforce = await runner.run(['getenforce']);
  const selinux: K3sNodeInspection['os']['selinux'] =
    enforce.exitCode !== 0 ? 'absent' : (enforce.stdout.trim().toLowerCase() as 'enforcing' | 'permissive') || 'disabled';

  const cpus = Number.parseInt((await runner.run(['nproc'])).stdout.trim(), 10) || 1;
  const memInfo = (await runner.readFile('/proc/meminfo'))?.toString('utf8') ?? '';
  const memoryBytes = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(memInfo)?.[1] ?? 0) * 1024;
  const dfResult = await runner.run(['df', '-B1', '--output=avail', '/var/lib']);
  const varLibFreeBytes = Number.parseInt(dfResult.stdout.trim().split(/\r?\n/).at(-1) ?? '0', 10) || 0;

  const addrResult = await runner.run(['ip', '-o', '-4', 'addr', 'show']);
  const localIpv4 = [...addrResult.stdout.matchAll(/inet (\d{1,3}(?:\.\d{1,3}){3})\//g)].map((m) => m[1]);
  const routeResult = await runner.run(['ip', '-4', 'route', 'get', '1.1.1.1']);
  const defaultRouteIp = /\bsrc\s+(\S+)/.exec(routeResult.stdout)?.[1] ?? null;
  let resolvedHost: string | null = null;
  if (node.hostName !== null) {
    const resolved = await runner.run(['getent', 'ahostsv4', node.hostName]);
    resolvedHost = resolved.exitCode === 0 ? (resolved.stdout.trim().split(/\s+/)[0] ?? null) : null;
  }

  const missing: string[] = [];
  for (const command of REQUIRED_COMMANDS) if ((await runner.run(['which', command])).exitCode !== 0) missing.push(command);
  if (node.deployUser !== 'root' && (await runner.run(['which', 'visudo'])).exitCode !== 0) missing.push('visudo');
  let packageManager: string | null = null;
  for (const candidate of PACKAGE_MANAGERS) {
    if ((await runner.run(['which', candidate])).exitCode === 0) {
      packageManager = candidate;
      break;
    }
  }

  const binaryVersionResult = await runner.run([K3S_BINARY, '--version']);
  const binaryVersion = binaryVersionResult.exitCode === 0 ? (binaryVersionResult.stdout.split(/\r?\n/)[0]?.trim() ?? null) : null;
  const serverUnit = await probeUnit(runner, 'k3s');
  const agentUnit = await probeUnit(runner, 'k3s-agent');
  const unit: K3sNodeInspection['k3s']['unit'] = serverUnit.loadState !== 'not-found' ? 'k3s' : agentUnit.loadState !== 'not-found' ? 'k3s-agent' : null;
  const active = unit === 'k3s' ? serverUnit : unit === 'k3s-agent' ? agentUnit : null;

  const stateBytes = await runner.readFile(K3S_NODE_STATE_FILE);
  let state: NodeStateFile | null = null;
  if (stateBytes !== null) {
    try {
      state = parseNodeState(JSON.parse(stateBytes.toString('utf8')));
    } catch {
      state = null;
    }
  }
  const dropinBytes = await runner.readFile(K3S_CONFIG_DROPIN);
  const dropinText = dropinBytes?.toString('utf8') ?? null;
  const dropinSha256 = dropinBytes === null ? null : await sha256OfLocalFile(runner, K3S_CONFIG_DROPIN);
  const dropin = dropinText === null ? null : parseK3sConfig(dropinText);
  const restartSha256 = dropin === null ? null : restartSha256Of(dropin);

  const dir = await runner.readDir(K3S_CONFIG_DROPIN_DIR.slice(0, K3S_CONFIG_DROPIN_DIR.lastIndexOf('/')));
  const foreignConfig: K3sNodeInspection['k3s']['foreignConfig'] = [];
  if (dir !== null) {
    for (const name of dir) {
      if (name === 'config.yaml') {
        const content = (await runner.readFile(`${K3S_CONFIG_DROPIN_DIR.slice(0, K3S_CONFIG_DROPIN_DIR.lastIndexOf('/'))}/config.yaml`))?.toString('utf8');
        const parsed = content === undefined ? null : parseK3sConfig(content);
        if (parsed !== null) foreignConfig.push({ file: 'config.yaml', keys: Object.keys(parsed) });
      }
    }
  }
  const unitEnvBytes = unit === null ? null : await runner.readFile(`/etc/systemd/system/${unit}.env`);
  const unitEnvK3sVars = unitEnvBytes === null ? [] : [...unitEnvBytes.toString('utf8').matchAll(/^(K3S_\w+)=/gm)].map((m) => m[1]);

  const tokenFile = await runner.readFile(K3S_TOKEN_FILE);
  const agentTokenFile = await runner.readFile(K3S_AGENT_TOKEN_FILE);
  const tokenFingerprints = {
    token: tokenFile === null ? null : tokenFingerprint(tokenFile.toString('utf8')),
    agentToken: agentTokenFile === null ? null : tokenFingerprint(agentTokenFile.toString('utf8')),
  };

  const caSha256 = await sha256OfLocalFile(runner, K3S_SERVER_CA);
  const datastore: Datastore | null =
    (await runner.stat(K3S_ETCD_DIR))?.type === 'directory' ? 'etcd' : (await runner.stat(`${K3S_SQLITE_DB_DIR}/state.db`)) !== null ? 'sqlite' : null;

  const isServer = node.role !== 'agent';
  const kube = hostKubeExecutor(runner, node.key);
  let apiReady: boolean | null = null;
  let netcheckPresent: boolean | null = null;
  let defaultStorageClasses: K3sNodeInspection['k3s']['defaultStorageClasses'] = null;
  if (isServer && active?.activeState === 'active') {
    try {
      const readyz = await kube.run({ args: ['get', '--raw=/readyz'], mutating: false, requestTimeoutS: 5, allowFailure: true });
      apiReady = readyz.exitCode === 0 && readyz.stdout.trim() === 'ok';
    } catch {
      apiReady = false;
    }
    if (apiReady) {
      const daemonsets = await kube.getJson<{ metadata: { name: string } }>(['daemonsets'], { namespace: 'dockflow-system', name: NETCHECK_DAEMONSET, allowNotFound: true });
      netcheckPresent = daemonsets.length > 0;
      const classes = await kube.getJson<{ metadata: { name: string; creationTimestamp?: string; annotations?: Record<string, string> } }>(['storageclasses'], {});
      defaultStorageClasses = classes
        .filter((sc) => sc.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true')
        .map((sc) => ({ name: sc.metadata.name, createdAt: sc.metadata.creationTimestamp ?? '' }));
    }
  }

  const portsInUse: K3sNodeInspection['portsInUse'] = [];
  const ssResult = await runner.run(['ss', '-Hlntup']);
  for (const line of ssResult.stdout.split(/\r?\n/)) {
    const match = /^(tcp|udp)\s+\S+\s+\S+\s+\S+\s+[^:]*:(\d+)\s.*users:\(\("([^"]+)"/.exec(line);
    if (match) portsInUse.push({ proto: match[1] as 'tcp' | 'udp', port: Number(match[2]), process: match[3] });
  }

  const dockerInfo = await runner.run(['docker', 'info', '--format', '{{.Swarm.LocalNodeState}}']);
  const swarmActive = dockerInfo.exitCode === 0 && dockerInfo.stdout.trim() === 'active';
  const dockerPresent = (await runner.run(['which', 'docker'])).exitCode === 0;
  const nmCloud = await runner.run(['systemctl', 'is-enabled', 'nm-cloud-setup.service']);
  const nmCloudSetupEnabled = nmCloud.exitCode === 0 && nmCloud.stdout.trim() === 'enabled';
  await runner.run(['ip', 'link', 'add', 'dockflow-wgtest', 'type', 'wireguard']);
  const wireguardCheck = await runner.run(['ip', 'link', 'del', 'dockflow-wgtest']);
  const wireguardAvailable = wireguardCheck.exitCode === 0;
  const cgroupControllers = (await runner.readFile('/sys/fs/cgroup/cgroup.controllers'))?.toString('utf8') ?? '';
  const cgroupMemory = cgroupControllers.split(/\s+/).includes('memory');
  const ntp = await runner.run(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value']);
  const ntpSynchronized = ntp.exitCode === 0 ? ntp.stdout.trim() === 'yes' : null;

  const deployUserInfo = await runner.lookupUser(node.deployUser);
  let keyAuthorized = false;
  if (deployUserInfo !== null && node.deployPublicKey !== null) {
    const authorized = (await runner.readFile(`${deployUserInfo.home}/.ssh/authorized_keys`))?.toString('utf8') ?? '';
    keyAuthorized = authorized.split(/\r?\n/).some((line) => line.split(/\s+/).includes(keyBlobOf(node.deployPublicKey as string)));
  }
  const legacySudoRules = await findLegacySudoRules(runner);

  return {
    os: { id: (os.get('ID') ?? '').toLowerCase(), versionId: os.get('VERSION_ID') ?? '', kernel, arch, systemd, selinux },
    resources: { cpus, memoryBytes, varLibFreeBytes },
    network: { localIpv4, resolvedHost, defaultRouteIp },
    commands: { missing, packageManager },
    k3s: {
      binaryVersion,
      unit,
      activeState: active?.activeState ?? null,
      subState: active?.subState ?? null,
      managed: state !== null,
      state,
      dropinSha256,
      restartSha256,
      dropin,
      foreignConfig,
      unitEnvK3sVars,
      tokenFingerprints,
      caSha256,
      datastore,
      apiReady,
      netcheckPresent,
      defaultStorageClasses,
    },
    helmVersion: null,
    firewall: await probeFirewall(runner),
    portsInUse,
    swarmActive,
    dockerPresent,
    nmCloudSetupEnabled,
    wireguardAvailable,
    cgroupMemory,
    ntpSynchronized,
    deployUser: { exists: deployUserInfo !== null, uid: deployUserInfo?.uid ?? null, home: deployUserInfo?.home ?? null, keyAuthorized },
    legacySudoRules,
  };
}

// ---------------------------------------------------------------------------
// prepare (4.3)
// ---------------------------------------------------------------------------

async function detectPackageManager(runner: HostRunner): Promise<string | null> {
  for (const candidate of PACKAGE_MANAGERS) {
    if ((await runner.run(['which', candidate])).exitCode === 0) return candidate;
  }
  return null;
}

/**
 * The `packages` step (4.3): installs whichever of curl, tar, coreutils (sha256sum) and iproute2 (ip)
 * is missing, plus sudo (visudo) when the deploy user is not root. `finalizeClusterPlan` already
 * refused a node with missing commands and no package manager (4.1), so one is expected here.
 */
async function runPackagesStep(runner: HostRunner, deployUser: string): Promise<'ok' | 'skip'> {
  const missing: string[] = [];
  for (const command of REQUIRED_COMMANDS) {
    if (command === 'systemctl') continue; // systemd itself is not installable; its absence refuses earlier (4.1)
    if ((await runner.run(['which', command])).exitCode !== 0) missing.push(command);
  }
  if (deployUser !== 'root' && (await runner.run(['which', 'visudo'])).exitCode !== 0) missing.push('visudo');
  if (missing.length === 0) return 'skip';

  const manager = await detectPackageManager(runner);
  if (manager === null) return 'skip';
  const packages = [...new Set(missing.map((command) => PACKAGE_OF_COMMAND[command]?.[manager]).filter((name): name is string => name !== undefined))];
  if (packages.length === 0) return 'skip';
  await runChecked(runner, [...INSTALL_ARGS_OF[manager], ...packages], {
    message: (detail) => `Installing ${packages.join(', ')} on this node failed (${detail})`,
    suggestion: `Install ${packages.join(', ')} by hand, or re-run once its package manager is reachable.`,
  });
  return 'ok';
}

async function runPrepare(runner: HostRunner, plan: K3sNodePlan): Promise<{ steps: StepResult[]; warnings: string[] }> {
  const node = plan.node;
  const cluster = plan.cluster;
  if (cluster === undefined) throw new Error('prepare needs the cluster section');
  const steps: StepResult[] = [];
  const warnings: string[] = [];

  emitEvent('packages', 'start');
  finishStep(steps, { id: 'packages', status: await runPackagesStep(runner, node.deployUser) });

  // deploy-user before dockflow-dir (design-05 4.3 order): ensureDockflowDir chowns to the deploy
  // user, who must already exist on a fresh node with a non-root deploy user.
  emitEvent('deploy-user', 'start');
  if (node.deployUser !== 'root' && node.deployPublicKey !== null) {
    await ensureDeployUser(node.deployUser, node.deployPublicKey, { runner, passwordless: true });
  }
  finishStep(steps, { id: 'deploy-user', status: 'ok' });

  emitEvent('dockflow-dir', 'start');
  await ensureDockflowDir(node.deployUser, runner);
  if (node.role !== 'agent') {
    const user = await runner.lookupUser(node.deployUser);
    if (user !== null) await ensureHelmDirectories(runner, user);
  }
  finishStep(steps, { id: 'dockflow-dir', status: 'ok' });

  emitEvent('sudoers', 'start');
  await configureServiceAccess(node.deployUser, 'k3s', { runner, key: node.key, onWarning: (message) => warnings.push(message) });
  finishStep(steps, { id: 'sudoers', status: 'ok' });

  emitEvent('legacy-sudoers', 'start');
  const legacy = await findLegacySudoRules(runner);
  if (legacy.length > 0) {
    warnings.push(userMessages.legacySudoRules(node.key, legacy).message);
    finishStep(steps, { id: 'legacy-sudoers', status: 'warn', detail: legacy.join(', ') });
  } else {
    finishStep(steps, { id: 'legacy-sudoers', status: 'ok' });
  }

  emitEvent('firewall', 'start');
  if (plan.options.skipFirewall || cluster.firewallTool === null) {
    finishStep(steps, { id: 'firewall', status: 'skip' });
  } else {
    const status = await probeFirewall(runner);
    const rules = buildFirewallRules(
      { role: node.role },
      { flannelBackend: cluster.flannelBackend, datastore: cluster.datastore, proxyPorts: cluster.proxyPorts, network: cluster.network },
    );
    await reconcileFirewall(runner, {
      key: node.key,
      tool: cluster.firewallTool,
      rules,
      status,
      nodeIp: cluster.network.nodeIp,
      skipFirewall: plan.options.skipFirewall,
    });
    finishStep(steps, { id: 'firewall', status: 'ok' });
  }

  emitEvent('download-k3s', 'start');
  await downloadToCache(runner, k3sBinaryComponent(plan.pins.k3s.version, plan.pins.k3s.binary), node.key);
  finishStep(steps, { id: 'download-k3s', status: 'ok' });
  emitEvent('download-install-script', 'start');
  await downloadToCache(runner, installScriptComponent(plan.pins.k3s.version, plan.pins.k3s.installScript), node.key);
  finishStep(steps, { id: 'download-install-script', status: 'ok' });
  if (node.role !== 'agent' && plan.pins.helm !== null) {
    emitEvent('download-helm', 'start');
    await downloadToCache(runner, helmComponent(plan.pins.helm), node.key);
    finishStep(steps, { id: 'download-helm', status: 'ok' });
    emitEvent('download-traefik-chart', 'start');
    const chart = await cacheTraefikChart(runner, { key: node.key, deployUser: node.deployUser });
    if (chart.warning !== null) warnings.push(chart.warning.message);
    finishStep(steps, { id: 'download-traefik-chart', status: chart.warning !== null ? 'warn' : 'ok' });
  }

  return { steps, warnings };
}

// ---------------------------------------------------------------------------
// install (4.4)
// ---------------------------------------------------------------------------

async function computeCaSha256(runner: HostRunner, role: K3sNodeRole): Promise<string | null> {
  if (role === 'agent') {
    const token = (await runner.readFile(K3S_TOKEN_FILE))?.toString('utf8');
    return token === undefined ? null : tokenFingerprint(token);
  }
  return sha256OfLocalFile(runner, K3S_SERVER_CA);
}

async function writeNodeState(runner: HostRunner, plan: K3sNodePlan, dropinSha256: string, restartSha256: string, caSha256: string | null, nowIso: string): Promise<void> {
  const node = plan.node;
  const cluster = plan.cluster;
  if (cluster === undefined) return;
  const existing = await runner.readFile(K3S_NODE_STATE_FILE);
  let envs = [plan.env].filter((e) => e !== '');
  let installedAt = nowIso;
  if (existing !== null) {
    try {
      const previous = JSON.parse(existing.toString('utf8')) as Partial<NodeStateFile>;
      const previousEnvs = (previous.envs ?? []).filter((e) => e !== plan.env);
      envs = [...previousEnvs, ...(plan.env === '' ? [] : [plan.env])];
      if (typeof previous.installedAt === 'string') installedAt = previous.installedAt;
    } catch {
      /* treated as a fresh install */
    }
  }
  const state: NodeStateFile = {
    schema: NODE_STATE_SCHEMA,
    managedBy: NODE_STATE_MANAGED_BY,
    dockflowVersion: plan.dockflowVersion,
    envs,
    nodeName: node.nodeName,
    role: node.role === 'agent' ? 'agent' : 'server',
    clusterInit: cluster.clusterInit,
    datastore: cluster.datastore,
    flannelBackend: cluster.flannelBackend,
    k3sVersion: cluster.action.toVersion,
    configSha256: dropinSha256,
    restartSha256,
    caSha256,
    installedAt,
    updatedAt: nowIso,
  };
  await runner.mkdir(K3S_DOCKFLOW_DIR, { mode: K3S_DOCKFLOW_DIR_MODE, uid: 0, gid: 0 });
  await writeFileAtomic(runner, K3S_NODE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, uid: 0, gid: 0 });
}

async function runInstall(runner: HostRunner, plan: K3sNodePlan, clock: Clock, redactor: Redactor): Promise<{ steps: StepResult[]; tokens: { server: string; agent: string } | null }> {
  const node = plan.node;
  const cluster = plan.cluster;
  if (cluster === undefined) throw new Error('install needs the cluster section');
  const steps: StepResult[] = [];
  const kind = cluster.action.kind;
  const freshInstall = kind === 'install' || kind === 'repair';

  emitEvent('verify-cache', 'start');
  if (freshInstall) {
    await downloadToCache(runner, k3sBinaryComponent(plan.pins.k3s.version, plan.pins.k3s.binary), node.key);
  }
  finishStep(steps, { id: 'verify-cache', status: freshInstall ? 'ok' : 'skip' });

  emitEvent('tokens', 'start');
  let generatedAgentToken: string | null = null;
  if (node.role === 'server-init' && plan.tokens.agent === null && freshInstall) {
    generatedAgentToken = generateAgentToken();
    redactor.add([generatedAgentToken]);
  }
  const tokenFiles = tokenFilesFor(node.role, plan.tokens, generatedAgentToken);
  if (tokenFiles.length > 0) {
    await runner.mkdir(TOKEN_DIRECTORY.path, { mode: TOKEN_DIRECTORY.mode, uid: 0, gid: 0 });
    for (const file of tokenFiles) await writeFileAtomic(runner, file.path, file.content, { mode: file.mode, uid: 0, gid: 0 });
  }
  finishStep(steps, { id: 'tokens', status: tokenFiles.length > 0 ? 'ok' : 'skip' });

  emitEvent('config', 'start');
  const render = renderK3sConfig(node, {
    env: plan.env,
    addressMode: cluster.addressMode,
    flannelBackend: cluster.flannelBackend,
    clusterInit: cluster.clusterInit,
    network: cluster.network,
    joinUrl: cluster.joinUrl,
  });
  if (kind !== 'start') {
    await runner.mkdir(K3S_CONFIG_DROPIN_DIR, { mode: 0o755, uid: 0, gid: 0 });
    if (!(await fileMatches(runner, K3S_CONFIG_DROPIN, render.content, { mode: K3S_CONFIG_DROPIN_MODE, uid: 0, gid: 0 }))) {
      await writeFileAtomic(runner, K3S_CONFIG_DROPIN, render.content, { mode: K3S_CONFIG_DROPIN_MODE, uid: 0, gid: 0 });
    }
    finishStep(steps, { id: 'config', status: 'ok' });
  } else {
    finishStep(steps, { id: 'config', status: 'skip' });
  }

  if (freshInstall) {
    emitEvent('binary', 'start');
    await installK3sBinary(runner, k3sBinaryComponent(plan.pins.k3s.version, plan.pins.k3s.binary), node.key);
    finishStep(steps, { id: 'binary', status: 'ok' });
  }

  if (freshInstall) emitEvent('join-probe', 'start');
  if (freshInstall && node.role !== 'server-init' && cluster.joinUrl !== null) {
    const probe = await runner.run(['curl', '-sk', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', `${cluster.joinUrl}/cacerts`]);
    if (probe.stdout.trim() !== '200') {
      throw new SetupStepError(
        `${node.key} cannot reach ${cluster.joinUrl}/cacerts (${firstLineOf(probe.stderr) || 'no response'})`,
        `Allow TCP 6443 from ${node.key} on the server it joins (host firewall or provider security group).`,
      );
    }
  }
  if (freshInstall) finishStep(steps, { id: 'join-probe', status: node.role === 'server-init' ? 'skip' : 'ok' });

  if (freshInstall) {
    emitEvent('install-script', 'start');
    await runInstallScript(runner, installScriptComponent(plan.pins.k3s.version, plan.pins.k3s.installScript), node.role, node.key, { redactor });
    finishStep(steps, { id: 'install-script', status: 'ok' });
  }

  emitEvent('restart', 'start');
  const unit = k3sUnitFor(node.role);
  if (kind !== 'noop') {
    const verb = kind === 'start' ? 'start' : 'restart';
    await runner.run(['systemctl', verb, '--no-block', unit]);
  }
  finishStep(steps, { id: 'restart', status: kind === 'noop' ? 'skip' : 'ok' });

  emitEvent('wait-service', 'start');
  if (kind !== 'noop') {
    await waitForService(runner, clock, { key: node.key, role: node.role, joinUrl: cluster.joinUrl, redactor });
  }
  finishStep(steps, { id: 'wait-service', status: kind === 'noop' ? 'skip' : 'ok' });

  emitEvent('state', 'start');
  const caSha256 = await computeCaSha256(runner, node.role);
  await writeNodeState(runner, plan, render.sha256, render.restartSha256, caSha256, clock.now().toISOString());
  finishStep(steps, { id: 'state', status: 'ok' });

  let tokens: { server: string; agent: string } | null = null;
  if (node.role === 'server-init' && generatedAgentToken !== null) {
    const serverToken = (await runner.readFile(K3S_SERVER_TOKEN))?.toString('utf8').trim() ?? '';
    tokens = { server: serverToken, agent: generatedAgentToken };
  }
  return { steps, tokens };
}

// ---------------------------------------------------------------------------
// control-plane (4.5)
// ---------------------------------------------------------------------------

async function runControlPlane(runner: HostRunner, plan: K3sNodePlan, clock: Clock, redactor: Redactor): Promise<{ steps: StepResult[]; report: ControlPlaneReport }> {
  const node = plan.node;
  const kube = hostKubeExecutor(runner, node.key, { redactor });
  const steps: StepResult[] = [];

  emitEvent('helm', 'start');
  let helmVersion = '';
  if (plan.pins.helm !== null) {
    const arch = await nodeArch(runner, node.key);
    const helm = await installHelm(runner, plan.pins.helm, arch, node.key);
    helmVersion = helm.version;
  }
  finishStep(steps, { id: 'helm', status: 'ok' });

  emitEvent('system-objects', 'start');
  await applySystemObjects(kube, { env: plan.env });
  let token: string;
  if (plan.options.rotateDeployToken && node.role === 'server-init') {
    token = await rotateDeployToken(kube, clock, { env: plan.env });
  } else {
    await applyIdentityObjects(kube);
    token = await waitForDeployerToken(kube, clock, { env: plan.env });
  }
  redactor.add([token]);
  finishStep(steps, { id: 'system-objects', status: 'ok' });

  emitEvent('storage-default', 'start');
  const storageDefault = await assertSingleDefaultStorageClass(kube, { env: plan.env });
  finishStep(steps, { id: 'storage-default', status: 'ok' });
  // the token itself was already awaited as part of system-objects; this step only records that it happened
  emitEvent('deployer-token', 'start');
  finishStep(steps, { id: 'deployer-token', status: 'ok' });

  emitEvent('kubeconfig', 'start');
  const caPem = (await runner.readFile(K3S_SERVER_CA))?.toString('utf8') ?? '';
  const user = await runner.lookupUser(node.deployUser);
  const kubeconfig = user === null ? 'unchanged' : await writeKubeconfig(runner, user, caPem, token);
  finishStep(steps, { id: 'kubeconfig', status: 'ok' });

  emitEvent('encryption-status', 'start');
  const encryptionRaw = await runner.run([K3S_BINARY, 'secrets-encrypt', 'status', '-o', 'json']);
  const { status: encryption, problem: encryptionProblem } = evaluateEncryptionStatus(encryptionRaw.stdout, node.key);
  if (encryptionProblem !== null) throw new SetupStepError(encryptionProblem.message, encryptionProblem.suggestion);
  finishStep(steps, { id: 'encryption-status', status: 'ok' });

  emitEvent('traefik-absent', 'start');
  const traefikCharts = await kube.getJson<{ metadata: { name: string } }>(['helmcharts.helm.cattle.io'], { namespace: 'kube-system', allowNotFound: true });
  const traefikDeployments = await kube.getJson<{ metadata: { name: string } }>(['deployments.apps'], { namespace: 'kube-system', name: 'traefik', allowNotFound: true });
  const traefikBundled = traefikCharts.some((c) => c.metadata.name === 'traefik' || c.metadata.name === 'traefik-crd') || traefikDeployments.length > 0;
  if (traefikBundled) {
    throw new SetupStepError(
      `The bundled Traefik is present on ${plan.env}`,
      'Dockflow installs its own Traefik (proxy.enabled); reset the cluster or remove the kube-system HelmCharts traefik and traefik-crd.',
    );
  }
  finishStep(steps, { id: 'traefik-absent', status: 'ok' });

  return { steps, report: { helmVersion, kubeconfig, encryption, traefikBundled: false, storageDefault } };
}

// ---------------------------------------------------------------------------
// read-tokens (4.6)
// ---------------------------------------------------------------------------

async function runReadTokens(runner: HostRunner, plan: K3sNodePlan): Promise<{ server: string; agent: string }> {
  const server = (await runner.readFile(K3S_SERVER_TOKEN))?.toString('utf8').trim() ?? '';
  const agentIsSymlink = (await runner.readLink(K3S_SERVER_AGENT_TOKEN)) !== null;
  const agent = (await runner.readFile(K3S_SERVER_AGENT_TOKEN))?.toString('utf8').trim() ?? '';
  const checked = checkClusterTokens(plan.env, { server, agent, agentIsSymlink });
  if (!checked.success) throw new SetupStepError(checked.error.message, checked.error.suggestion);
  return checked.data;
}

// ---------------------------------------------------------------------------
// finalize (4.7)
// ---------------------------------------------------------------------------

async function runFinalize(runner: HostRunner, plan: K3sNodePlan, clock: Clock): Promise<{ steps: StepResult[]; verification: ClusterVerification }> {
  const node = plan.node;
  const kube = hostKubeExecutor(runner, node.key);
  const steps: StepResult[] = [];

  emitEvent('stale-helper-cleanup', 'start');
  const removed = await removeNetcheckDaemonSet(kube);
  finishStep(steps, { id: 'stale-helper-cleanup', status: removed === 'removed' ? 'ok' : 'skip' });

  emitEvent('node-labels', 'start');
  const cluster = plan.cluster;
  if (cluster !== undefined) {
    for (const planNode of cluster.nodes) await reconcileNodeLabels(kube, planNode.nodeName, planNode.nodeLabels);
  }
  finishStep(steps, { id: 'node-labels', status: 'ok' });

  emitEvent('network-check', 'start');
  const nodeCount = cluster?.nodes.length ?? 1;
  let networkCheck: NetworkCheckResult = { ran: false, ok: true, failures: [] };
  if (nodeCount > 1 && !plan.options.skipNetworkCheck) {
    await applyNetcheckDaemonSet(kube);
    networkCheck = await runNetworkCheck(kube, clock, { nodeCount, flannelBackend: cluster?.flannelBackend ?? 'vxlan' });
  }
  finishStep(steps, { id: 'network-check', status: !networkCheck.ran ? 'skip' : networkCheck.ok ? 'ok' : 'failed' });

  const expected: ExpectedNode[] = (cluster?.nodes ?? [{ key: node.key, nodeName: node.nodeName, role: node.role, nodeIp: null, nodeLabels: {} }]).map((planNode) => ({
    key: planNode.key,
    name: planNode.nodeName,
    kubeletVersion: cluster?.action.toVersion ?? plan.pins.k3s.version,
    controlPlane: planNode.role !== 'agent',
    etcdMember: cluster?.datastore === 'etcd' && planNode.role !== 'agent',
  }));
  emitEvent('cluster-verification', 'start');
  const verification = await buildClusterVerification(kube, {
    env: plan.env,
    expected,
    etcdExpected: cluster?.datastore === 'etcd' ? expected.filter((n) => n.etcdMember).length : 0,
    encryption: [],
    networkCheck,
    clock,
  });
  finishStep(steps, { id: 'cluster-verification', status: verification.problems.some((p) => p.severity === 'error') ? 'failed' : 'ok' });

  return { steps, verification };
}

// ---------------------------------------------------------------------------
// Dispatch (3.4)
// ---------------------------------------------------------------------------

async function runOperation(runner: HostRunner, clock: Clock, redactor: Redactor, plan: K3sNodePlan): Promise<NodeStepResult> {
  const result = baseResult(plan);
  try {
    switch (plan.operation) {
      case 'inspect':
        result.inspection = await inspect(runner, plan);
        break;
      case 'prepare': {
        const { steps, warnings } = await runPrepare(runner, plan);
        result.steps = steps;
        result.warnings = warnings;
        break;
      }
      case 'install': {
        const { steps, tokens } = await runInstall(runner, plan, clock, redactor);
        result.steps = steps;
        result.tokens = tokens;
        break;
      }
      case 'control-plane': {
        const { steps, report } = await runControlPlane(runner, plan, clock, redactor);
        result.steps = steps;
        result.controlPlane = report;
        break;
      }
      case 'read-tokens':
        result.tokens = await runReadTokens(runner, plan);
        break;
      case 'finalize': {
        const { steps, verification } = await runFinalize(runner, plan, clock);
        result.steps = steps;
        result.verification = verification;
        if (verification.problems.some((p) => p.severity === 'error')) {
          throw new SetupStepError(`Cluster verification of ${plan.env} failed`, 'See the verification problems for the failing checks.');
        }
        break;
      }
      case 'reset':
        result.reset = await runNodeReset(runner, { key: plan.node.key, role: plan.node.role, deleteVolumes: plan.options.deleteVolumes, clock });
        break;
      default:
        throw new Error(`Unknown operation ${String(plan.operation)}`);
    }
    return result;
  } catch (error) {
    const described = describeError(error, redactor);
    result.status = 'failed';
    result.error = { step: plan.operation, message: described.message, suggestion: described.suggestion, logTail: described.logTail };
    return result;
  }
}

// ---------------------------------------------------------------------------
// Entry (3.4)
// ---------------------------------------------------------------------------

export interface NodeStepDeps {
  runner?: HostRunner;
  clock?: Clock;
}

/**
 * The node step: reads at most 1 MiB of plan JSON from `stdin`, refuses non-root and invalid input
 * with exit 2 and no result line, otherwise runs the requested operation under the node lock and
 * prints exactly one `{"dockflowNodeResult": ...}` line before exiting 0 (ok) or 1 (failed/refused).
 */
export async function runK3sNodeStep(stdin: NodeJS.ReadableStream, deps: NodeStepDeps = {}): Promise<void> {
  const runner = deps.runner ?? localHostRunner;
  const clock = deps.clock ?? systemClock;

  if (runner.effectiveUid() !== 0) {
    printError('dockflow setup --k3s-plan must run as root');
    process.exitCode = 2;
    return;
  }

  const text = await readAll(stdin, NODE_PLAN_MAX_READ_BYTES);
  const parsed = parseNodePlan(text);
  if (!parsed.success) {
    printError(`Invalid k3s node plan (${parsed.error})`);
    process.exitCode = 2;
    return;
  }
  const plan = parsed.data;
  const redactor = new Redactor();
  addPlanSecrets(redactor, plan);

  if (plan.dockflowVersion !== DOCKFLOW_VERSION) {
    const problem = nodeMessages.versionMismatch(plan.node.key, plan.dockflowVersion);
    emit({ ...baseResult(plan), status: 'refused', error: { step: plan.operation, message: problem.message, suggestion: problem.suggestion, logTail: [] } });
    process.exitCode = 1;
    return;
  }

  let locked = false;
  try {
    locked = await acquireLock(runner);
    if (!locked) {
      const pidText = (await runner.readFile(SETUP_LOCK_FILE))?.toString('utf8').trim() ?? '0';
      const problem = nodeMessages.lockHeld(plan.node.key, Number.parseInt(pidText, 10) || 0);
      emit({ ...baseResult(plan), status: 'refused', error: { step: plan.operation, message: problem.message, suggestion: problem.suggestion, logTail: [] } });
      process.exitCode = 1;
      return;
    }

    const result = await runOperation(runner, clock, redactor, plan);
    emit(result);
    process.exitCode = result.status === 'ok' ? 0 : 1;
  } finally {
    if (locked) await releaseLock(runner);
  }
}
