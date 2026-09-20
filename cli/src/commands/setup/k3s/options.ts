// The Commander registration of the cluster-mode flag table (design-05 1.2, 19.1, F38): one helper
// applied to `setup` (which parses every cluster flag, wherever it is written on the command line)
// and to `setup k3s <env>` (whose own copies exist only so Commander accepts them there too and
// shows them in `--help`; the parsed value is always read back through `optsWithGlobals()`). Also
// the bootstrap-identity resolution and the `SetupOptions` -> `K3sSetupOptions`/`K3sResetOptions`
// conversions, since neither Commander option carries a default (defaults live here, F38).

import type { Command } from 'commander';
import { Option } from 'commander';
import * as fs from 'fs';
import type { K3sResetOptions } from './index';
import type { BootstrapIdentity } from './transport';
import type { K3sSetupOptions } from './plan';
import { ConfigError, ValidationError } from '../../../utils/errors';
import { promptPassword } from '../prompts';
import type { SetupOptions } from '../types';

/** Everything the cluster-mode action reads, parsed on `setup` (or merged through `optsWithGlobals`). */
export type K3sSetupCliOptions = SetupOptions;

/** stdin and stdout are a terminal (K3sSetupOptions.interactive / K3sResetOptions.interactive). */
export function isInteractiveSession(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** fresh Option objects per call: one command never shares an Option instance with another */
function k3sClusterOptions(): Option[] {
  return [
    new Option('--ssh-user <user>', 'Bootstrap SSH user, root or passwordless sudo (default: root)'),
    new Option('-k, --key <path>', 'Bootstrap SSH private key'),
    new Option(
      '--password <password>',
      "Bootstrap SSH password or key passphrase (prefer the prompt: argv is visible in your process list and shell history)",
    ),
    new Option('--dry-run', 'Inspect nodes and print the plan without changing anything'),
    new Option('-y, --yes', 'Do not ask before restarts and upgrades'),
    new Option('--upgrade', 'Consent to upgrading k3s to the pinned version'),
    new Option('--flannel-backend <backend>', 'vxlan or wireguard-native (new clusters only)'),
    new Option('--skip-firewall', 'Do not change ufw/firewalld; print the required flows'),
    new Option('--skip-network-check', 'Skip the cross-node pod network check'),
    new Option('--skip-reachability-check', 'Skip the post-setup check for ports answering from outside the cluster'),
    new Option('--insecure-host-key', 'Do not verify or record SSH host keys (prints a warning per node)'),
    new Option('--require-host-key', 'Refuse to connect to a node with no recorded SSH host key'),
    new Option('--convert-datastore', 'Consent to the one-way SQLite to embedded etcd conversion'),
    new Option('--shared-cluster', 'Allow nodes that already serve another Dockflow environment (shared cluster-admin)'),
    new Option('--rotate-deploy-token', 'Revoke and recreate the deploy identity token'),
    new Option('--reset', 'Uninstall k3s from the environment (see --node, --delete-volumes)'),
    new Option('--node <key>', 'With --reset: only this server (repeatable)').argParser(collect),
    new Option('--delete-volumes', 'With --reset: delete volume data, datastore backups and the cluster token'),
    new Option('--confirm <env>', 'With --reset in non-interactive sessions: the environment name'),
    new Option('--dev', 'Upload the locally built CLI instead of the release binary'),
    new Option('--binary <path>', 'Use this local Linux Dockflow binary on the nodes').hideHelp(),
  ];
}

/**
 * Registers every flag of the table above on `cmd`, skipping one it already defines (Commander
 * throws on a conflicting flag redefinition, and `setup` already has `-k`/`--password`/`-y`/`--dev`
 * for local/remote mode). No Commander default is ever attached here: `toSetupOptions`/
 * `toResetOptions` apply the defaults, so merging values from two Command instances stays unambiguous.
 */
export function addK3sClusterOptions(cmd: Command): Command {
  for (const option of k3sClusterOptions()) {
    if (!cmd.options.some((o) => o.long === option.long)) cmd.addOption(option);
  }
  return cmd;
}

// ---------------------------------------------------------------------------
// Validation that does not need a project (design-05 19.1's "validation" row)
// ---------------------------------------------------------------------------

const CLUSTER_ONLY_FLAGS: ReadonlyArray<{ key: keyof SetupOptions; flag: string }> = [
  { key: 'sshUser', flag: '--ssh-user' },
  { key: 'dryRun', flag: '--dry-run' },
  { key: 'upgrade', flag: '--upgrade' },
  { key: 'skipFirewall', flag: '--skip-firewall' },
  { key: 'skipNetworkCheck', flag: '--skip-network-check' },
  { key: 'skipReachabilityCheck', flag: '--skip-reachability-check' },
  { key: 'insecureHostKey', flag: '--insecure-host-key' },
  { key: 'requireHostKey', flag: '--require-host-key' },
  { key: 'convertDatastore', flag: '--convert-datastore' },
  { key: 'sharedCluster', flag: '--shared-cluster' },
  { key: 'rotateDeployToken', flag: '--rotate-deploy-token' },
  { key: 'reset', flag: '--reset' },
  { key: 'node', flag: '--node' },
  { key: 'deleteVolumes', flag: '--delete-volumes' },
  { key: 'confirm', flag: '--confirm' },
  { key: 'binary', flag: '--binary' },
];

/**
 * A cluster-only flag needs `--env <env>` (or `dockflow setup k3s <env>`, which sets it for this
 * check too): without it there is no environment whose servers.yml the flag would apply to.
 * `--flannel-backend` is not in this list (design-05 1.2): it is also a local single-host option.
 */
export function assertClusterFlagsNeedEnv(options: K3sSetupCliOptions): void {
  if (options.env) return;
  for (const { key, flag } of CLUSTER_ONLY_FLAGS) {
    const value = options[key];
    const isSet = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
    if (isSet) throw new ValidationError(`${flag} needs --env <env> (or dockflow setup k3s <env>)`);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap identity (design-05 1.2, 2.1, 3.5)
// ---------------------------------------------------------------------------

/**
 * Resolves the identity every bootstrap connection of this run uses (never the deploy key): the key
 * file named by `-k/--key`, the password of `--password`, or — only in a terminal, since a
 * non-interactive session has nothing to prompt — an interactive password prompt when neither is set.
 */
export async function resolveBootstrapIdentity(options: K3sSetupCliOptions): Promise<BootstrapIdentity> {
  const sshUser = options.sshUser || 'root';
  let privateKey: string | undefined;
  if (options.key) {
    if (!fs.existsSync(options.key)) throw new ConfigError(`Bootstrap SSH key file not found: ${options.key}`);
    privateKey = fs.readFileSync(options.key, 'utf-8');
  }
  let password = options.password;
  if (privateKey === undefined && password === undefined) {
    if (isInteractiveSession()) {
      password = await promptPassword(`Bootstrap SSH password for ${sshUser}`);
    } else {
      throw new ValidationError(
        'Cluster setup needs a bootstrap identity: -k/--key or --password',
        'Pass -k <path> to a bootstrap private key, or --password, or run this from a terminal to be prompted.',
      );
    }
  }
  return { sshUser, privateKey, password };
}

// ---------------------------------------------------------------------------
// SetupOptions -> K3sSetupOptions / K3sResetOptions (no Commander default, F38)
// ---------------------------------------------------------------------------

export function toSetupOptions(options: K3sSetupCliOptions): K3sSetupOptions {
  return {
    sshUser: options.sshUser || 'root',
    dryRun: Boolean(options.dryRun),
    yes: Boolean(options.yes),
    upgrade: Boolean(options.upgrade),
    convertDatastore: Boolean(options.convertDatastore),
    sharedCluster: Boolean(options.sharedCluster),
    flannelBackend: options.flannelBackend ?? null,
    skipFirewall: Boolean(options.skipFirewall),
    skipNetworkCheck: Boolean(options.skipNetworkCheck),
    skipReachabilityCheck: Boolean(options.skipReachabilityCheck),
    insecureHostKey: Boolean(options.insecureHostKey),
    requireHostKey: Boolean(options.requireHostKey),
    rotateDeployToken: Boolean(options.rotateDeployToken),
    binary: options.binary ?? null,
    dev: Boolean(options.dev),
    interactive: isInteractiveSession(),
  };
}

export function toResetOptions(options: K3sSetupCliOptions): K3sResetOptions {
  return {
    sshUser: options.sshUser || 'root',
    nodes: options.node ?? [],
    deleteVolumes: Boolean(options.deleteVolumes),
    yes: Boolean(options.yes),
    confirm: options.confirm ?? null,
    sharedCluster: Boolean(options.sharedCluster),
    insecureHostKey: Boolean(options.insecureHostKey),
    requireHostKey: Boolean(options.requireHostKey),
    binary: options.binary ?? null,
    dev: Boolean(options.dev),
    interactive: isInteractiveSession(),
  };
}
