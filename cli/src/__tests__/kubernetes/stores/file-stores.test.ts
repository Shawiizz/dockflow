import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DOCKFLOW_ACCESSORIES_DIR, DOCKFLOW_LOCKS_DIR, DOCKFLOW_STACKS_DIR } from '../../../constants';
import type {
  HelmReleaseRecord,
  LockData,
  ReleaseInput,
  ReleaseMetadata,
  StackArtifact,
} from '../../../services/orchestrator/interfaces';
import { FileLockStore, type FileLockStoreOptions } from '../../../services/orchestrator/stores/file-lock-store';
import { DOCKFLOW_STATE_ROOT, FileReleaseStore } from '../../../services/orchestrator/stores/file-release-store';
import type { Result } from '../../../types/result';
import { DeployError, ErrorCode } from '../../../utils/errors';
import { canonicalJson, sha256Hex } from '../../../utils/hash';
import { hasPosixShell, LocalShell, type ScriptedReply, ScriptedShell } from '../fakes/local-shell';

const STACK = 'shop-production';
const HEADER = '# dockflow-artifact: swarm-compose/1';
const T0 = Date.parse('2026-09-19T10:00:00.000Z');
const MINUTE = 60_000;
const STALE_TAKEN = 'Lock was stale but another deploy acquired it first';

function metadata(version: string, epoch: number): ReleaseMetadata {
  return {
    project_name: 'shop',
    version,
    env: 'production',
    timestamp: new Date(epoch * 1000).toISOString(),
    epoch,
    performer: 'ci@runner',
    branch: 'main',
    orchestrator: 'swarm',
    artifact_format: 'swarm-compose/1',
  };
}

function artifact(content: string, helm: HelmReleaseRecord[] = []): StackArtifact {
  return {
    format: 'swarm-compose/1',
    role: 'app',
    content,
    helm,
    diagnostics: [],
    digest: sha256Hex(`${content}\n${canonicalJson(helm)}`),
  };
}

/** `build` changes the content without changing the version (same-version redeploys) */
function release(version: string, epoch: number, build = version): ReleaseInput {
  const compose = `services:\n  web:\n    image: registry.example.com/shop-web:${build}\n`;
  return {
    version,
    compose,
    artifact: artifact(`${HEADER}\n${compose}`),
    metadata: metadata(version, epoch),
  };
}

function lockData(performer: string, startedAt: number, message = 'Deploy 1.0.0'): LockData {
  return {
    performer,
    started_at: new Date(startedAt).toISOString(),
    timestamp: Math.floor(startedAt / 1000),
    version: '1.0.0',
    stack: STACK,
    message,
  };
}

function errorOf<T>(result: Result<T, Error>): string {
  if (result.success) throw new Error('expected a failed result');
  return result.error.message;
}

function dataOf<T>(result: Result<T, Error>): T {
  if (!result.success) throw result.error;
  return result.data;
}

async function thrown(run: () => Promise<unknown>): Promise<DeployError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DeployError) return error;
    throw error;
  }
  throw new Error('expected a DeployError');
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

type LockCommand = 'read' | 'create' | 'takeover' | 'force' | 'release';

function lockCommand(command: string): LockCommand {
  if (command.startsWith('cat ')) return 'read';
  if (command.includes('.takeover')) return 'takeover';
  if (command.startsWith('rm -f ')) return 'release';
  if (command.includes(' ln ')) return 'create';
  return 'force';
}

function scriptedLock(
  replies: Partial<Record<LockCommand, ScriptedReply | ScriptedReply[]>>,
  options: FileLockStoreOptions = {},
): { shell: ScriptedShell; lock: FileLockStore } {
  const seen: Partial<Record<LockCommand, number>> = {};
  const shell = new ScriptedShell((command) => {
    const kind = lockCommand(command);
    const reply = replies[kind];
    if (!Array.isArray(reply)) return reply;
    const index = seen[kind] ?? 0;
    seen[kind] = index + 1;
    return reply[Math.min(index, reply.length - 1)];
  });
  return { shell, lock: new FileLockStore(shell, STACK, { now: () => T0, performer: 'bob@ci', ...options }) };
}

describe('FileReleaseStore', () => {
  let shell: LocalShell;
  let stackDir: string;
  const releases = (): FileReleaseStore => new FileReleaseStore(shell, { root: shell.root });

  beforeEach(() => {
    shell = new LocalShell();
    stackDir = shell.path('stacks', STACK);
  });

  afterEach(() => {
    shell.cleanup();
  });

  test.if(hasPosixShell)(
    'U-SWARM-06: create writes the release files 0600 under umask 077 and returns the previous version name',
    async () => {
      const store = releases();
      const first = release('1.0.0', 100);

      expect(await store.create(STACK, first)).toEqual({ previous: null });

      const dir = join(stackDir, '1.0.0');
      expect(readdirSync(dir).sort()).toEqual(['docker-compose.yml', 'metadata.json', 'stack.yml']);
      for (const file of ['docker-compose.yml', 'stack.yml', 'metadata.json']) {
        expect(mode(join(dir, file))).toBe(0o600);
      }
      expect(mode(dir)).toBe(0o700);
      expect(readFileSync(join(dir, 'stack.yml'), 'utf8').split('\n')[0]).toBe(HEADER);
      expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toBe(first.compose);
      expect(JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'))).toEqual(first.metadata);
      expect(readlinkSync(join(stackDir, 'current'))).toBe(`${shell.root}/stacks/${STACK}/1.0.0`);

      expect(await store.create(STACK, release('1.1.0', 200))).toEqual({ previous: '1.0.0' });
      expect(mode(join(stackDir, '1.1.0', 'metadata.json'))).toBe(0o600);

      const writes = shell.calls.filter((call) => call.command.includes('cat > ') || call.command.includes('mkdir '));
      expect(writes.length).toBeGreaterThan(0);
      for (const call of writes) expect(call.command.startsWith('umask 077')).toBe(true);
    },
  );

  test.if(hasPosixShell)(
    'U-SWARM-08: readArtifact falls back to docker-compose.yml with format swarm-compose/1 for old releases',
    async () => {
      const compose = 'services:\n  web:\n    image: registry.example.com/shop-web:0.9.0\n';
      mkdirSync(join(stackDir, '0.9.0'), { recursive: true });
      writeFileSync(join(stackDir, '0.9.0', 'docker-compose.yml'), compose);
      writeFileSync(join(stackDir, '0.9.0', 'metadata.json'), JSON.stringify(metadata('0.9.0', 90), null, 2));
      // a stack.yml written before the artifact header existed
      mkdirSync(join(stackDir, '0.9.5'), { recursive: true });
      writeFileSync(join(stackDir, '0.9.5', 'stack.yml'), compose);

      const store = releases();
      expect(await store.readArtifact(STACK, '0.9.0')).toEqual(artifact(compose));
      expect(await store.readArtifact(STACK, '0.9.5')).toEqual(artifact(compose));
      expect(await store.readCompose(STACK, '0.9.0')).toBe(compose);
    },
  );

  test.if(hasPosixShell)('C-REL-04: readArtifact round-trips content, format and helm; diagnostics are []', async () => {
    const helm: HelmReleaseRecord[] = [
      {
        name: 'cache',
        role: 'app',
        namespace: 'dockflow-shop-production',
        chart: { kind: 'repo', repo: 'https://charts.example.com', chart: 'cache' },
        version: '1.2.3',
        values: { replicas: 2, auth: { enabled: false } },
        valuesSha256: 'b'.repeat(64),
        timeoutS: 300,
        chartSha256: null,
      },
    ];
    const input = release('1.0.0', 100);
    const stored = { ...input, artifact: artifact(input.artifact.content, helm) };
    const store = releases();
    await store.create(STACK, stored);

    expect(mode(join(stackDir, '1.0.0', 'helm.json'))).toBe(0o600);
    expect(await store.readArtifact(STACK, '1.0.0')).toEqual(stored.artifact);
  });

  test.if(hasPosixShell)('stack.yml always starts with the artifact header, added when the content has none', async () => {
    const compose = 'services:\n  web:\n    image: registry.example.com/shop-web:1.0.0\n';
    const store = releases();
    await store.create(STACK, { ...release('1.0.0', 100), artifact: artifact(compose) });

    const read = await store.readArtifact(STACK, '1.0.0');
    expect(read.content).toBe(`${HEADER}\n${compose}`);
    expect(read.format).toBe('swarm-compose/1');
    expect(read.digest).toBe(sha256Hex(`${HEADER}\n${compose}\n[]`));
  });

  test.if(hasPosixShell)(
    'C-REL-02/03/05: current, currentVersion, currentCompose, readCompose, list and latestVersion',
    async () => {
      const store = releases();
      expect(await store.current(STACK)).toBeNull();
      expect(await store.currentVersion(STACK)).toBeNull();
      expect(await store.currentCompose(STACK)).toBeNull();
      expect(await store.list(STACK)).toEqual([]);
      expect(await store.latestVersion(STACK)).toBeNull();

      const inputs = [release('1.0.0', 100), release('1.2.0', 300), release('1.1.0', 200)];
      for (const input of inputs) await store.create(STACK, input);

      expect(await store.current(STACK)).toEqual(inputs[2].metadata);
      expect(await store.currentVersion(STACK)).toBe('1.1.0');
      expect(await store.currentCompose(STACK)).toBe(inputs[2].compose);
      expect(await store.readCompose(STACK, '1.0.0')).toBe(inputs[0].compose);
      expect(await store.readCompose(STACK, '9.9.9')).toBeNull();
      expect((await store.list(STACK)).map((entry) => entry.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
      expect(await store.latestVersion(STACK)).toBe('1.2.0');
    },
  );

  test.if(hasPosixShell)('list skips corrupted metadata and metadata naming another version', async () => {
    const store = releases();
    await store.create(STACK, release('1.0.0', 100));
    mkdirSync(join(stackDir, 'broken'));
    writeFileSync(join(stackDir, 'broken', 'metadata.json'), '{not json');
    mkdirSync(join(stackDir, 'renamed'));
    writeFileSync(join(stackDir, 'renamed', 'metadata.json'), JSON.stringify(metadata('..', 50)));

    expect((await store.list(STACK)).map((entry) => entry.version)).toEqual(['1.0.0']);
    // prune only ever deletes listed versions
    await store.prune(STACK, 0);
    expect(existsSync(join(stackDir, 'broken'))).toBe(true);
    expect(existsSync(join(stackDir, 'renamed'))).toBe(true);
  });

  test.if(hasPosixShell)('C-REL-06/07/08: setCurrent(null), remove of a non-current release, remove with restoreCurrentTo', async () => {
    const store = releases();
    for (const input of [release('1.0.0', 100), release('1.1.0', 200), release('1.2.0', 300)]) {
      await store.create(STACK, input);
    }

    await store.remove(STACK, '1.0.0', { restoreCurrentTo: null });
    expect(existsSync(join(stackDir, '1.0.0'))).toBe(false);
    expect(await store.currentVersion(STACK)).toBe('1.2.0');

    await store.remove(STACK, '1.2.0', { restoreCurrentTo: '1.1.0' });
    expect(existsSync(join(stackDir, '1.2.0'))).toBe(false);
    expect(await store.currentVersion(STACK)).toBe('1.1.0');
    expect(await store.current(STACK)).toEqual(metadata('1.1.0', 200));

    await store.setCurrent(STACK, null);
    expect(await store.currentVersion(STACK)).toBeNull();
    expect(await store.current(STACK)).toBeNull();
    expect(existsSync(join(stackDir, '1.1.0'))).toBe(true);

    await store.setCurrent(STACK, '1.1.0');
    expect(await store.currentVersion(STACK)).toBe('1.1.0');
  });

  test.if(hasPosixShell)('C-REL-09: prune(2) keeps current and the newest other release, returns the removed metadata', async () => {
    const store = releases();
    for (const input of [release('1.0.0', 100), release('1.1.0', 200), release('1.2.0', 300), release('1.3.0', 400)]) {
      await store.create(STACK, input);
    }
    await store.setCurrent(STACK, '1.0.0');

    const removed = await store.prune(STACK, 2);

    expect(removed).toEqual([metadata('1.2.0', 300), metadata('1.1.0', 200)]);
    expect((await store.list(STACK)).map((entry) => entry.version)).toEqual(['1.3.0', '1.0.0']);
    expect(await store.currentVersion(STACK)).toBe('1.0.0');
    expect(await store.prune(STACK, 2)).toEqual([]);
  });

  test.if(hasPosixShell)('C-REL-10: readArtifact of a missing release throws DeployError ROLLBACK_FAILED', async () => {
    const error = await thrown(() => releases().readArtifact(STACK, '4.0.0'));
    expect(error.code).toBe(ErrorCode.ROLLBACK_FAILED);
    expect(error.message).toBe(`Release 4.0.0 not found in ${stackDir}`);
  });

  test.if(hasPosixShell)(
    'C-REL-11: a same-version create replaces the release without ever leaving it unreadable',
    async () => {
      const store = releases();
      await store.create(STACK, release('1.0.0', 100));
      const dir = join(stackDir, '1.0.0');
      const unreadable: string[] = [];
      shell.onCommand = (command) => {
        try {
          const stack = readFileSync(join(dir, 'stack.yml'), 'utf8');
          const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as ReleaseMetadata;
          if (!stack.startsWith(HEADER) || meta.version !== '1.0.0') unreadable.push(command);
        } catch {
          unreadable.push(command);
        }
      };

      const second = release('1.0.0', 200, '1.0.0-rebuilt');
      expect(await store.create(STACK, second)).toEqual({ previous: '1.0.0' });
      shell.onCommand = null;

      expect(unreadable).toEqual([]);
      expect(await store.readArtifact(STACK, '1.0.0')).toEqual(second.artifact);
      expect(await store.current(STACK)).toEqual(second.metadata);
      expect(await store.list(STACK)).toEqual([second.metadata]);
      expect(mode(join(dir, 'stack.yml'))).toBe(0o600);
    },
  );

  test.if(hasPosixShell)(
    'an interrupted same-version create keeps the previous files readable; the next create drops the leftovers',
    async () => {
      const first = release('1.0.0', 100);
      await releases().create(STACK, first);
      shell.onCommand = (command) => {
        if (command.includes('echo replacing')) throw new Error('connection lost');
      };

      await expect(releases().create(STACK, release('1.0.0', 200, 'rebuilt'))).rejects.toThrow('connection lost');
      shell.onCommand = null;

      const fresh = releases();
      expect(await fresh.readArtifact(STACK, '1.0.0')).toEqual(first.artifact);
      expect(await fresh.list(STACK)).toEqual([first.metadata]);
      expect(readdirSync(stackDir).some((name) => name.startsWith('.tmp-'))).toBe(true);

      await fresh.create(STACK, release('1.1.0', 300));
      expect(readdirSync(stackDir).filter((name) => name.startsWith('.'))).toEqual([]);
    },
  );

  test.if(hasPosixShell)(
    'a failed same-version redeploy restores the previous files on remove(v, {restoreCurrentTo: v})',
    async () => {
      const store = releases();
      const first = release('1.0.0', 100);
      await store.create(STACK, first);
      await store.create(STACK, { ...release('1.0.0', 200, 'rebuilt'), artifact: artifact(`${HEADER}\nx: 1\n`, []) });

      await store.remove(STACK, '1.0.0', { restoreCurrentTo: '1.0.0' });

      expect(await store.readArtifact(STACK, '1.0.0')).toEqual(first.artifact);
      expect(await store.current(STACK)).toEqual(first.metadata);
      expect(await store.currentCompose(STACK)).toBe(first.compose);
      expect(readdirSync(stackDir).filter((name) => name.startsWith('.'))).toEqual([]);

      // the restore is one-shot: a later remove deletes the release
      await store.remove(STACK, '1.0.0', { restoreCurrentTo: null });
      expect(existsSync(join(stackDir, '1.0.0'))).toBe(false);
      expect(await store.currentVersion(STACK)).toBeNull();
    },
  );

  test.if(hasPosixShell)(
    "C-REL-12: readState and writeAccessoriesDigest round trip through today's hash file across instances",
    async () => {
      const digest = 'a'.repeat(64);
      const hashFile = shell.path('accessories', STACK, '.hash');

      await releases().writeAccessoriesDigest(STACK, digest);
      expect(readFileSync(hashFile, 'utf8')).toBe(`${digest}\n`);
      expect(await releases().readState(STACK)).toEqual({ current: null, accessoriesDigest: digest });

      await releases().create(STACK, release('1.0.0', 100));
      expect(await releases().readState(STACK)).toEqual({ current: '1.0.0', accessoriesDigest: digest });

      await releases().writeAccessoriesDigest(STACK, null);
      expect(existsSync(hashFile)).toBe(false);
      expect(await releases().readState(STACK)).toEqual({ current: '1.0.0', accessoriesDigest: null });
    },
  );

  test('R-S2-03: every path sits under the root option, /var/lib/dockflow by default', async () => {
    expect(`${DOCKFLOW_STATE_ROOT}/stacks`).toBe(DOCKFLOW_STACKS_DIR);
    expect(`${DOCKFLOW_STATE_ROOT}/locks`).toBe(DOCKFLOW_LOCKS_DIR);
    expect(`${DOCKFLOW_STATE_ROOT}/accessories`).toBe(DOCKFLOW_ACCESSORIES_DIR);

    const scripted = new ScriptedShell(() => undefined);
    const defaults = new FileReleaseStore(scripted);
    expect(defaults.hookWorkingDir(STACK)).toBe(`${DOCKFLOW_STACKS_DIR}/${STACK}/current`);
    await defaults.readState(STACK);
    await new FileLockStore(scripted, STACK).status();
    expect(scripted.calls.map((call) => call.command)).toEqual([
      `printf '%s\\n' "$(readlink '${DOCKFLOW_STACKS_DIR}/${STACK}/current' 2>/dev/null)" "$(cat '${DOCKFLOW_ACCESSORIES_DIR}/${STACK}/.hash' 2>/dev/null)"`,
      `cat '${DOCKFLOW_LOCKS_DIR}/${STACK}.lock' 2>/dev/null || echo NO_LOCK`,
    ]);

    const custom = new FileReleaseStore(scripted, { root: '/srv/dockflow-test/' });
    expect(custom.hookWorkingDir(STACK)).toBe(`/srv/dockflow-test/stacks/${STACK}/current`);
    await new FileLockStore(scripted, STACK, { root: '/srv/dockflow-test' }).status();
    expect(scripted.calls.at(-1)?.command).toBe(`cat '/srv/dockflow-test/locks/${STACK}.lock' 2>/dev/null || echo NO_LOCK`);
  });

  test('names that are not one plain path segment are refused before any command', async () => {
    const scripted = new ScriptedShell(() => undefined);
    const store = new FileReleaseStore(scripted);

    for (const version of ['', '.', '..', '.hidden', 'a/b', '../x', 'current', 'v1\n2']) {
      const error = await thrown(() => store.create(STACK, release(version, 1)));
      expect(error.message).toBe(`Version ${JSON.stringify(version)} cannot be used as a release directory name`);
      expect(error.suggestion).toBe(
        'Use a version without `/` or control characters that does not start with `.` and is not `current`.',
      );
    }
    await thrown(() => store.readArtifact(STACK, '..'));
    await thrown(() => store.remove('../other', '1.0.0'));
    expect(() => store.hookWorkingDir('shop/production')).toThrow(
      'Stack name "shop/production" cannot be used as a file name',
    );
    expect(() => new FileLockStore(scripted, STACK, { name: '../proxy' })).toThrow(
      'Lock name "../proxy" cannot be used as a file name',
    );
    expect(scripted.calls).toEqual([]);
  });

  test('create failures keep the messages of the release directory code', async () => {
    const denied = new ScriptedShell(
      (command) => (command.startsWith('umask 077\nmkdir -p') ? { exitCode: 1, stderr: 'Permission denied\n' } : undefined),
      'deploy',
    );
    const mkdirError = await thrown(() => new FileReleaseStore(denied).create(STACK, release('1.0.0', 100)));
    expect(mkdirError.message).toBe(
      `Failed to create release directory ${DOCKFLOW_STACKS_DIR}/${STACK}/1.0.0: Permission denied`,
    );
    expect(mkdirError.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(mkdirError.suggestion).toBe(
      `Ensure the deploy user has write access to ${DOCKFLOW_STACKS_DIR}/${STACK}. Run once as root: \`mkdir -p '${DOCKFLOW_STACKS_DIR}/${STACK}' && chown deploy: '${DOCKFLOW_STACKS_DIR}/${STACK}'\``,
    );

    const full = new ScriptedShell((command) =>
      command.includes('/stack.yml') ? { exitCode: 1, stderr: 'No space left on device\n' } : undefined,
    );
    const writeError = await thrown(() => new FileReleaseStore(full).create(STACK, release('1.0.0', 100)));
    expect(writeError.message).toBe('Failed to write release stack for 1.0.0: No space left on device');
    expect(full.calls.at(-1)?.command.startsWith(`rm -rf '${DOCKFLOW_STACKS_DIR}/${STACK}/.tmp-1.0.0-`)).toBe(true);

    const noLink = new ScriptedShell((command) => (command.includes('ln -sfn') ? { exitCode: 2 } : undefined));
    const linkError = await thrown(() => new FileReleaseStore(noLink).create(STACK, release('1.0.0', 100)));
    expect(linkError.message).toBe('Failed to update the current release symlink: exit 2');
  });
});

describe('FileLockStore', () => {
  let shell: LocalShell;
  let clock: number;
  const lockFile = (name = STACK): string => shell.path('locks', `${name}.lock`);
  const locks = (performer: string, options: FileLockStoreOptions = {}): FileLockStore =>
    new FileLockStore(shell, STACK, { root: shell.root, now: () => clock, performer, ...options });

  beforeEach(() => {
    shell = new LocalShell();
    clock = T0;
  });

  afterEach(() => {
    shell.cleanup();
  });

  test.if(hasPosixShell)('C-LOCK-01/06: acquire on a free lock returns LockData; status reports it', async () => {
    const lock = locks('alice@ci');
    expect(dataOf(await lock.status())).toEqual({ locked: false });

    const data = dataOf(await lock.acquire({ message: 'Deploy 1.0.0', version: '1.0.0' }));
    expect(data).toEqual(lockData('alice@ci', T0));
    expect(readFileSync(lockFile(), 'utf8')).toBe(JSON.stringify(data, null, 2));
    expect(readdirSync(shell.path('locks'))).toEqual([`${STACK}.lock`]);

    clock = T0 + 12 * MINUTE;
    expect(dataOf(await locks('bob@ci').status())).toEqual({
      locked: true,
      data,
      durationMinutes: 12,
      isStale: false,
    });
    clock = T0 + 31 * MINUTE;
    expect(dataOf(await lock.status())).toMatchObject({ durationMinutes: 31, isStale: true });
  });

  test.if(hasPosixShell)("acquire without options keeps today's defaults", async () => {
    const data = dataOf(await locks('alice@ci').acquire());
    expect(data.version).toBe('manual-lock');
    expect(data.message).toBe('Manual lock via CLI');
    expect(data.stack).toBe(STACK);
  });

  test.if(hasPosixShell)("C-LOCK-02: acquire while held fails with today's text", async () => {
    const held = dataOf(await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' }));
    clock = T0 + 5 * MINUTE;

    expect(errorOf(await locks('bob@ci').acquire())).toBe('Already locked by alice@ci (5 min ago)');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(held);
    expect(readdirSync(shell.path('locks'))).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('C-LOCK-03: a stale lock is taken over, including an unreadable one', async () => {
    await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
    clock = T0 + 31 * MINUTE;

    const data = dataOf(await locks('bob@ci').acquire({ message: 'Deploy 1.1.0' }));
    expect(data.performer).toBe('bob@ci');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(data);

    writeFileSync(lockFile(), '{half a lock');
    expect(dataOf(await locks('carol@ci').status())).toEqual({ locked: true, isStale: true });
    expect(dataOf(await locks('carol@ci').acquire()).performer).toBe('carol@ci');
    expect(readdirSync(shell.path('locks'))).toEqual([`${STACK}.lock`]);
  });

  test.if(hasPosixShell)('C-LOCK-04: force replaces a live lock', async () => {
    await locks('alice@ci').acquire();
    const data = dataOf(await locks('bob@ci').acquire({ force: true, message: 'Hotfix' }));
    expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(data);
    expect(data.performer).toBe('bob@ci');
    expect(data.message).toBe('Hotfix');

    // without a lock in place, force simply creates it
    expect(dataOf(await locks('carol@ci', { name: 'other' }).acquire({ force: true })).performer).toBe('carol@ci');
    expect(readdirSync(shell.path('locks')).sort()).toEqual(['other.lock', `${STACK}.lock`]);
  });

  test.if(hasPosixShell)('C-LOCK-05: release twice is ok and removes the lock file', async () => {
    const lock = locks('alice@ci');
    await lock.acquire();
    expect(dataOf(await lock.release())).toBeUndefined();
    expect(existsSync(lockFile())).toBe(false);
    expect(dataOf(await lock.release())).toBeUndefined();
    expect(dataOf(await lock.acquire()).performer).toBe('alice@ci');
  });

  for (const order of [
    ['bob@ci', 'carol@ci'],
    ['carol@ci', 'bob@ci'],
  ] as const) {
    test.if(hasPosixShell)(
      `C-LOCK-07: two acquirers racing on a stale lock, ${order[0]} held: exactly one wins, the loser deletes nothing`,
      async () => {
        const [late, early] = order;
        await locks('alice@ci').acquire({ message: 'Deploy 1.0.0', version: '1.0.0' });
        clock = T0 + 45 * MINUTE;

        // `late` has read the stale lock and is about to swap it when `early` takes it over
        const held = shell.hold((command) => command.includes('.takeover'));
        const lateResult = locks(late).acquire({ message: 'late' });
        await held.reached;
        const earlyData = dataOf(await locks(early).acquire({ message: 'early' }));
        held.release();

        expect(errorOf(await lateResult)).toBe(STALE_TAKEN);
        expect(earlyData.performer).toBe(early);
        expect(JSON.parse(readFileSync(lockFile(), 'utf8'))).toEqual(earlyData);
        expect(readdirSync(shell.path('locks'))).toEqual([`${STACK}.lock`]);
      },
    );
  }

  test.if(hasPosixShell)('a lock released between the read and the takeover is simply created', async () => {
    await locks('alice@ci').acquire();
    clock = T0 + 45 * MINUTE;
    const held = shell.hold((command) => command.includes('.takeover'));
    const pending = locks('bob@ci').acquire();
    await held.reached;
    dataOf(await locks('alice@ci').release());
    held.release();

    expect(dataOf(await pending).performer).toBe('bob@ci');
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).performer).toBe('bob@ci');
  });

  test.if(hasPosixShell)('a takeover guard left by a killed process expires', async () => {
    await locks('alice@ci').acquire();
    clock = T0 + 45 * MINUTE;
    const guard = `${lockFile()}.takeover`;
    mkdirSync(guard);
    expect(errorOf(await locks('bob@ci').acquire())).toBe(STALE_TAKEN);

    const old = new Date(Date.now() - 5 * MINUTE);
    utimesSync(guard, old, old);
    expect(dataOf(await locks('bob@ci').acquire()).performer).toBe('bob@ci');
    expect(existsSync(guard)).toBe(false);
  });

  test.if(hasPosixShell)('an explicit lock name selects its own file', async () => {
    const proxy = locks('alice@ci', { name: 'dockflow-proxy' });
    const data = dataOf(await proxy.acquire());
    expect(data.stack).toBe(STACK);
    expect(existsSync(lockFile('dockflow-proxy'))).toBe(true);
    expect(dataOf(await locks('bob@ci').status())).toEqual({ locked: false });
    expect(errorOf(await locks('bob@ci', { name: 'dockflow-proxy' }).acquire())).toBe(
      'Already locked by alice@ci (0 min ago)',
    );
  });

  test("lock texts equal today's when the server refuses", async () => {
    const alice = JSON.stringify(lockData('alice@ci', T0 - 5 * MINUTE), null, 2);
    const stale = JSON.stringify(lockData('alice@ci', T0 - 45 * MINUTE), null, 2);
    const file = `${DOCKFLOW_LOCKS_DIR}/${STACK}.lock`;

    const busy = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: alice } });
    expect(errorOf(await busy.lock.acquire())).toBe('Already locked by alice@ci (5 min ago)');

    const denied = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: 'NO_LOCK\n' } });
    expect(errorOf(await denied.lock.acquire())).toBe(
      `Cannot create lock file at ${file}. Check directory permissions on the server.`,
    );
    expect(denied.shell.calls.map((call) => lockCommand(call.command))).toEqual(['create', 'read', 'create', 'read']);

    const lost = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: stale }, takeover: { stdout: 'LOCKED\n' } });
    expect(errorOf(await lost.lock.acquire())).toBe(STALE_TAKEN);
    const takeover = lost.shell.calls.find((call) => lockCommand(call.command) === 'takeover');
    expect(takeover?.command).toContain(`= '${stale}' ]`);
    expect(JSON.parse(takeover?.stdin ?? '').performer).toBe('bob@ci');

    const won = scriptedLock({ create: { stdout: 'LOCKED\n' }, read: { stdout: stale }, takeover: { stdout: 'ACQUIRED\n' } });
    expect(dataOf(await won.lock.acquire()).performer).toBe('bob@ci');

    const forced = scriptedLock({ force: { stdout: 'FAILED\n' } });
    expect(errorOf(await forced.lock.acquire({ force: true }))).toBe(
      `Cannot create lock file at ${file}. Check directory permissions on the server.`,
    );

    const stuck = scriptedLock({ release: { stdout: 'EXISTS\n' } });
    expect(errorOf(await stuck.lock.release())).toBe('Lock file could not be removed. Check permissions on the server.');
    expect(stuck.shell.calls[0]?.command).toBe(`rm -f '${file}'; test -f '${file}' && echo EXISTS || echo REMOVED`);

    const garbled = scriptedLock({ read: { stdout: 'not json' } });
    expect(dataOf(await garbled.lock.status())).toEqual({ locked: true, isStale: true });
  });

  test('transport failures become failed results', async () => {
    const broken = new FileLockStore(
      {
        run: () => Promise.reject(new Error('connection reset')),
      },
      STACK,
      { performer: 'bob@ci' },
    );
    expect(errorOf(await broken.status())).toBe('connection reset');
    expect(errorOf(await broken.acquire())).toBe('connection reset');
    expect(errorOf(await broken.release())).toBe('connection reset');
  });
});
