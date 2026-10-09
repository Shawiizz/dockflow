import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertReleaseName,
  computeOrphanImages,
  extractComposeImages,
  parseReleaseList,
  Release,
  releaseEpoch,
  type ReleaseMetadata,
  removeImagesCommand,
  selectRetention,
  selectRollbackTarget,
} from '../services/release';
import type { StackBackend } from '../services/orchestrator/interfaces';
import type { SSHExecResult } from '../types';
import { DeployError, ErrorCode } from '../utils/errors';
import type { RemoteShell } from '../utils/remote-shell';
import { hasPosixShell, LocalShell } from './helpers/local-shell';

const STACK = 'demo-production';

function meta(version: string, epoch: number): ReleaseMetadata {
  return {
    project_name: 'demo',
    version,
    env: 'production',
    timestamp: new Date(epoch * 1000).toISOString(),
    epoch,
    performer: 'ci',
    branch: 'main',
  };
}

const listing = (...releases: ReleaseMetadata[]) => releases.map((r) => `${r.version}\t${JSON.stringify(r)}`).join('\n');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseReleaseList', () => {
  it('parses one directory and metadata per line, newest first', () => {
    expect(parseReleaseList(listing(meta('1.0.0', 100), meta('1.0.1', 200))).map((r) => r.version)).toEqual(['1.0.1', '1.0.0']);
  });

  it('empty output → empty list', () => {
    expect(parseReleaseList('')).toEqual([]);
    expect(parseReleaseList('  \n ')).toEqual([]);
  });

  it('reports a directory whose metadata is unreadable or names another version, and leaves it out', () => {
    const corrupted: string[] = [];
    const out = parseReleaseList(
      `${listing(meta('1.0.0', 100))}\n1.0.1\t{broken json\n1.0.2\t${JSON.stringify(meta('9.9.9', 300))}`,
      (directory) => corrupted.push(directory),
    );
    expect(out.map((r) => r.version)).toEqual(['1.0.0']);
    expect(corrupted).toEqual(['1.0.1', '1.0.2']);
  });

  it('orders releases of the same epoch by version', () => {
    expect(parseReleaseList(listing(meta('1.0.1', 100), meta('1.0.2', 100))).map((r) => r.version)).toEqual(['1.0.2', '1.0.1']);
  });
});

describe('selectRollbackTarget', () => {
  const releases = [meta('3.0.0', 300), meta('2.0.0', 200), meta('1.0.0', 100)];

  it('with the failed version: the newest other release', () => {
    expect(selectRollbackTarget(releases, '3.0.0', '3.0.0')?.version).toBe('2.0.0');
    expect(selectRollbackTarget(releases, null, '9.9.9')?.version).toBe('3.0.0');
  });

  it('without: the release before current, so a second rollback goes further back', () => {
    expect(selectRollbackTarget(releases, '3.0.0')?.version).toBe('2.0.0');
    expect(selectRollbackTarget(releases, '2.0.0')?.version).toBe('1.0.0');
  });

  it('without a current record: skips the newest', () => {
    expect(selectRollbackTarget(releases, null)?.version).toBe('2.0.0');
  });

  it('nothing older → null', () => {
    expect(selectRollbackTarget(releases, '1.0.0')).toBeNull();
    expect(selectRollbackTarget([], null, '1.0.0')).toBeNull();
    expect(selectRollbackTarget([meta('1.0.0', 100)], null, '1.0.0')).toBeNull();
  });
});

describe('selectRetention', () => {
  const releases = [meta('4.0.0', 400), meta('3.0.0', 300), meta('2.0.0', 200), meta('1.0.0', 100)];

  it('keeps the newest N', () => {
    expect(selectRetention(releases, '4.0.0', 2).removed.map((r) => r.version)).toEqual(['2.0.0', '1.0.0']);
  });

  it('keeps current even when older than the newest N (after a rollback)', () => {
    const { kept, removed } = selectRetention(releases, '1.0.0', 2);
    expect(kept.map((r) => r.version)).toEqual(['4.0.0', '3.0.0', '1.0.0']);
    expect(removed.map((r) => r.version)).toEqual(['2.0.0']);
  });
});

describe('releaseEpoch', () => {
  it('is the deploy time, but always after every stored release (another machine may run ahead)', () => {
    const now = new Date(1000 * 1000);
    expect(releaseEpoch(now, [])).toBe(1000);
    expect(releaseEpoch(now, [meta('1.0.0', 500)])).toBe(1000);
    expect(releaseEpoch(now, [meta('1.0.0', 500), meta('1.0.1', 2000)])).toBe(2001);
  });
});

describe('assertReleaseName', () => {
  it('accepts plain names', () => {
    expect(() => assertReleaseName('1.4.2-beta+build.7', 'version')).not.toThrow();
    expect(() => assertReleaseName('shop-production', 'stack')).not.toThrow();
  });

  for (const bad of ['', 'feature/login', '..', '.hidden', 'current', 'a\nb']) {
    it(`refuses the version ${JSON.stringify(bad)}`, () => {
      expect(() => assertReleaseName(bad, 'version')).toThrow(DeployError);
    });
  }

  it('a stack may be named current', () => {
    expect(() => assertReleaseName('current', 'stack')).not.toThrow();
  });
});

describe('extractComposeImages', () => {
  it('handles unquoted, single-quoted and double-quoted images', () => {
    const yaml = `
services:
  a:
    image: plain:1
  b:
    image: 'single:2'
  c:
    image: "double:3"
`;
    expect(extractComposeImages(yaml)).toEqual(['plain:1', 'single:2', 'double:3']);
  });

  it('no images → empty list', () => {
    expect(extractComposeImages('services: {}')).toEqual([]);
  });

  it('reads services only: an image: in a comment or a label is not an image', () => {
    const yaml = ['services:', '  web:', '    image: web:2  # was image: web:1', '    labels:', '      note: "image: other:9"'].join(String.fromCharCode(10));
    expect(extractComposeImages(yaml)).toEqual(['web:2']);
  });

  it('reads every document of several files separated by ---', () => {
    const nl = String.fromCharCode(10);
    const yaml = ['services:', '  a:', '    image: a:1', '---', 'services:', '  b:', '    image: b:1', '---'].join(nl);
    expect(extractComposeImages(yaml)).toEqual(['a:1', 'b:1']);
  });
});

describe('computeOrphanImages', () => {
  it('removes only images that are neither running nor kept', () => {
    const orphans = computeOrphanImages(
      'running:1\n',
      'services:\n  a:\n    image: kept:1\n',
      'services:\n  a:\n    image: kept:1\n  b:\n    image: running:1\n  c:\n    image: orphan:1\n',
    );
    expect(orphans).toEqual(['orphan:1']);
  });

  it(':latest images are never removed', () => {
    expect(computeOrphanImages('', '', 'services:\n  a:\n    image: thing:latest\n')).toEqual([]);
  });

  it('deduplicates orphans', () => {
    expect(computeOrphanImages('', '', 'services:\n  a:\n    image: dup:1\n  b:\n    image: dup:1\n')).toEqual(['dup:1']);
  });
});

describe('removeImagesCommand', () => {
  // a docker that knows one running and one exited container of the image, and logs what it is asked
  const FAKE_DOCKER = [
    '#!/bin/sh',
    'echo "$*" >> calls',
    'case "$1" in',
    '  ps) case "$*" in *status=exited*) echo exited-1 ;; *) echo running-1; echo exited-1 ;; esac ;;',
    'esac',
  ].join('\n');

  test.if(hasPosixShell)('removes the stopped containers of an image, never a running one, then the image', async () => {
    const shell = new LocalShell();
    try {
      mkdirSync(join(shell.root, 'bin'));
      writeFileSync(join(shell.root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });

      await shell.run(`PATH="$PWD/bin:$PATH"; ${removeImagesCommand(['shop-web:1.0.0'])}`);

      const calls = readFileSync(join(shell.root, 'calls'), 'utf8').trim().split('\n');
      expect(calls[0]).toContain('ancestor=shop-web:1.0.0');
      expect(calls.slice(1)).toEqual(['rm exited-1', 'rmi shop-web:1.0.0']);
    } finally {
      rmSync(shell.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeBackend(options: { redeployFails?: boolean; convergenceFails?: boolean } = {}) {
  const redeployed: string[] = [];
  const backend = {
    redeploy: async (_stackName: string, content: string) => {
      redeployed.push(content);
      return options.redeployFails
        ? { success: false as const, error: new DeployError('redeploy boom') }
        : { success: true as const, data: undefined };
    },
    waitConvergence: async () => ({ converged: !options.convergenceFails, rolledBack: false, timedOut: false }),
  } as unknown as StackBackend;
  return { backend, redeployed };
}

/** Answers each command from a function, for the server failures a temporary directory cannot produce. */
function scripted(reply: (command: string) => Partial<SSHExecResult> | undefined): { shell: RemoteShell; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    shell: {
      async run(command) {
        commands.push(command);
        const answer = reply(command) ?? {};
        return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Failures reported by the server
// ---------------------------------------------------------------------------

describe('Release when the server refuses', () => {
  const twoReleases = (command: string) =>
    command.includes('for d in */') ? { stdout: listing(meta('2.0.0', 200), meta('1.0.0', 100)) } : undefined;

  it('a current symlink that cannot be updated fails the create', async () => {
    const { shell } = scripted((command) => (command.includes('ln -sfn') ? { stderr: 'permission denied', exitCode: 2 } : undefined));
    await expect(new Release(shell).createRelease(STACK, '1.0.0', 'services: {}\n', 'stack\n', meta('1.0.0', 100))).rejects.toThrow(
      'current release symlink',
    );
  });

  it('an unreadable stack stops the rollback before any redeploy', async () => {
    const { shell } = scripted((command) => twoReleases(command) ?? (command.startsWith('cat ') ? { exitCode: 1 } : undefined));
    const { backend, redeployed } = fakeBackend();
    await expect(new Release(shell).rollback(STACK, backend, '2.0.0')).rejects.toThrow('Could not read the stack for rollback');
    expect(redeployed).toEqual([]);
  });

  it('a failed redeploy leaves current alone', async () => {
    const { shell, commands } = scripted((command) => twoReleases(command) ?? (command.startsWith('cat ') ? { stdout: 'services: {}\n' } : undefined));
    const { backend } = fakeBackend({ redeployFails: true });
    await expect(new Release(shell).rollback(STACK, backend, '2.0.0')).rejects.toThrow('redeploy boom');
    expect(commands.some((command) => command.includes('ln -sfn'))).toBe(false);
  });

  it('a rollback that does not converge fails', async () => {
    const { shell } = scripted((command) => twoReleases(command) ?? (command.startsWith('cat ') ? { stdout: 'services: {}\n' } : undefined));
    const { backend } = fakeBackend({ convergenceFails: true });
    await expect(new Release(shell).rollback(STACK, backend, '2.0.0')).rejects.toThrow('Rollback to 1.0.0 did not converge');
  });

  it('a rollback deployed but not recorded says so', async () => {
    const { shell } = scripted(
      (command) =>
        twoReleases(command) ??
        (command.startsWith('cat ') ? { stdout: 'services: {}\n' } : command.startsWith('ln -sfn') ? { stderr: 'read-only file system', exitCode: 1 } : undefined),
    );
    await expect(new Release(shell).rollback(STACK, fakeBackend().backend, '2.0.0')).rejects.toThrow(
      'failed to update the current release symlink',
    );
  });

  it('no previous release → ROLLBACK_FAILED', async () => {
    const { shell } = scripted(() => undefined);
    await expect(new Release(shell).rollback(STACK, fakeBackend().backend, '1.0.0')).rejects.toMatchObject({
      code: ErrorCode.ROLLBACK_FAILED,
    });
  });

  it('a version that is not a plain name is refused before any command', async () => {
    const { shell, commands } = scripted(() => undefined);
    await expect(new Release(shell).createRelease(STACK, 'feature/login', '', '', meta('feature/login', 1))).rejects.toThrow(
      'cannot be used as a release directory name',
    );
    expect(commands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The release store on a real shell
// ---------------------------------------------------------------------------

describe('Release on a real shell', () => {
  let shell: LocalShell;
  let release: Release;
  const stackDir = (): string => join(shell.root, 'stacks', STACK);
  const file = (version: string, name: string): string => join(stackDir(), version, name);
  const current = (): string => readlinkSync(join(stackDir(), 'current'));
  const create = (version: string, epoch: number, stack = `stack ${version}\n`) =>
    release.createRelease(STACK, version, `compose ${version}\n`, stack, meta(version, epoch));

  beforeEach(() => {
    shell = new LocalShell();
    release = new Release(shell, { stacksDir: join(shell.root, 'stacks') });
  });

  afterEach(() => {
    rmSync(shell.root, { recursive: true, force: true });
  });

  test.if(hasPosixShell)('a release is written for the deploy user only and becomes current', async () => {
    const { previousSymlink } = await create('1.0.0', 100);
    expect(previousSymlink).toBeNull();
    expect(readFileSync(file('1.0.0', 'stack.yml'), 'utf8')).toBe('stack 1.0.0\n');
    expect(statSync(file('1.0.0', 'stack.yml')).mode & 0o777).toBe(0o600);
    expect(statSync(join(stackDir(), '1.0.0')).mode & 0o777).toBe(0o700);
    expect(current()).toBe(join(stackDir(), '1.0.0'));
    expect(readdirSync(stackDir()).sort()).toEqual(['1.0.0', 'current']);
  });

  test.if(hasPosixShell)('a failed redeploy of the same version gets its previous files back', async () => {
    await create('1.0.0', 100, 'old stack\n');
    const { previousSymlink } = await create('1.0.0', 200, 'new stack\n');
    expect(readFileSync(file('1.0.0', 'stack.yml'), 'utf8')).toBe('new stack\n');

    await release.removeRelease(STACK, '1.0.0', previousSymlink);
    expect(readFileSync(file('1.0.0', 'stack.yml'), 'utf8')).toBe('old stack\n');
    expect(current()).toBe(join(stackDir(), '1.0.0'));
    expect(readdirSync(stackDir()).sort()).toEqual(['1.0.0', 'current']);
  });

  test.if(hasPosixShell)('a failed new version is removed and current goes back', async () => {
    await create('1.0.0', 100);
    const { previousSymlink } = await create('1.0.1', 200);
    await release.removeRelease(STACK, '1.0.1', previousSymlink);
    expect(existsSync(join(stackDir(), '1.0.1'))).toBe(false);
    expect(current()).toBe(join(stackDir(), '1.0.0'));
  });

  test.if(hasPosixShell)('a rollback after a failed same-version redeploy re-applies the previous files', async () => {
    await create('1.0.0', 100, 'old stack\n');
    const { previousSymlink } = await create('1.0.0', 200, 'new stack\n');
    const { backend, redeployed } = fakeBackend();

    expect(await release.rollback(STACK, backend, '1.0.0', previousSymlink)).toBe('1.0.0');
    expect(redeployed).toEqual(['old stack\n']);
    expect(existsSync(join(stackDir(), '1.0.0'))).toBe(true);
  });

  test.if(hasPosixShell)('two manual rollbacks in a row walk back one release each', async () => {
    await create('1.0.0', 100);
    await create('1.0.1', 200);
    await create('1.0.2', 300);
    const { backend, redeployed } = fakeBackend();

    expect(await release.rollback(STACK, backend)).toBe('1.0.1');
    expect(await release.rollback(STACK, backend)).toBe('1.0.0');
    expect(redeployed).toEqual(['stack 1.0.1\n', 'stack 1.0.0\n']);
    expect(current()).toBe(join(stackDir(), '1.0.0'));
  });

  test.if(hasPosixShell)('cleanup keeps current, even rolled back past the retention', async () => {
    for (const [version, epoch] of [['1.0.0', 100], ['1.0.1', 200], ['1.0.2', 300], ['1.0.3', 400]] as const) {
      await create(version, epoch);
    }
    const { backend } = fakeBackend();
    await release.rollback(STACK, backend);
    await release.rollback(STACK, backend);
    await release.rollback(STACK, backend);
    expect(current()).toBe(join(stackDir(), '1.0.0'));

    await release.cleanupOldReleases(STACK, { project_name: 'demo', stack_management: { keep_releases: 2 } } as never);
    expect(readdirSync(stackDir()).sort()).toEqual(['1.0.0', '1.0.2', '1.0.3', 'current']);
  });

  test.if(hasPosixShell)('listing skips a directory whose metadata names another version', async () => {
    await create('1.0.0', 100);
    mkdirSync(join(stackDir(), 'other'));
    writeFileSync(join(stackDir(), 'other', 'metadata.json'), JSON.stringify(meta('1.0.0', 500)));
    expect((await release.listReleases(STACK)).map((r) => r.version)).toEqual(['1.0.0']);
    expect(await release.latestVersion(STACK)).toBe('1.0.0');
    expect(await release.currentVersion(STACK)).toBe('1.0.0');
  });
});
