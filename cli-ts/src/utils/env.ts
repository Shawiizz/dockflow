/**
 * Environment utilities
 * Functions for loading and parsing environment files
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProjectRoot } from './config';

/**
 * Load all variables from .env.dockflow file
 */
export function loadEnvDockflow(): Record<string, string> {
  const envFile = join(getProjectRoot(), '.env.dockflow');
  const vars: Record<string, string> = {};

  if (!existsSync(envFile)) {
    return vars;
  }

  const content = readFileSync(envFile, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      vars[key] = value;
    }
  }

  return vars;
}

/**
 * Build environment exports string for shell scripts
 */
export function buildEnvExports(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `export ${key}="${value.replace(/"/g, '\\"')}"`)
    .join('\n');
}
