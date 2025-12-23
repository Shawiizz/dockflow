/**
 * Validation utilities for YAML configuration files
 * Provides user-friendly error messages and formatting
 */

import { z } from 'zod';
import chalk from 'chalk';
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
 * Validation result with parsed data or errors
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: ValidationIssue[];
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
    chalk.red.bold(`✗ Validation failed for ${fileName}`),
    '',
  ];

  for (const error of errors) {
    lines.push(chalk.yellow(`  → ${error.path}`));
    lines.push(chalk.white(`    ${error.message}`));
    lines.push('');
  }

  lines.push(chalk.gray('  Run `dockflow config validate` for detailed validation'));
  
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
 * Validate both config files and return combined result
 */
export function validateAllConfigs(
  config: unknown,
  servers: unknown
): { config: ValidationResult<z.output<typeof DockflowConfigSchema>>; servers: ValidationResult<z.output<typeof ServersConfigSchema>> } {
  const configResult = validateConfig(config);
  const serversResult = validateServersConfig(servers);

  return {
    config: {
      success: configResult.success,
      data: configResult.success ? configResult.data : undefined,
      errors: !configResult.success ? configResult.error : undefined,
    },
    servers: {
      success: serversResult.success,
      data: serversResult.success ? serversResult.data : undefined,
      errors: !serversResult.success ? serversResult.error : undefined,
    },
  };
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

/**
 * Print detailed validation report
 */
export function printValidationReport(
  configResult: ValidationResult<unknown>,
  serversResult: ValidationResult<unknown>
): void {
  console.log('');
  console.log(chalk.bold('Configuration Validation Report'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log('');

  // Config.yml status
  if (configResult.success) {
    console.log(chalk.green('✓ config.yml: Valid'));
  } else if (configResult.errors) {
    console.log(chalk.red('✗ config.yml: Invalid'));
    for (const error of configResult.errors) {
      console.log(chalk.yellow(`    ${error.path}: ${error.message}`));
      const suggestion = getSuggestion(error);
      if (suggestion) {
        console.log(chalk.gray(`      💡 ${suggestion}`));
      }
    }
  } else {
    console.log(chalk.gray('○ config.yml: Not found'));
  }

  console.log('');

  // Servers.yml status
  if (serversResult.success) {
    console.log(chalk.green('✓ servers.yml: Valid'));
  } else if (serversResult.errors) {
    console.log(chalk.red('✗ servers.yml: Invalid'));
    for (const error of serversResult.errors) {
      console.log(chalk.yellow(`    ${error.path}: ${error.message}`));
      const suggestion = getSuggestion(error);
      if (suggestion) {
        console.log(chalk.gray(`      💡 ${suggestion}`));
      }
    }
  } else {
    console.log(chalk.gray('○ servers.yml: Not found'));
  }

  console.log('');
  console.log(chalk.gray('─'.repeat(40)));

  const allValid = configResult.success && serversResult.success;
  if (allValid) {
    console.log(chalk.green.bold('All configuration files are valid! ✓'));
  } else {
    console.log(chalk.red.bold('Please fix the validation errors above.'));
  }
  console.log('');
}
