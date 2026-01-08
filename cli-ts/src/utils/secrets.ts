/**
 * Secrets loading utilities
 * Supports loading secrets from:
 * - .env.dockflow file (for local development)
 * - JSON file (for CI environments)
 * - DOCKFLOW_SECRETS environment variable (JSON string)
 */

import { existsSync, readFileSync } from 'fs';
import { ENV_FILE_PATH } from '../constants';

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
 * 
 * In local development:
 *   Uses .env.dockflow file only
 * 
 * In CI environment:
 *   Uses JSON file / env vars only (.env.dockflow is IGNORED with a warning)
 */
export function loadSecrets(): void {
  const inCI = isCI();
  
  // 1. Check for .env.dockflow
  if (existsSync(ENV_FILE_PATH)) {
    if (inCI) {
      // In CI: warn and IGNORE the file completely
      console.warn('');
      console.warn('\x1b[33m⚠️  WARNING: .env.dockflow file detected in CI environment!\x1b[0m');
      console.warn('\x1b[33m   This file should NOT be committed to your repository.\x1b[0m');
      console.warn('\x1b[33m   Add it to .gitignore: echo ".env.dockflow" >> .gitignore\x1b[0m');
      console.warn('\x1b[33m   This file will be IGNORED. Using CI secrets instead.\x1b[0m');
      console.warn('');
    } else {
      // In local dev: load the file and return
      try {
        const content = readFileSync(ENV_FILE_PATH, 'utf-8');
        const secrets = parseDotenv(content);
        
        for (const [key, value] of Object.entries(secrets)) {
          if (value.trim() !== '') {
            process.env[key] = value;
          }
        }
        
        console.log(`Loaded secrets from ${ENV_FILE_PATH}`);
        return;
      } catch (error) {
        console.error(`Failed to load ${ENV_FILE_PATH}: ${error}`);
      }
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
      
      console.log(`Loaded secrets from ${secretsPath}`);
      return;
    } catch (error) {
      console.error(`Failed to load secrets from ${secretsPath}: ${error}`);
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
      
      console.log('Loaded secrets from DOCKFLOW_SECRETS');
      return;
    } catch (error) {
      console.error(`Failed to parse DOCKFLOW_SECRETS: ${error}`);
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
      
      console.log('Loaded secrets from GITHUB_SECRETS');
    } catch (error) {
      console.error(`Failed to parse GITHUB_SECRETS: ${error}`);
    }
  }
}
