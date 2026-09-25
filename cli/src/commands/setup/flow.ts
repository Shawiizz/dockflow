/**
 * Shared steps between the interactive and non-interactive local setup flows.
 */

import { Readable } from 'node:stream';
import * as fs from 'fs';
import { DOCKFLOW_VERSION } from '../../constants';
import { K8S_KUBECONFIG_DIR } from '../../services/orchestrator/kubernetes/constants';
import { K3S_PIN } from '../../services/orchestrator/kubernetes/k3s/versions';
import { systemClock } from '../../services/orchestrator/kubernetes/deps';
import { printSection, printSuccess, printWarning, printInfo, printBlank, printRaw } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { checkDependencies, installDependencies, detectPackageManager } from './dependencies';
import { provisionHost } from './provision';
import { configureServiceAccess } from './user';
import { displayConnectionInfo } from './connection';
import { nodeArch } from './k3s/install';
import { setupMessages } from './k3s/messages';
import { inspect, runK3sNodeStep, type ControlPlaneReport, type NodeStepResult } from './k3s/node';
import { localHostRunner } from './k3s/host-runner';
import { buildLocalPlan, buildNodePlan, finalizeClusterPlan, type K3sClusterPlan, type K3sNodePlan, type NodeOperation } from './k3s/plan';
import type { HostConfig } from './types';

/**
 * Verify required dependencies and install the missing ones.
 * `confirmInstall` lets the interactive flow ask first; returning false
 * aborts the setup.
 */
export async function ensureSetupDependencies(
  confirmInstall?: () => Promise<boolean>,
): Promise<void> {
  const deps = checkDependencies();
  if (deps.ok) return;

  printInfo('Missing required dependencies:');
  deps.missing.forEach((m) => printWarning(`  - ${m}`));
  printBlank();

  const pm = detectPackageManager();
  if (!pm) {
    throw new CLIError(
      `Could not detect package manager. Please install dependencies manually: ${deps.missing.join(', ')}`,
      ErrorCode.COMMAND_FAILED,
    );
  }

  if (confirmInstall && !(await confirmInstall())) {
    throw new CLIError(
      'Please install the missing dependencies and try again.',
      ErrorCode.VALIDATION_FAILED,
    );
  }

  if (!installDependencies(deps.missingDeps)) {
    throw new CLIError(
      'Failed to install dependencies. Please install them manually and try again.',
      ErrorCode.COMMAND_FAILED,
    );
  }
  printBlank();

  const recheck = checkDependencies();
  if (!recheck.ok) {
    throw new CLIError(
      `Some dependencies are still missing: ${recheck.missing.join(', ')}`,
      ErrorCode.VALIDATION_FAILED,
    );
  }
}

// ---------------------------------------------------------------------------
// k3s local single-host install (design-05 4.8): the coordinator's own node-step code
// (`runK3sNodeStep`), run in-process against this machine instead of over SSH.
// ---------------------------------------------------------------------------

/**
 * Runs one node-step operation the same way the cluster coordinator does over SSH — through
 * `runK3sNodeStep`, the protocol design-05 3.4 defines — but in-process, against the real
 * `HostRunner` of this machine. `runK3sNodeStep` speaks its result as a single stdout line rather
 * than a return value (3.4: the wire protocol is the same whether the node is local or remote), so
 * this captures that line by intercepting `process.stdout.write` for the duration of the call and
 * restores it immediately after, success or failure.
 */
async function runNodeOperationLocally(plan: K3sNodePlan): Promise<NodeStepResult> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runK3sNodeStep(Readable.from([JSON.stringify(plan)]), { runner: localHostRunner, clock: systemClock });
  } finally {
    process.stdout.write = originalWrite;
    // Bun leaves process.exitCode unchanged when assigned `undefined` once it already holds a
    // number, so `undefined` can't stand for "no exit code" here: a stale non-zero previousExitCode
    // would otherwise get faithfully restored over a step that just reported success.
    process.exitCode = previousExitCode ?? 0;
  }
  const line = lines.find((entry) => entry.includes('dockflowNodeResult'));
  if (line === undefined) {
    throw new CLIError(`The ${plan.operation} step on this host produced no result`, ErrorCode.COMMAND_FAILED);
  }
  return (JSON.parse(line) as { dockflowNodeResult: NodeStepResult }).dockflowNodeResult;
}

function throwIfFailed(operation: NodeOperation, result: NodeStepResult): void {
  if (result.status === 'ok') return;
  throw new CLIError(
    result.error?.message ?? `The ${operation} step on this host failed`,
    ErrorCode.COMMAND_FAILED,
    result.error?.suggestion,
  );
}

/**
 * `inspect -> decide -> prepare -> install -> control-plane -> finalize` on this host (design-05
 * 4.8): a single-node plan never needs the cross-node network check (`buildLocalPlan` sets
 * `skipNetworkCheck: true`, and `finalize`'s own check only runs when the cluster has more than one
 * node either way). Firewall management is not offered in local mode (design-05 1.2 lists no
 * `--skip-firewall` for it): every node plan carries `firewallTool: null`, which the shared `prepare`
 * step treats as "skip".
 */
async function runK3sLocalNodeOperations(plan: K3sClusterPlan): Promise<{ controlPlane: ControlPlaneReport | null }> {
  const node = plan.nodes[0];
  const arch = await nodeArch(localHostRunner, node.key);

  const inspectPlan = buildNodePlan({ operation: 'inspect', node: node.key, arch, plan });
  const inspection = await inspect(localHostRunner, inspectPlan);

  const cluster = finalizeClusterPlan(plan, { [node.key]: inspection });
  if (cluster.refusals.length > 0) {
    const problem = setupMessages.refusals('this host', cluster.refusals);
    throw new CLIError(problem.message, ErrorCode.VALIDATION_FAILED, problem.suggestion);
  }
  for (const warning of cluster.warnings) printWarning(warning.message);

  let controlPlane: ControlPlaneReport | null = null;
  const operations: readonly NodeOperation[] = ['prepare', 'install', 'control-plane', 'finalize'];
  for (const operation of operations) {
    const nodePlan = buildNodePlan({ operation, node: node.key, arch, plan, cluster, firewallTool: null });
    const result = await runNodeOperationLocally(nodePlan);
    throwIfFailed(operation, result);
    for (const warning of result.warnings) printWarning(warning);
    if (result.controlPlane !== null) controlPlane = result.controlPlane;
  }
  return { controlPlane };
}

/** design-05 17.3 (after the connection string block). */
function printK3sLocalSummary(config: HostConfig, plan: K3sClusterPlan, controlPlane: ControlPlaneReport | null): void {
  const node = plan.nodes[0];
  const encryption = controlPlane?.encryption.enabled ? 'on' : 'off';
  printBlank();
  printInfo(`k3s ${K3S_PIN.version} is running on this host (node ${node.nodeName}, flannel ${plan.requestedBackend ?? 'vxlan'}, secrets encryption ${encryption})`);
  printInfo(`Deploy kubeconfig: ${K8S_KUBECONFIG_DIR}/config (owner ${config.deployUser}, mode 600)`);
  printBlank();
  printInfo('Add this server to .dockflow/servers.yml:');
  printRaw('  servers:');
  printRaw(`    ${node.key}:`);
  printRaw(`      host: ${config.publicHost}`);
  printRaw('      role: manager');
  printRaw('      tags: [production]');
  printInfo('and set orchestrator: k3s in .dockflow/config.yml.');
}

/**
 * Provision the host, install and start k3s on it when the orchestrator is k3s, finalize service
 * access for the deploy user, and display the connection information. Common tail of both setup
 * flows.
 */
export async function completeSetup(config: HostConfig): Promise<void> {
  await provisionHost(config);

  let k3sPlan: K3sClusterPlan | null = null;
  let k3sControlPlane: ControlPlaneReport | null = null;

  if (config.orchestrator === 'k3s' && config.k3s) {
    const publicKeyPath = `${config.privateKeyPath}.pub`;
    const deployPublicKey = fs.existsSync(publicKeyPath) ? fs.readFileSync(publicKeyPath, 'utf-8').trim() : null;
    k3sPlan = buildLocalPlan({
      nodeName: config.k3s.nodeName,
      deployUser: config.deployUser,
      deployPublicKey,
      privateHost: config.k3s.privateHost,
      publicHost: config.publicHost,
      requestedBackend: config.k3s.flannelBackend,
      dockflowVersion: DOCKFLOW_VERSION,
    });
    const result = await runK3sLocalNodeOperations(k3sPlan);
    k3sControlPlane = result.controlPlane;
    await configureServiceAccess(config.deployUser, 'k3s');
  } else {
    // nginx may have just been installed — reconfigure service access now that
    // the binaries are available.
    await configureServiceAccess(config.deployUser, config.orchestrator);
  }

  printBlank();
  printSection('Setup Complete');
  printBlank();
  printSuccess('The machine has been successfully configured!');

  const privateKey = fs.readFileSync(config.privateKeyPath, 'utf-8');
  displayConnectionInfo(config, privateKey);

  if (k3sPlan !== null) printK3sLocalSummary(config, k3sPlan, k3sControlPlane);
}
