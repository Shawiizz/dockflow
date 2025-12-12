/**
 * Version utilities
 * Functions for version management and auto-increment
 */

import chalk from 'chalk';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { parseConnectionString } from './connection';

/**
 * Increment version string
 * Examples:
 *   1.0.0 -> 1.0.1
 *   1.0.0-beta -> 1.0.0-beta2
 *   1.0.0-beta2 -> 1.0.0-beta3
 *   main-abc123 -> main-abc123-2
 */
export function incrementVersion(version: string): string {
  // Check if version ends with a number after a letter (e.g., beta2, rc3)
  const suffixMatch = version.match(/^(.+[a-zA-Z])(\d+)$/);
  if (suffixMatch) {
    const [, base, num] = suffixMatch;
    return `${base}${parseInt(num) + 1}`;
  }

  // Check if version is semver-like (ends with .number)
  const semverMatch = version.match(/^(.+)\.(\d+)$/);
  if (semverMatch) {
    const [, base, num] = semverMatch;
    return `${base}.${parseInt(num) + 1}`;
  }

  // Check if version ends with -number (e.g., main-abc123-2)
  const dashNumMatch = version.match(/^(.+)-(\d+)$/);
  if (dashNumMatch) {
    const [, base, num] = dashNumMatch;
    return `${base}-${parseInt(num) + 1}`;
  }

  // Check if version contains letters at the end without number (e.g., 1.0.0-beta)
  if (/[a-zA-Z]$/.test(version)) {
    return `${version}2`;
  }

  // Default: append -2
  return `${version}-2`;
}

/**
 * Get the latest deployed version from the server via SSH
 */
export async function getLatestVersion(
  connectionString: string,
  projectName: string,
  env: string,
  debug: boolean = false
): Promise<string | null> {
  const conn = parseConnectionString(connectionString);
  if (!conn) {
    if (debug) console.log(chalk.gray('[DEBUG] Failed to parse connection string'));
    return null;
  }

  // Stack name is project_name-env
  const stackName = `${projectName}-${env}`;
  if (debug) console.log(chalk.gray(`[DEBUG] Looking for versions in stack: ${stackName}`));
  if (debug) console.log(chalk.gray(`[DEBUG] SSH connection: ${conn.user}@${conn.host}:${conn.port}`));

  // Write private key to temp file
  // Ensure proper line endings (Unix LF) and handle escaped newlines
  const tempKeyPath = join(process.env.TEMP || '/tmp', `dockflow_deploy_key_${Date.now()}`);
  const fs = await import('fs');

  // Convert escaped \n to actual newlines and normalize line endings
  let privateKey = conn.privateKey
    .replace(/\\n/g, '\n') // Handle escaped newlines
    .replace(/\r\n/g, '\n') // Normalize Windows line endings
    .replace(/\r/g, '\n'); // Handle old Mac line endings

  // Ensure the key ends with a newline
  if (!privateKey.endsWith('\n')) {
    privateKey += '\n';
  }

  if (debug) console.log(chalk.gray(`[DEBUG] Private key first 50 chars: ${privateKey.substring(0, 50).replace(/\n/g, '\\n')}`));

  fs.writeFileSync(tempKeyPath, privateKey, { mode: 0o600 });

  try {
    // SSH command to get latest version from metadata files
    // Releases are stored directly in /var/lib/dockflow/stacks/{stack_name}/{version}/
    const sshCmd = `
      STACKS_DIR="/var/lib/dockflow/stacks/${stackName}"
      echo "DEBUG: Checking $STACKS_DIR" >&2
      if [ -d "$STACKS_DIR" ]; then
        echo "DEBUG: Directory exists" >&2
        ls -la "$STACKS_DIR" >&2
        LATEST=""
        LATEST_TS=""
        for DIR in "$STACKS_DIR"/*/; do
          echo "DEBUG: Checking $DIR" >&2
          if [ -f "$DIR/metadata.json" ]; then
            echo "DEBUG: Found metadata.json in $DIR" >&2
            cat "$DIR/metadata.json" >&2
            TS=$(cat "$DIR/metadata.json" | grep -o '"timestamp"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
            VERSION=$(cat "$DIR/metadata.json" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
            echo "DEBUG: Found TS=$TS VERSION=$VERSION" >&2
            if [ -z "$LATEST_TS" ] || [ "$TS" \\> "$LATEST_TS" ]; then
              LATEST_TS="$TS"
              LATEST="$VERSION"
            fi
          fi
        done
        echo "$LATEST"
      else
        echo "DEBUG: Directory does not exist" >&2
      fi
    `;

    const result = spawnSync('ssh', [
      '-i', tempKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-p', conn.port.toString(),
      `${conn.user}@${conn.host}`,
      sshCmd,
    ], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    fs.unlinkSync(tempKeyPath);

    if (debug) {
      console.log(chalk.gray(`[DEBUG] SSH exit code: ${result.status}`));
      console.log(chalk.gray(`[DEBUG] SSH stdout: "${result.stdout}"`));
      console.log(chalk.gray(`[DEBUG] SSH stderr: ${result.stderr}`));
    }

    if (result.status === 0 && result.stdout) {
      return result.stdout.trim() || null;
    }
    return null;
  } catch {
    try {
      const fs = await import('fs');
      fs.unlinkSync(tempKeyPath);
    } catch {
      /* ignore */
    }
    return null;
  }
}
