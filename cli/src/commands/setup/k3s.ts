/**
 * Setup k3s Command
 *
 * Initializes a k3s cluster:
 * - Opens firewall ports for k3s communication
 * - Installs k3s server on the manager node
 * - Copies kubeconfig for the dockflow user
 * - Retrieves the join token
 * - Installs k3s agent on each worker node
 * - Verifies cluster status
 *
 * This command should be run once before the first deployment
 * to set up the cluster topology.
 */

import { printIntro, printOutro, printNote, printError, printInfo, printWarning, printBlank, printRaw, createSpinner } from '../../utils/output';
import { hasServersConfig } from '../../utils/config';
import { CLIError, ConnectionError, ErrorCode } from '../../utils/errors';
import {
  resolveDeploymentForEnvironment,
  getServerPrivateKey,
  getAvailableEnvironments,
} from '../../utils/servers';
import { sshExec } from '../../utils/ssh';
import { loadSecrets } from '../../utils/secrets';
import { openPorts } from './firewall';
import {
  K3S_PORTS,
  K3S_KUBECONFIG_PATH,
  K3S_DOCKFLOW_KUBECONFIG,
  K3S_TOKEN_PATH,
} from '../../constants';
import type { SSHKeyConnection, ResolvedServer } from '../../types';

/**
 * Build SSH connection from resolved server
 */
function buildConnection(env: string, server: ResolvedServer): SSHKeyConnection | null {
  const privateKey = getServerPrivateKey(env, server.name);
  if (!privateKey) {
    return null;
  }
  return {
    host: server.host,
    port: server.port,
    user: server.user,
    privateKey,
  };
}

/**
 * Install k3s server on the manager node
 */
async function installK3sServer(
  connection: SSHKeyConnection,
  managerName: string,
  managerHost: string,
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Installing k3s server on ${managerName}...`);

  try {
    // Check if k3s is already installed
    const check = await sshExec(connection, 'which k3s 2>/dev/null');
    if (check.stdout.trim()) {
      spinner.succeed(`k3s already installed on ${managerName}`);
      return true;
    }

    // Install k3s server
    const result = await sshExec(
      connection,
      `curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode=644 --tls-san=${managerHost}`,
    );

    if (result.exitCode !== 0) {
      spinner.fail(`Failed to install k3s: ${result.stderr || result.stdout}`);
      return false;
    }

    // Wait for k3s to be ready
    spinner.text = `Waiting for k3s to be ready on ${managerName}...`;
    const ready = await sshExec(
      connection,
      `for i in $(seq 1 30); do kubectl get nodes --kubeconfig ${K3S_KUBECONFIG_PATH} 2>/dev/null && exit 0; sleep 2; done; exit 1`,
    );

    if (ready.exitCode !== 0) {
      spinner.fail('k3s installed but not ready after 60 seconds');
      return false;
    }

    spinner.succeed(`k3s server installed on ${managerName}`);
    return true;
  } catch (error) {
    spinner.fail(`Failed to install k3s: ${error}`);
    return false;
  }
}

/**
 * Copy kubeconfig for the dockflow deploy user and patch the server address
 */
async function setupKubeconfig(
  connection: SSHKeyConnection,
  managerHost: string,
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start('Setting up kubeconfig...');

  try {
    await sshExec(connection, `sudo cp ${K3S_KUBECONFIG_PATH} ${K3S_DOCKFLOW_KUBECONFIG}`);
    await sshExec(
      connection,
      `sudo sed -i 's/127.0.0.1/${managerHost}/g' ${K3S_DOCKFLOW_KUBECONFIG}`,
    );
    await sshExec(
      connection,
      `sudo chown ${connection.user}:${connection.user} ${K3S_DOCKFLOW_KUBECONFIG}`,
    );

    spinner.succeed('Kubeconfig ready');
    return true;
  } catch (error) {
    spinner.fail(`Failed to setup kubeconfig: ${error}`);
    return false;
  }
}

/**
 * Retrieve the k3s join token from the manager
 */
async function getJoinToken(connection: SSHKeyConnection): Promise<string | null> {
  const spinner = createSpinner();
  spinner.start('Retrieving join token...');

  try {
    const result = await sshExec(connection, `sudo cat ${K3S_TOKEN_PATH}`);
    const token = result.stdout.trim();

    if (!token) {
      spinner.fail('Join token is empty');
      return null;
    }

    spinner.succeed('Join token retrieved');
    return token;
  } catch (error) {
    spinner.fail(`Failed to retrieve join token: ${error}`);
    return null;
  }
}

/**
 * Determine the internal IP of the manager for worker join
 */
async function getManagerInternalIp(
  connection: SSHKeyConnection,
  managerHost: string,
): Promise<string> {
  if (managerHost !== 'localhost' && managerHost !== '127.0.0.1') {
    return managerHost;
  }

  // Dev/E2E mode: detect internal IP
  const ipResult = await sshExec(
    connection,
    "hostname -I | tr ' ' '\\n' | grep -v '^172\\.17\\.' | grep -v '^$' | tail -1",
  );
  const ip = ipResult.stdout.trim();
  if (ip) return ip;

  const fallback = await sshExec(connection, "hostname -I | awk '{print $NF}'");
  return fallback.stdout.trim() || managerHost;
}

/**
 * Install k3s agent on a worker node
 */
async function installK3sAgent(
  connection: SSHKeyConnection,
  workerName: string,
  managerIp: string,
  token: string,
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Installing k3s agent on ${workerName}...`);

  try {
    // Check if k3s-agent is already running
    const check = await sshExec(connection, 'systemctl is-active k3s-agent 2>/dev/null');
    if (check.stdout.trim() === 'active') {
      spinner.succeed(`k3s agent already running on ${workerName}`);
      return true;
    }

    const result = await sshExec(
      connection,
      `curl -sfL https://get.k3s.io | K3S_URL=https://${managerIp}:6443 K3S_TOKEN=${token} sh -`,
    );

    if (result.exitCode !== 0) {
      spinner.fail(`Failed to install k3s agent on ${workerName}: ${result.stderr || result.stdout}`);
      return false;
    }

    spinner.succeed(`k3s agent installed on ${workerName}`);
    return true;
  } catch (error) {
    spinner.fail(`Failed to install k3s agent on ${workerName}: ${error}`);
    return false;
  }
}

/**
 * Display cluster status via kubectl
 */
async function displayClusterStatus(connection: SSHKeyConnection): Promise<void> {
  printBlank();
  printInfo('Cluster Status:');

  try {
    const nodesResult = await sshExec(
      connection,
      `kubectl get nodes --kubeconfig ${K3S_DOCKFLOW_KUBECONFIG}`,
    );
    printRaw(nodesResult.stdout);
  } catch {
    printWarning('Could not retrieve cluster status');
  }
}

/**
 * Run the setup k3s command
 */
export async function runSetupK3s(env: string): Promise<void> {
  // Load secrets from .env.dockflow or CI environment
  loadSecrets();

  printIntro(`Setting up k3s cluster for ${env}`);
  printBlank();

  // Check servers.yml exists
  if (!hasServersConfig()) {
    throw new CLIError(
      '.dockflow/servers.yml not found. Create a servers.yml file to define your cluster.',
      ErrorCode.CONFIG_NOT_FOUND,
    );
  }

  // Resolve deployment
  const deployment = resolveDeploymentForEnvironment(env);
  if (!deployment) {
    const availableEnvs = getAvailableEnvironments();
    const suggestion = availableEnvs.length > 0
      ? `Available environments: ${availableEnvs.join(', ')}`
      : undefined;
    throw new CLIError(
      `No manager server found for environment "${env}"`,
      ErrorCode.VALIDATION_FAILED,
      suggestion,
    );
  }

  const { manager, workers } = deployment;

  printInfo(`Manager: ${manager.name} (${manager.host})`);
  if (workers.length > 0) {
    printInfo(`Workers: ${workers.map(w => `${w.name} (${w.host})`).join(', ')}`);
  } else {
    printInfo('Workers: none (single-node cluster)');
  }
  printBlank();

  // Build manager connection
  const managerConnection = buildConnection(env, manager);
  if (!managerConnection) {
    throw new ConnectionError(
      `No SSH key found for manager "${manager.name}"`,
      'Set the SSH private key via environment variables or servers.yml',
    );
  }

  const totalSteps = workers.length > 0 ? 6 : 4;
  let step = 1;

  // Step 1: Open ports on all nodes
  printInfo(`Step ${step}/${totalSteps}: Opening firewall ports...`);
  await openPorts(managerConnection, manager.name, K3S_PORTS);

  for (const worker of workers) {
    const workerConnection = buildConnection(env, worker);
    if (workerConnection) {
      await openPorts(workerConnection, worker.name, K3S_PORTS);
    }
  }
  printBlank();
  step++;

  // Step 2: Install k3s server on manager
  printInfo(`Step ${step}/${totalSteps}: Installing k3s on manager...`);
  const installed = await installK3sServer(managerConnection, manager.name, manager.host);
  if (!installed) {
    throw new CLIError('Failed to install k3s server', ErrorCode.COMMAND_FAILED);
  }
  printBlank();
  step++;

  // Step 3: Setup kubeconfig
  printInfo(`Step ${step}/${totalSteps}: Setting up kubeconfig...`);
  const managerInternalIp = await getManagerInternalIp(managerConnection, manager.host);
  const kubeconfigOk = await setupKubeconfig(managerConnection, managerInternalIp);
  if (!kubeconfigOk) {
    throw new CLIError('Failed to setup kubeconfig', ErrorCode.COMMAND_FAILED);
  }
  printBlank();
  step++;

  // Step 4: Retrieve join token (only needed if there are workers)
  if (workers.length > 0) {
    printInfo(`Step ${step}/${totalSteps}: Retrieving join token...`);
    const token = await getJoinToken(managerConnection);
    if (!token) {
      throw new CLIError('Failed to retrieve k3s join token', ErrorCode.COMMAND_FAILED);
    }
    printBlank();
    step++;

    // Step 5: Install k3s agent on each worker
    printInfo(`Step ${step}/${totalSteps}: Joining workers to cluster...`);
    let allJoined = true;

    for (const worker of workers) {
      const workerConnection = buildConnection(env, worker);
      if (!workerConnection) {
        printError(`No SSH key found for worker "${worker.name}"`);
        allJoined = false;
        continue;
      }

      const joined = await installK3sAgent(workerConnection, worker.name, managerInternalIp, token);
      if (!joined) {
        allJoined = false;
      }
    }

    if (!allJoined) {
      printWarning('Some workers failed to join the cluster');
    }
    printBlank();
    step++;
  }

  // Final step: Verification
  printInfo(`Step ${step}/${totalSteps}: Verifying cluster...`);
  await displayClusterStatus(managerConnection);

  printNote(`Deploy with: dockflow deploy ${env}`);
  printOutro('k3s cluster is ready!');
}
