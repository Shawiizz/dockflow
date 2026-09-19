/**
 * Swarm ImageBackend (DESIGN-CORE 6.1): today's transfer of locally built images
 * (services/distribution.ts), the registry login on the manager, and the docker listings and prunes
 * of `list images` and `prune`, now run on every node they are given. Swarm never removed images
 * after a deploy: `remove` and `collectGarbage` leave them to `dockflow prune`.
 */

import { DeployError, ErrorCode } from '../../../utils/errors';
import { type ContainerRuntime, distributeAll, type LocalEngine, registryLoginOn } from '../../distribution';
import type { ClusterNodeRef, ImageBackend, NodeImage, OrchestratorTarget, RegistryCredentials, StackRef } from '../interfaces';
import { errorText, firstLine, parseByteSize, runSwarmQuery, type SwarmSsh, swarmSsh } from './swarm-utils';

export const SWARM_DETECT_PODMAN_COMMAND = 'which podman 2>/dev/null';
/**
 * Full image ids of every container, running or not: an image they use is not prunable. A container
 * removed between the two commands is not an error.
 */
export const SWARM_IMAGES_IN_USE_COMMAND = "docker ps -aq | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null || true";
export const SWARM_DISK_USAGE_COMMAND = "docker system df --format '{{json .}}'";
export const SWARM_PRESENT_IMAGES_COMMAND = "docker images --format '{{.Repository}}:{{.Tag}}'";

export type RuntimePruneTarget = 'containers' | 'volumes' | 'networks';

const RUNTIME_PRUNE: Readonly<Record<RuntimePruneTarget, { command: string; what: string }>> = {
  containers: { command: 'docker container prune -f', what: 'Container prune' },
  volumes: { command: 'docker volume prune -f', what: 'Volume prune' },
  networks: { command: 'docker network prune -f', what: 'Network prune' },
};

export function swarmImageListCommand(all: boolean): string {
  return `docker images${all ? ' -a' : ''} --no-trunc --format '{{json .}}'`;
}

export function swarmImagePruneCommand(all: boolean): string {
  return `docker image prune -f${all ? ' -a' : ''}`;
}

/** `Total reclaimed space: 1.2GB` of a docker prune; null when docker printed none. */
export function parseReclaimed(stdout: string): string | null {
  const match = /Total reclaimed space: (.+)/.exec(stdout);
  return match ? match[1].trim() : null;
}

function field(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' && value !== '<none>' ? value : null;
}

function jsonRow(line: string): Record<string, unknown> | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  return row !== null && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : null;
}

/** One `docker images --format '{{json .}}'` row; an untagged image is shown only with `all`. */
export function parseImageLsLine(line: string, inUse: ReadonlySet<string>, all: boolean): NodeImage | null {
  const row = jsonRow(line);
  if (row === null) return null;
  const id = field(row, 'ID');
  const repository = field(row, 'Repository');
  const tag = field(row, 'Tag');
  const digest = field(row, 'Digest');
  if (id === null) return null;
  let ref: string;
  if (repository !== null && tag !== null) ref = `${repository}:${tag}`;
  else if (!all) return null;
  else if (repository !== null) ref = digest !== null ? `${repository}@${digest}` : repository;
  else ref = id;
  return { ref, id, sizeBytes: parseByteSize(field(row, 'Size') ?? ''), inUse: inUse.has(id) };
}

/** The Images row of `docker system df --format '{{json .}}'`: `3.1GB used by images, 1.2GB (40%) reclaimable`. */
export function parseSystemDf(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const row = line.trim() ? jsonRow(line.trim()) : null;
    if (row === null || field(row, 'Type') !== 'Images') continue;
    const size = field(row, 'Size');
    if (size === null) return null;
    const reclaimable = field(row, 'Reclaimable');
    return `${size} used by images${reclaimable ? `, ${reclaimable} reclaimable` : ''}`;
  }
  return null;
}

/** `redis` -> `redis:latest`, `docker.io/library/redis:7` -> `redis:7`, as `docker images` shows them. */
export function dockerShortRef(ref: string): string {
  let name = ref.trim().replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');
  const lastSegment = name.slice(name.lastIndexOf('/') + 1);
  if (!name.includes('@') && !lastSegment.includes(':')) name = `${name}:latest`;
  return name;
}

export interface SwarmImageBackendOptions {
  /** default: the real SSH transport; also carries the image transfer */
  ssh?: SwarmSsh;
  /** `container_engine` of config.yml; detected on the manager when absent, as before */
  containerEngine?: ContainerRuntime;
  /** default: the local CLI of the same engine */
  localEngine?: LocalEngine;
}

export class SwarmImageBackend implements ImageBackend {
  private readonly ssh: SwarmSsh;
  private engine: Promise<ContainerRuntime> | null = null;

  constructor(
    private readonly target: OrchestratorTarget,
    private readonly options: SwarmImageBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
  }

  async distribute(images: string[], nodes: ClusterNodeRef[]): Promise<void> {
    if (images.length === 0 || nodes.length === 0) return;
    const engine = await this.containerEngine();
    const options = this.options.localEngine ? { transport: this.ssh, local: this.options.localEngine } : { transport: this.ssh };
    await distributeAll(images, nodes, engine, options);
  }

  async verifyPresence(images: string[], nodes: ClusterNodeRef[]): Promise<{ node: string; missing: string[] }[]> {
    if (images.length === 0) return [];
    const reports: { node: string; missing: string[] }[] = [];
    for (const node of nodes) {
      const stdout = await runSwarmQuery(this.ssh, node, this.target.env, SWARM_PRESENT_IMAGES_COMMAND, 'docker images');
      const present = new Set((stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
      const missing = images.filter((image) => !present.has(dockerShortRef(image)));
      if (missing.length > 0) reports.push({ node: node.name, missing });
    }
    return reports;
  }

  /** `docker login` on the manager, so `docker stack deploy --with-registry-auth` can pull. */
  async ensurePullSecret(_ref: StackRef, registry: RegistryCredentials): Promise<string | null> {
    const engine = await this.containerEngine();
    await registryLoginOn(
      this.ssh,
      this.target.controlPlane,
      { url: registry.server, username: registry.username, password: registry.password },
      engine,
    );
    return null;
  }

  async remove(_images: string[], _nodes: ClusterNodeRef[]): Promise<void> {}

  async collectGarbage(_nodes: ClusterNodeRef[], _removed: string[], _kept: string[]): Promise<void> {}

  async list(
    nodes: ClusterNodeRef[],
    options: { all: boolean },
  ): Promise<{ node: string; images: NodeImage[]; diskUsage: string | null }[]> {
    const env = this.target.env;
    return Promise.all(
      nodes.map(async (node) => {
        const [images, used, df] = await Promise.all([
          runSwarmQuery(this.ssh, node, env, swarmImageListCommand(options.all), 'docker images'),
          runSwarmQuery(this.ssh, node, env, SWARM_IMAGES_IN_USE_COMMAND, 'docker inspect'),
          runSwarmQuery(this.ssh, node, env, SWARM_DISK_USAGE_COMMAND, 'docker system df'),
        ]);
        const inUse = new Set((used ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
        const rows: NodeImage[] = [];
        for (const line of (images ?? '').split('\n')) {
          if (!line.trim()) continue;
          const row = parseImageLsLine(line.trim(), inUse, options.all);
          if (row) rows.push(row);
        }
        return { node: node.name, images: rows, diskUsage: parseSystemDf(df ?? '') };
      }),
    );
  }

  prune(nodes: ClusterNodeRef[], options: { all: boolean }): Promise<{ node: string; reclaimed: string | null }[]> {
    return this.pruneEach(nodes, swarmImagePruneCommand(options.all), 'Image prune');
  }

  pruneRuntime(nodes: ClusterNodeRef[], target: RuntimePruneTarget): Promise<{ node: string; reclaimed: string | null }[]> {
    const { command, what } = RUNTIME_PRUNE[target];
    return this.pruneEach(nodes, command, what);
  }

  /** every node is attempted; a failure on one must not read as a success on the others */
  private async pruneEach(
    nodes: ClusterNodeRef[],
    command: string,
    what: string,
  ): Promise<{ node: string; reclaimed: string | null }[]> {
    const outcomes = await Promise.all(
      nodes.map(async (node) => {
        try {
          const result = await this.ssh.exec(node, command);
          if (result.exitCode !== 0) {
            return { node: node.name, error: firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}` };
          }
          return { node: node.name, reclaimed: parseReclaimed(result.stdout) };
        } catch (error) {
          return { node: node.name, error: errorText(error) };
        }
      }),
    );
    const failures = outcomes.flatMap((o) => ('error' in o ? [`${what} failed on ${o.node}: ${o.error}`] : []));
    if (failures.length > 0) throw new DeployError(failures.join('; '), ErrorCode.DEPLOY_FAILED);
    return outcomes.map((o) => ({ node: o.node, reclaimed: 'reclaimed' in o ? (o.reclaimed ?? null) : null }));
  }

  private containerEngine(): Promise<ContainerRuntime> {
    const configured = this.options.containerEngine;
    if (configured) return Promise.resolve(configured);
    if (this.engine === null) {
      const detecting = this.ssh
        .exec(this.target.controlPlane, SWARM_DETECT_PODMAN_COMMAND)
        .then((result): ContainerRuntime => (result.exitCode === 0 && result.stdout.trim() !== '' ? 'podman' : 'docker'));
      // a lost connection is not an answer: the next call asks again
      detecting.catch(() => {
        if (this.engine === detecting) this.engine = null;
      });
      this.engine = detecting;
    }
    return this.engine;
  }
}
