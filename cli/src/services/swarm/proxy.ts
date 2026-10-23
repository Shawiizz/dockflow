/**
 * Swarm proxy backend.
 *
 * Deploys Traefik as a Swarm stack when `config.proxy.enabled` is true.
 * Later deploys leave it alone unless its configuration changed: the hash of the
 * generated stack is kept as a label on the service and compared on each deploy.
 */

import { createHash } from 'crypto';

import type { SSHKeyConnection } from '../../types';
import type { ProxyConfig } from '../../utils/config';
import { shellQuote, sshExec, sshExecChannel } from '../../utils/ssh';
import { printDebug, printDim, printSuccess } from '../../utils/output';
import { DeployError, ErrorCode } from '../../utils/errors';
import {
  TRAEFIK_STACK_NAME,
  TRAEFIK_NETWORK_NAME,
  TRAEFIK_CERTS_VOLUME,
  TRAEFIK_IMAGE,
  SOCKET_PROXY_IMAGE,
} from '../../constants';


const CONFIG_HASH_LABEL = 'dockflow.config-hash';
const TRAEFIK_SERVICE = `${TRAEFIK_STACK_NAME}_traefik`;
const SERVICE_PORTS_FORMAT = '{{.Spec.Name}}|{{range .Endpoint.Ports}}{{.PublishedPort}}/{{.Protocol}}/{{.PublishMode}} {{end}}';
const SOCKET_PROXY_SERVICE = 'socket-proxy';
const SOCKET_PROXY_NETWORK = 'socket-proxy';

interface PortHolder {
  port: number;
  description: string;
}

interface ServicePort {
  port: number;
  protocol: string;
  mode: string;
}

/** Lines `name|80/tcp/ingress 443/tcp/host ` as SERVICE_PORTS_FORMAT prints them. */
export function parseServicePorts(output: string): Array<{ name: string; ports: ServicePort[] }> {
  const services: Array<{ name: string; ports: ServicePort[] }> = [];
  for (const line of output.split('\n')) {
    const [name, rest = ''] = line.trim().split('|');
    if (!name) continue;
    const ports = rest.split(/\s+/).flatMap((entry) => {
      const [port, protocol, mode] = entry.split('/');
      return port && Number(port) > 0 ? [{ port: Number(port), protocol, mode }] : [];
    });
    services.push({ name, ports });
  }
  return services;
}

/** The TCP listeners of `ss -ltnp`: local port and, when ss may show it, the process name. */
export function parseListeners(output: string): Array<{ port: number; process?: string }> {
  const listeners: Array<{ port: number; process?: string }> = [];
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN' || columns.length < 5) continue;
    const port = Number(columns[3].slice(columns[3].lastIndexOf(':') + 1));
    if (!Number.isInteger(port)) continue;
    listeners.push({ port, process: /users:\(\("([^"]+)"/.exec(line)?.[1] });
  }
  return listeners;
}

export class SwarmProxy {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Ensure the Traefik stack is running with the current configuration.
   * Skips when it already runs with the same generated stack.
   */
  async ensureRunning(proxyConfig: ProxyConfig): Promise<void> {
    const configHash = SwarmProxy.configHash(proxyConfig);
    const state = await this.currentState();
    if (state.replicas === '1/1' && state.configHash === configHash) {
      printDebug('Traefik stack already running');
      return;
    }

    await this.assertPortsFree(proxyConfig, state.replicas !== '');

    printDim(state.replicas ? 'Updating Traefik reverse proxy...' : 'Deploying Traefik reverse proxy...');

    // Create overlay network (idempotent)
    await sshExec(
      this.connection,
      `docker network create --driver overlay --attachable ${TRAEFIK_NETWORK_NAME} 2>/dev/null || true`,
    );

    // Create certs volume if ACME enabled (idempotent)
    const acme = proxyConfig.acme !== false;
    if (acme) {
      await sshExec(
        this.connection,
        `docker volume create ${TRAEFIK_CERTS_VOLUME} 2>/dev/null || true`,
      );
    }

    const { stream, done } = await sshExecChannel(
      this.connection,
      `docker stack deploy --prune --resolve-image changed -c - ${TRAEFIK_STACK_NAME}`,
    );
    stream.end(SwarmProxy.generateCompose(proxyConfig, configHash));
    const result = await done;

    if (result.exitCode !== 0) {
      throw new Error(`Traefik deployment failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    printSuccess('Traefik reverse proxy deployed');
  }

  /**
   * Traefik publishes 80 (and 443 with ACME) on the manager: a port another service or a
   * process already holds would fail the stack deploy with an error that names no one.
   * Traefik's own service holding them is an update. A listener on the host is only looked
   * for on a first install: while Traefik runs, it is the one holding the ports.
   */
  private async assertPortsFree(proxyConfig: ProxyConfig, traefikExists: boolean): Promise<void> {
    const ports = SwarmProxy.publishedPorts(proxyConfig);
    const holders = await this.swarmServiceHolders(ports);
    if (!traefikExists) {
      const known = new Set(holders.map((holder) => holder.port));
      holders.push(...(await this.hostListeners(ports)).filter((holder) => !known.has(holder.port)));
    }
    if (holders.length === 0) return;

    throw new DeployError(
      `Cannot deploy Traefik: ${holders.map((holder) => holder.description).join('; ')}`,
      ErrorCode.DEPLOY_FAILED,
      `Free the port, or move the holder to another one, then deploy again. Traefik needs ${ports.join(' and ')} on the manager.`,
    );
  }

  static publishedPorts(proxyConfig: ProxyConfig): number[] {
    return proxyConfig.acme !== false ? [80, 443] : [80];
  }

  /** Swarm services other than Traefik that publish one of the ports, host mode only when a task runs on a manager. */
  private async swarmServiceHolders(ports: number[]): Promise<PortHolder[]> {
    const listing = await sshExec(
      this.connection,
      `docker service ls -q | xargs -r docker service inspect --format ${shellQuote(SERVICE_PORTS_FORMAT)} 2>/dev/null`,
    );
    if (listing.exitCode !== 0) {
      printDebug(`Could not list the published ports of the Swarm services: ${listing.stderr.trim() || `exit ${listing.exitCode}`}`);
      return [];
    }

    const published = parseServicePorts(listing.stdout)
      .filter((service) => service.name !== TRAEFIK_SERVICE)
      .map((service) => ({ ...service, ports: service.ports.filter((p) => p.protocol === 'tcp' && ports.includes(p.port)) }))
      .filter((service) => service.ports.length > 0);
    if (published.length === 0) return [];

    const managers = published.some((service) => service.ports.some((p) => p.mode === 'host')) ? await this.managerNodes() : new Set<string>();
    const holders: PortHolder[] = [];
    for (const service of published) {
      for (const { port, mode } of service.ports) {
        if (mode === 'host' && !(await this.runsOn(service.name, managers))) continue;
        holders.push({
          port,
          description: `port ${port} is already published by the Swarm service "${service.name}"${mode === 'host' ? ' (host mode, on a manager)' : ''}`,
        });
      }
    }
    return holders;
  }

  private async managerNodes(): Promise<Set<string>> {
    const result = await sshExec(this.connection, `docker node ls --filter role=manager --format '{{.Hostname}}' 2>/dev/null`);
    return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  }

  private async runsOn(service: string, nodes: Set<string>): Promise<boolean> {
    const result = await sshExec(
      this.connection,
      `docker service ps ${shellQuote(service)} --filter desired-state=running --format '{{.Node}}' 2>/dev/null`,
    );
    return result.stdout.split('\n').some((line) => nodes.has(line.trim()));
  }

  /** Listeners on the manager itself, by process name when `ss` may show it. Without `ss`, nothing is reported. */
  private async hostListeners(ports: number[]): Promise<PortHolder[]> {
    const result = await sshExec(this.connection, 'ss -ltnp 2>/dev/null');
    if (result.exitCode !== 0) {
      printDebug('ss is not available on the manager: the ports 80 and 443 were not checked for other listeners');
      return [];
    }
    const listeners = parseListeners(result.stdout).filter((listener) => ports.includes(listener.port));
    // IPv4 and IPv6 sockets of one process are two lines
    return listeners
      .filter((listener, i) => listeners.findIndex((other) => other.port === listener.port) === i)
      .map((listener) => ({
        port: listener.port,
        description: listener.process
          ? `port ${listener.port} is already in use on the manager by "${listener.process}"`
          : `port ${listener.port} is already in use on the manager by a process Dockflow cannot name (run \`ss -ltnp\` as root there to see it)`,
      }));
  }

  /** Replicas of the Traefik service (empty when absent) and the config hash it was deployed with. */
  private async currentState(): Promise<{ replicas: string; configHash: string }> {
    const service = TRAEFIK_SERVICE;
    const [replicas, labels] = await Promise.all([
      sshExec(this.connection, `docker service ls --filter ${shellQuote(`name=${service}`)} --format '{{.Replicas}}' 2>/dev/null`),
      sshExec(this.connection, `docker service inspect ${shellQuote(service)} --format '{{index .Spec.Labels "${CONFIG_HASH_LABEL}"}}' 2>/dev/null`),
    ]);
    return { replicas: replicas.stdout.trim(), configHash: labels.exitCode === 0 ? labels.stdout.trim() : '' };
  }

  /** A short hash of the stack generated for this configuration. */
  static configHash(proxyConfig: ProxyConfig): string {
    return createHash('sha256').update(SwarmProxy.generateCompose(proxyConfig)).digest('hex').slice(0, 16);
  }

  /**
   * Generate the Traefik docker-compose YAML from config.
   * With a config hash, the service carries it as a label.
   */
  static generateCompose(proxyConfig: ProxyConfig, configHash?: string): string {
    const acme = proxyConfig.acme !== false;
    const dashboard = proxyConfig.dashboard?.enabled === true;
    const dashboardDomain = proxyConfig.dashboard?.domain;

    const command: string[] = [
      '--providers.swarm=true',
      // Traefik answers the internet: it reads Swarm through the read-only proxy, never the socket
      `--providers.swarm.endpoint=tcp://${SOCKET_PROXY_SERVICE}:2375`,
      '--providers.swarm.exposedByDefault=false',
      `--providers.swarm.network=${TRAEFIK_NETWORK_NAME}`,
      '--entrypoints.web.address=:80',
    ];

    if (acme) {
      command.push(
        '--entrypoints.websecure.address=:443',
        '--entrypoints.web.http.redirections.entrypoint.to=websecure',
        '--entrypoints.web.http.redirections.entrypoint.scheme=https',
        ...(proxyConfig.email ? [`--certificatesresolvers.letsencrypt.acme.email=${proxyConfig.email}`] : []),
        '--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
        '--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web',
      );
    }

    // the client address arrives in X-Forwarded-For from a CDN, which Traefik only keeps from trusted senders
    const trusted = proxyConfig.trusted_ips ?? [];
    if (trusted.length > 0) {
      for (const entrypoint of acme ? ['web', 'websecure'] : ['web']) {
        command.push(`--entrypoints.${entrypoint}.forwardedHeaders.trustedIPs=${trusted.join(',')}`);
      }
    }

    if (dashboard) {
      command.push('--api.dashboard=true');
    }

    // Ports
    const ports: Array<{ target: number; published: number; protocol: string; mode: string }> = [
      { target: 80, published: 80, protocol: 'tcp', mode: 'host' },
    ];
    if (acme) {
      ports.push({ target: 443, published: 443, protocol: 'tcp', mode: 'host' });
    }

    // Volumes
    const volumes: string[] = [];
    if (acme) {
      volumes.push(`${TRAEFIK_CERTS_VOLUME}:/letsencrypt`);
    }

    // Deploy labels
    const labels: string[] = ['traefik.enable=false'];
    if (dashboard && dashboardDomain) {
      labels.length = 0; // Remove the disable label
      labels.push(
        'traefik.enable=true',
        `traefik.http.routers.traefik-dashboard.rule=Host(\`${dashboardDomain}\`)`,
        'traefik.http.routers.traefik-dashboard.service=api@internal',
      );
      if (acme) {
        labels.push(
          'traefik.http.routers.traefik-dashboard.entrypoints=websecure',
          'traefik.http.routers.traefik-dashboard.tls.certresolver=letsencrypt',
        );
      } else {
        labels.push('traefik.http.routers.traefik-dashboard.entrypoints=web');
      }
    }

    if (configHash) {
      labels.push(`${CONFIG_HASH_LABEL}=${configHash}`);
    }

    // Build the compose structure as YAML
    // Using string template for precise control over output format
    const commandYaml = command.map((c) => `      - "${c}"`).join('\n');
    const portsYaml = ports
      .map((p) => `      - target: ${p.target}\n        published: ${p.published}\n        protocol: ${p.protocol}\n        mode: ${p.mode}`)
      .join('\n');
    const volumesYaml = volumes.length > 0 ? `    volumes:\n${volumes.map((v) => `      - ${v}`).join('\n')}\n` : '';
    const labelsYaml = labels.map((l) => `        - "${l}"`).join('\n');

    // The proxy holds the socket read-only and answers GET requests on the parts of the Docker
    // API the Swarm provider reads (POST stays off), on a network only Traefik joins.
    let yaml = `version: "3.8"

services:
  traefik:
    image: ${TRAEFIK_IMAGE}
    command:
${commandYaml}
    ports:
${portsYaml}
${volumesYaml}    networks:
      - ${TRAEFIK_NETWORK_NAME}
      - ${SOCKET_PROXY_NETWORK}
    deploy:
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure
      labels:
${labelsYaml}

  ${SOCKET_PROXY_SERVICE}:
    image: ${SOCKET_PROXY_IMAGE}
    environment:
      SERVICES: "1"
      TASKS: "1"
      NETWORKS: "1"
      NODES: "1"
      INFO: "1"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - ${SOCKET_PROXY_NETWORK}
    deploy:
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure

networks:
  ${TRAEFIK_NETWORK_NAME}:
    external: true
  ${SOCKET_PROXY_NETWORK}:
    driver: overlay
    internal: true`;

    if (acme) {
      yaml += `

volumes:
  ${TRAEFIK_CERTS_VOLUME}:
    external: true`;
    }

    return yaml;
  }
}
