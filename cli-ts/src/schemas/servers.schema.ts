/**
 * Schema validation for .deployment/servers.yml
 * Uses Zod for runtime type checking and validation
 */

import { z } from 'zod';

/**
 * Environment variables dictionary schema
 * Keys must be valid environment variable names
 */
const ENV_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

export const EnvVarsSchema = z.record(
  z.string().regex(
    ENV_VAR_NAME_REGEX,
    'Environment variable names must be uppercase, start with a letter, and contain only letters, numbers, and underscores'
  ),
  z.string()
).describe('Environment variables key-value pairs');

/**
 * Server role schema
 */
export const ServerRoleSchema = z.enum(['manager', 'worker']).describe(
  'Role in Docker Swarm cluster: manager (orchestrates) or worker (runs containers)'
);

/**
 * Tag validation - lowercase alphanumeric with hyphens
 */
const TAG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Single server configuration schema
 */
export const ServerConfigSchema = z.object({
  role: ServerRoleSchema.optional().default('manager').describe(
    'Server role in Swarm cluster (default: manager)'
  ),
  
  host: z.string()
    .optional()
    .describe('Server hostname or IP address (can be overridden by CI secrets)'),
  
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
 * Complete servers.yml configuration schema
 */
export const ServersConfigSchema = z.object({
  servers: z.record(
    z.string()
      .min(1, 'Server name cannot be empty')
      .max(63, 'Server name must be 63 characters or less')
      .regex(
        /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/,
        'Server name must be lowercase alphanumeric with hyphens or underscores'
      ),
    ServerConfigSchema
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
}).refine(
  (config) => {
    // Ensure at least one manager exists for each unique tag
    const tagManagers: Record<string, boolean> = {};
    
    for (const [, server] of Object.entries(config.servers)) {
      const role = server.role ?? 'manager';
      if (role === 'manager') {
        for (const tag of server.tags) {
          tagManagers[tag] = true;
        }
      }
    }
    
    // Check all tags have at least one manager
    for (const [, server] of Object.entries(config.servers)) {
      for (const tag of server.tags) {
        if (!tagManagers[tag]) {
          return false;
        }
      }
    }
    
    return true;
  },
  { message: 'Each environment tag must have at least one manager server' }
);

/**
 * Type inference from schema
 */
export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfigOutput = z.output<typeof ServerConfigSchema>;
export type ServersConfigInput = z.input<typeof ServersConfigSchema>;
export type ServersConfigOutput = z.output<typeof ServersConfigSchema>;
