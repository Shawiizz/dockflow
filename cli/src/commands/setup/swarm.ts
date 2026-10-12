/**
 * Setup Swarm Command
 * 
 * Initializes a Docker Swarm cluster:
 * - Initializes Swarm on the manager node
 * - Opens firewall ports for Swarm communication
 * - Joins worker nodes to the cluster
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
  getAvailableEnvironments
} from '../../utils/servers';
import { sshExec } from '../../utils/ssh';
import { loadSecrets } from '../../utils/secrets';
import { openPorts } from './firewall';
import type { SSHKeyConnection, ResolvedServer } from '../../types';

/**
 * Swarm ports that need to be open
 */
const SWARM_PORTS = [
  { port: 2377, protocol: 'tcp', description: 'Cluster management' },
  { port: 7946, protocol: 'tcp', description: 'Node communication' },
  { port: 7946, protocol: 'udp', description: 'Node communication' },
  { port: 4789, protocol: 'udp', description: 'Overlay network' },
];

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
 * Open firewall ports for Swarm (delegates to shared helper)
 */
async function openSwarmPorts(connection: SSHKeyConnection, serverName: string): Promise<boolean> {
  return openPorts(connection, serverName, SWARM_PORTS);
}

/**
 * Initialize Swarm on manager and return join token + internal IP for workers to join
 */
async function initializeSwarm(
  connection: SSHKeyConnection, 
  managerName: string,
  managerHost: string
): Promise<{ token: string; internalIp: string } | null> {
  const spinner = createSpinner();
  spinner.start(`Initializing Docker Swarm on ${managerName}...`);
  
  try {
    // Determine the IP for workers to join
    let internalIp: string;
    
    if (managerHost !== 'localhost' && managerHost !== '127.0.0.1') {
      // Production: use the configured host (real IP or hostname)
      internalIp = managerHost;
    } else {
      // Dev/E2E mode with localhost: detect internal IP
      // In Docker-in-Docker, we need to find the IP on the shared network
      // Exclude 172.17.x.x (default Docker bridge) and take the last remaining IP
      const ipResult = await sshExec(connection, 
        "hostname -I | tr ' ' '\\n' | grep -v '^172\\.17\\.' | grep -v '^$' | tail -1"
      );
      internalIp = ipResult.stdout.trim();
      
      // Fallback: if no IP found after filtering, try the simple approach
      if (!internalIp) {
        const fallbackResult = await sshExec(connection, "hostname -I | awk '{print $NF}'");
        internalIp = fallbackResult.stdout.trim();
      }
      
      if (!internalIp) {
        spinner.fail('Could not determine internal IP address');
        return null;
      }
    }

    // Check current swarm state
    const stateResult = await sshExec(connection, "docker info --format '{{.Swarm.LocalNodeState}}'");
    const state = stateResult.stdout.trim();
    
    if (state === 'active') {
      // Already in a swarm, get the join token
      const tokenResult = await sshExec(connection, 'docker swarm join-token worker -q');
      const token = tokenResult.stdout.trim();
      spinner.succeed(`Docker Swarm already active on ${managerName}`);
      return { token, internalIp };
    }
    
    // Initialize new swarm
    const initResult = await sshExec(connection, 
      `docker swarm init --advertise-addr ${internalIp} 2>&1`
    );
    
    if (initResult.exitCode !== 0) {
      spinner.fail(`Failed to initialize Swarm: ${initResult.stderr || initResult.stdout}`);
      return null;
    }
    
    // Get join token
    const tokenResult = await sshExec(connection, 'docker swarm join-token worker -q');
    const token = tokenResult.stdout.trim();
    
    spinner.succeed(`Docker Swarm initialized on ${managerName} (${internalIp})`);
    return { token, internalIp };
  } catch (error) {
    spinner.fail(`Failed to initialize Swarm: ${error}`);
    return null;
  }
}

/**
 * Join a worker to the swarm
 */
async function joinWorkerToSwarm(
  connection: SSHKeyConnection,
  workerName: string,
  managerHost: string,
  joinToken: string
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Joining ${workerName} to Swarm cluster...`);
  
  try {
    // Check if already in swarm
    const stateResult = await sshExec(connection, "docker info --format '{{.Swarm.LocalNodeState}}'");
    const state = stateResult.stdout.trim();
    
    if (state === 'active') {
      spinner.succeed(`${workerName} is already in a Swarm cluster`);
      return true;
    }
    
    // Leave any inactive swarm first
    if (state === 'inactive') {
      await sshExec(connection, 'docker swarm leave --force 2>/dev/null || true');
    }
    
    // Join the swarm
    const joinResult = await sshExec(connection, 
      `docker swarm join --token ${joinToken} ${managerHost}:2377`
    );
    
    if (joinResult.exitCode !== 0) {
      spinner.fail(`Failed to join ${workerName}: ${joinResult.stderr || joinResult.stdout}`);
      return false;
    }
    
    spinner.succeed(`${workerName} joined the Swarm cluster`);
    return true;
  } catch (error) {
    spinner.fail(`Failed to join ${workerName}: ${error}`);
    return false;
  }
}

export interface WorkerFailure {
  name: string;
  reason: string;
}

/** Joins every worker it can; returns the ones that could not be joined. */
export async function joinWorkers(
  workers: readonly ResolvedServer[],
  connect: (worker: ResolvedServer) => SSHKeyConnection | null,
  managerHost: string,
  joinToken: string,
): Promise<WorkerFailure[]> {
  const failures: WorkerFailure[] = [];
  for (const worker of workers) {
    const connection = connect(worker);
    if (!connection) {
      printError(`No SSH key found for worker "${worker.name}"`);
      failures.push({ name: worker.name, reason: 'no SSH key' });
      continue;
    }
    if (!(await joinWorkerToSwarm(connection, worker.name, managerHost, joinToken))) {
      failures.push({ name: worker.name, reason: 'could not join the cluster' });
    }
  }
  return failures;
}

/** A cluster missing workers is not "ready": the command fails, naming them. */
export function requireAllJoined(env: string, failures: readonly WorkerFailure[]): void {
  if (failures.length === 0) return;
  for (const { name, reason } of failures) printWarning(`${name}: ${reason}`);
  throw new CLIError(
    `Swarm setup of ${env} failed on ${failures.map(({ name }) => name).join(', ')}`,
    ErrorCode.COMMAND_FAILED,
    'Fix the cause above and run setup again: nodes already in the cluster are left alone.',
  );
}

/** Nodes of `docker node ls --format '{{.Hostname}}|{{.Status}}'` that are not Ready, and how many are. */
export function readiness(nodeList: string): { ready: number; notReady: string[] } {
  const nodes = nodeList.trim().split('\n').filter(Boolean).map((line) => line.split('|'));
  return {
    ready: nodes.filter(([, status]) => status === 'Ready').length,
    notReady: nodes.filter(([, status]) => status !== 'Ready').map(([host, status]) => `${host} (${status})`),
  };
}

/** A worker that joined can still be Down for Swarm: the cluster is ready once every node is Ready. */
async function waitForReadyNodes(connection: SSHKeyConnection, expected: number): Promise<string | null> {
  let last = { ready: 0, notReady: [] as string[] };
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await sshExec(connection, `docker node ls --format '{{.Hostname}}|{{.Status}}'`);
    last = readiness(result.stdout);
    if (last.ready >= expected && last.notReady.length === 0) return null;
    await Bun.sleep(2000);
  }
  return `${last.ready} of ${expected} node(s) Ready after 60s${last.notReady.length > 0 ? `; not ready: ${last.notReady.join(', ')}` : ''}`;
}

/**
 * Display cluster status
 */
async function displayClusterStatus(connection: SSHKeyConnection): Promise<void> {
  printBlank();
  printInfo('Cluster Status:');

  try {
    const nodesResult = await sshExec(connection, 'docker node ls');
    printRaw(nodesResult.stdout);
  } catch (error) {
    printWarning('Could not retrieve cluster status');
  }
}

/**
 * Run the setup swarm command
 */
export async function runSetupSwarm(env: string): Promise<void> {
  // Load secrets from .env.dockflow or CI environment
  loadSecrets();

  printIntro(`Setting up Docker Swarm cluster for ${env}`);
  printBlank();

  // Check servers.yml exists
  if (!hasServersConfig()) {
    throw new CLIError(
      'No servers configuration found. Create dockflow.yml or .dockflow/servers.yml to define your cluster.',
      ErrorCode.CONFIG_NOT_FOUND
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
      suggestion
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
      'Set the SSH private key via environment variables or servers.yml'
    );
  }

  // Step 1: Open ports on all nodes, which no other node uses on a single-node cluster
  if (workers.length === 0) {
    printInfo('Step 1/3: No firewall port to open (single-node cluster: no other node connects to it)');
  } else {
    printInfo('Step 1/3: Opening firewall ports...');
    await openSwarmPorts(managerConnection, manager.name);

    for (const worker of workers) {
      const workerConnection = buildConnection(env, worker);
      if (workerConnection) {
        await openSwarmPorts(workerConnection, worker.name);
      }
    }
  }
  printBlank();

  // Step 2: Initialize Swarm on manager
  printInfo('Step 2/3: Initializing Swarm on manager...');
  const swarmInit = await initializeSwarm(managerConnection, manager.name, manager.host);
  if (!swarmInit) {
    throw new CLIError(
      'Failed to initialize Swarm cluster',
      ErrorCode.COMMAND_FAILED
    );
  }
  const { token: joinToken, internalIp: managerInternalIp } = swarmInit;
  printBlank();

  // Step 3: Join workers
  let failedWorkers: WorkerFailure[] = [];
  if (workers.length > 0) {
    printInfo('Step 3/3: Joining workers to cluster...');
    // Use the manager's internal IP for swarm join (not the external SSH host)
    failedWorkers = await joinWorkers(workers, (worker) => buildConnection(env, worker), managerInternalIp, joinToken);
  } else {
    printInfo('Step 3/3: No workers to join (single-node cluster)');
  }
  printBlank();

  const expected = 1 + workers.length - failedWorkers.length;
  const notReady = expected > 1 ? await waitForReadyNodes(managerConnection, expected) : null;

  // Display final status
  await displayClusterStatus(managerConnection);

  requireAllJoined(env, failedWorkers);
  if (notReady) {
    throw new CLIError(
      `Swarm setup of ${env}: ${notReady}`,
      ErrorCode.COMMAND_FAILED,
      'A node that stays Down usually cannot reach the manager on ports 2377, 7946 and 4789; check the firewall between them.',
    );
  }

  printNote(`Deploy with: dockflow deploy ${env}`);
  printOutro('Docker Swarm cluster is ready!');
}
