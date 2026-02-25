/**
 * Validation utilities for YAML configuration files
 * Provides user-friendly error messages and formatting
 */

import { z } from 'zod';
import { colors } from '../utils/output';
import { DockflowConfigSchema } from './config.schema';
import { ServersConfigSchema } from './servers.schema';
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
