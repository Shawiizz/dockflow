/**
 * Schema validation for .dockflow/config.yml
 * Uses Zod for runtime type checking and validation
 */

import { posix } from 'path';
import { z } from 'zod';
import { M } from '../services/orchestrator/messages';

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

/** Proxy keys that only the Kubernetes Traefik implements; Swarm's Traefik is per stack. */
export const K3S_ONLY_PROXY_KEYS = ['manage', 'acme_ca_server', 'acme_ca_bundle', 'default_ingress_class'] as const;

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
  dashboard: ProxyDashboardSchema.optional().describe(
    'Traefik dashboard configuration'
  ),
  manage: z.boolean().optional().default(true).describe(
    'k3s only. true (default): this stack installs and updates the cluster Traefik. ' +
    'false: this stack uses the Traefik another stack manages and never changes it'
  ),
  acme_ca_server: z.url({ protocol: /^https$/, error: M.acmeCaServerHttps }).optional().describe(
    'k3s only. ACME directory URL; unset means Let\'s Encrypt production. ' +
    'Use https://acme-staging-v02.api.letsencrypt.org/directory to rehearse, or a private CA'
  ),
  acme_ca_bundle: z.string().min(1, M.acmeCaBundlePath).optional().describe(
    'k3s only. Project path of the PEM bundle that signs acme_ca_server when it is not publicly trusted; ' +
    'under .dockflow/ or listed in templates'
  ),
  default_ingress_class: z.boolean().optional().default(false).describe(
    'k3s only. Make IngressClass traefik the cluster default, so Ingress objects in any namespace ' +
    'that omit ingressClassName are published on 80/443'
  ),
}).superRefine((proxy, ctx) => {
  // A stack that does not manage the proxy never registers an ACME account
  if (proxy.enabled && proxy.acme !== false && proxy.manage !== false && !proxy.email) {
    ctx.addIssue({ code: 'custom', message: 'proxy.email is required when proxy.enabled is true and acme is not disabled' });
  }
  if (proxy.manage === false && !proxy.enabled) {
    ctx.addIssue({ code: 'custom', message: M.proxyManageNeedsEnabled, path: ['manage'] });
  }
  if (proxy.acme === false) {
    for (const key of ['acme_ca_server', 'acme_ca_bundle'] as const) {
      if (proxy[key] !== undefined) ctx.addIssue({ code: 'custom', message: M.acmeCaNeedsAcme, path: [key] });
    }
  }
  if (proxy.acme_ca_bundle !== undefined && proxy.acme_ca_server === undefined) {
    ctx.addIssue({ code: 'custom', message: M.acmeCaBundleNeedsServer, path: ['acme_ca_bundle'] });
  }
});

// ---------------------------------------------------------------------------
// Helm releases (k3s only)
// ---------------------------------------------------------------------------

/** Go durations as Helm's --timeout reads them: `90s`, `5m`, `1h30m` */
export const DURATION_RE = /^([0-9]+(\.[0-9]+)?(ms|s|m|h))+$/;
/** DNS-1123 label without its length limit; Helm release names stop at 53, namespaces at 63 */
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** One exact SemVer 2.0 version with an optional leading v: no range, no wildcard, no latest */
export const EXACT_SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const CHART_DIGEST_RE = /^[a-f0-9]{64}$/;

export const HelmReleaseSchema = z.object({
  name: z.string()
    .max(53, M.helmNameTooLong)
    .regex(DNS_LABEL_RE, M.helmName)
    .describe('Helm release name, unique across roles; addressed by --only, rollback and dockflow helm'),
  chart: z.string().min(1, M.helmChart).describe(
    'Chart name inside repo, or an OCI reference oci://<registry>/<path>/<chart> without tag or digest'
  ),
  repo: z.url({ protocol: /^https?$/, error: M.helmRepoUrl }).optional().describe(
    'Chart repository URL (http:// or https://); required unless chart starts with oci://'
  ),
  // YAML reads `version: 1.2` as a number: the exact-version message says more than a type error
  version: z.string(M.exactVersion).regex(EXACT_SEMVER_RE, M.exactVersion).describe(
    'Exact chart version such as 1.2.3 or v1.2.3 (no ranges, no latest)'
  ),
  digest: z.string().regex(CHART_DIGEST_RE, M.chartDigest).optional().describe(
    'Expected sha256 of the chart archive (.tgz), 64 lowercase hexadecimal characters'
  ),
  role: z.enum(['app', 'accessory']).optional().default('app').describe(
    'app: deployed, rolled back and uninstalled with the application; accessory: deployed with --accessories, never uninstalled implicitly'
  ),
  namespace: z.string()
    .max(63, M.namespaceLabel)
    .regex(DNS_LABEL_RE, M.namespaceLabel)
    .optional()
    .describe('Target namespace (default: the stack namespace)'),
  values: z.record(z.string(), z.unknown()).optional().default({}).describe(
    'Chart values, merged after values_files; rendered with the rest of config.yml'
  ),
  values_files: z.array(z.string().min(1, M.valuesFilePath)).optional().default([]).describe(
    'Values files merged in order; each must be under .dockflow/ or listed in templates, so it is rendered'
  ),
  timeout: z.string().regex(DURATION_RE, M.duration).optional().describe(
    'Helm --timeout for this release (default: helm.timeout)'
  ),
  auth: z.object({
    username: z.string().min(1, M.helmAuthField),
    password: z.string().min(1, M.helmAuthField),
  }).optional().describe(
    'Basic auth for repo, or the registry login for an oci:// chart; never stored in releases or logs'
  ),
}).strict();

export const HelmConfigSchema = z.object({
  timeout: z.string().regex(DURATION_RE, M.duration).optional().default('5m').describe(
    'Default Helm --timeout of every release'
  ),
  releases: z.array(HelmReleaseSchema).optional().default([]).describe(
    'Helm releases, applied in list order'
  ),
}).strict();

/**
 * Whether `path` reaches the rendered file map: every file under .dockflow/ and every templates
 * destination is rendered with Nunjucks, nothing else is. A values file or CA bundle outside that
 * set would be read as nothing (the render map has no entry for it), so the schema refuses it.
 */
export function isRenderedPath(path: string, templates: ReadonlyArray<string | { src: string; dest: string }> | undefined): boolean {
  const target = normalizeProjectPath(path);
  if (target.startsWith('.dockflow/')) return true;
  return (templates ?? []).some((t) => normalizeProjectPath(typeof t === 'string' ? t : t.dest) === target);
}

function normalizeProjectPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, '/'));
}

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
 * Dockflow configuration schema without its cross-field rules (see DockflowConfigSchema)
 */
export const DockflowConfigBaseSchema = z.object({
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

  helm: HelmConfigSchema.optional().describe(
    'Helm releases deployed with the stack (orchestrator: k3s only)'
  ),
});

type DockflowConfigOutput = z.output<typeof DockflowConfigBaseSchema>;

/** Rules that span several sections of config.yml (DESIGN-CORE 7.1, design-04 2.3.1). */
function checkConfigRules(config: DockflowConfigOutput, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: PropertyKey[]): void => {
    ctx.addIssue({ code: 'custom', message, path });
  };
  const k3s = config.orchestrator === 'k3s';

  if (config.helm !== undefined && !k3s) issue(M.helmRequiresK3s, ['helm']);
  const seen = new Set<string>();
  (config.helm?.releases ?? []).forEach((release, i) => {
    const at = (...rest: PropertyKey[]): PropertyKey[] => ['helm', 'releases', i, ...rest];
    if (seen.has(release.name)) issue(M.helmDuplicateName(release.name), at('name'));
    seen.add(release.name);
    const oci = release.chart.startsWith('oci://');
    if (oci && release.repo !== undefined) issue(M.helmRepoWithOci, at('repo'));
    if (!oci && release.repo === undefined) issue(M.helmRepoRequired, at('repo'));
    release.values_files.forEach((file, j) => {
      if (file !== '' && !isRenderedPath(file, config.templates)) {
        issue(M.valuesFileUnrendered(file), at('values_files', j));
      }
    });
  });

  if (k3s && config.options?.remote_build === true) issue(M.remoteBuildK3s, ['options', 'remote_build']);

  const proxy = config.proxy;
  if (proxy === undefined) return;
  if (!k3s) {
    // Only values that differ from the defaults: zod has filled the defaults in already
    const written = {
      manage: proxy.manage === false,
      acme_ca_server: proxy.acme_ca_server !== undefined,
      acme_ca_bundle: proxy.acme_ca_bundle !== undefined,
      default_ingress_class: proxy.default_ingress_class === true,
    };
    for (const key of K3S_ONLY_PROXY_KEYS) {
      if (written[key]) issue(M.proxyKeyRequiresK3s(`proxy.${key}`), ['proxy', key]);
    }
  }
  const bundle = proxy.acme_ca_bundle;
  if (bundle !== undefined && bundle !== '' && !isRenderedPath(bundle, config.templates)) {
    issue(M.acmeCaBundleUnrendered(bundle), ['proxy', 'acme_ca_bundle']);
  }
}

/**
 * Complete Dockflow configuration schema
 */
export const DockflowConfigSchema = DockflowConfigBaseSchema.superRefine(checkConfigRules);

// zod 4's merge() drops refinements, and dockflow.yml (flat layout) is validated by this schema
// merged with the servers schema: every merge result keeps the cross-field rules.
const mergeWithoutRules = DockflowConfigSchema.merge;
DockflowConfigSchema.merge = ((other: z.ZodObject) =>
  mergeWithoutRules(other).superRefine((value, ctx) => checkConfigRules(value as DockflowConfigOutput, ctx))) as typeof mergeWithoutRules;
