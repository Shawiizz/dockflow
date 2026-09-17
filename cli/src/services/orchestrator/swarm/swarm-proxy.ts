/**
 * Swarm proxy backend.
 *
 * Deploys Traefik as a Swarm stack when `config.proxy.enabled` is true.
 * Later deploys leave it alone unless its configuration changed: the hash of the
 * generated stack is kept as a label on the service and compared on each deploy.
 */

import { createHash } from 'crypto';

import type { SSHKeyConnection } from '../../../types';
import type { ProxyConfig } from '../../../utils/config';
import { sshExec, sshExecChannel } from '../../../utils/ssh';
import { printDebug, printDim, printSuccess } from '../../../utils/output';
import {
  TRAEFIK_STACK_NAME,
  TRAEFIK_NETWORK_NAME,
  TRAEFIK_CERTS_VOLUME,
  TRAEFIK_IMAGE,
} from '../../../constants';

import type { ProxyBackend } from '../interfaces';

const CONFIG_HASH_LABEL = 'dockflow.config-hash';

export class SwarmProxyBackend implements ProxyBackend {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Ensure the Traefik stack is running with the current configuration.
   * Skips when it already runs with the same generated stack.
   */
  async ensureRunning(proxyConfig: ProxyConfig): Promise<void> {
    const configHash = SwarmProxyBackend.configHash(proxyConfig);
    const state = await this.currentState();
    if (state.replicas === '1/1' && state.configHash === configHash) {
      printDebug('Traefik stack already running');
      return;
    }

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
    stream.end(SwarmProxyBackend.generateCompose(proxyConfig, configHash));
    const result = await done;

    if (result.exitCode !== 0) {
      throw new Error(`Traefik deployment failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    printSuccess('Traefik reverse proxy deployed');
  }

  /** Replicas of the Traefik service (empty when absent) and the config hash it was deployed with. */
  private async currentState(): Promise<{ replicas: string; configHash: string }> {
    const service = `${TRAEFIK_STACK_NAME}_traefik`;
    const [replicas, labels] = await Promise.all([
      sshExec(this.connection, `docker service ls --filter "name=${service}" --format '{{.Replicas}}' 2>/dev/null`),
      sshExec(this.connection, `docker service inspect ${service} --format '{{index .Spec.Labels "${CONFIG_HASH_LABEL}"}}' 2>/dev/null`),
    ]);
    return { replicas: replicas.stdout.trim(), configHash: labels.exitCode === 0 ? labels.stdout.trim() : '' };
  }

  /** A short hash of the stack generated for this configuration. */
  static configHash(proxyConfig: ProxyConfig): string {
    return createHash('sha256').update(SwarmProxyBackend.generateCompose(proxyConfig)).digest('hex').slice(0, 16);
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
      '--providers.swarm.exposedByDefault=false',
      `--providers.swarm.network=${TRAEFIK_NETWORK_NAME}`,
      '--entrypoints.web.address=:80',
    ];

    if (acme) {
      command.push(
        '--entrypoints.websecure.address=:443',
        '--entrypoints.web.http.redirections.entrypoint.to=websecure',
        '--entrypoints.web.http.redirections.entrypoint.scheme=https',
        `--certificatesresolvers.letsencrypt.acme.email=${proxyConfig.email}`,
        '--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json',
        '--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web',
      );
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
    const volumes: string[] = ['/var/run/docker.sock:/var/run/docker.sock:ro'];
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
    const volumesYaml = volumes.map((v) => `      - ${v}`).join('\n');
    const labelsYaml = labels.map((l) => `        - "${l}"`).join('\n');

    let yaml = `version: "3.8"

services:
  traefik:
    image: ${TRAEFIK_IMAGE}
    command:
${commandYaml}
    ports:
${portsYaml}
    volumes:
${volumesYaml}
    networks:
      - ${TRAEFIK_NETWORK_NAME}
    deploy:
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure
      labels:
${labelsYaml}

networks:
  ${TRAEFIK_NETWORK_NAME}:
    external: true`;

    if (acme) {
      yaml += `

volumes:
  ${TRAEFIK_CERTS_VOLUME}:
    external: true`;
    }

    return yaml;
  }
}
