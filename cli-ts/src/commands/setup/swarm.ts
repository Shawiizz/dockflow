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

import chalk from 'chalk';
import ora from 'ora';
import { printHeader, printError, printSuccess, printInfo, printWarning } from '../../utils/output';
import { hasServersConfig } from '../../utils/config';
import { CLIError, ConnectionError, ErrorCode } from '../../utils/errors';
import { 
  resolveDeploymentForEnvironment, 
  getServerPrivateKey,
  getAvailableEnvironments
} from '../../utils/servers';
import { sshExec } from '../../utils/ssh';
import { loadSecrets } from '../../utils/secrets';
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
 * Open firewall ports for Swarm
 */
async function openSwarmPorts(connection: SSHKeyConnection, serverName: string): Promise<boolean> {
  const spinner = ora(`Opening Swarm ports on ${serverName}...`).start();
  
  try {
    // Check which firewall is available
    const ufwCheck = await sshExec(connection, 'which ufw 2>/dev/null');
    const firewallCmdCheck = await sshExec(connection, 'which firewall-cmd 2>/dev/null');
    
    if (ufwCheck.stdout.trim()) {
      // UFW (Ubuntu/Debian)
      for (const { port, protocol } of SWARM_PORTS) {
        await sshExec(connection, `sudo ufw allow ${port}/${protocol} 2>/dev/null || true`);
      }
      await sshExec(connection, 'sudo ufw reload 2>/dev/null || true');
    } else if (firewallCmdCheck.stdout.trim()) {
      // firewalld (RHEL/CentOS)
      for (const { port, protocol } of SWARM_PORTS) {
        await sshExec(connection, `sudo firewall-cmd --permanent --add-port=${port}/${protocol} 2>/dev/null || true`);
      }
      await sshExec(connection, 'sudo firewall-cmd --reload 2>/dev/null || true');
    } else {
      // Try iptables as fallback
      for (const { port, protocol } of SWARM_PORTS) {
        await sshExec(connection, `sudo iptables -I INPUT -p ${protocol} --dport ${port} -j ACCEPT 2>/dev/null || true`);
      }
    }
    
    spinner.succeed(`Swarm ports opened on ${serverName}`);
    return true;
  } catch (error) {
    spinner.warn(`Could not open ports on ${serverName} (may already be open or no firewall)`);
    return true; // Continue anyway
  }
}

/**
 * Initialize Swarm on manager and return join token + internal IP for workers to join
 */
async function initializeSwarm(
  connection: SSHKeyConnection, 
  managerName: string,
  managerHost: string
): Promise<{ token: string; internalIp: string } | null> {
  const spinner = ora(`Initializing Docker Swarm on ${managerName}...`).start();
  
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
  const spinner = ora(`Joining ${workerName} to Swarm cluster...`).start();
  
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

/**
 * Display cluster status
 */
async function displayClusterStatus(connection: SSHKeyConnection): Promise<void> {
  console.log('');
  printInfo('Cluster Status:');
  
  try {
    const nodesResult = await sshExec(connection, 'docker node ls');
    console.log(nodesResult.stdout);
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

  printHeader(`Setting up Docker Swarm cluster for ${env}`);
  console.log('');

  // Check servers.yml exists
  if (!hasServersConfig()) {
    throw new CLIError(
      '.dockflow/servers.yml not found. Create a servers.yml file to define your cluster.',
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
  console.log('');

  // Build manager connection
  const managerConnection = buildConnection(env, manager);
  if (!managerConnection) {
    throw new ConnectionError(
      `No SSH key found for manager "${manager.name}"`,
      'Set the SSH private key via environment variables or servers.yml'
    );
  }

  // Step 1: Open ports on all nodes
  printInfo('Step 1/3: Opening firewall ports...');
  await openSwarmPorts(managerConnection, manager.name);
  
  for (const worker of workers) {
    const workerConnection = buildConnection(env, worker);
    if (workerConnection) {
      await openSwarmPorts(workerConnection, worker.name);
    }
  }
  console.log('');

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
  console.log('');

  // Step 3: Join workers
  if (workers.length > 0) {
    printInfo('Step 3/3: Joining workers to cluster...');
    let allJoined = true;
    
    for (const worker of workers) {
      const workerConnection = buildConnection(env, worker);
      if (!workerConnection) {
        printError(`No SSH key found for worker "${worker.name}"`);
        allJoined = false;
        continue;
      }
      
      // Use the manager's internal IP for swarm join (not the external SSH host)
      const joined = await joinWorkerToSwarm(workerConnection, worker.name, managerInternalIp, joinToken);
      if (!joined) {
        allJoined = false;
      }
    }
    
    if (!allJoined) {
      printWarning('Some workers failed to join the cluster');
    }
  } else {
    printInfo('Step 3/3: No workers to join (single-node cluster)');
  }
  console.log('');

  // Display final status
  await displayClusterStatus(managerConnection);

  printSuccess('Docker Swarm cluster is ready!');
  console.log('');
  printInfo(`Deploy with: dockflow deploy ${env}`);
}
