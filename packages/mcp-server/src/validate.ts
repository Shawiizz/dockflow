import { parse as parseYaml } from 'yaml';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function validateServersBlock(
  servers: Record<string, unknown>,
  errors: string[],
  prefix = 'servers',
) {
  if (Object.keys(servers).length === 0) {
    errors.push(`${prefix}: at least one server must be defined`);
    return;
  }

  const tagManagers: Record<string, boolean> = {};

  for (const [name, raw] of Object.entries(servers)) {
    if (!SERVER_NAME_RE.test(name)) {
      errors.push(`${prefix}.${name}: name must be lowercase alphanumeric with hyphens or underscores`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${prefix}.${name}: must be an object`);
      continue;
    }
    const s = raw as Record<string, unknown>;

    if (!s.tags || !Array.isArray(s.tags) || s.tags.length === 0) {
      errors.push(`${prefix}.${name}.tags: required, must be a non-empty array`);
    } else {
      for (const tag of s.tags as string[]) {
        if (!TAG_RE.test(tag)) {
          errors.push(`${prefix}.${name}.tags: "${tag}" must be lowercase alphanumeric with hyphens`);
        }
      }
      const role = (s.role as string | undefined) ?? 'manager';
      if (role === 'manager') {
        for (const tag of s.tags as string[]) tagManagers[tag] = true;
      }
    }

    if (s.role !== undefined && !['manager', 'worker'].includes(s.role as string)) {
      errors.push(`${prefix}.${name}.role: must be "manager" or "worker"`);
    }
    if (s.port !== undefined && (typeof s.port !== 'number' || s.port < 1 || s.port > 65535)) {
      errors.push(`${prefix}.${name}.port: must be a number between 1 and 65535`);
    }
  }

  // Ensure each tag has at least one manager
  for (const [, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (!Array.isArray(s.tags)) continue;
    for (const tag of s.tags as string[]) {
      if (!tagManagers[tag]) {
        errors.push(`${prefix}: tag "${tag}" has no manager server`);
      }
    }
  }
}

function validateConfigBlock(obj: Record<string, unknown>, errors: string[]) {
  // project_name
  if (!obj.project_name) {
    errors.push('project_name: required');
  } else if (typeof obj.project_name !== 'string') {
    errors.push('project_name: must be a string');
  } else if (obj.project_name.length > 63) {
    errors.push('project_name: must be 63 characters or less');
  } else if (!PROJECT_NAME_RE.test(obj.project_name)) {
    errors.push('project_name: must be lowercase alphanumeric with hyphens, no leading/trailing hyphens');
  }

  // orchestrator
  if (obj.orchestrator !== undefined && !['swarm', 'k3s'].includes(obj.orchestrator as string)) {
    errors.push('orchestrator: must be "swarm" or "k3s"');
  }

  // container_engine
  if (obj.container_engine !== undefined && !['docker', 'podman'].includes(obj.container_engine as string)) {
    errors.push('container_engine: must be "docker" or "podman"');
  }

  // registry
  if (obj.registry !== undefined) {
    if (typeof obj.registry !== 'object' || Array.isArray(obj.registry)) {
      errors.push('registry: must be an object');
    } else {
      const r = obj.registry as Record<string, unknown>;
      const validTypes = ['local', 'dockerhub', 'ghcr', 'gitlab', 'custom'];
      if (!r.type) {
        errors.push('registry.type: required');
      } else if (!validTypes.includes(r.type as string)) {
        errors.push(`registry.type: must be one of ${validTypes.join(', ')}`);
      } else if (r.type === 'custom' && !r.url) {
        errors.push('registry.url: required when registry.type is "custom"');
      }
    }
  }

  // proxy
  if (obj.proxy !== undefined) {
    if (typeof obj.proxy !== 'object' || Array.isArray(obj.proxy)) {
      errors.push('proxy: must be an object');
    } else {
      const p = obj.proxy as Record<string, unknown>;
      if (p.enabled && p.acme !== false && !p.email) {
        errors.push('proxy.email: required when proxy.enabled is true and acme is not disabled');
      }
      if (p.dashboard && typeof p.dashboard === 'object') {
        const d = p.dashboard as Record<string, unknown>;
        if (d.enabled && !d.domain) {
          errors.push('proxy.dashboard.domain: required when proxy.dashboard.enabled is true');
        }
      }
    }
  }
}

export function validateConfig(content: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${e}`] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['Root must be a YAML object'] };
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  validateConfigBlock(obj, errors);

  // servers block present → root config (dockflow.yml) or servers.yml
  if (obj.servers !== undefined) {
    if (typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
      errors.push('servers: must be an object');
    } else {
      validateServersBlock(obj.servers as Record<string, unknown>, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateServersOnly(content: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${e}`] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, errors: ['Root must be a YAML object'] };
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  if (!obj.servers) {
    errors.push('servers: required');
  } else if (typeof obj.servers !== 'object' || Array.isArray(obj.servers)) {
    errors.push('servers: must be an object');
  } else {
    validateServersBlock(obj.servers as Record<string, unknown>, errors);
  }

  return { valid: errors.length === 0, errors };
}

export function formatValidationResult(result: ValidationResult, filename: string): string {
  if (result.valid) {
    return `✓ ${filename} is valid.`;
  }
  const lines = [`✗ ${filename} has ${result.errors.length} error(s):\n`];
  for (const err of result.errors) {
    lines.push(`  → ${err}`);
  }
  return lines.join('\n');
}
