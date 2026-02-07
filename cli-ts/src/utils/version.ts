/**
 * Version utilities
 * Functions for version management and auto-increment
 */

import { printDebug } from './output';
import { parseConnectionString } from './connection-parser';
import { sshExec } from './ssh';

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
  const result = parseConnectionString(connectionString);
  if (!result.success) {
    if (debug) printDebug(`Failed to parse connection string: ${result.error}`);
    return null;
  }
  const conn = result.data;

  // Stack name is project_name-env
  const stackName = `${projectName}-${env}`;
  if (debug) printDebug(`Looking for versions in stack: ${stackName}`);
  if (debug) printDebug(`SSH connection: ${conn.user}@${conn.host}:${conn.port}`);

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

    const result = await sshExec(
      { host: conn.host, port: conn.port, user: conn.user, privateKey: conn.privateKey },
      sshCmd,
    );

    if (debug) {
      printDebug(`SSH exit code: ${result.exitCode}`);
      printDebug(`SSH stdout: "${result.stdout}"`);
      printDebug(`SSH stderr: ${result.stderr}`);
    }

    if (result.exitCode === 0 && result.stdout) {
      return result.stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}
