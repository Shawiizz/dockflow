/**
 * Schema validation for .dockflow/servers.yml
 * Uses Zod for runtime type checking and validation
 */

import { z } from 'zod';
import type { Diagnostic } from '../services/orchestrator/diagnostics';
import { isReservedKey, LABEL_KEY_RE, LABEL_VALUE_RE } from '../services/orchestrator/kubernetes/model/units';
import { nodeNameFor } from '../services/orchestrator/kubernetes/naming';
import { M } from '../services/orchestrator/messages';
import type { ServerConfig } from '../types/servers';

/**
 * zod reports a record key that fails its schema as "Invalid key in record" and keeps the key
 * schema's own message nested: surface that message instead.
 */
const recordKeyMessage = { error: (issue: z.core.$ZodRawIssue) => (issue.code === 'invalid_key' ? issue.issues[0]?.message : undefined) };

/**
 * Environment variables dictionary schema
 * Keys must be valid environment variable names (case-insensitive, converted to lowercase internally)
 */
const ENV_VAR_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export const EnvVarsSchema = z.record(
  z.string().regex(
    ENV_VAR_NAME_REGEX,
    'Environment variable names must start with a letter and contain only letters, numbers, and underscores'
  ),
  z.string(),
  recordKeyMessage,
)
  .nullable()
  .transform((val) => val ?? {})
  .describe('Environment variables key-value pairs');

/**
 * Server role schema
 */
export const ServerRoleSchema = z.enum(['manager', 'worker']).describe(
  'Role in the cluster: manager (Swarm manager / k3s server) or worker (Swarm worker / k3s agent)'
);

const KUBERNETES_KEY_RE = /(^|\.)(kubernetes\.io|k8s\.io)\//;

/** Kubernetes label key; the kubernetes.io, k8s.io and Dockflow prefixes belong to the cluster and to Dockflow */
const NodeLabelKeySchema = z.string()
  .max(253, M.labelKeyTooLong)
  .regex(LABEL_KEY_RE, M.labelKey)
  .refine((key) => !KUBERNETES_KEY_RE.test(key) && !isReservedKey(key), M.labelKeyReserved);

// A value that is too long also fails the pattern, which bounds the length: report the length only
const NodeLabelValueSchema = z.string()
  .max(63, { error: M.labelValueTooLong, abort: true })
  .regex(LABEL_VALUE_RE, M.labelValue);

/**
 * Tag validation - lowercase alphanumeric with hyphens
 */
const TAG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Single server configuration schema
 */
export const ServerConfigSchema = z.object({
  role: ServerRoleSchema.optional().default('manager').describe(
    'Server role: manager (Swarm manager / k3s server) or worker (Swarm worker / k3s agent) (default: manager)'
  ),

  host: z.string()
    .optional()
    .describe('Server hostname or IP address (can be overridden by CI secrets)'),

  private_host: z.union([z.ipv4(M.privateHostIp), z.ipv6(M.privateHostIp)], M.privateHostIp)
    .optional()
    .describe('Private IP used for cluster traffic (k3s node-ip, firewall sources, join address). Defaults to host.'),

  node_labels: z.record(NodeLabelKeySchema, NodeLabelValueSchema, recordKeyMessage)
    .optional()
    .describe('Kubernetes node labels applied by dockflow setup (k3s only; ignored on Swarm)'),

  tags: z.array(
    z.string()
      .min(1, 'Tag cannot be empty')
      .max(50, 'Tag must be 50 characters or less')
      .regex(TAG_REGEX, 'Tags must be lowercase alphanumeric with hyphens')
  )
    .min(1, 'At least one tag is required')
    .describe('Environment tags this server belongs to (e.g., production, staging)'),
  
  user: z.string()
    .min(1)
    .max(32)
    .optional()
    .describe('SSH user (overrides defaults.user)'),
  
  port: z.number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe('SSH port (overrides defaults.port)'),
  
  env: EnvVarsSchema.optional().describe(
    'Server-specific environment variables'
  ),
});

/**
 * Default SSH configuration schema
 */
export const ServerDefaultsSchema = z.object({
  user: z.string()
    .min(1, 'Default user is required')
    .max(32, 'Username must be 32 characters or less')
    .default('dockflow')
    .describe('Default SSH user for all servers'),
  
  port: z.number()
    .int()
    .min(1)
    .max(65535)
    .default(22)
    .describe('Default SSH port for all servers'),
});

/**
 * Environment variables by tag schema
 */
export const EnvByTagSchema = z.record(
  z.string(), // tag name or 'all'
  EnvVarsSchema
).optional().describe('Environment variables grouped by tag');

/**
 * Base servers schema (without manager refine) — used for merging into RootConfigSchema
 */
export const ServersBaseSchema = z.object({
  servers: z.record(
    z.string()
      .min(1, 'Server name cannot be empty')
      .max(63, 'Server name must be 63 characters or less')
      .regex(
        /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/,
        'Server name must be lowercase alphanumeric with hyphens or underscores'
      ),
    ServerConfigSchema,
    recordKeyMessage,
  )
    .refine(
      (servers) => Object.keys(servers).length > 0,
      { message: 'At least one server must be defined' }
    )
    .describe('Server definitions keyed by server name'),

  defaults: ServerDefaultsSchema.optional().describe(
    'Default SSH settings for all servers'
  ),

  env: EnvByTagSchema.describe(
    'Environment variables by tag (all, production, staging, etc.)'
  ),
});

export function validateManagerPerTag(config: { servers: Record<string, { role?: string; tags: string[] }> }): boolean {
  const tagManagers: Record<string, boolean> = {};
  for (const server of Object.values(config.servers)) {
    if ((server.role ?? 'manager') === 'manager') {
      for (const tag of server.tags) tagManagers[tag] = true;
    }
  }
  for (const server of Object.values(config.servers)) {
    for (const tag of server.tags) {
      if (!tagManagers[tag]) return false;
    }
  }
  return true;
}

/**
 * Complete servers.yml configuration schema
 */
export const ServersConfigSchema = ServersBaseSchema.refine(
  validateManagerPerTag,
  { message: 'Each environment tag must have at least one manager server' }
);

/** The servers.yml fields the k3s topology rules read; pass hosts after CI overrides when known. */
export type TopologyServer = Pick<ServerConfig, 'role' | 'host' | 'private_host'> & { tags: readonly string[] };

const Ipv6Schema = z.ipv6();

/**
 * The k3s rules that need no node, shared by `dockflow setup`, `dockflow validate <env>` and the MCP
 * validator (DESIGN-CORE 7.2, design-05 2.1). Swarm shares the generic schema, so they are not zod
 * rules: callers run them when `orchestrator: k3s`. Servers outside `env` form another cluster and
 * are ignored.
 */
export function k3sTopologyIssues(servers: Readonly<Record<string, TopologyServer>>, env: string): Diagnostic[] {
  const members = Object.entries(servers).filter(([, server]) => server.tags.includes(env));
  const issues: Diagnostic[] = [];

  // An embedded-etcd cluster of 2n members tolerates no more failures than one of 2n - 1
  const managers = members.filter(([, server]) => (server.role ?? 'manager') === 'manager').length;
  if (managers >= 2 && managers % 2 === 0) {
    issues.push({ severity: 'error', code: 'servers.manager-count', path: 'servers', message: M.managerCount(env, managers) });
  }

  const nodeOwners = new Map<string, string>();
  for (const [key, server] of members) {
    const node = nodeNameFor(key);
    const owner = nodeOwners.get(node);
    if (owner === undefined) {
      nodeOwners.set(node, key);
    } else {
      issues.push({ severity: 'error', code: 'servers.duplicate-node', path: `servers.${key}`, message: M.duplicateNode(owner, key, node) });
    }

    const field = server.private_host !== undefined ? 'private_host' : 'host';
    const address = server.private_host ?? server.host;
    if (address !== undefined && Ipv6Schema.safeParse(address).success) {
      issues.push({
        severity: 'error',
        code: 'servers.ipv6-cluster-address',
        path: `servers.${key}.${field}`,
        message: M.privateHostIpv6K3s(key),
        hint: M.privateHostIpv6K3sSuggestion,
      });
    }
  }
  return issues;
}
