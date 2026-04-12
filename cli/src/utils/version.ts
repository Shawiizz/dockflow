/**
 * Version utilities
 * Functions for version management and auto-increment
 */

import { printDebug } from './output';
import { parseConnectionString } from './connection-parser';
import { sshExec } from './ssh';
import { DOCKFLOW_STACKS_DIR } from '../constants';

/**
 * Increment version string
 * Examples:
 *   1.0.0 -> 1.0.1
 *   1.0.0-beta -> 1.0.0-beta2
 *   1.0.0-beta2 -> 1.0.0-beta3
 *   main-abc123 -> main-abc123-2
 */
export function incrementVersion(version: string): string {
  // Branch-SHA pattern (e.g., main-abc12345, develop-f3a1b2c8) — append -2 counter
  // Must be checked first to avoid the suffixMatch regex corrupting hex SHAs
  if (/^.+-[0-9a-f]{6,}$/i.test(version)) {
    return `${version}-2`;
  }

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

  // Pre-release label ending in letters with a dash separator (e.g., 1.0.0-beta)
  if (/[a-zA-Z]$/.test(version) && /-[a-zA-Z]/.test(version)) {
    return `${version}2`;
  }

  // Default: append -2
  return `${version}-2`;
}

/**
 * Get the latest deployed version from the server via SSH.
 * Reads metadata.json files from release dirs, picks the latest by timestamp.
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

  const stackName = `${projectName}-${env}`;
  if (debug) printDebug(`Looking for versions in stack: ${stackName}`);

  const cmd = `
STACKS_DIR="${DOCKFLOW_STACKS_DIR}/${stackName}"
[ -d "$STACKS_DIR" ] || exit 0
latest_version=""
latest_ts=""
for meta in "$STACKS_DIR"/*/metadata.json; do
  [ -f "$meta" ] || continue
  data=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('timestamp', ''))
    print(d.get('version', ''))
except Exception:
    pass
" "$meta" 2>/dev/null)
  ts=$(echo "$data" | sed -n '1p')
  ver=$(echo "$data" | sed -n '2p')
  [ -z "$ts" ] && continue
  if [ -z "$latest_ts" ] || [ "$ts" \\> "$latest_ts" ]; then
    latest_ts="$ts"
    latest_version="$ver"
  fi
done
echo "$latest_version"
`.trim();

  try {
    const sshResult = await sshExec(
      { host: conn.host, port: conn.port, user: conn.user, privateKey: conn.privateKey },
      cmd,
    );

    if (debug) {
      printDebug(`SSH exit code: ${sshResult.exitCode}`);
      printDebug(`SSH stdout: "${sshResult.stdout}"`);
    }

    if (sshResult.exitCode === 0 && sshResult.stdout) {
      return sshResult.stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}
