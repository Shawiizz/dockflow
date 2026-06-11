/**
 * Validation utilities for YAML configuration files
 * Provides user-friendly error messages and formatting
 */

import { z } from 'zod';
import { colors } from '../utils/output';
import { DockflowConfigSchema } from './config.schema';
import { ServersConfigSchema } from './servers.schema';
import { RootConfigSchema } from './root-config.schema';
import type { RootConfig } from './root-config.schema';
import type { Result } from '../types';
import { ok, err } from '../types';

/**
 * Validation error with path and message
 */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/**
 * Format Zod path to readable string
 */
function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return 'root';

  return path.map((segment, index) => {
    if (typeof segment === 'number') {
      return `[${segment}]`;
    }
    if (typeof segment === 'symbol') {
      return `[Symbol(${segment.description ?? ''})]`;
    }
    return index === 0 ? segment : `.${segment}`;
  }).join('');
}

/**
 * Transform Zod errors to ValidationIssues
 */
function transformZodErrors(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Format validation errors for console output
 */
export function formatValidationErrors(errors: ValidationIssue[], fileName: string): string {
  const lines: string[] = [
    '',
    colors.error(`\u2717 Validation failed for ${fileName}`),
    '',
  ];

  for (const error of errors) {
    lines.push(colors.warning(`  \u2192 ${error.path}`));
    lines.push(`    ${error.message}`);
    lines.push('');
  }

  lines.push(colors.dim('  Run `dockflow config validate` for detailed validation'));

  return lines.join('\n');
}

/**
 * Validate config.yml content
 */
export function validateConfig(data: unknown): Result<z.output<typeof DockflowConfigSchema>, ValidationIssue[]> {
  const result = DockflowConfigSchema.safeParse(data);

  if (result.success) {
    return ok(result.data);
  }

  return err(transformZodErrors(result.error));
}

/**
 * Validate servers.yml content
 */
export function validateServersConfig(data: unknown): Result<z.output<typeof ServersConfigSchema>, ValidationIssue[]> {
  const result = ServersConfigSchema.safeParse(data);

  if (result.success) {
    return ok(result.data);
  }

  return err(transformZodErrors(result.error));
}

/**
 * Validate dockflow.yml content (merged config + servers)
 */
export function validateRootConfig(data: unknown): Result<RootConfig, ValidationIssue[]> {
  const result = RootConfigSchema.safeParse(data);

  if (result.success) {
    return ok(result.data);
  }

  return err(transformZodErrors(result.error));
}

// ---------------------------------------------------------------------------
// Unknown key detection
//
// Zod strips unknown keys silently, so a typo like `retention:` instead of
// `retention_count:` passes validation and the setting is ignored. These
// helpers walk the schema alongside the raw YAML data and report keys the
// schema does not declare, with a "did you mean" suggestion when a close
// match exists.
// ---------------------------------------------------------------------------

export interface UnknownKey {
  path: string;
  suggestion?: string;
}

/** Peel optional/nullable/default wrappers to reach the underlying schema. */
function unwrapSchema(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/** Levenshtein distance — small inputs only (config key names). */
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function closestKey(key: string, candidates: string[]): string | undefined {
  // Prefix relationship first: `retention` → `retention_count`,
  // `destination` → `dest`. Require 3+ shared chars to avoid noise.
  let bestPrefix: string | undefined;
  let bestPrefixDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (Math.min(key.length, candidate.length) < 3) continue;
    if (!candidate.startsWith(key) && !key.startsWith(candidate)) continue;
    const distance = editDistance(key, candidate);
    if (distance < bestPrefixDistance) {
      bestPrefixDistance = distance;
      bestPrefix = candidate;
    }
  }
  if (bestPrefix) return bestPrefix;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only suggest near-misses — a completely different word is not a typo
  return bestDistance <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

/**
 * Recursively collect keys present in `data` that the schema does not declare.
 * Records accept arbitrary keys (only their values are walked), and unions are
 * skipped entirely — a missed warning beats a false positive.
 */
export function findUnknownKeys(schema: z.ZodType, data: unknown, basePath = ''): UnknownKey[] {
  const resolved = unwrapSchema(schema);

  if (resolved instanceof z.ZodObject) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
    const shape = resolved.shape as Record<string, z.ZodType>;
    const knownKeys = Object.keys(shape);
    const unknown: UnknownKey[] = [];
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const path = basePath ? `${basePath}.${key}` : key;
      if (key in shape) {
        unknown.push(...findUnknownKeys(shape[key], value, path));
      } else {
        unknown.push({ path, suggestion: closestKey(key, knownKeys) });
      }
    }
    return unknown;
  }

  if (resolved instanceof z.ZodArray) {
    if (!Array.isArray(data)) return [];
    const element = resolved.element as z.ZodType;
    return data.flatMap((item, i) => findUnknownKeys(element, item, `${basePath}[${i}]`));
  }

  if (resolved instanceof z.ZodRecord) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
    const valueType = resolved.valueType as z.ZodType;
    return Object.entries(data as Record<string, unknown>).flatMap(([key, value]) =>
      findUnknownKeys(valueType, value, basePath ? `${basePath}.${key}` : key),
    );
  }

  return [];
}

/** Unknown keys in config.yml content */
export function findUnknownConfigKeys(data: unknown): UnknownKey[] {
  return findUnknownKeys(DockflowConfigSchema, data);
}

/** Unknown keys in servers.yml content */
export function findUnknownServersKeys(data: unknown): UnknownKey[] {
  return findUnknownKeys(ServersConfigSchema, data);
}

/** Unknown keys in dockflow.yml (flat layout) content */
export function findUnknownRootKeys(data: unknown): UnknownKey[] {
  return findUnknownKeys(RootConfigSchema, data);
}

/**
 * Get human-readable suggestions for common errors
 */
export function getSuggestion(issue: ValidationIssue): string | null {
  const suggestions: Record<string, string> = {
    // Project name errors
    'invalid_string': issue.path === 'project_name'
      ? 'Use lowercase letters, numbers, and hyphens only (e.g., "my-app")'
      : null as unknown as string,

    // Missing required fields
    'invalid_type': `Check that the field exists and has the correct type`,

    // Array errors
    'too_small': 'This field requires at least one item',

    // Regex failures
    'invalid_regex': 'Check the format requirements for this field',
  };

  return suggestions[issue.code] ?? null;
}
