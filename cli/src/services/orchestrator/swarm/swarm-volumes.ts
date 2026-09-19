/**
 * Read-only Swarm VolumeBackend (DESIGN-CORE 6.1): `accessories list` and `accessories remove`
 * display the stack volumes through it, because commands never call docker directly. Removal stays
 * with `accessories remove --volumes` (the stack backend); `remove` here refuses (R-05).
 */

import { UnsupportedOperationError } from '../../../utils/errors';
import { shellQuote } from '../../../utils/ssh';
import { capabilityRefusal } from '../capabilities';
import type {
  ClusterNodeRef,
  OrchestratorTarget,
  StackNaming,
  StackRole,
  VolumeBackend,
  VolumeInfo,
  VolumeRemovalReport,
  VolumeScope,
} from '../interfaces';
import { swarmNaming } from './swarm-naming';
import { runSwarmQuery, type SwarmSsh, swarmSsh } from './swarm-utils';

export interface SwarmVolumeBackendOptions {
  /** default: the real SSH transport */
  ssh?: SwarmSsh;
  naming?: StackNaming;
}

export function volumeListCommand(scope: string): string {
  return `docker volume ls --filter ${shellQuote(`label=com.docker.stack.namespace=${scope}`)} --format '{{json .}}'`;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' && value !== 'N/A' ? value : null;
}

/**
 * One `docker volume ls --format '{{json .}}'` row. Docker reports no phase, reclaim policy or
 * users for a volume, so those stay unknown; a `local` volume lives on the node it was listed on.
 */
export function parseVolumeLsLine(
  line: string,
  context: { scope: string; role: StackRole; node: ClusterNodeRef },
): VolumeInfo | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const name = stringField(record, 'Name');
  if (name === null) return null;
  const prefix = `${context.scope}_`;
  return {
    name,
    composeName: name.startsWith(prefix) ? name.slice(prefix.length) : null,
    role: context.role,
    phase: 'Unknown',
    capacity: stringField(record, 'Size'),
    storageClass: stringField(record, 'Driver'),
    node: stringField(record, 'Scope') === 'local' ? context.node.name : null,
    reclaimPolicy: null,
    usedBy: [],
    hostPath: stringField(record, 'Mountpoint'),
  };
}

export class SwarmVolumeBackend implements VolumeBackend {
  private readonly ssh: SwarmSsh;
  private readonly naming: StackNaming;

  constructor(
    private readonly target: OrchestratorTarget,
    options: SwarmVolumeBackendOptions = {},
  ) {
    this.ssh = options.ssh ?? swarmSsh;
    this.naming = options.naming ?? swarmNaming;
  }

  /** Volumes of the role's stack on the control plane, as `docker volume ls` showed them before. */
  async list(scope: VolumeScope): Promise<VolumeInfo[]> {
    // Swarm has no namespaces: a namespace override names nothing Swarm holds
    if (scope.namespace !== undefined) return [];
    const roles: StackRole[] = scope.role === null ? ['app', 'accessory'] : [scope.role];
    const node = this.target.controlPlane;
    const volumes: VolumeInfo[] = [];
    for (const role of roles) {
      const stack = this.naming.scope({ project: scope.project, env: scope.env, role });
      const stdout = await runSwarmQuery(this.ssh, node, this.target.env, volumeListCommand(stack), 'docker volume ls');
      for (const line of (stdout ?? '').split('\n')) {
        if (!line.trim()) continue;
        const info = parseVolumeLsLine(line.trim(), { scope: stack, role, node });
        if (info) volumes.push(info);
      }
    }
    return volumes;
  }

  async remove(_scope: VolumeScope, _names: string[]): Promise<VolumeRemovalReport> {
    const { message, suggestion } = capabilityRefusal('volumes', 'dockflow volumes rm');
    throw new UnsupportedOperationError(message, suggestion);
  }
}
