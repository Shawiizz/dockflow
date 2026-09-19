/**
 * Swarm proxy backend.
 *
 * Deploys Traefik as a Swarm stack when `config.proxy.enabled` is true, on the swarm the control
 * plane belongs to. Later deploys leave it alone unless its configuration changed: the hash of the
 * generated stack is kept as a label on the service and compared on each deploy.
 */

import { createHash } from 'crypto';

import { TRAEFIK_CERTS_VOLUME, TRAEFIK_IMAGE, TRAEFIK_NETWORK_NAME, TRAEFIK_STACK_NAME } from '../../../constants';
import type { ProxyConfig } from '../../../utils/config';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { printDebug, printDim, printSuccess } from '../../../utils/output';
import { shellQuote } from '../../../utils/ssh';
import type {
  HelmEventSink,
  OrchestratorTarget,
  ProxyBackend,
  ProxyEnsureResult,
  ProxyPlan,
  ProxyStatus,
} from '../interfaces';
import { execWithStdin } from './swarm-stack-ops';
import { type SwarmExecResult, type SwarmSsh, swarmSsh, swarmTransportError } from './swarm-utils';

const CONFIG_HASH_LABEL = 'dockflow.config-hash';
const TRAEFIK_SERVICE = `${TRAEFIK_STACK_NAME}_traefik`;

export interface SwarmProxyBackendOptions {
  /** default: the real SSH transport */
  ssh?: SwarmSsh;
}

/** What the running Traefik service reports; every field empty when it is not deployed. */
export interface SwarmProxyState {
  /** `1/1`; '' when the service does not exist */
  replicas: string;
  image: string;
  configHash: string;
  args: string[];
}

/** `traefik:v3.6@sha256:...` -> `v3.6`; null without a tag. */
export function imageTag(image: string): string | null {
  const reference = image.split('@')[0];
  const colon = reference.lastIndexOf(':');
  if (colon < 0 || colon < reference.lastIndexOf('/')) return null;
  return reference.slice(colon + 1) || null;
}

function parseArgs(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** ProxyStatus of a Swarm Traefik; Swarm has no owner record, reclaim policy or recorded node. */
export function swarmProxyStatus(state: SwarmProxyState): ProxyStatus {
  const installed = state.replicas !== '';
  const ready = state.replicas === '1/1';
  const entryPoints = state.args
    .map((arg) => /^--entrypoints\.([^.=]+)\.address=/.exec(arg)?.[1])
    .filter((name): name is string => name !== undefined);
  const status: ProxyStatus = {
    installed,
    ready,
    version: installed ? imageTag(state.image) : null,
    owner: null,
    entryPoints: [...new Set(entryPoints)],
    acme: state.args.some((arg) => arg.startsWith('--certificatesresolvers.letsencrypt.acme.')),
    acmeReclaimPolicy: null,
  };
  if (installed && !ready) status.detail = `Traefik runs ${state.replicas} replicas`;
  return status;
}

export class SwarmProxyBackend implements ProxyBackend {
  private readonly ssh: SwarmSsh;

  constructor(
    private readonly target: OrchestratorTarget,
    options: SwarmProxyBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
  }

  /** Read-only: whether `ensure()` would deploy Traefik, and why. */
  async plan(proxy: ProxyConfig, _env: string): Promise<ProxyPlan> {
    const state = await this.currentState();
    const status = swarmProxyStatus(state);
    const base = { status, blockers: [], warnings: [], node: null };
    if (!status.installed) return { ...base, action: 'install', reason: 'Traefik is not deployed' };
    if (state.configHash !== SwarmProxyBackend.configHash(proxy)) {
      return { ...base, action: 'upgrade', reason: 'the proxy configuration changed' };
    }
    if (!status.ready) return { ...base, action: 'upgrade', reason: `Traefik runs ${state.replicas} replicas` };
    return { ...base, action: 'unchanged', reason: 'Traefik already runs this configuration' };
  }

  /**
   * Ensures the Traefik stack runs with the current configuration; skips when it already runs the
   * same generated stack. Progress goes to `events` when given, else to today's output lines.
   */
  async ensure(proxy: ProxyConfig, env: string, events?: HelmEventSink): Promise<ProxyEnsureResult> {
    const plan = await this.plan(proxy, env);
    if (plan.action === 'unchanged') {
      printDebug('Traefik stack already running');
      return { changed: false, action: 'unchanged', version: plan.status.version };
    }

    const step = plan.status.installed ? 'Updating Traefik reverse proxy...' : 'Deploying Traefik reverse proxy...';
    if (events) events.step(step);
    else printDim(step);

    await this.run(`docker network create --driver overlay --attachable ${shellQuote(TRAEFIK_NETWORK_NAME)} 2>/dev/null || true`);
    if (proxy.acme !== false) {
      await this.run(`docker volume create ${shellQuote(TRAEFIK_CERTS_VOLUME)} 2>/dev/null || true`);
    }

    const compose = SwarmProxyBackend.generateCompose(proxy, SwarmProxyBackend.configHash(proxy));
    let result: SwarmExecResult;
    try {
      result = await execWithStdin(
        this.ssh,
        this.target.controlPlane,
        `docker stack deploy --prune --resolve-image changed -c - ${shellQuote(TRAEFIK_STACK_NAME)}`,
        compose,
      );
    } catch (error) {
      throw swarmTransportError(this.target.controlPlane, this.target.env, error);
    }
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Traefik deployment failed: ${result.stderr.trim() || result.stdout.trim()}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    if (!events) printSuccess('Traefik reverse proxy deployed');
    return { changed: true, action: plan.action, version: imageTag(TRAEFIK_IMAGE) };
  }

  async status(): Promise<ProxyStatus> {
    return swarmProxyStatus(await this.currentState());
  }

  private async run(command: string): Promise<SwarmExecResult> {
    try {
      return await this.ssh.exec(this.target.controlPlane, command);
    } catch (error) {
      throw swarmTransportError(this.target.controlPlane, this.target.env, error);
    }
  }

  private async currentState(): Promise<SwarmProxyState> {
    const [listed, inspected] = await Promise.all([
      this.run(
        `docker service ls --filter ${shellQuote(`name=${TRAEFIK_SERVICE}`)} --format '{{.Replicas}}|{{.Image}}' 2>/dev/null`,
      ),
      this.run(
        `docker service inspect ${shellQuote(TRAEFIK_SERVICE)} --format '{{index .Spec.Labels "${CONFIG_HASH_LABEL}"}}|{{json .Spec.TaskTemplate.ContainerSpec.Args}}' 2>/dev/null`,
      ),
    ]);
    const [replicas = '', image = ''] = (listed.stdout.trim().split('\n')[0] ?? '').split('|');
    let configHash = '';
    let args: string[] = [];
    if (inspected.exitCode === 0) {
      const text = inspected.stdout.trim();
      const pipe = text.indexOf('|');
      configHash = (pipe < 0 ? text : text.slice(0, pipe)).trim();
      args = pipe < 0 ? [] : parseArgs(text.slice(pipe + 1));
    }
    return { replicas: replicas.trim(), image: image.trim(), configHash, args };
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
