/**
 * Pure helpers for the remote setup flow: building the flag list forwarded to
 * the remote `dockflow setup` invocation, and resolving and verifying the
 * binary download. Unit-tested in __tests__/setup-forward.test.ts.
 */

import { shellQuote } from '../../utils/ssh';
import type { SetupOptions } from './types';

/**
 * Build the flags forwarded to the remote `dockflow setup` command.
 *
 * Identity flags (--user, --host, --port) are forwarded so a dedicated deploy
 * user can be created non-interactively over SSH; --host defaults to the host
 * being provisioned. Values are single-quoted (passwords may contain spaces).
 */
export function buildForwardFlags(
  options: SetupOptions & { orchestrator?: string; deployPassword?: string },
  remote: { host: string; port: number },
): string[] {
  const flags: string[] = [];
  const quote = shellQuote;

  if (options.skipDockerInstall) flags.push('--skip-docker-install');
  if (options.orchestrator) flags.push('--orchestrator', quote(options.orchestrator));
  if (options.nginx) flags.push('--nginx');

  if (options.user) {
    flags.push('--user', quote(options.user));
    if (options.deployPassword) flags.push('--password', quote(options.deployPassword));
    flags.push('--generate-key');
  }

  // The public host/port of the connection string default to what we are
  // connected to — overridable with explicit --host/--port.
  flags.push('--host', quote(options.host || remote.host));
  flags.push('--port', quote(options.port || String(remote.port)));

  if (options.yes) flags.push('--yes');

  return flags;
}

/**
 * Resolve the download URL for the server-side binary.
 * Pinned to this CLI's version so the binary that provisions the server is
 * the same one the operator runs; dev builds fall back to the latest release.
 */
export function buildBinaryDownloadUrl(
  releaseLatestUrl: string,
  version: string,
  binaryName: string,
): string {
  const isDev = !version || version === '0.0.0' || version.includes('dev');
  if (isDev) {
    return `${releaseLatestUrl}/${binaryName}`;
  }
  return `${releaseLatestUrl.replace(/latest\/download$/, `download/${version}`)}/${binaryName}`;
}

/**
 * Shell program the server runs to fetch the binary into `dest`, executable only once its
 * SHA-256 matches the one the release publishes in `SHA256SUMS`; on a mismatch nothing is
 * left at `dest`.
 */
export function verifiedDownloadCommand(
  releaseLatestUrl: string,
  version: string,
  binaryName: string,
  dest: string,
): string {
  const binaryUrl = shellQuote(buildBinaryDownloadUrl(releaseLatestUrl, version, binaryName));
  const sumsUrl = shellQuote(buildBinaryDownloadUrl(releaseLatestUrl, version, 'SHA256SUMS'));
  return [
    'set -e',
    `f=${shellQuote(dest)}; s=${shellQuote(`${dest}.sha256sums`)}; verified=`,
    // whatever stops the program, a binary that was not verified goes
    `trap 'rm -f "$s"; [ -n "$verified" ] || rm -f "$f"' EXIT`,
    'rm -f "$f" "$s"',
    `curl -fsSL ${binaryUrl} -o "$f"`,
    `curl -fsSL ${sumsUrl} -o "$s"`,
    `expected=$(awk -v name=${shellQuote(binaryName)} '$2 == name || $2 == "*" name { print $1 }' "$s")`,
    `actual=$(sha256sum "$f" | cut -d' ' -f1)`,
    'if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then',
    `  echo "SHA-256 of ${binaryName} does not match the release: expected \${expected:-nothing}, got $actual" >&2`,
    '  exit 1',
    'fi',
    'chmod +x "$f"',
    'verified=1',
  ].join('\n');
}
