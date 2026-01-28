/**
 * Secrets loading utilities
 * Supports loading secrets from:
 * - .env.dockflow file (for local development)
 * - JSON file (for CI environments)
 * - DOCKFLOW_SECRETS environment variable (JSON string)
 */

import { existsSync, readFileSync } from 'fs';
import { ENV_FILE_PATH } from '../constants';
import { printWarning, printSuccess, printError } from './output';

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
 * Check if we're running in CI environment
 */
export function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE
  );
}

/**
 * Load secrets into process.env from various sources
 * Priority: .env.dockflow > JSON file > DOCKFLOW_SECRETS env var
 */
export function loadSecrets(): void {
  // 1. Check for .env.dockflow (local development or E2E tests)
  if (existsSync(ENV_FILE_PATH)) {
    try {
      const content = readFileSync(ENV_FILE_PATH, 'utf-8');
      const secrets = parseDotenv(content);
      
      for (const [key, value] of Object.entries(secrets)) {
        if (value.trim() !== '') {
          process.env[key] = value;
        }
      }
      
      // Warn in CI that this file should not be committed
      if (isCI()) {
        console.log('');
        printWarning('WARNING: .env.dockflow file detected in CI environment!');
        printWarning('This file should NOT be committed to your repository.');
        printWarning('Add it to .gitignore: echo ".env.dockflow" >> .gitignore');
        console.log('');
      }
      
      printSuccess(`Loaded secrets from ${ENV_FILE_PATH}`);
      return;
    } catch (error) {
      printError(`Failed to load ${ENV_FILE_PATH}: ${error}`);
    }
  }
  
  // 2. Check for JSON secrets file (CI environment)
  const secretsPath = process.env.DOCKFLOW_SECRETS_FILE || '/tmp/secrets.json';
  
  if (existsSync(secretsPath)) {
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
  
  // 4. Check for GITHUB_SECRETS (GitHub Actions)
  const githubSecrets = process.env.GITHUB_SECRETS;
  if (githubSecrets) {
    try {
      const secrets = JSON.parse(githubSecrets);
      
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && value.trim() !== '') {
          process.env[key] = value;
        }
      }
      
      printSuccess('Loaded secrets from GITHUB_SECRETS');
    } catch (error) {
      printError(`Failed to parse GITHUB_SECRETS: ${error}`);
    }
  }
}
