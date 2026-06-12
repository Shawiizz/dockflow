import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult } from '../types';

// ---------------------------------------------------------------------------
// SSH mock — must be installed before importing Release.
// Each test scripts responses via `sshResponses`; commands are recorded
// in `executedCommands` for assertions.
// ---------------------------------------------------------------------------

type Responder = (cmd: string) => SSHExecResult | undefined;

const executedCommands: string[] = [];
let sshResponses: Responder = () => undefined;

const okResult = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', exitCode: 0 });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (_conn: unknown, cmd: string): Promise<SSHExecResult> => {
    executedCommands.push(cmd);
    return sshResponses(cmd) ?? okResult();
  },
  sshExecChannel: async (_conn: unknown, cmd: string) => {
    executedCommands.push(cmd);
    return {
      stream: { end: (_data?: unknown) => {} },
      done: Promise.resolve(sshResponses(cmd) ?? okResult()),
    };
  },
}));

const { Release, parseReleaseList, selectRollbackCandidate, extractComposeImages, computeOrphanImages } =
  await import('../services/release');
type ReleaseMetadata = import('../services/release').ReleaseMetadata;
const { DeployError } = await import('../utils/errors');

function meta(version: string, epoch: number): ReleaseMetadata {
  return {
    project_name: 'demo',
    version,
    env: 'production',
    timestamp: new Date(epoch).toISOString(),
    epoch,
    performer: 'ci',
    branch: 'main',
  };
}

beforeEach(() => {
  executedCommands.length = 0;
  sshResponses = () => undefined;
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseReleaseList', () => {
  it('parses one metadata JSON per line, sorted newest first', () => {
    const out = parseReleaseList(
      JSON.stringify(meta('1.0.0', 100)) + '\n' + JSON.stringify(meta('1.0.1', 200)) + '\n',
    );
    expect(out.map(r => r.version)).toEqual(['1.0.1', '1.0.0']);
  });

  it('empty output → empty list', () => {
    expect(parseReleaseList('')).toEqual([]);
    expect(parseReleaseList('  \n ')).toEqual([]);
  });

  it('corrupted lines are skipped and reported, valid ones kept', () => {
    let corrupted = 0;
    const out = parseReleaseList(
      JSON.stringify(meta('1.0.0', 100)) + '\n{broken json\n' + JSON.stringify(meta('1.0.1', 200)),
      () => corrupted++,
    );
    expect(out).toHaveLength(2);
    expect(corrupted).toBe(1);
  });
});

describe('selectRollbackCandidate', () => {
  const releases = [meta('3.0.0', 300), meta('2.0.0', 200), meta('1.0.0', 100)];

  it('with failedVersion: picks newest release that is not the failed one', () => {
    expect(selectRollbackCandidate(releases, '3.0.0')!.version).toBe('2.0.0');
  });

  it('failedVersion not in list: picks newest', () => {
    expect(selectRollbackCandidate(releases, '9.9.9')!.version).toBe('3.0.0');
  });

  it('without failedVersion: skips the most recent (current) release', () => {
    expect(selectRollbackCandidate(releases)!.version).toBe('2.0.0');
  });

  it('no candidate available → null', () => {
    expect(selectRollbackCandidate([], '1.0.0')).toBeNull();
    expect(selectRollbackCandidate([meta('1.0.0', 100)])).toBeNull();
    expect(selectRollbackCandidate([meta('1.0.0', 100)], '1.0.0')).toBeNull();
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
    const orphans = computeOrphanImages('', '', 'services:\n  a:\n    image: thing:latest\n');
    expect(orphans).toEqual([]);
  });

  it('deduplicates orphans', () => {
    const orphans = computeOrphanImages(
      '',
      '',
      'services:\n  a:\n    image: dup:1\n  b:\n    image: dup:1\n',
    );
    expect(orphans).toEqual(['dup:1']);
  });

  it('empty running output does not protect anything', () => {
    const orphans = computeOrphanImages('\n', '', 'services:\n  a:\n    image: x:1\n');
    expect(orphans).toEqual(['x:1']);
  });
});

// ---------------------------------------------------------------------------
// Rollback flow (scripted SSH + fake StackBackend)
// ---------------------------------------------------------------------------

interface FakeBackendOptions {
  redeployFails?: boolean;
  convergenceFails?: boolean;
}

function makeFakeBackend(options: FakeBackendOptions = {}) {
  const calls: { redeploy: Array<{ stackName: string; content: string }>; convergence: number } = {
    redeploy: [],
    convergence: 0,
  };
  const backend = {
    redeploy: async (stackName: string, rawContent: string) => {
      calls.redeploy.push({ stackName, content: rawContent });
      return options.redeployFails
        ? { success: false as const, error: new DeployError('redeploy boom') }
        : { success: true as const, data: undefined };
    },
    waitConvergence: async () => {
      calls.convergence++;
      return { converged: !options.convergenceFails, rolledBack: false, timedOut: false };
    },
  };
  return { backend, calls };
}

const conn = { host: 'h', port: 22, user: 'u', privateKey: 'k' };

describe('Release.rollback', () => {
  it('happy path: redeploys previous compose, updates symlink, removes failed dir', async () => {
    const release = new Release(conn);
    const { backend, calls } = makeFakeBackend();

    sshResponses = (cmd) => {
      if (cmd.includes('for d in */')) {
        return okResult(JSON.stringify(meta('2.0.0', 200)) + '\n' + JSON.stringify(meta('1.0.0', 100)));
      }
      if (cmd.startsWith('cat ')) return okResult('services:\n  web:\n    image: web:1\n');
      return okResult();
    };

    const version = await release.rollback('demo', backend as never, '2.0.0');

    expect(version).toBe('1.0.0');
    expect(calls.redeploy).toHaveLength(1);
    expect(calls.redeploy[0].content).toContain('web:1');
    expect(calls.convergence).toBe(1);
    // Symlink restored to the previous release dir
    expect(executedCommands.some(c => c.includes('ln -sfn') && c.includes('/1.0.0'))).toBe(true);
    // Failed release dir removed
    expect(executedCommands.some(c => c.includes('rm -rf') && c.includes('/2.0.0'))).toBe(true);
  });

  it('fast path: previousReleasePath skips release discovery', async () => {
    const release = new Release(conn);
    const { backend, calls } = makeFakeBackend();

    sshResponses = (cmd) => (cmd.startsWith('cat ') ? okResult('services: {}\n') : okResult());

    const version = await release.rollback('demo', backend as never, null, '/var/lib/dockflow/stacks/demo/1.5.0');

    expect(version).toBe('1.5.0');
    expect(calls.redeploy).toHaveLength(1);
    // No listing command was needed
    expect(executedCommands.some(c => c.includes('for d in */'))).toBe(false);
  });

  it('no previous release → DeployError', async () => {
    const release = new Release(conn);
    const { backend } = makeFakeBackend();
    sshResponses = (cmd) => (cmd.includes('for d in */') ? okResult('') : okResult());

    await expect(release.rollback('demo', backend as never, '1.0.0')).rejects.toThrow(
      'No previous release available for rollback',
    );
  });

  it('unreadable previous compose → DeployError, no redeploy attempted', async () => {
    const release = new Release(conn);
    const { backend, calls } = makeFakeBackend();
    sshResponses = (cmd) => {
      if (cmd.includes('for d in */')) {
        return okResult(JSON.stringify(meta('2.0.0', 200)) + '\n' + JSON.stringify(meta('1.0.0', 100)));
      }
      if (cmd.startsWith('cat ')) return { stdout: '', stderr: 'no such file', exitCode: 1 };
      return okResult();
    };

    await expect(release.rollback('demo', backend as never, '2.0.0')).rejects.toThrow(
      'Could not read compose for rollback',
    );
    expect(calls.redeploy).toHaveLength(0);
  });

  it('redeploy failure → DeployError, symlink not touched', async () => {
    const release = new Release(conn);
    const { backend } = makeFakeBackend({ redeployFails: true });
    sshResponses = (cmd) => {
      if (cmd.includes('for d in */')) {
        return okResult(JSON.stringify(meta('2.0.0', 200)) + '\n' + JSON.stringify(meta('1.0.0', 100)));
      }
      if (cmd.startsWith('cat ')) return okResult('services: {}\n');
      return okResult();
    };

    await expect(release.rollback('demo', backend as never, '2.0.0')).rejects.toThrow('redeploy boom');
    expect(executedCommands.some(c => c.includes('ln -sfn'))).toBe(false);
  });

  it('convergence failure → DeployError', async () => {
    const release = new Release(conn);
    const { backend } = makeFakeBackend({ convergenceFails: true });
    sshResponses = (cmd) => {
      if (cmd.includes('for d in */')) {
        return okResult(JSON.stringify(meta('2.0.0', 200)) + '\n' + JSON.stringify(meta('1.0.0', 100)));
      }
      if (cmd.startsWith('cat ')) return okResult('services: {}\n');
      return okResult();
    };

    await expect(release.rollback('demo', backend as never, '2.0.0')).rejects.toThrow(
      'Rollback did not converge',
    );
  });
});

describe('Release.createRelease', () => {
  it('fails loudly when the current symlink cannot be updated', async () => {
    const release = new Release(conn);
    sshResponses = (cmd) => {
      if (cmd.includes('ln -sfn')) return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      return okResult();
    };

    await expect(
      release.createRelease('demo', '1.0.0', 'services: {}\n', meta('1.0.0', 100)),
    ).rejects.toThrow('current release symlink');
  });
});

describe('Release.rollback — symlink failure', () => {
  it('redeploy succeeded but symlink update failed → loud rollback error', async () => {
    const release = new Release(conn);
    const { backend, calls } = makeFakeBackend();
    sshResponses = (cmd) => {
      if (cmd.includes('for d in */')) {
        return okResult(JSON.stringify(meta('2.0.0', 200)) + '\n' + JSON.stringify(meta('1.0.0', 100)));
      }
      if (cmd.startsWith('cat ')) return okResult('services: {}\n');
      if (cmd.includes('ln -sfn')) return { stdout: '', stderr: 'read-only file system', exitCode: 1 };
      return okResult();
    };

    await expect(release.rollback('demo', backend as never, '2.0.0')).rejects.toThrow(
      'failed to update the current release symlink',
    );
    // The redeploy itself did happen — only the bookkeeping failed
    expect(calls.redeploy).toHaveLength(1);
  });
});

describe('Release.listReleases', () => {
  it('returns parsed sorted releases from the remote listing', async () => {
    const release = new Release(conn);
    sshResponses = (cmd) =>
      cmd.includes('for d in */')
        ? okResult(JSON.stringify(meta('1.0.0', 100)) + '\n' + JSON.stringify(meta('2.0.0', 200)))
        : okResult();

    const releases = await release.listReleases('demo');
    expect(releases.map(r => r.version)).toEqual(['2.0.0', '1.0.0']);
  });
});
