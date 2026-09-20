/**
 * Control-plane resolution and failover (DESIGN-CORE 6.6, D20, D26): which node an orchestrator
 * command runs on, chosen once per command and never retried mid-flight (design-03 19.2). Shared by
 * both orchestrators: Swarm prefers the leader, Kubernetes has no leader concept and takes the first
 * ready server in servers.yml order. Probing reuses each orchestrator's own `ClusterBackend.probe`
 * (`SwarmClusterBackend`/`KubernetesClusterBackend`), so the failover algorithm and the day-2 probe
 * never disagree about what "ready" means.
 */

import type { SSHKeyConnection } from '../../types';
import type { ResolvedServer } from '../../types/servers';
import type { DockflowConfig } from '../../utils/config';
import { getServerPassword, getServerPrivateKey } from '../../utils/servers/ci-secrets';
import { CLIError, ConnectionError, ErrorCode, ValidationError } from '../../utils/errors';
import { printDebug, printWarning } from '../../utils/output';
import { Redactor } from '../../utils/redact';
import { getAvailableEnvironments, resolveServersForEnvironment } from '../../utils/servers/resolver';
import { KubernetesClusterBackend } from './kubernetes/backends/cluster';
import { createSharedMemo, systemClock, type Clock, type SshTransport } from './kubernetes/deps';
import { k3sDistribution } from './kubernetes/k3s/distribution';
import { createKubeExecutor, sshTransport as realTransport } from './kubernetes/runtime/kubectl';
import type { ClusterNodeRef, ControlPlaneProbe, OrchestratorKind, OrchestratorTarget } from './interfaces';
import { SwarmClusterBackend } from './swarm/swarm-cluster';

export interface ResolveTargetOptions {
  /** --server; must name a manager */
  server?: string;
  /** default true; deploy --no-failover sets false */
  failover?: boolean;
  /** deploy and setup: a worker without SSH credentials is an error instead of being skipped */
  requireWorkerCredentials?: boolean;
  /** deploy, image distribution, uploads: a worker without SSH credentials warns instead of only debug-logging */
  needsWorkers?: boolean;
  onProbe?: (probe: ControlPlaneProbe) => void;
  /** test injection: the transport every probe and credential check runs on; default: real SSH (K78) */
  probe?: SshTransport;
  /** test injection: the clock the Kubernetes probe guard runs on; default: the system clock (K78) */
  clock?: Clock;
  /**
   * Test injection: servers.yml's resolved rows, replacing `resolveServersForEnvironment(env)`.
   * `resolveOrchestratorTarget` otherwise reads the project's real servers.yml, which a unit test
   * must never depend on (this checkout's own `.dockflow/servers.yml` is exactly such a file).
   */
  servers?: readonly ResolvedServer[];
}

function toNodeRef(server: Pick<ResolvedServer, 'name' | 'role' | 'host' | 'privateHost'>, connection: SSHKeyConnection): ClusterNodeRef {
  return { name: server.name, role: server.role, host: server.host, privateHost: server.privateHost, connection };
}

/** CI-secret credentials for one server (env vars only, D21): never reads servers.yml again. */
function connectionFor(env: string, server: ResolvedServer): SSHKeyConnection | null {
  const privateKey = getServerPrivateKey(env, server.name);
  if (!privateKey) return null;
  return { host: server.host, port: server.port, user: server.user, privateKey, password: getServerPassword(env, server.name) };
}

function noServersSuggestion(): string {
  const environments = getAvailableEnvironments();
  return environments.length > 0
    ? `Available environments: ${environments.join(', ')}`
    : 'Add servers with the appropriate tags to servers.yml.';
}

function credentialsErrorFor(subject: string, env: string): ConnectionError {
  return new ConnectionError(`No SSH credentials for ${subject} of ${env}`);
}

function probeLine(probe: ControlPlaneProbe): string {
  return probe.detail ? `${probe.node}: ${probe.status} (${probe.detail})` : `${probe.node}: ${probe.status}`;
}

/** One probe, through the orchestrator's own `ClusterBackend.probe`, so failover and day-2 agree. */
async function probeNode(kind: OrchestratorKind, node: ClusterNodeRef, transport: SshTransport, clock: Clock): Promise<ControlPlaneProbe> {
  if (kind === 'swarm') {
    const placeholder: OrchestratorTarget = {
      kind: 'swarm',
      project: '',
      env: '',
      stackName: '',
      controlPlane: node,
      managers: [node],
      workers: [],
      probes: [],
    };
    return new SwarmClusterBackend(placeholder, { ssh: transport }).probe(node);
  }
  const redactor = new Redactor();
  const executor = createKubeExecutor(node, { distribution: k3sDistribution, redactor, clock, transport });
  const backend = new KubernetesClusterBackend(
    { kubectl: executor, distribution: k3sDistribution, redactor, clock },
    createSharedMemo(),
    { env: '', managers: [node], workers: [] },
    { executorFor: () => executor },
  );
  return backend.probe(node);
}

/** Swarm: `docker info` ControlAvailable + leader check (today's logic). Kubernetes: `kubectl get --raw=/readyz`. */
export async function probeControlPlane(kind: OrchestratorKind, node: ClusterNodeRef): Promise<ControlPlaneProbe> {
  return probeNode(kind, node, realTransport, systemClock);
}

function pickReadyIndex(kind: OrchestratorKind, probes: readonly ControlPlaneProbe[]): number {
  if (kind === 'swarm') {
    const leader = probes.findIndex((probe) => probe.status === 'leader');
    if (leader !== -1) return leader;
  }
  return probes.findIndex((probe) => probe.status === 'ready');
}

export async function resolveOrchestratorTarget(
  env: string,
  config: DockflowConfig,
  options: ResolveTargetOptions = {},
): Promise<OrchestratorTarget> {
  const kind: OrchestratorKind = config.orchestrator ?? 'swarm';
  const transport = options.probe ?? realTransport;
  const clock = options.clock ?? systemClock;
  const project = config.project_name;
  const stackName = `${project}-${env}`;

  const allServers = options.servers ?? resolveServersForEnvironment(env);
  if (allServers.length === 0) {
    throw new CLIError(`No servers found with tag "${env}"`, ErrorCode.NO_SERVERS_FOR_ENV, noServersSuggestion());
  }
  const allManagers = allServers.filter((server) => server.role === 'manager');

  // 1. managers with SSH credentials, servers.yml order; without them, dropped with printDebug.
  const credentialed: { server: ResolvedServer; node: ClusterNodeRef }[] = [];
  for (const server of allManagers) {
    const connection = connectionFor(env, server);
    if (!connection) {
      printDebug(`Manager ${server.name} has no SSH credentials; skipped`);
      continue;
    }
    credentialed.push({ server, node: toNodeRef(server, connection) });
  }
  if (credentialed.length === 0) throw credentialsErrorFor('any manager', env);

  let controlPlane: ClusterNodeRef;
  let probes: ControlPlaneProbe[] = [];

  // 2. --server must name a manager; no probe runs when it is given.
  if (options.server !== undefined) {
    const named = allServers.find((server) => server.name === options.server);
    if (!named) {
      throw new CLIError(
        `No server named "${options.server}" for environment ${env}`,
        ErrorCode.NO_SERVERS_FOR_ENV,
        `Use one of: ${allManagers.map((manager) => manager.name).join(', ')}`,
      );
    }
    if (named.role === 'worker') {
      throw new ValidationError(
        `${named.name} is a worker (k3s agent); orchestrator commands run on a manager`,
        `Use one of: ${allManagers.map((manager) => manager.name).join(', ')}`,
      );
    }
    const picked = credentialed.find((candidate) => candidate.server.name === named.name);
    if (!picked) throw credentialsErrorFor(`manager ${named.name}`, env);
    controlPlane = picked.node;
  } else if (credentialed.length === 1 || options.failover === false) {
    // 3. one manager, or failover disabled: first manager, no probe.
    controlPlane = credentialed[0].node;
  } else {
    // 4. several managers: probe all concurrently.
    const results = await Promise.all(credentialed.map((candidate) => probeNode(kind, candidate.node, transport, clock)));
    results.forEach((probe) => options.onProbe?.(probe));
    probes = results;
    const pickedIndex = pickReadyIndex(kind, results);
    if (pickedIndex === -1) {
      throw new ConnectionError(`No control-plane node of ${env} is ready`, results.map(probeLine).join('\n'));
    }
    controlPlane = credentialed[pickedIndex].node;
  }

  // 5. workers with SSH credentials.
  const workers: ClusterNodeRef[] = [];
  for (const server of allServers.filter((candidate) => candidate.role === 'worker')) {
    const connection = connectionFor(env, server);
    if (!connection) {
      if (options.requireWorkerCredentials) throw credentialsErrorFor(`worker ${server.name}`, env);
      const message = `Worker ${server.name} has no SSH credentials; skipped`;
      if (options.needsWorkers) printWarning(message);
      else printDebug(message);
      continue;
    }
    workers.push(toNodeRef(server, connection));
  }

  return {
    kind,
    project,
    env,
    stackName,
    controlPlane,
    managers: credentialed.map((candidate) => candidate.node),
    workers,
    probes,
  };
}
