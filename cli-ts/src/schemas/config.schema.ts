/**
 * Schema validation for .dockflow/config.yml
 * Uses Zod for runtime type checking and validation
 */

import { z } from 'zod';

/**
 * Registry configuration schema
 * Supports: local, dockerhub, ghcr, gitlab, custom
 */
export const RegistryConfigSchema = z.object({
  type: z.enum(['local', 'dockerhub', 'ghcr', 'gitlab', 'custom']).describe(
    'Registry type: local (no push), dockerhub, ghcr, gitlab, or custom'
  ),
  url: z.string().url().optional().describe('Registry URL (required for custom type)'),
  username: z.string().optional().describe('Registry username'),
  password: z.string().optional().describe('Registry password (use CI secrets in production)'),
  enabled: z.boolean().optional().default(true).describe('Enable/disable registry push'),
  namespace: z.string().optional().describe('Image namespace/organization'),
  token: z.string().optional().describe('Registry token (alternative to password)'),
}).refine(
  (data) => {
    // Custom registry requires URL
    if (data.type === 'custom' && !data.url) {
      return false;
    }
    return true;
  },
  { message: 'Custom registry type requires a URL' }
);

/**
 * Build options schema
 */
export const BuildOptionsSchema = z.object({
  remote_build: z.boolean().optional().default(false).describe(
    'Build images on the remote server instead of locally'
  ),
  image_auto_tag: z.boolean().optional().default(true).describe(
    'Automatically append -<env>:<version> to image names (e.g., myapp-production:1.0.0)'
  ),
  enable_debug_logs: z.boolean().optional().default(false).describe(
    'Enable verbose debug logging during deployment'
  ),
});

/**
 * Health check endpoint schema
 */
export const HealthCheckEndpointSchema = z.object({
  url: z.string().describe('URL to check (can include Jinja2 templates)'),
  name: z.string().optional().describe('Human-readable name for this endpoint'),
  expected_status: z.number().int().min(100).max(599).optional().default(200).describe(
    'Expected HTTP status code'
  ),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']).optional().default('GET').describe(
    'HTTP method to use'
  ),
  timeout: z.number().int().positive().optional().default(30).describe(
    'Request timeout in seconds'
  ),
  validate_certs: z.boolean().optional().default(true).describe(
    'Validate SSL certificates'
  ),
  retries: z.number().int().min(1).max(20).optional().default(3).describe(
    'Number of retry attempts'
  ),
  retry_delay: z.number().int().min(1).max(60).optional().default(5).describe(
    'Delay between retries in seconds'
  ),
});

/**
 * Health checks configuration schema
 */
export const HealthCheckConfigSchema = z.object({
  enabled: z.boolean().optional().default(true).describe(
    'Enable/disable health checks'
  ),
  on_failure: z.enum(['notify', 'rollback', 'fail', 'ignore']).optional().default('notify').describe(
    'Action on health check failure: notify (log only), rollback (revert), fail (stop), ignore'
  ),
  startup_delay: z.number().int().min(0).max(300).optional().default(10).describe(
    'Seconds to wait before running health checks'
  ),
  wait_for_internal: z.boolean().optional().default(true).describe(
    'Wait for Docker Swarm internal healthchecks before running endpoint checks'
  ),
  endpoints: z.array(HealthCheckEndpointSchema).optional().default([]).describe(
    'List of endpoints to check'
  ),
});

/**
 * Template file configuration schema
 * Supports either a simple string (src = dest) or an object with src/dest
 */
export const TemplateFileSchema = z.union([
  z.string().describe('File path to render in-place (src = dest)'),
  z.object({
    src: z.string().describe('Source file path (relative to project root)'),
    dest: z.string().describe('Destination file path (relative to project root)'),
  }),
]);

/**
 * Hooks configuration schema
 */
export const HooksConfigSchema = z.object({
  enabled: z.boolean().optional().default(true).describe(
    'Enable/disable hooks execution'
  ),
  timeout: z.number().int().min(1).max(3600).optional().default(300).describe(
    'Maximum execution time for hooks in seconds'
  ),
  'pre-build': z.string().optional().describe(
    'Script to run before building images'
  ),
  'post-build': z.string().optional().describe(
    'Script to run after building images'
  ),
  'pre-deploy': z.string().optional().describe(
    'Script to run before deploying stack'
  ),
  'post-deploy': z.string().optional().describe(
    'Script to run after successful deployment'
  ),
});

/**
 * Stack management schema
 */
export const StackManagementSchema = z.object({
  keep_releases: z.number().int().min(1).max(50).optional().default(3).describe(
    'Number of previous releases to retain'
  ),
  cleanup_on_failure: z.boolean().optional().default(true).describe(
    'Clean up failed deployment images'
  ),
});

/**
 * Lock configuration schema
 */
export const LockConfigSchema = z.object({
  stale_threshold_minutes: z.number().int().min(1).max(1440).optional().default(30).describe(
    'Minutes after which a deployment lock is considered stale (default: 30)'
  ),
});

/**
 * Supported database types for backup/restore
 */
export const BackupDbType = z.enum(['postgres', 'mysql', 'mongodb', 'redis', 'raw', 'volume']);

/**
 * Backup configuration for a single accessory service
 */
export const BackupAccessorySchema = z.object({
  type: BackupDbType.describe(
    'Database type: postgres, mysql, mongodb, redis, raw (custom command), or volume (Docker volumes)'
  ),
  dump_command: z.string().optional().describe(
    'Custom dump command (required for raw type, overrides default for other types)'
  ),
  restore_command: z.string().optional().describe(
    'Custom restore command (required for raw type, overrides default for other types)'
  ),
  dump_options: z.string().optional().describe(
    'Additional options passed to the dump command (e.g., "--no-owner --clean")'
  ),
  restore_options: z.string().optional().describe(
    'Additional options passed to the restore command'
  ),
  exclude_volumes: z.array(z.string()).optional().describe(
    'Volume name patterns to exclude from backup (only for volume type)'
  ),
  include_bind_mounts: z.boolean().optional().default(true).describe(
    'Include host bind mounts in volume backup (default: true, only for volume type)'
  ),
}).refine(
  (data) => {
    if (data.type === 'raw' && !data.dump_command) return false;
    if (data.type === 'raw' && !data.restore_command) return false;
    return true;
  },
  { message: 'Raw backup type requires both dump_command and restore_command' }
);

/**
 * Backup/restore configuration schema
 */
export const BackupConfigSchema = z.object({
  retention_count: z.number().int().min(1).max(1000).optional().default(10).describe(
    'Number of backups to retain per service (used by prune command)'
  ),
  compression: z.enum(['gzip', 'none']).optional().default('gzip').describe(
    'Compression method for backups'
  ),
  accessories: z.record(z.string(), BackupAccessorySchema).optional().describe(
    'Per-accessory backup configuration (key = service name from accessories.yml)'
  ),
  services: z.record(z.string(), BackupAccessorySchema).optional().describe(
    'Per-service backup configuration for main stack services (key = service name from docker-compose.yml)'
  ),
});

/**
 * Traefik dashboard configuration schema
 */
export const ProxyDashboardSchema = z.object({
  enabled: z.boolean().optional().default(false).describe(
    'Enable the Traefik dashboard'
  ),
  domain: z.string().optional().describe(
    'Domain to expose the Traefik dashboard on (required if enabled)'
  ),
}).refine(
  (data) => !data.enabled || !!data.domain,
  { message: 'proxy.dashboard.domain is required when proxy.dashboard.enabled is true' }
);

/**
 * Reverse proxy configuration schema (Traefik + Let's Encrypt)
 */
export const ProxyConfigSchema = z.object({
  enabled: z.boolean().optional().default(false).describe(
    'Enable automatic HTTPS routing via Traefik'
  ),
  email: z.string().email().optional().describe(
    'Email address for Let\'s Encrypt certificate notifications (required when enabled)'
  ),
  domains: z.record(z.string(), z.string()).optional().describe(
    'Domain per environment, e.g. { production: "app.example.com", staging: "staging.example.com" }'
  ),
  dashboard: ProxyDashboardSchema.optional().describe(
    'Traefik dashboard configuration'
  ),
}).refine(
  (data) => !data.enabled || !!data.email,
  { message: 'proxy.email is required when proxy.enabled is true' }
);

/**
 * Project name validation pattern
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens
 */
const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Complete Dockflow configuration schema
 */
export const DockflowConfigSchema = z.object({
  project_name: z.string()
    .min(1, 'Project name is required')
    .max(63, 'Project name must be 63 characters or less (DNS label limit)')
    .regex(
      PROJECT_NAME_REGEX,
      'Project name must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a hyphen.'
    )
    .describe('Unique project identifier used for stack naming'),
  
  registry: RegistryConfigSchema.optional().describe(
    'Docker registry configuration for image storage'
  ),
  
  options: BuildOptionsSchema.optional().describe(
    'Build and deployment options'
  ),

  stack_management: StackManagementSchema.optional().describe(
    'Stack release management settings'
  ),

  health_checks: HealthCheckConfigSchema.optional().describe(
    'Health check configuration for deployment verification'
  ),
  
  hooks: HooksConfigSchema.optional().describe(
    'Lifecycle hooks for custom scripts'
  ),

  lock: LockConfigSchema.optional().describe(
    'Deployment lock settings'
  ),

  backup: BackupConfigSchema.optional().describe(
    'Backup/restore configuration for accessories'
  ),

  templates: z.array(TemplateFileSchema).optional().describe(
    'List of files to render with Jinja2 templating before deployment'
  ),

  proxy: ProxyConfigSchema.optional().describe(
    'Automatic HTTPS proxy configuration (Traefik + Let\'s Encrypt)'
  ),
});

/**
 * Type inference from schema
 */
export type DockflowConfigInput = z.input<typeof DockflowConfigSchema>;
export type DockflowConfigOutput = z.output<typeof DockflowConfigSchema>;
