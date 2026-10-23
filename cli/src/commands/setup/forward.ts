/**
 * Pure helpers for the remote setup flow: the flags forwarded to the remote `dockflow setup`, and
 * the binary download and its verification. Unit-tested in __tests__/setup-forward.test.ts.
 */

import { readFileSync } from 'fs';
import { shellQuote } from '../../utils/ssh';
import { CLIError, ErrorCode } from '../../utils/errors';
import type { SetupOptions } from './types';

/**
 * The flags forwarded to the remote `dockflow setup`. --user, --host and --port go along so a
 * dedicated deploy user can be created over SSH. The deploy user's password is not a flag: it would
 * show in the server's process list, so it goes through a file (`--password-file`).
 */
export function buildForwardFlags(
  options: SetupOptions,
  remote: { host: string; port: number },
): string[] {
  const flags: string[] = [];
  const quote = shellQuote;

  if (options.skipDockerInstall) flags.push('--skip-docker-install');
  if (options.nginx) flags.push('--nginx');
  if (options.portFilter === false) flags.push('--no-port-filter');

  if (options.user) {
    flags.push('--user', quote(options.user));
    flags.push('--generate-key');
  }

  // the public host and port of the connection string default to the host being provisioned
  flags.push('--host', quote(options.host || remote.host));
  flags.push('--port', quote(options.port || String(remote.port)));

  if (options.yes) flags.push('--yes');

  return flags;
}

/** A build without a release number of its own: it has no pinned release to download. */
export function isDevVersion(version: string): boolean {
  return !version || version === '0.0.0' || version.includes('dev');
}

/**
 * The download URL of the server-side binary, pinned to this CLI's version so the binary that
 * provisions the server is the one the operator runs; dev builds fall back to the latest release.
 */
export function buildBinaryDownloadUrl(
  releaseLatestUrl: string,
  version: string,
  binaryName: string,
): string {
  if (isDevVersion(version)) {
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

export type RemoteArch = 'x64' | 'arm64';

/** The release binary architecture for a `uname -m` answer, or null for a machine Dockflow has no binary for. */
export function archFromMachine(machine: string): RemoteArch | null {
  switch (machine.trim()) {
    case 'x86_64':
    case 'amd64':
      return 'x64';
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    default:
      return null;
  }
}

/** A private directory (mode 0700, owned by the connecting user) for the binary that will run as root. */
export const MAKE_TEMP_DIR_COMMAND = 'mktemp -d "${TMPDIR:-/tmp}/dockflow-setup.XXXXXXXX"';

/** The directory `MAKE_TEMP_DIR_COMMAND` printed, or null when the output is not a single absolute path. */
export function tempDirFrom(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length === 1 && lines[0].trim().startsWith('/') ? lines[0].trim() : null;
}

export function removeDirCommand(dir: string): string {
  return `rm -rf -- ${shellQuote(dir)}`;
}

/**
 * Shell program that turns the upload `<dir>/dockflow.part` into `<dir>/dockflow`, executable only
 * once its SHA-256 is the one of the local file; on a mismatch nothing executable is left.
 */
export function installUploadCommand(dir: string, sha256: string): string {
  return [
    'set -e',
    `cd ${shellQuote(dir)}`,
    `if ! printf '%s  %s\\n' ${shellQuote(sha256)} dockflow.part | sha256sum -c --status -; then`,
    '  rm -f dockflow.part',
    '  echo "SHA-256 of the uploaded binary does not match the local build" >&2',
    '  exit 1',
    'fi',
    'chmod 700 dockflow.part',
    'mv -f dockflow.part dockflow',
  ].join('\n');
}

/** The version the uploaded or downloaded binary must print; null when it is the latest release of an unreleased CLI. */
export function expectedBinaryVersion(cliVersion: string, uploadedBuild: boolean): string | null {
  return isDevVersion(cliVersion) && !uploadedBuild ? null : cliVersion;
}

/** Whether `dockflow --version` printed `expected` as a word of its first line. */
export function printsVersion(output: string, expected: string): boolean {
  const first = output.split(/\r?\n/)[0] ?? '';
  return first.trim().split(/\s+/).includes(expected);
}

/** The password in a `--password-file`: the whole file, without the line break an editor or echo adds. */
export function readPasswordFile(path: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new CLIError(
      `Cannot read the password file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ErrorCode.INVALID_ARGUMENT,
    );
  }
  const password = content.replace(/\r?\n$/, '');
  if (password === '') throw new CLIError(`The password file ${path} is empty`, ErrorCode.INVALID_ARGUMENT);
  return password;
}
