import { afterEach, beforeEach, describe, expect, it, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertReleaseName,
  builtRepositories,
  computeOrphanImages,
  computeStaleTags,
  extractComposeImages,
  type ImageNode,
  missingImagesCommand,
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
import * as output from '../utils/output';
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

function fakeBackend(options: { redeployFails?: boolean; convergenceFails?: boolean; accessories?: string | null | Error } = {}) {
  const redeployed: string[] = [];
  const backend = {
    accessoriesDigest: async () => {
      if (options.accessories instanceof Error) throw options.accessories;
      return options.accessories ?? null;
    },
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

  test.if(hasPosixShell)('cleanup removes the images of the dropped releases on the other nodes too', async () => {
    for (const [version, epoch] of [['1.0.0', 100], ['1.0.1', 200]] as const) {
      await release.createRelease(STACK, version, `services:\n  web:\n    image: shop-web:${version}\n`, `stack ${version}\n`, meta(version, epoch));
    }
    const worker: string[] = [];
    const workerShell: RemoteShell = {
      async run(command) {
        worker.push(command);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await release.cleanupOldReleases(STACK, { project_name: 'demo', stack_management: { keep_releases: 1 } } as never, [workerShell]);

    expect(worker).toEqual([removeImagesCommand(['shop-web:1.0.0'])]);
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

// ---------------------------------------------------------------------------
// Accessories after a rollback
// ---------------------------------------------------------------------------

describe('Release rollback and the accessories', () => {
  let shell: LocalShell;
  let release: Release;
  let warnings: string[];
  let spies: { mockRestore(): void }[] = [];
  const stackDir = (): string => join(shell.root, 'stacks', STACK);
  const create = (version: string, epoch: number, accessories?: string) =>
    release.createRelease(STACK, version, `compose ${version}\n`, `stack ${version}\n`, {
      ...meta(version, epoch),
      ...(accessories && { accessories_digest: accessories }),
    });
  const accessoriesWarnings = () => warnings.filter((warning) => warning.startsWith('Accessories were not rolled back'));

  beforeEach(() => {
    shell = new LocalShell();
    release = new Release(shell, { stacksDir: join(shell.root, 'stacks') });
    warnings = [];
    spies = [
      spyOn(output, 'printWarning').mockImplementation((message: string) => {
        warnings.push(message);
      }),
      spyOn(output, 'printInfo').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    rmSync(shell.root, { recursive: true, force: true });
  });

  test.if(hasPosixShell)('the digest is stored in the release metadata', async () => {
    await create('1.0.0', 100, 'aaa');
    expect(JSON.parse(readFileSync(join(stackDir(), '1.0.0', 'metadata.json'), 'utf8')).accessories_digest).toBe('aaa');
    expect((await release.listReleases(STACK))[0].accessories_digest).toBe('aaa');
  });

  test.if(hasPosixShell)('warns, naming the version, when the accessories changed since the restored release', async () => {
    await create('1.0.0', 100, 'aaa');
    await create('1.0.1', 200, 'bbb');

    expect(await release.rollback(STACK, fakeBackend({ accessories: 'bbb' }).backend)).toBe('1.0.0');
    expect(accessoriesWarnings()).toEqual(['Accessories were not rolled back: they changed since 1.0.0']);
  });

  test.if(hasPosixShell)('warns after the automatic rollback of a failed deploy too', async () => {
    await create('1.0.0', 100, 'aaa');
    const { previousSymlink } = await create('1.0.1', 200, 'bbb');

    await release.rollback(STACK, fakeBackend({ accessories: 'bbb' }).backend, '1.0.1', previousSymlink);
    expect(accessoriesWarnings()).toEqual(['Accessories were not rolled back: they changed since 1.0.0']);
  });

  test.if(hasPosixShell)('says nothing when the accessories are the ones the release ran with', async () => {
    await create('1.0.0', 100, 'aaa');
    await create('1.0.1', 200, 'aaa');

    await release.rollback(STACK, fakeBackend({ accessories: 'aaa' }).backend);
    expect(accessoriesWarnings()).toEqual([]);
  });

  test.if(hasPosixShell)('says nothing for a release that recorded no digest', async () => {
    await create('1.0.0', 100);
    await create('1.0.1', 200, 'bbb');

    await release.rollback(STACK, fakeBackend({ accessories: 'bbb' }).backend);
    expect(accessoriesWarnings()).toEqual([]);
  });

  test.if(hasPosixShell)('says nothing when the server has no accessories digest to compare with', async () => {
    await create('1.0.0', 100, 'aaa');
    await create('1.0.1', 200, 'bbb');

    await release.rollback(STACK, fakeBackend({ accessories: null }).backend);
    expect(accessoriesWarnings()).toEqual([]);
  });

  test.if(hasPosixShell)('a digest that cannot be read does not fail the rollback', async () => {
    await create('1.0.0', 100, 'aaa');
    await create('1.0.1', 200, 'bbb');

    expect(await release.rollback(STACK, fakeBackend({ accessories: new Error('ssh down') }).backend)).toBe('1.0.0');
    expect(accessoriesWarnings()).toEqual([]);
    expect(readlinkSync(join(stackDir(), 'current'))).toBe(join(stackDir(), '1.0.0'));
  });
});

// ---------------------------------------------------------------------------
// Images on the nodes before a rollback without registry
// ---------------------------------------------------------------------------

describe('extractComposeImages built only', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: shop-web-production:1.0.0',
    '    build: ./web',
    '  api:',
    '    image: shop-api-production:1.0.0',
    '    build:',
    '      context: ./api',
    '  cache:',
    '    image: redis:7',
    '',
  ].join('\n');

  it('keeps the images of the services with a build section', () => {
    expect(extractComposeImages(compose, true)).toEqual(['shop-web-production:1.0.0', 'shop-api-production:1.0.0']);
    expect(extractComposeImages(compose)).toEqual(['shop-web-production:1.0.0', 'shop-api-production:1.0.0', 'redis:7']);
  });
});

describe('Release rollback and the images on the nodes', () => {
  const COMPOSE = [
    'services:',
    '  web:',
    '    image: shop-web-production:1.0.0',
    '    build: ./web',
    '  api:',
    '    image: shop-api-production:1.0.0',
    '    build: ./api',
    '  cache:',
    '    image: redis:7',
    '',
  ].join('\n');
  // a docker that has the images listed, one per line, in the file `images`
  const FAKE_DOCKER = ['#!/bin/sh', '[ "$1 $2" = "image inspect" ] || exit 2', 'grep -qxF "$3" images'].join('\n');

  let manager: LocalShell;
  let worker: LocalShell;
  let release: Release;
  let warnings: string[];
  let spies: { mockRestore(): void }[] = [];
  const stackDir = (): string => join(manager.root, 'stacks', STACK);

  /** a node of the cluster holding `images`, whose shell runs the fake docker */
  function node(shell: LocalShell, name: string, images: string[]): ImageNode {
    mkdirSync(join(shell.root, 'bin'), { recursive: true });
    writeFileSync(join(shell.root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(join(shell.root, 'images'), images.map((image) => `${image}\n`).join(''));
    return { name, shell: { run: (command, stdin) => shell.run(`PATH="$PWD/bin:$PATH"; ${command}`, stdin) } };
  }

  const releaseImages = ['shop-web-production:1.0.0', 'shop-api-production:1.0.0'];

  beforeEach(async () => {
    manager = new LocalShell();
    worker = new LocalShell();
    release = new Release(manager, { stacksDir: join(manager.root, 'stacks') });
    warnings = [];
    spies = [
      spyOn(output, 'printWarning').mockImplementation((message: string) => {
        warnings.push(message);
      }),
      spyOn(output, 'printInfo').mockImplementation(() => {}),
    ];
    await release.createRelease(STACK, '1.0.0', COMPOSE, 'stack 1.0.0\n', meta('1.0.0', 100));
    await release.createRelease(STACK, '1.0.1', COMPOSE.replaceAll('1.0.0', '1.0.1'), 'stack 1.0.1\n', meta('1.0.1', 200));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    rmSync(manager.root, { recursive: true, force: true });
    rmSync(worker.root, { recursive: true, force: true });
  });

  test.if(hasPosixShell)('missingImagesCommand lists the images a node does not have', async () => {
    const result = await node(worker, 'worker', ['shop-web-production:1.0.0']).shell.run(missingImagesCommand(releaseImages));
    expect(result.stdout).toBe('shop-api-production:1.0.0\n');
  });

  test.if(hasPosixShell)('fails at once, naming the missing images and the nodes, and changes nothing', async () => {
    const nodes = [node(manager, 'server_1', releaseImages), node(worker, 'agent_1', ['shop-web-production:1.0.0'])];
    const { backend, redeployed } = fakeBackend();

    const failure = await release.rollback(STACK, backend, null, null, { imageNodes: nodes }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect((failure as DeployError).message).toBe(
      'Cannot roll back to 1.0.0: its images are missing on agent_1 (shop-api-production:1.0.0)',
    );
    expect((failure as DeployError).suggestion).toContain('Deploy 1.0.0 again');
    expect(redeployed).toEqual([]);
    expect(readlinkSync(join(stackDir(), 'current'))).toBe(join(stackDir(), '1.0.1'));
  });

  test.if(hasPosixShell)('names every node that lacks something', async () => {
    const nodes = [node(manager, 'server_1', ['shop-api-production:1.0.0']), node(worker, 'agent_1', [])];

    const failure = await release.rollback(STACK, fakeBackend().backend, null, null, { imageNodes: nodes }).catch((error: unknown) => error);

    expect((failure as DeployError).message).toBe(
      'Cannot roll back to 1.0.0: its images are missing on server_1 (shop-web-production:1.0.0); agent_1 (shop-web-production:1.0.0, shop-api-production:1.0.0)',
    );
  });

  test.if(hasPosixShell)('rolls back when every node has the images; an image Dockflow does not build is not asked for', async () => {
    const nodes = [node(manager, 'server_1', releaseImages), node(worker, 'agent_1', releaseImages)];
    const { backend, redeployed } = fakeBackend();

    expect(await release.rollback(STACK, backend, null, null, { imageNodes: nodes })).toBe('1.0.0');
    expect(redeployed).toEqual(['stack 1.0.0\n']);
  });

  test.if(hasPosixShell)('checks the target of the automatic rollback of a failed deploy too', async () => {
    const nodes = [node(worker, 'agent_1', [])];
    const previous = join(stackDir(), '1.0.0');

    await expect(release.rollback(STACK, fakeBackend().backend, '1.0.1', previous, { imageNodes: nodes })).rejects.toMatchObject({
      code: ErrorCode.ROLLBACK_FAILED,
    });
  });

  test.if(hasPosixShell)('does not look at the nodes when none is given, as with a registry', async () => {
    const { backend, redeployed } = fakeBackend();
    expect(await release.rollback(STACK, backend)).toBe('1.0.0');
    expect(redeployed).toEqual(['stack 1.0.0\n']);
  });

  test.if(hasPosixShell)('a node that cannot be asked is reported and does not block the rollback', async () => {
    const unreachable: ImageNode = {
      name: 'agent_2',
      shell: {
        async run() {
          throw new Error('Timed out');
        },
      },
    };
    const nodes = [node(manager, 'server_1', releaseImages), unreachable];

    expect(await release.rollback(STACK, fakeBackend().backend, null, null, { imageNodes: nodes })).toBe('1.0.0');
    expect(warnings).toContain('Could not check the images on agent_2: Timed out');
  });
});

// ---------------------------------------------------------------------------
// Tag sweep at release cleanup
// ---------------------------------------------------------------------------

describe('builtRepositories', () => {
  const compose = [
    'services:',
    '  web:',
    '    image: shop-web-production:1.0.0',
    '    build: ./web',
    '  api:',
    '    image: registry.example.com:5000/team/shop-api-production:1.0.0',
    '    build: ./api',
    '  worker:',
    '    image: shop-worker:1.0.0',
    '    build: ./worker',
    '  db:',
    '    image: postgres-production:16',
    '',
  ].join('\n');

  it('names the repositories Dockflow tags for the environment, registry prefix included', () => {
    expect(builtRepositories(compose, 'production')).toEqual(['shop-web-production', 'registry.example.com:5000/team/shop-api-production']);
  });

  it('is empty for another environment', () => {
    expect(builtRepositories(compose, 'staging')).toEqual([]);
  });
});

describe('computeStaleTags', () => {
  const repositories = new Set(['shop-web-production']);
  const local = [
    'shop-web-production:1.0.0',
    'shop-web-production:0.9.0',
    'shop-web-production:latest',
    'shop-web-production:<none>',
    'shop-web-staging:0.9.0',
    'other:0.9.0',
    '',
  ].join('\n');

  it('keeps what a release or a service refers to, :latest, untagged images and other repositories', () => {
    expect(computeStaleTags(local, repositories, ['shop-web-production:1.0.0'])).toEqual(['shop-web-production:0.9.0']);
  });

  it('reads an image running by digest as its tag', () => {
    expect(computeStaleTags(local, repositories, ['shop-web-production:1.0.0@sha256:abc123', 'shop-web-production:0.9.0@sha256:def456'])).toEqual([]);
  });
});

describe('Release cleanup sweeps the tags nothing refers to', () => {
  const composeOf = (version: string) =>
    [
      'services:',
      '  web:',
      `    image: shop-web-production:${version}`,
      '    build: ./web',
      '  cache:',
      '    image: redis:7',
      '',
    ].join('\n');
  // a docker with local images in `images`, running ones in `running`; every call is logged in `calls`
  const FAKE_DOCKER = [
    '#!/bin/sh',
    'echo "$*" >> calls',
    'case "$1" in',
    '  images) cat images ;;',
    '  ps) case "$*" in *"{{.Image}}"*) cat running ;; esac ;;',
    '  stack) ;;',
    '  rmi) grep -qxF "$2" running && exit 1; grep -vxF "$2" images > images.new; mv images.new images ;;',
    'esac',
  ].join('\n');

  let manager: LocalShell;
  let worker: LocalShell;
  let release: Release;
  const config = (keep: number) => ({ project_name: 'shop', stack_management: { keep_releases: keep } }) as never;
  const create = (version: string, epoch: number) =>
    release.createRelease(STACK, version, composeOf(version), `stack ${version}\n`, { ...meta(version, epoch), env: 'production' });

  /** a node whose docker has `images`, and `running` containers */
  function node(shell: LocalShell, images: string[], running: string[] = []): RemoteShell {
    mkdirSync(join(shell.root, 'bin'), { recursive: true });
    writeFileSync(join(shell.root, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(join(shell.root, 'images'), images.map((image) => `${image}\n`).join(''));
    writeFileSync(join(shell.root, 'running'), running.map((image) => `${image}\n`).join(''));
    writeFileSync(join(shell.root, 'calls'), '');
    return { run: (command, stdin) => shell.run(`PATH="$PWD/bin:$PATH"; ${command}`, stdin) };
  }
  const calls = (shell: LocalShell) => readFileSync(join(shell.root, 'calls'), 'utf8').trim().split('\n');
  const images = (shell: LocalShell) => readFileSync(join(shell.root, 'images'), 'utf8').trim().split('\n').sort();
  const removed = (shell: LocalShell) => calls(shell).filter((call) => call.startsWith('rmi ')).map((call) => call.slice(4)).sort();

  const LEFTOVERS = [
    'shop-web-production:0.9.0',
    'shop-web-production:0.8.0',
    'shop-web-production:latest',
    'shop-web-staging:0.9.0',
    'other:0.9.0',
    'redis:6',
  ];

  beforeEach(() => {
    manager = new LocalShell();
    worker = new LocalShell();
  });

  afterEach(() => {
    rmSync(manager.root, { recursive: true, force: true });
    rmSync(worker.root, { recursive: true, force: true });
  });

  async function cleanup(keep: number, nodes: { manager: RemoteShell; worker: RemoteShell }) {
    release = new Release(nodes.manager, { stacksDir: join(manager.root, 'stacks') });
    await create('1.0.0', 100);
    await create('1.0.1', 200);
    await create('1.0.2', 300);
    await release.cleanupOldReleases(STACK, config(keep), [nodes.worker]);
  }

  // The manager's shell also holds the release files: its docker is the fake one, its releases are real.
  test.if(hasPosixShell)('removes the tags of the project no kept release refers to, on every node, and nothing else', async () => {
    const kept = ['shop-web-production:1.0.2', 'shop-web-production:1.0.1'];
    const managerNode = node(manager, [...kept, 'shop-web-production:1.0.0', ...LEFTOVERS]);
    const workerNode = node(worker, [...kept, 'shop-web-production:0.9.0', 'other:0.9.0']);

    await cleanup(2, { manager: managerNode, worker: workerNode });

    expect(removed(manager)).toEqual(['shop-web-production:0.8.0', 'shop-web-production:0.9.0', 'shop-web-production:1.0.0']);
    expect(images(manager)).toEqual(['other:0.9.0', 'redis:6', 'shop-web-production:1.0.1', 'shop-web-production:1.0.2', 'shop-web-production:latest', 'shop-web-staging:0.9.0']);
    expect(removed(worker)).toEqual(['shop-web-production:0.9.0', 'shop-web-production:1.0.0']);
    expect(images(worker)).toEqual(['other:0.9.0', 'shop-web-production:1.0.1', 'shop-web-production:1.0.2']);
  });

  test.if(hasPosixShell)('sweeps even when no release is dropped', async () => {
    const kept = ['shop-web-production:1.0.2', 'shop-web-production:1.0.1', 'shop-web-production:1.0.0'];
    const managerNode = node(manager, [...kept, 'shop-web-production:0.9.0']);
    const workerNode = node(worker, kept);

    await cleanup(3, { manager: managerNode, worker: workerNode });

    expect(removed(manager)).toEqual(['shop-web-production:0.9.0']);
    expect(removed(worker)).toEqual([]);
    expect(readdirSync(join(manager.root, 'stacks', STACK)).sort()).toEqual(['1.0.0', '1.0.1', '1.0.2', 'current']);
  });

  test.if(hasPosixShell)('never removes the image of a running container, even one no release refers to', async () => {
    const managerNode = node(manager, ['shop-web-production:1.0.2', 'shop-web-production:0.9.0', 'shop-web-production:0.8.0'], ['shop-web-production:0.8.0']);
    const workerNode = node(worker, []);

    await cleanup(3, { manager: managerNode, worker: workerNode });

    expect(removed(manager)).toEqual(['shop-web-production:0.9.0']);
    expect(images(manager)).toContain('shop-web-production:0.8.0');
  });

  test.if(hasPosixShell)('sweeps nothing when a kept release cannot be read', async () => {
    const managerNode = node(manager, ['shop-web-production:1.0.2', 'shop-web-production:0.9.0']);
    const workerNode = node(worker, ['shop-web-production:0.9.0']);
    release = new Release(managerNode, { stacksDir: join(manager.root, 'stacks') });
    await create('1.0.0', 100);
    await create('1.0.1', 200);
    rmSync(join(manager.root, 'stacks', STACK, '1.0.1', 'docker-compose.yml'));

    await release.cleanupOldReleases(STACK, config(3), [workerNode]);

    expect(removed(manager)).toEqual([]);
    expect(removed(worker)).toEqual([]);
  });

  test.if(hasPosixShell)('a node whose docker does not answer is left alone and does not stop the others', async () => {
    const managerNode = node(manager, ['shop-web-production:1.0.2', 'shop-web-production:0.9.0']);
    const workerNode: RemoteShell = { run: async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }) };

    await cleanup(3, { manager: managerNode, worker: workerNode });

    expect(removed(manager)).toEqual(['shop-web-production:0.9.0']);
  });
});
