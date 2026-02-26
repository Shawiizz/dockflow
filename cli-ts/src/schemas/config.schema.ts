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

  templates: z.array(TemplateFileSchema).optional().describe(
    'List of files to render with Jinja2 templating before deployment'
  ),
});

/**
 * Type inference from schema
 */
export type DockflowConfigInput = z.input<typeof DockflowConfigSchema>;
export type DockflowConfigOutput = z.output<typeof DockflowConfigSchema>;
