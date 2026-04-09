/**
 * Traefik Service
 *
 * Deploys and manages the Traefik reverse proxy stack on Docker Swarm.
 * Replaces the Ansible role `traefik`.
 *
 * Traefik is deployed as a Swarm stack when `config.proxy.enabled` is true.
 * The stack is deployed once and left running — subsequent deploys only
 * ensure it exists (idempotent).
 */

import type { SSHKeyConnection } from '../types';
import type { ProxyConfig } from '../utils/config';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printDim, printSuccess } from '../utils/output';
import {
  TRAEFIK_STACK_NAME,
  TRAEFIK_NETWORK_NAME,
  TRAEFIK_CERTS_VOLUME,
  TRAEFIK_IMAGE,
} from '../constants';

export class TraefikService {
  constructor(private readonly connection: SSHKeyConnection) {}

  /**
   * Ensure the Traefik stack is deployed and running.
   * Idempotent: skips if the stack already exists with the right replica count.
   */
  async ensureRunning(proxyConfig: ProxyConfig): Promise<void> {
    const running = await this.isRunning();
    if (running) {
      printDebug('Traefik stack already running');
      return;
    }

    printDim('Deploying Traefik reverse proxy...');

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

    // Generate and deploy stack
    const composeYaml = TraefikService.generateCompose(proxyConfig);
    const escaped = shellEscape(composeYaml);
    const result = await sshExec(
      this.connection,
      `echo '${escaped}' | docker stack deploy --prune --resolve-image changed -c - ${TRAEFIK_STACK_NAME}`,
    );

    if (result.exitCode !== 0) {
      throw new Error(`Traefik deployment failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }

    printSuccess('Traefik reverse proxy deployed');
  }

  /**
   * Check if the Traefik stack is already running with 1/1 replica.
   */
  private async isRunning(): Promise<boolean> {
    const result = await sshExec(
      this.connection,
      `docker service ls --filter "name=${TRAEFIK_STACK_NAME}_traefik" --format '{{.Replicas}}' 2>/dev/null`,
    );
    return result.stdout.trim() === '1/1';
  }

  /**
   * Generate the Traefik docker-compose YAML from config.
   */
  static generateCompose(proxyConfig: ProxyConfig): string {
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
    const ports: object[] = [
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

    // Build the compose structure as YAML
    // Using string template for precise control over output format
    const commandYaml = command.map((c) => `      - "${c}"`).join('\n');
    const portsYaml = ports
      .map((p: any) => `      - target: ${p.target}\n        published: ${p.published}\n        protocol: ${p.protocol}\n        mode: ${p.mode}`)
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
