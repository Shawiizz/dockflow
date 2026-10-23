/** Zod schema of servers.yml (and of the servers part of the flat dockflow.yml). */

import { z } from 'zod';
import { isIpOrCidr } from './config.schema';

// templates see these names lowercased
const ENV_VAR_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** zod reports a record key that fails its schema as "Invalid key in record": say the key's own rule. */
const recordKeyMessage = { error: (issue: z.core.$ZodRawIssue) => (issue.code === 'invalid_key' ? issue.issues[0]?.message : undefined) };

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

export const ServerRoleSchema = z.enum(['manager', 'worker']).describe(
  'Role in Docker Swarm cluster: manager (orchestrates) or worker (runs containers)'
);

const TAG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export const ServerConfigSchema = z.object({
  role: ServerRoleSchema.optional().default('manager').describe(
    'Server role in Swarm cluster (default: manager)'
  ),

  host: z.string()
    .optional()
    .describe('Server hostname or IP address (can be overridden by CI secrets)'),

  private_host: z.string()
    .refine((address) => !address.includes('/') && isIpOrCidr(address), { message: 'must be an IP address, e.g. 10.0.0.5' })
    .optional()
    .describe('Private IP address of the server: Swarm traffic between nodes goes through it, SSH still uses host'),

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

export const EnvByTagSchema = z.record(
  z.string(), // a tag name or 'all'
  EnvVarsSchema
).optional().describe('Environment variables grouped by tag');

/** Without the manager-per-tag check, so RootConfigSchema can merge it. */
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

/** True when every tag in use has at least one manager. */
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

export const ServersConfigSchema = ServersBaseSchema.refine(
  validateManagerPerTag,
  { message: 'Each environment tag must have at least one manager server' }
);
