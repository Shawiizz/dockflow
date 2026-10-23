/**
 * `setup swarm`: initializes Swarm on the manager, opens the firewall ports and joins the workers.
 * Run once before the first deploy.
 */

import { printIntro, printOutro, printNote, printError, printInfo, printWarning, printBlank, printRaw, createSpinner } from '../../utils/output';
import { hasServersConfig } from '../../utils/config';
import { CLIError, ConnectionError, ErrorCode } from '../../utils/errors';
import {
  resolveDeploymentForEnvironment,
  getServerPrivateKey,
  getAvailableEnvironments
} from '../../utils/servers';
import { sshExec, shellQuote } from '../../utils/ssh';
import { loadSecrets } from '../../utils/secrets';
import { openPorts } from './firewall';
import type { SSHKeyConnection, ResolvedServer } from '../../types';

const SWARM_PORTS = [
  { port: 2377, protocol: 'tcp', description: 'Cluster management' },
  { port: 7946, protocol: 'tcp', description: 'Node communication' },
  { port: 7946, protocol: 'udp', description: 'Node communication' },
  { port: 4789, protocol: 'udp', description: 'Overlay network' },
];

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
    hostKey: server.hostKey,
  };
}

/** The address Swarm nodes reach this one on: the private address when servers.yml sets one. */
export function swarmAddress(server: ResolvedServer): string {
  return server.privateHost ?? server.host;
}

/** `docker swarm join` for a worker; an IPv6 manager address is bracketed. */
export function swarmJoinCommand(joinToken: string, managerAddress: string, advertiseAddress?: string): string {
  const manager = managerAddress.includes(':') ? `[${managerAddress}]` : managerAddress;
  const advertise = advertiseAddress ? ` --advertise-addr ${shellQuote(advertiseAddress)}` : '';
  return `docker swarm join --token ${shellQuote(joinToken)}${advertise} ${shellQuote(`${manager}:2377`)}`;
}

/**
 * A node already in a cluster keeps the address it advertised when it joined: private_host does not
 * move it, so the operator is told instead of being left with traffic on the public network.
 */
async function warnIfAdvertisedElsewhere(connection: SSHKeyConnection, server: ResolvedServer): Promise<void> {
  if (!server.privateHost) return;
  const result = await sshExec(connection, "docker info --format '{{.Swarm.NodeAddr}}'");
  const advertised = result.stdout.trim();
  if (result.exitCode === 0 && advertised !== '' && advertised !== server.privateHost) {
    printWarning(
      `${server.name} advertises ${advertised} in the Swarm, not its private_host ${server.privateHost}: the cluster keeps using ${advertised}. ` +
      'To move it, have the node leave the cluster (`docker swarm leave --force`) and run setup swarm again.',
    );
  }
}

async function openSwarmPorts(connection: SSHKeyConnection, serverName: string): Promise<boolean> {
  return openPorts(connection, serverName, SWARM_PORTS);
}

/**
 * Initializes Swarm on the manager, or reuses the one running. Returns the worker join token and
 * the address workers join through; null, after failing the spinner, when that cannot be done.
 */
export async function initializeSwarm(
  connection: SSHKeyConnection,
  manager: ResolvedServer,
): Promise<{ token: string; internalIp: string } | null> {
  const managerName = manager.name;
  const managerHost = swarmAddress(manager);
  const spinner = createSpinner();
  spinner.start(`Initializing Docker Swarm on ${managerName}...`);

  try {
    let internalIp: string;

    if (managerHost !== 'localhost' && managerHost !== '127.0.0.1') {
      internalIp = managerHost;
    } else {
      // dev and E2E run against localhost; in Docker-in-Docker the nodes meet on the shared network,
      // so take the last address that is not on the default bridge (172.17.x.x)
      const ipResult = await sshExec(connection,
        "hostname -I | tr ' ' '\\n' | grep -v '^172\\.17\\.' | grep -v '^$' | tail -1"
      );
      internalIp = ipResult.stdout.trim();

      // nothing left after the filter: take the last address
      if (!internalIp) {
        const fallbackResult = await sshExec(connection, "hostname -I | awk '{print $NF}'");
        internalIp = fallbackResult.stdout.trim();
      }

      if (!internalIp) {
        spinner.fail('Could not determine internal IP address');
        return null;
      }
    }

    const stateResult = await sshExec(connection, "docker info --format '{{.Swarm.LocalNodeState}}'");
    const state = stateResult.stdout.trim();

    if (state === 'active') {
      const tokenResult = await sshExec(connection, 'docker swarm join-token worker -q');
      const token = tokenResult.stdout.trim();
      spinner.succeed(`Docker Swarm already active on ${managerName}`);
      await warnIfAdvertisedElsewhere(connection, manager);
      return { token, internalIp };
    }

    const initResult = await sshExec(connection,
      `docker swarm init --advertise-addr ${shellQuote(internalIp)} 2>&1`
    );

    if (initResult.exitCode !== 0) {
      spinner.fail(`Failed to initialize Swarm: ${initResult.stderr || initResult.stdout}`);
      return null;
    }

    const tokenResult = await sshExec(connection, 'docker swarm join-token worker -q');
    const token = tokenResult.stdout.trim();

    spinner.succeed(`Docker Swarm initialized on ${managerName} (${internalIp})`);
    return { token, internalIp };
  } catch (error) {
    spinner.fail(`Failed to initialize Swarm: ${error}`);
    return null;
  }
}

async function joinWorkerToSwarm(
  connection: SSHKeyConnection,
  worker: ResolvedServer,
  managerHost: string,
  joinToken: string
): Promise<boolean> {
  const workerName = worker.name;
  const spinner = createSpinner();
  spinner.start(`Joining ${workerName} to Swarm cluster...`);

  try {
    const stateResult = await sshExec(connection, "docker info --format '{{.Swarm.LocalNodeState}}'");
    const state = stateResult.stdout.trim();

    if (state === 'active') {
      spinner.succeed(`${workerName} is already in a Swarm cluster`);
      await warnIfAdvertisedElsewhere(connection, worker);
      return true;
    }

    // Leave any inactive swarm first
    if (state === 'inactive') {
      await sshExec(connection, 'docker swarm leave --force 2>/dev/null || true');
    }

    const joinResult = await sshExec(connection, swarmJoinCommand(joinToken, managerHost, worker.privateHost));

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
    if (!(await joinWorkerToSwarm(connection, worker, managerHost, joinToken))) {
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

export async function runSetupSwarm(env: string): Promise<void> {
  loadSecrets();

  printIntro(`Setting up Docker Swarm cluster for ${env}`);
  printBlank();

  if (!hasServersConfig()) {
    throw new CLIError(
      'No servers configuration found. Create dockflow.yml or .dockflow/servers.yml to define your cluster.',
      ErrorCode.CONFIG_NOT_FOUND
    );
  }

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

  const managerConnection = buildConnection(env, manager);
  if (!managerConnection) {
    throw new ConnectionError(
      `No SSH key found for manager "${manager.name}"`,
      'Set the SSH private key via environment variables or servers.yml'
    );
  }

  // a single-node cluster has no other node to reach it: no port to open
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

  printInfo('Step 2/3: Initializing Swarm on manager...');
  const swarmInit = await initializeSwarm(managerConnection, manager);
  if (!swarmInit) {
    throw new CLIError(
      'Failed to initialize Swarm cluster',
      ErrorCode.COMMAND_FAILED
    );
  }
  const { token: joinToken, internalIp: managerInternalIp } = swarmInit;
  printBlank();

  let failedWorkers: WorkerFailure[] = [];
  if (workers.length > 0) {
    printInfo('Step 3/3: Joining workers to cluster...');
    // workers join through the manager's internal address, not the SSH host
    failedWorkers = await joinWorkers(workers, (worker) => buildConnection(env, worker), managerInternalIp, joinToken);
  } else {
    printInfo('Step 3/3: No workers to join (single-node cluster)');
  }
  printBlank();

  const expected = 1 + workers.length - failedWorkers.length;
  const notReady = expected > 1 ? await waitForReadyNodes(managerConnection, expected) : null;

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
