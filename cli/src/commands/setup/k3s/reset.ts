// Node-side reset and uninstall (design-05 18.3, K58): removing the firewall rules Dockflow added,
// stopping k3s, preserving volume data and datastore backups (unless `--delete-volumes`), running
// k3s's own uninstall script, then removing the Dockflow files a fresh `install` would recreate. The
// coordinator's scope rules (whole environment vs `--node`, drain-before-reset, confirmation) are
// design-05 18.1/18.2, outside this file (P60).

import { HELM_BIN_PATH, HELM_HOME_DIR, K8S_KUBECONFIG_DIR } from '../../../services/orchestrator/kubernetes/constants';
import type { Clock } from '../../../services/orchestrator/kubernetes/deps';
import {
  DOWNLOAD_CACHE_DIR,
  K3S_BINARY,
  K3S_DATA_DIR,
  K3S_NODE_STATE_FILE,
  K3S_SERVER_TOKEN,
  K3S_STORAGE_DIR,
  PRESERVED_DIR,
  SUDOERS_K3S_FILE,
} from './constants';
import { readFirewallState, removeDockflowRules } from './firewall';
import { firstLineOf, type HostRunner, runChecked, SetupStepError } from './host-runner';
import { type SetupProblem } from './messages';
import type { K3sNodeRole } from './plan';

const K3S_KILLALL_SCRIPT = '/usr/local/bin/k3s-killall.sh';
const K3S_UNINSTALL_SCRIPT = '/usr/local/bin/k3s-uninstall.sh';
const K3S_AGENT_UNINSTALL_SCRIPT = '/usr/local/bin/k3s-agent-uninstall.sh';
const PRESERVE_FILE_MODE = 0o600;
const PRESERVE_DIR_MODE = 0o700;
const SCRIPT_TIMEOUT_MS = 300_000;

export const resetMessages = {
  notManagedByDockflow: (key: string): SetupProblem => ({
    message: `k3s on ${key} was not installed by Dockflow; Dockflow does not uninstall it`,
    suggestion: `Uninstall it by hand (${K3S_UNINSTALL_SCRIPT} or ${K3S_AGENT_UNINSTALL_SCRIPT}) on ${key} if that is what you want.`,
  }),
  scriptFailed: (script: string, key: string, detail: string): SetupProblem => ({
    message: `${script} failed on ${key} (${detail})`,
    suggestion: `Run it by hand on ${key} and check the output.`,
  }),
} as const;

// ---------------------------------------------------------------------------
// Types (18.3.1)
// ---------------------------------------------------------------------------

export interface PreservedData {
  /** /var/lib/dockflow-preserved/<ts>, null with --delete-volumes */
  path: string | null;
  /** 'storage', 'etcd-snapshots', 'db-dockflow-pre-<v>', 'token', 'encryption-config.json' */
  items: string[];
  /** du -sb of the directory */
  bytes: number;
}

export interface ResetReport {
  preserved: PreservedData;
  removed: string[];
  firewallRulesRemoved: number;
}

// ---------------------------------------------------------------------------
// preserve-data (18.3.1, K58)
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

async function directorySize(runner: HostRunner, path: string): Promise<number> {
  const info = await runner.stat(path);
  if (info === null) return 0;
  if (info.type !== 'directory') return info.size;
  const children = (await runner.readDir(path)) ?? [];
  let total = 0;
  for (const child of children) total += await directorySize(runner, `${path}/${child}`);
  return total;
}

/** No secrets: the token and the encryption config it preserves are files, never their content. */
export function renderPreservedReadme(): string {
  return [
    'This directory holds what Dockflow moved aside before running the k3s uninstall script.',
    '',
    'storage/                    volume data of the local-path StorageClass',
    'etcd-snapshots/             etcd snapshots Dockflow scheduled before upgrades',
    'db-dockflow-pre-*/          whole SQLite `db` directories, copied before an upgrade',
    'token                       the cluster token of the uninstalled cluster (0600 root)',
    'encryption-config.json      the secrets-encryption key of the uninstalled cluster',
    '',
    'The token belongs to the cluster that was just removed; it is required by',
    '`k3s server --cluster-reset --cluster-reset-restore-path=<this dir>/etcd-snapshots/<file>`',
    'to restore a snapshot. `encryption-config.json` is required to read Secrets out of a',
    'snapshot restored on another cluster. Nothing here is printed by Dockflow.',
    '',
  ].join('\n');
}

/**
 * Moves volume data, etcd snapshots and pre-upgrade SQLite copies aside, and copies the cluster
 * token and the encryption config (root 0600), into one timestamped directory (18.3.1). Every entry
 * present is listed in `items`, in the order this function considers them.
 */
export async function preserveData(runner: HostRunner, clock: Clock): Promise<PreservedData> {
  const root = `${PRESERVED_DIR}/${formatTimestamp(clock.now())}`;
  await runner.mkdir(root, { mode: PRESERVE_DIR_MODE, uid: 0, gid: 0 });
  const items: string[] = [];

  const moveIfNonEmpty = async (source: string, name: string): Promise<void> => {
    const info = await runner.stat(source);
    if (info === null) return;
    if (info.type === 'directory') {
      const children = await runner.readDir(source);
      if (children === null || children.length === 0) return;
    }
    await runner.rename(source, `${root}/${name}`);
    items.push(name);
  };
  const copyIfPresent = async (source: string, name: string): Promise<void> => {
    const bytes = await runner.readFile(source);
    if (bytes === null) return;
    await runner.writeFile(`${root}/${name}`, bytes, { mode: PRESERVE_FILE_MODE, uid: 0, gid: 0 });
    items.push(name);
  };

  await moveIfNonEmpty(K3S_STORAGE_DIR, 'storage');
  await moveIfNonEmpty(`${K3S_DATA_DIR}/server/db/snapshots`, 'etcd-snapshots');
  const serverDir = `${K3S_DATA_DIR}/server`;
  const preUpgradeDirs = ((await runner.readDir(serverDir)) ?? []).filter((name) => name.startsWith('db-dockflow-pre-')).sort();
  for (const name of preUpgradeDirs) await moveIfNonEmpty(`${serverDir}/${name}`, name);
  await copyIfPresent(K3S_SERVER_TOKEN, 'token');
  await copyIfPresent(`${serverDir}/cred/encryption-config.json`, 'encryption-config.json');

  await runner.writeFile(`${root}/README.txt`, renderPreservedReadme(), { mode: PRESERVE_FILE_MODE, uid: 0, gid: 0 });
  return { path: root, items, bytes: await directorySize(runner, root) };
}

// ---------------------------------------------------------------------------
// killall, uninstall, dockflow-files (18.3)
// ---------------------------------------------------------------------------

export async function runKillAll(runner: HostRunner, key: string): Promise<void> {
  const result = await runner.run([K3S_KILLALL_SCRIPT], { timeoutMs: SCRIPT_TIMEOUT_MS });
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = result.timedOut ? 'timed out' : firstLineOf(result.stderr) || firstLineOf(result.stdout) || `exit ${result.exitCode}`;
    throw stepError(resetMessages.scriptFailed(K3S_KILLALL_SCRIPT, key, detail));
  }
}

function stepError(problem: SetupProblem): SetupStepError {
  return new SetupStepError(problem.message, problem.suggestion);
}

/** `k3s-uninstall.sh` (servers) or `k3s-agent-uninstall.sh` (agents); it deletes `/etc/rancher/k3s`
 *  and the whole data directory itself (F6), so nothing here removes those paths a second time. */
export async function runUninstallScript(runner: HostRunner, role: K3sNodeRole, key: string): Promise<void> {
  const script = role === 'agent' ? K3S_AGENT_UNINSTALL_SCRIPT : K3S_UNINSTALL_SCRIPT;
  await runChecked(runner, [script], {
    message: (detail) => resetMessages.scriptFailed(script, key, detail).message,
    suggestion: resetMessages.scriptFailed(script, key, '').suggestion,
  });
}

/** Dockflow's own files that a fresh `install` recreates; the deploy user and its dir are kept. */
export async function removeDockflowFiles(runner: HostRunner): Promise<string[]> {
  const targets = [SUDOERS_K3S_FILE, K8S_KUBECONFIG_DIR, HELM_HOME_DIR, HELM_BIN_PATH, DOWNLOAD_CACHE_DIR];
  const removed: string[] = [];
  for (const path of targets) {
    if ((await runner.stat(path)) === null) continue;
    await runner.remove(path, { recursive: true });
    removed.push(path);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The `reset` operation
// ---------------------------------------------------------------------------

export interface NodeResetInput {
  key: string;
  role: K3sNodeRole;
  deleteVolumes: boolean;
  clock: Clock;
}

/**
 * Runs every node-side step of a reset, in the table order of 18.3: firewall rules removed first (a
 * node that never reaches `uninstall` is not left with stale rules), then `k3s-killall.sh`, data
 * preserved (unless `--delete-volumes`), the k3s uninstall script, and the Dockflow files a fresh
 * install would recreate.
 */
export async function runNodeReset(runner: HostRunner, input: NodeResetInput): Promise<ResetReport> {
  const state = await runner.readFile(K3S_NODE_STATE_FILE);
  if (state === null && (await runner.stat(K3S_BINARY)) !== null) {
    throw stepError(resetMessages.notManagedByDockflow(input.key));
  }

  let firewallRulesRemoved = 0;
  const firewallState = await readFirewallState(runner);
  if (firewallState !== null) firewallRulesRemoved = await removeDockflowRules(runner, firewallState, { key: input.key });

  await runKillAll(runner, input.key);

  const preserved: PreservedData = input.deleteVolumes ? { path: null, items: [], bytes: 0 } : await preserveData(runner, input.clock);

  await runUninstallScript(runner, input.role, input.key);
  const removed = await removeDockflowFiles(runner);

  return { preserved, removed, firewallRulesRemoved };
}
