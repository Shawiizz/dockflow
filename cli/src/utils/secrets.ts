/** Loads deploy secrets into process.env from a dotenv file, a JSON file or an environment variable. */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ENV_FILE_PATH } from '../constants';
import { getProjectRoot } from './config';
import { detectCIEnvironment } from './ci';
import { printWarning, printSuccess, printError, printBlank } from './output';

/**
 * A quoted value may span several lines, up to the line that ends with the
 * closing quote — the only way to write a multi-line secret such as a private
 * key. A value that opens and closes its quote on one line reads exactly as it
 * always did, and escape sequences are never expanded.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else if (quote === '"' || quote === "'") {
      const closing = lines.findIndex((line, j) => j > i && line.trimEnd().endsWith(quote));
      // without a closing line, the lone quote stays part of a single-line value
      if (closing !== -1) {
        const body = [value.slice(1), ...lines.slice(i + 1, closing), lines[closing].trimEnd().slice(0, -1)];
        value = body.join('\n');
        i = closing;
      }
    }

    if (key) result[key] = value;
  }

  return result;
}

/**
 * Loads secrets into process.env from the first source that works, in this order: .env.dockflow
 * (project root first, then the working directory), the JSON file named by DOCKFLOW_SECRETS_FILE,
 * then the DOCKFLOW_SECRETS JSON string. Empty values are skipped.
 */
export function loadSecrets(): void {
  let envFilePath = ENV_FILE_PATH;
  try {
    const projectRoot = getProjectRoot();
    const rootEnvFile = join(projectRoot, ENV_FILE_PATH);
    if (existsSync(rootEnvFile)) {
      envFilePath = rootEnvFile;
    }
  } catch {
    // no project root: keep the path relative to the working directory
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

/** Loads the secrets before a Commander action runs; goes inside withErrorHandler. */
export function withSecrets<T extends unknown[]>(
  fn: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
  return (...args: T) => {
    loadSecrets();
    return fn(...args);
  };
}
