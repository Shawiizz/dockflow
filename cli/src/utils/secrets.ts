/**
 * Secrets loading utilities
 * Supports loading secrets from:
 * - .env.dockflow file (for local development)
 * - JSON file (for CI environments)
 * - DOCKFLOW_SECRETS environment variable (JSON string)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ENV_FILE_PATH } from '../constants';
import { getProjectRoot } from './config';
import { detectCIEnvironment } from './ci';
import { printWarning, printSuccess, printError, printBlank } from './output';

/**
 * Parse a dotenv file content into key-value pairs
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    if (key) result[key] = value;
  }
  
  return result;
}

/**
 * Load secrets into process.env from various sources
 * Priority: .env.dockflow > JSON file > DOCKFLOW_SECRETS env var
 */
export function loadSecrets(): void {
  // 1. Check for .env.dockflow (local development or E2E tests)
  // Try project root first, then CWD as fallback
  let envFilePath = ENV_FILE_PATH;
  try {
    const projectRoot = getProjectRoot();
    const rootEnvFile = join(projectRoot, ENV_FILE_PATH);
    if (existsSync(rootEnvFile)) {
      envFilePath = rootEnvFile;
    }
  } catch {
    // No project root found, use CWD-relative path
  }

  if (existsSync(envFilePath)) {
    try {
      const content = readFileSync(envFilePath, 'utf-8');
      const secrets = parseDotenv(content);
      
      for (const [key, value] of Object.entries(secrets)) {
        if (value.trim() !== '') {
          process.env[key] = value;
        }
      }
      
      // Warn in CI that this file should not be committed
      if (detectCIEnvironment()) {
        printBlank();
        printWarning('WARNING: .env.dockflow file detected in CI environment!');
        printWarning('This file should NOT be committed to your repository.');
        printWarning('Add it to .gitignore: echo ".env.dockflow" >> .gitignore');
        printBlank();
      }
      
      printSuccess(`Loaded secrets from ${envFilePath}`);
      return;
    } catch (error) {
      printError(`Failed to load ${envFilePath}: ${error}`);
    }
  }
  
  // 2. Check for JSON secrets file (explicit path only)
  const secretsPath = process.env.DOCKFLOW_SECRETS_FILE;

  if (secretsPath && existsSync(secretsPath)) {
    try {
      const content = readFileSync(secretsPath, 'utf-8');
      const secrets = JSON.parse(content);
      
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && value.trim() !== '') {
          process.env[key] = value;
        }
      }
      
      printSuccess(`Loaded secrets from ${secretsPath}`);
      return;
    } catch (error) {
      printError(`Failed to load secrets from ${secretsPath}: ${error}`);
    }
  }
  
  // 3. Check for DOCKFLOW_SECRETS env var (JSON string)
  const secretsEnv = process.env.DOCKFLOW_SECRETS;
  if (secretsEnv) {
    try {
      const secrets = JSON.parse(secretsEnv);
      
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && value.trim() !== '') {
          process.env[key] = value;
        }
      }
      
      printSuccess('Loaded secrets from DOCKFLOW_SECRETS');
      return;
    } catch (error) {
      printError(`Failed to parse DOCKFLOW_SECRETS: ${error}`);
    }
  }
  
}

/**
 * Wrap a Commander action to load secrets before execution.
 * Composes with withErrorHandler:
 *   .action(withErrorHandler(withSecrets(async (...args) => { ... })))
 */
export function withSecrets<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return (...args: T) => {
    loadSecrets();
    return fn(...args);
  };
}
