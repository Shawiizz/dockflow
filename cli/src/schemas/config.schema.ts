/**
 * Schema validation for .dockflow/config.yml
 * Uses Zod for runtime type checking and validation
 */

import { z } from 'zod';
import { parsePortSpec } from '../utils/port-spec';

/**
 * Registry configuration schema
 * Supports: local, dockerhub, ghcr, gitlab, custom
 */
export const RegistryConfigSchema = z.object({
  type: z.enum(['local', 'dockerhub', 'ghcr', 'gitlab', 'custom']).describe(
    'Registry type: local (no push), dockerhub, ghcr, gitlab, or custom'
  ),
  url: z.string().optional().describe('Registry hostname or URL (required for custom type)'),
  username: z.string().optional().describe('Registry username'),
  password: z.string().optional().describe('Registry password (use CI secrets in production)'),
  enabled: z.boolean().optional().default(true).describe('Enable/disable registry push'),
  namespace: z.string().optional().describe('Image namespace/organization'),
  token: z.string().optional().describe('Registry token (alternative to password)'),
  additional_tags: z.array(z.string()).optional().describe(
    'Additional tags to push besides the version tag. Supports variables: {version}, {env}, {branch}, {sha}'
  ),
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
  remote: z.boolean().optional().default(false).describe(
    'Run the check via SSH curl on the remote server instead of locally — useful for non-public endpoints (e.g. localhost ports, internal services)'
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
  timeout: z.number().int().min(10).max(600).optional().describe(
    'Swarm health check timeout in seconds (default: 120)'
  ),
  interval: z.number().int().min(1).max(60).optional().describe(
    'Swarm health check poll interval in seconds (default: 5)'
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
export const HookEntrySchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional().describe('Label shown in the deploy output'),
    run: z.string().optional().describe('Inline command to run'),
    script: z.string().optional().describe('Script path, relative to the project root'),
    fatal: z.boolean().optional().describe('Abort the deploy if this entry fails'),
    timeout: z.number().int().min(1).max(3600).optional().describe('Timeout for this entry, in seconds'),
  }).refine(
    (e) => (e.run === undefined) !== (e.script === undefined),
    { message: 'a hook entry needs exactly one of `run` or `script`' },
  ),
]);

const hookPhase = (when: string) =>
  z.array(HookEntrySchema).optional().describe(`Entries to run ${when}`);

export const HooksConfigSchema = z.object({
  enabled: z.boolean().optional().default(true).describe(
    'Enable/disable hooks execution'
  ),
  timeout: z.number().int().min(1).max(3600).optional().default(300).describe(
    'Maximum execution time for hooks in seconds'
  ),
  fatal: z.boolean().optional().default(false).describe(
    'Default fatality for entries that do not set their own (default: false — warnings only)'
  ),
  'pre-build': hookPhase('before building images'),
  'post-build': hookPhase('after building images'),
  'pre-upload': hookPhase('on the server before files are uploaded'),
  'post-upload': hookPhase('on the server after files are uploaded'),
  'pre-deploy': hookPhase('on the server before the stack is deployed'),
  'post-deploy': hookPhase('on the server after a successful deployment'),
  'on-failure': hookPhase('on the server after a failed deployment, once rollbacks are done'),
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

const IPV4_ADDRESS = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_ADDRESS = /^(?=.*:)[0-9a-fA-F:.]+$/;

/** An IPv4 or IPv6 address, or a CIDR range of one (`173.245.48.0/20`, `2400:cb00::/32`) */
export function isIpOrCidr(value: string): boolean {
  const [address = '', prefix, extra] = value.split('/');
  if (extra !== undefined) return false;
  const v4 = IPV4_ADDRESS.test(address);
  if (!v4 && !(IPV6_ADDRESS.test(address) && address.split('::').length <= 2)) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128);
}

/** A host name as Traefik's Host() matches it: dot-separated labels of letters, digits and hyphens */
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * A route Traefik serves for one service, beside the default route of proxy.domains
 */
export const ProxyRouteSchema = z.object({
  service: z.string().min(1).describe(
    'Service of docker-compose.yml or accessories.yml the requests go to'
  ),
  domains: z.record(
    z.string(),
    z.string().regex(HOST_NAME, { message: 'must be a domain name, e.g. panel.example.com' })
  ).describe(
    'Domain per environment, e.g. { production: "panel.example.com" }; the route is left out of the environments not listed'
  ),
  // `docker stack deploy` would read a `$` as a variable: /a$b would become /a
  path: z.string().regex(/^\/[^\s`$]*$/, { message: 'must start with / and contain no spaces, backticks or $' }).optional().describe(
    'Only the requests whose path starts with this prefix, e.g. /ws; the path reaches the service unchanged'
  ),
  port: z.number().int().min(1).max(65535).optional().describe(
    'Container port the requests go to; it does not need to be published. Defaults to the first port of the service (ports, then expose)'
  ),
});

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
  acme: z.boolean().optional().default(true).describe(
    'Enable ACME/Let\'s Encrypt TLS certificates. Set to false for HTTP-only (dev/test environments)'
  ),
  domains: z.record(z.string(), z.string()).optional().describe(
    'Domain per environment, e.g. { production: "app.example.com", staging: "staging.example.com" }'
  ),
  routes: z.array(ProxyRouteSchema).optional().describe(
    'Routes of their own for chosen services: a domain per environment, a path, a port. A service listed here gets no route on proxy.domains'
  ),
  dashboard: ProxyDashboardSchema.optional().describe(
    'Traefik dashboard configuration'
  ),
  trusted_ips: z.array(
    z.string().refine(isIpOrCidr, { message: 'must be an IP address or a CIDR range, e.g. 173.245.48.0/20' })
  ).optional().describe(
    'Addresses of a CDN or load balancer in front of Traefik: Traefik keeps the X-Forwarded-* headers they send, so apps see the client address'
  ),
}).refine(
  (data) => !data.enabled || data.acme === false || !!data.email,
  { message: 'proxy.email is required when proxy.enabled is true and acme is not disabled' }
);

const PortValueSchema = z.union([z.number(), z.string()]).refine(
  (value) => parsePortSpec(value) !== null,
  { message: 'must be a port or a range within 1-65535, with /tcp or /udp when needed: 443, 51820/udp, 8000-8010/tcp' }
);

/**
 * A published port the internet may reach. The object form is strict: a misspelled `from` would
 * otherwise open the port to everyone.
 */
export const PublicPortSchema = z.union([
  PortValueSchema,
  z.object({
    port: PortValueSchema,
    from: z.array(
      z.string().refine(isIpOrCidr, { message: 'must be an IP address or a CIDR range, e.g. 173.245.48.0/20' })
    ).min(1).optional().describe('Addresses or CIDR ranges the port answers; any address when absent'),
  }).strict(),
]);

/**
 * Filter of the internet traffic to published container ports (Swarm hosts set up by dockflow setup)
 */
export const FirewallConfigSchema = z.object({
  public_ports: z.array(PublicPortSchema).optional().describe(
    'Published container ports the internet may reach; the others answer only locally and on private networks. ' +
    'Traefik\'s ports are added when proxy.enabled is true'
  ),
});

/**
 * Webhook notification configuration schema
 */
export const WebhookConfigSchema = z.object({
  url: z.string().url().describe(
    'Webhook URL to POST to after deployment'
  ),
  on: z.array(z.enum(['success', 'failure', 'always'])).optional().default(['always']).describe(
    'When to fire: "success", "failure", or "always" (default)'
  ),
  secret: z.string().optional().describe(
    'Optional HMAC-SHA256 secret — adds X-Dockflow-Signature header to the request'
  ),
  headers: z.record(z.string(), z.string()).optional().describe(
    'Additional HTTP headers to send with the request'
  ),
  timeout: z.number().int().min(1).max(60).optional().default(10).describe(
    'Request timeout in seconds (default: 10)'
  ),
});

/**
 * Notifications configuration schema
 */
export const NotificationsConfigSchema = z.object({
  webhooks: z.array(WebhookConfigSchema).optional().default([]).describe(
    'List of webhook endpoints to notify after each deployment'
  ),
});

/**
 * Project name validation pattern
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens
 */
const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Extras — files/directories to transfer to the remote server before deploying.
 * Useful for config files referenced as bind mounts in docker-compose volumes.
 */
export const PluginUseSchema = z.object({
  use: z.string().min(1).describe(
    'Plugin to use: a name (looked up in .dockflow/plugins/, then among built-in plugins) or a path starting with ./ or ../'
  ),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens only').optional().describe(
    'Instance id, required when one plugin is used more than once. Defaults to the plugin name.'
  ),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
    'Values for the inputs the plugin declares'
  ),
}).strict();

export const UploadItemSchema = z.object({
  src: z.string().describe('Local path relative to project root (file or directory)'),
  dest: z.string()
    .refine(v => v.startsWith('/') || v.includes('{{'), { message: 'dest must be an absolute path (starting with /)' })
    .describe('Absolute destination path on the remote server (Nunjucks templates allowed)'),
  service: z.union([z.string(), z.array(z.string())]).optional()
    .describe('Service(s) this upload belongs to. When --services is used, only uploads matching a targeted service are transferred.'),
  permissions: z.string().optional()
    .describe('File permissions to apply after upload, in octal notation (e.g. "640", "755").'),
  owner: z.string().optional()
    .describe('File owner to apply after upload, in "user" or "user:group" format (e.g. "mosquitto", "www-data:www-data").'),
  exclude: z.array(z.string()).optional()
    .describe('Glob patterns or directory/file names to skip during upload (e.g. ".git", "*.md", "node_modules").'),
  compress: z.boolean().optional()
    .describe('Compress the archive during transfer (default: true). Set to false for repos of already-compressed files (JARs, ZIPs) to reduce CPU overhead.'),
});

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

  orchestrator: z.enum(['swarm', 'k3s'])
    .optional()
    .default('swarm')
    .describe('Orchestration backend: "swarm" (Docker Swarm, default) or "k3s" (lightweight Kubernetes)'),

  container_engine: z.enum(['docker', 'podman'])
    .optional()
    .describe('Container engine for building & distributing images. Auto-detected on the remote if not set.'),

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
    'List of files to render with Nunjucks templating before deployment'
  ),

  plugins: z.array(PluginUseSchema).optional().describe(
    'Plugins that contribute uploads and hook entries to the deployment'
  ),

  proxy: ProxyConfigSchema.optional().describe(
    'Automatic HTTPS proxy configuration (Traefik + Let\'s Encrypt)'
  ),

  firewall: FirewallConfigSchema.optional().describe(
    'Which published container ports the internet may reach (Swarm)'
  ),

  notifications: NotificationsConfigSchema.optional().describe(
    'Post-deployment notification webhooks'
  ),

  uploads: z.array(UploadItemSchema).optional().describe(
    'Files or directories to transfer to the remote server before deploying. ' +
    'Useful for config files referenced as bind mounts in docker-compose volumes.'
  ),

  no_services: z.boolean().optional().describe(
    'Set to true for projects with no Docker services (upload-only deployments). ' +
    'Skips Docker build, compose deploy, and all service commands. ' +
    'Without this flag, a missing docker-compose.yml is treated as a configuration error.'
  ),
});
