/**
 * Compose selection — picks services out of a compose, reads the external networks and volumes
 * it declares, and parses container ports.
 */

import { isRecord } from './yaml';
import type { ParsedCompose } from './types';

/**
 * Parse the container port from a docker-compose port entry.
 *
 * Supported formats:
 *   "80"                 → 80
 *   "8080:80"            → 80
 *   "0.0.0.0:8080:80"   → 80
 *   "127.0.0.1:8080:80" → 80
 *   "80/tcp"             → 80
 *   "8080:80/tcp"        → 80
 *   { target: 80 }       → 80   (long syntax)
 */
export function parseContainerPort(port: unknown): number {
  if (port && typeof port === 'object') return Number((port as Record<string, unknown>).target);
  const raw = String(port);
  const withoutProto = raw.split('/')[0];
  const parts = withoutProto.split(':');
  return parseInt(parts[parts.length - 1], 10);
}

/**
 * Return a shallow copy of compose containing only the specified services.
 * Networks and volumes are kept intact so external resource creation still works.
 */
export function filterServices(compose: ParsedCompose, filter: string[]): ParsedCompose {
  const filterSet = new Set(filter);
  return {
    ...compose,
    services: Object.fromEntries(
      Object.entries(compose.services).filter(([name]) => filterSet.has(name)),
    ),
  };
}

/** External networks or volumes, by the name docker knows them: `name:` when set, else the key. */
function externalNames(section: Record<string, unknown> | undefined): string[] {
  if (!isRecord(section)) return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(section)) {
    if (!isRecord(value) || value.external !== true) continue;
    names.push(typeof value.name === 'string' && value.name !== '' ? value.name : key);
  }
  return names;
}

export function getExternalNetworks(compose: ParsedCompose): string[] {
  return externalNames(compose.networks);
}

/**
 * The external networks Dockflow creates before a deploy. The default network of one of the
 * project's stacks is left out: that stack's deploy creates it, and fails if it already exists.
 */
export function externalNetworksToCreate(compose: ParsedCompose, appStackName: string): string[] {
  const createdByTheirStack = new Set([`${appStackName}_default`, `${appStackName}-accessories_default`]);
  return getExternalNetworks(compose).filter((name) => !createdByTheirStack.has(name));
}

export function getExternalVolumes(compose: ParsedCompose): string[] {
  return externalNames(compose.volumes);
}

export function hasServices(compose: ParsedCompose): boolean {
  return Object.keys(compose.services).length > 0;
}
