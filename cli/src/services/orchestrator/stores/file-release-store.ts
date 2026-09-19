/**
 * Swarm release history, kept as files on the control-plane manager (D20: Swarm keeps today's
 * layout; the Kubernetes bundle uses ClusterReleaseStore instead).
 *
 *   <root>/stacks/<stack>/
 *     current -> <root>/stacks/<stack>/1.4.2          symlink, the current release
 *     1.4.2/docker-compose.yml                         tagged compose (images of the release)
 *     1.4.2/stack.yml                                  the artifact, `# dockflow-artifact: ...` first
 *     1.4.2/metadata.json                              ReleaseMetadata
 *     1.4.2/helm.json                                  Helm records, only when there are any
 *   <root>/accessories/<stack>/.hash                   accessories digest (RoleStateStore)
 *
 * Release files are written under `umask 077`. A release is written to a hidden temporary
 * directory first and moved into place, so no interruption leaves a stored version unreadable.
 */

import { randomBytes } from 'crypto';
import { RELEASE_STACK_FILE } from '../../../constants';
import type { ConnectionInfo } from '../../../types';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { printDebug, printWarning } from '../../../utils/output';
import { shellQuote, sshExec, sshExecChannel } from '../../../utils/ssh';
import type {
  HelmReleaseRecord,
  ReleaseInput,
  ReleaseMetadata,
  ReleaseStore,
  StackArtifact,
  StackArtifactFormat,
} from '../interfaces';

/** Default root of every file store; tests pass a temporary directory instead (R-S2-03). */
export const DOCKFLOW_STATE_ROOT = '/var/lib/dockflow';

const ARTIFACT_HEADER_PREFIX = '# dockflow-artifact: ';
const ARTIFACT_FORMATS: readonly StackArtifactFormat[] = ['swarm-compose/1', 'k8s-manifests/1'];
const COMPOSE_FILE = 'docker-compose.yml';
const METADATA_FILE = 'metadata.json';
const HELM_FILE = 'helm.json';
const CURRENT_LINK = 'current';
const ACCESSORIES_HASH_FILE = '.hash';
// Hidden names: the release listing glob `*/` never matches them.
const TEMP_PREFIX = '.tmp-';
const BACKUP_PREFIX = '.replaced-';
/** metadata last, so a listing never names a version whose other files are still the old ones */
const RELEASE_FILES = [COMPOSE_FILE, RELEASE_STACK_FILE, HELM_FILE, METADATA_FILE];

export interface StoreShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs one shell command on the node that holds the store files; `stdin` is the command's input. */
export interface StoreShell {
  /** remote account, only used in messages */
  readonly user?: string;
  run(command: string, stdin?: string): Promise<StoreShellResult>;
}

export function sshStoreShell(connection: ConnectionInfo): StoreShell {
  return {
    user: connection.user,
    async run(command: string, stdin?: string): Promise<StoreShellResult> {
      if (stdin === undefined) {
        const { stdout, stderr, exitCode } = await sshExec(connection, command);
        return { stdout, stderr, exitCode };
      }
      const { stream, done } = await sshExecChannel(connection, command);
      stream.end(stdin);
      return done;
    },
  };
}

export type StoreNameKind = 'stack' | 'version' | 'lock';

/**
 * Stack names, versions and lock names become paths under `rm -rf`: each must be one plain path
 * segment (no `/`, no control character, not hidden, and a version cannot shadow `current`).
 */
export function assertStoreName(value: string, kind: StoreNameKind): void {
  let plain = value !== '' && !value.startsWith('.') && !value.includes('/');
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) plain = false;
  }
  if (kind === 'version' && value === CURRENT_LINK) plain = false;
  if (plain) return;
  const shown = JSON.stringify(value);
  if (kind === 'version') {
    throw new DeployError(
      `Version ${shown} cannot be used as a release directory name`,
      ErrorCode.DEPLOY_FAILED,
      'Use a version without `/` or control characters that does not start with `.` and is not `current`.',
    );
  }
  throw new DeployError(
    `${kind === 'stack' ? 'Stack' : 'Lock'} name ${shown} cannot be used as a file name`,
    ErrorCode.DEPLOY_FAILED,
    'Use a name without `/` or control characters that does not start with `.`.',
  );
}

function failure(result: StoreShellResult): string {
  return result.stderr.trim() || `exit ${result.exitCode}`;
}

/** `readlink` output -> version name; the link target is a path, the store speaks versions. */
function versionOfLink(target: string): string | null {
  const path = target.trim().replace(/\/+$/, '');
  if (!path) return null;
  return path.slice(path.lastIndexOf('/') + 1) || null;
}

function withArtifactHeader(artifact: StackArtifact): string {
  return artifact.content.startsWith(ARTIFACT_HEADER_PREFIX)
    ? artifact.content
    : `${ARTIFACT_HEADER_PREFIX}${artifact.format}\n${artifact.content}`;
}

/** Releases written before the header existed hold a plain Swarm compose file. */
function artifactFormatOf(content: string): StackArtifactFormat {
  const newline = content.indexOf('\n');
  const firstLine = (newline >= 0 ? content.slice(0, newline) : content).trim();
  if (firstLine.startsWith(ARTIFACT_HEADER_PREFIX)) {
    const format = firstLine.slice(ARTIFACT_HEADER_PREFIX.length).trim();
    const known = ARTIFACT_FORMATS.find((candidate) => candidate === format);
    if (known) return known;
  }
  return 'swarm-compose/1';
}

function parseMetadata(text: string): ReleaseMetadata | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as ReleaseMetadata;
  if (typeof metadata.version !== 'string' || metadata.version === '') return null;
  if (typeof metadata.epoch === 'number') return metadata;
  return { ...metadata, epoch: Number(metadata.epoch) || 0 };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Keeps `keep` releases, newest first, with the current one always among them. */
function releasesBeyond(releases: ReleaseMetadata[], current: string | null, keep: number): ReleaseMetadata[] {
  const kept = new Set<string>();
  if (current !== null && releases.some((release) => release.version === current)) kept.add(current);
  for (const release of releases) {
    if (kept.size >= keep) break;
    kept.add(release.version);
  }
  return releases.filter((release) => !kept.has(release.version));
}

export interface FileReleaseStoreOptions {
  /** replaces `/var/lib/dockflow` */
  root?: string;
}

export class FileReleaseStore implements ReleaseStore {
  private readonly stacksDir: string;
  private readonly accessoriesDir: string;
  /** `<stack>/<version>` whose previous files this process kept aside during a same-version create */
  private readonly replaced = new Set<string>();

  constructor(
    private readonly shell: StoreShell,
    options: FileReleaseStoreOptions = {},
  ) {
    const root = (options.root ?? DOCKFLOW_STATE_ROOT).replace(/\/+$/, '');
    this.stacksDir = `${root}/stacks`;
    this.accessoriesDir = `${root}/accessories`;
  }

  private stackDir(stackName: string): string {
    assertStoreName(stackName, 'stack');
    return `${this.stacksDir}/${stackName}`;
  }

  private releaseDir(stackName: string, version: string): string {
    assertStoreName(version, 'version');
    return `${this.stackDir(stackName)}/${version}`;
  }

  private backupDir(stackName: string, version: string): string {
    assertStoreName(version, 'version');
    return `${this.stackDir(stackName)}/${BACKUP_PREFIX}${version}`;
  }

  private accessoriesHash(stackName: string): { dir: string; file: string } {
    assertStoreName(stackName, 'stack');
    const dir = `${this.accessoriesDir}/${stackName}`;
    return { dir, file: `${dir}/${ACCESSORIES_HASH_FILE}` };
  }

  async create(stackName: string, release: ReleaseInput): Promise<{ previous: string | null }> {
    const { version } = release;
    const stackDir = this.stackDir(stackName);
    const dir = this.releaseDir(stackName, version);
    const backup = this.backupDir(stackName, version);
    const tmp = `${stackDir}/${TEMP_PREFIX}${version}-${randomBytes(4).toString('hex')}`;
    const q = shellQuote;

    // Leftovers of an interrupted create are dropped; the deploy lock rules out a concurrent one.
    const prepared = await this.shell.run(
      [
        'umask 077',
        `mkdir -p ${q(stackDir)} || exit 1`,
        `rm -rf ${q(stackDir)}/${TEMP_PREFIX}* ${q(stackDir)}/${BACKUP_PREFIX}*`,
        `mkdir ${q(tmp)} || exit 1`,
        `readlink ${q(`${stackDir}/${CURRENT_LINK}`)} 2>/dev/null || true`,
      ].join('\n'),
    );
    if (prepared.exitCode !== 0) {
      const owner = this.shell.user ?? '<deploy user>';
      throw new DeployError(
        `Failed to create release directory ${dir}: ${failure(prepared)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user has write access to ${stackDir}. Run once as root: \`mkdir -p ${q(stackDir)} && chown ${owner}: ${q(stackDir)}\``,
      );
    }
    for (const key of this.replaced) {
      if (key.startsWith(`${stackName}/`)) this.replaced.delete(key);
    }
    const previous = versionOfLink(prepared.stdout);

    const files: { name: string; label: string; content: string }[] = [
      { name: COMPOSE_FILE, label: 'compose', content: release.compose },
      { name: RELEASE_STACK_FILE, label: 'stack', content: withArtifactHeader(release.artifact) },
      { name: METADATA_FILE, label: 'metadata', content: JSON.stringify(release.metadata, null, 2) },
    ];
    if (release.artifact.helm.length > 0) {
      files.push({ name: HELM_FILE, label: 'Helm records', content: canonicalJson(release.artifact.helm) });
    }
    const written = await Promise.all(
      files.map((file) => this.shell.run(`umask 077 && cat > ${q(`${tmp}/${file.name}`)}`, file.content)),
    );
    const failed = written.findIndex((result) => result.exitCode !== 0);
    if (failed >= 0) {
      await this.discard(tmp);
      throw new DeployError(
        `Failed to write release ${files[failed].label} for ${version}: ${failure(written[failed])}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }

    // A new version is one directory rename. An existing one is replaced file by file (each `mv` is
    // atomic) after a copy of its files is kept aside, so a failed redeploy can put them back.
    const names = RELEASE_FILES.map(q).join(' ');
    const committed = await this.shell.run(
      [
        'umask 077',
        `if [ -d ${q(dir)} ]; then`,
        `  rm -rf ${q(backup)} && cp -Rp ${q(dir)} ${q(backup)} || exit 1`,
        '  echo replacing',
        `  for f in ${names}; do`,
        `    if [ -f ${q(tmp)}/"$f" ]; then mv -f ${q(tmp)}/"$f" ${q(dir)}/"$f" || exit 1; else rm -f ${q(dir)}/"$f"; fi`,
        '  done',
        `  rm -rf ${q(tmp)}`,
        'else',
        `  mv ${q(tmp)} ${q(dir)} || exit 1`,
        'fi',
        `ln -sfn ${q(dir)} ${q(`${stackDir}/${CURRENT_LINK}`)} || exit 2`,
      ].join('\n'),
    );
    const replacing = committed.stdout.includes('replacing');
    if (replacing) this.replaced.add(`${stackName}/${version}`);
    if (committed.exitCode === 2) {
      throw new DeployError(
        `Failed to update the current release symlink: ${failure(committed)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${stackDir}.`,
      );
    }
    if (committed.exitCode !== 0) {
      await this.discard(tmp);
      if (replacing) {
        await this.restoreReplaced(stackName, version).catch((error: unknown) =>
          printDebug(`Release ${version} restore failed: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      throw new DeployError(
        `Failed to move release ${version} into place: ${failure(committed)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${stackDir}.`,
      );
    }

    printDebug(`Release ${version} created at ${dir}`);
    return { previous };
  }

  async current(stackName: string): Promise<ReleaseMetadata | null> {
    const file = `${this.stackDir(stackName)}/${CURRENT_LINK}/${METADATA_FILE}`;
    const result = await this.shell.run(`cat ${shellQuote(file)} 2>/dev/null`);
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    const metadata = parseMetadata(result.stdout);
    if (!metadata) printDebug(`Current release metadata of ${stackName} is unreadable`);
    return metadata;
  }

  async currentVersion(stackName: string): Promise<string | null> {
    const link = `${this.stackDir(stackName)}/${CURRENT_LINK}`;
    const result = await this.shell.run(`readlink ${shellQuote(link)} 2>/dev/null`);
    return result.exitCode === 0 ? versionOfLink(result.stdout) : null;
  }

  async currentCompose(stackName: string): Promise<string | null> {
    return this.readText(`${this.stackDir(stackName)}/${CURRENT_LINK}/${COMPOSE_FILE}`);
  }

  async list(stackName: string): Promise<ReleaseMetadata[]> {
    const stackDir = this.stackDir(stackName);
    const result = await this.shell.run(
      `cd ${shellQuote(stackDir)} 2>/dev/null && for d in */; do ` +
        '[ -L "${d%/}" ] && continue; ' +
        `[ -f "\${d}${METADATA_FILE}" ] && printf '%s\\t' "\${d%/}" && tr -d '\\n' < "\${d}${METADATA_FILE}" && echo; ` +
        'done || true',
    );

    const releases: ReleaseMetadata[] = [];
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      const name = tab >= 0 ? line.slice(0, tab) : line;
      const metadata = tab >= 0 ? parseMetadata(line.slice(tab + 1)) : null;
      // the directory name is what prune deletes, so metadata naming another version is not trusted
      if (metadata && metadata.version === name) {
        releases.push(metadata);
      } else {
        printWarning(`Skipping release directory ${name} with corrupted metadata in ${stackDir}`);
      }
    }
    return releases.sort((a, b) => b.epoch - a.epoch || compareCodeUnits(b.version, a.version));
  }

  async latestVersion(stackName: string): Promise<string | null> {
    return (await this.list(stackName))[0]?.version ?? null;
  }

  async readArtifact(stackName: string, version: string): Promise<StackArtifact> {
    const dir = this.releaseDir(stackName, version);
    const q = shellQuote;
    // first line: the Helm records ([] when absent); the rest: stack.yml, or the compose of a
    // release written before stack.yml existed
    const result = await this.shell.run(
      [
        `helm=$(cat ${q(`${dir}/${HELM_FILE}`)} 2>/dev/null) || helm='[]'`,
        `printf '%s\\n' "$helm"`,
        `cat ${q(`${dir}/${RELEASE_STACK_FILE}`)} 2>/dev/null || cat ${q(`${dir}/${COMPOSE_FILE}`)} 2>/dev/null`,
      ].join('\n'),
    );
    const newline = result.stdout.indexOf('\n');
    const content = newline >= 0 ? result.stdout.slice(newline + 1) : '';
    if (result.exitCode !== 0 || !content.trim()) {
      throw new DeployError(
        `Release ${version} not found in ${this.stackDir(stackName)}`,
        ErrorCode.ROLLBACK_FAILED,
      );
    }
    const helm = this.parseHelm(result.stdout.slice(0, newline), version, dir);
    return {
      format: artifactFormatOf(content),
      role: 'app',
      content,
      helm,
      diagnostics: [],
      digest: sha256Hex(`${content}\n${canonicalJson(helm)}`),
    };
  }

  async readCompose(stackName: string, version: string): Promise<string | null> {
    return this.readText(`${this.releaseDir(stackName, version)}/${COMPOSE_FILE}`);
  }

  async setCurrent(stackName: string, version: string | null): Promise<void> {
    const stackDir = this.stackDir(stackName);
    const link = shellQuote(`${stackDir}/${CURRENT_LINK}`);
    const command =
      version === null ? `rm -f ${link}` : `ln -sfn ${shellQuote(this.releaseDir(stackName, version))} ${link}`;
    const result = await this.shell.run(command);
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to update the current release symlink: ${failure(result)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${stackDir}.`,
      );
    }
  }

  async remove(stackName: string, version: string, options?: { restoreCurrentTo: string | null }): Promise<void> {
    const dir = this.releaseDir(stackName, version);
    if (this.replaced.has(`${stackName}/${version}`)) {
      // a failed same-version redeploy: the previous files of that version come back
      await this.restoreReplaced(stackName, version);
      if (options) await this.setCurrent(stackName, options.restoreCurrentTo);
      return;
    }
    if (options && (await this.currentVersion(stackName)) === version) {
      await this.setCurrent(stackName, options.restoreCurrentTo); // current first: never a dangling pointer
    }
    const result = await this.shell.run(
      `timeout 30 rm -rf ${shellQuote(dir)} ${shellQuote(this.backupDir(stackName, version))}`,
    );
    if (result.exitCode !== 0) {
      throw new DeployError(`Failed to remove release ${version}: ${failure(result)}`, ErrorCode.DEPLOY_FAILED);
    }
    printDebug(`Removed release ${version}`);
  }

  async prune(stackName: string, keep: number): Promise<ReleaseMetadata[]> {
    const [releases, current] = await Promise.all([this.list(stackName), this.currentVersion(stackName)]);
    const removed = releasesBeyond(releases, current, keep);
    if (removed.length === 0) return [];
    const paths = removed.flatMap((release) => [
      this.releaseDir(stackName, release.version),
      this.backupDir(stackName, release.version),
    ]);
    const result = await this.shell.run(`timeout 60 rm -rf ${paths.map(shellQuote).join(' ')}`);
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to remove old releases of ${stackName}: ${failure(result)}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
    return removed;
  }

  hookWorkingDir(stackName: string): string {
    return `${this.stackDir(stackName)}/${CURRENT_LINK}`;
  }

  async readState(stackName: string): Promise<{ current: string | null; accessoriesDigest: string | null }> {
    const link = `${this.stackDir(stackName)}/${CURRENT_LINK}`;
    const { file } = this.accessoriesHash(stackName);
    const result = await this.shell.run(
      `printf '%s\\n' "$(readlink ${shellQuote(link)} 2>/dev/null)" "$(cat ${shellQuote(file)} 2>/dev/null)"`,
    );
    const [target = '', digest = ''] = result.stdout.split('\n');
    return { current: versionOfLink(target), accessoriesDigest: digest.trim() || null };
  }

  async writeAccessoriesDigest(stackName: string, digest: string | null): Promise<void> {
    const { dir, file } = this.accessoriesHash(stackName);
    const command =
      digest === null
        ? `rm -f ${shellQuote(file)}`
        : `mkdir -p ${shellQuote(dir)} && printf '%s\\n' ${shellQuote(digest)} > ${shellQuote(file)}`;
    const result = await this.shell.run(command);
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to record the accessories digest of ${stackName}: ${failure(result)}`,
        ErrorCode.DEPLOY_FAILED,
        `Ensure the deploy user can write to ${dir}.`,
      );
    }
  }

  private async readText(path: string): Promise<string | null> {
    const result = await this.shell.run(`cat ${shellQuote(path)} 2>/dev/null`);
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout : null;
  }

  private parseHelm(text: string, version: string, dir: string): HelmReleaseRecord[] {
    try {
      const value: unknown = JSON.parse(text);
      if (Array.isArray(value)) return value as HelmReleaseRecord[];
    } catch {
      // reported below
    }
    throw new DeployError(`Release ${version} has unreadable Helm records in ${dir}`, ErrorCode.ROLLBACK_FAILED);
  }

  /** Puts back the files a same-version create kept aside (only complete copies are kept aside). */
  private async restoreReplaced(stackName: string, version: string): Promise<void> {
    const dir = shellQuote(this.releaseDir(stackName, version));
    const backup = shellQuote(this.backupDir(stackName, version));
    const result = await this.shell.run(
      [
        'umask 077',
        `if [ -d ${backup} ]; then`,
        `  mkdir -p ${dir} || exit 1`,
        `  for f in ${RELEASE_FILES.map(shellQuote).join(' ')}; do`,
        `    if [ -f ${backup}/"$f" ]; then mv -f ${backup}/"$f" ${dir}/"$f" || exit 1; else rm -f ${dir}/"$f"; fi`,
        '  done',
        `  rm -rf ${backup}`,
        'fi',
      ].join('\n'),
    );
    if (result.exitCode !== 0) {
      throw new DeployError(
        `Failed to restore the previous files of release ${version}: ${failure(result)}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
    this.replaced.delete(`${stackName}/${version}`);
  }

  private async discard(tmp: string): Promise<void> {
    await this.shell
      .run(`rm -rf ${shellQuote(tmp)}`)
      .catch((error: unknown) =>
        printDebug(`Release temp cleanup failed: ${error instanceof Error ? error.message : String(error)}`),
      );
  }
}
