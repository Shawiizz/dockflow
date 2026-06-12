/**
 * Pure helpers for the remote setup flow: building the flag list forwarded to
 * the remote `dockflow setup` invocation, and resolving the binary download
 * URL. Unit-tested in __tests__/setup-forward.test.ts.
 */

import { shellEscape } from '../../utils/ssh';
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
  const quote = (v: string) => `'${shellEscape(v)}'`;

  if (options.skipDockerInstall) flags.push('--skip-docker-install');
  if (options.orchestrator) flags.push('--orchestrator', quote(options.orchestrator));
  if (options.nginx) flags.push('--nginx');
  if (options.portainer) flags.push('--portainer');
  if (options.portainerPort) flags.push('--portainer-port', quote(options.portainerPort));
  if (options.portainerPassword) flags.push('--portainer-password', quote(options.portainerPassword));
  if (options.portainerDomain) flags.push('--portainer-domain', quote(options.portainerDomain));

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
