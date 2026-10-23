import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  filterUploads,
  resolveFileDestPath,
  uploadName,
  uploadOwnedDir,
  fileBackupPath,
  dirBackupPath,
  runWithConcurrency,
  rolledBackError,
  uploadFiles,
  convergenceError,
  runPostRollbackHealthChecks,
  cleanupFailedImages,
  failureOutcome,
  cleanupManager,
  accessoriesKey,
  deployAccessories,
  releaseAccessoriesDigest,
} from '../commands/deploy-phases';
import { accessoriesDigest, serialize } from '../services/compose';
import { removeImagesCommand } from '../services/release';
import * as ssh from '../utils/ssh';
import { HealthCheck } from '../services/health-check';
import type { SwarmStack } from '../services/swarm/stack';
import * as output from '../utils/output';
import type { DeployContext } from '../commands/deploy-context';
import { DeployError, ErrorCode } from '../utils/errors';
import type { UploadItem } from '../utils/config';

describe('filterUploads', () => {
  const uploads: UploadItem[] = [
    { src: 'global.conf', dest: '/etc/global.conf' },                          // no service
    { src: 'web.conf', dest: '/etc/web.conf', service: 'web' },               // string service
    { src: 'shared.conf', dest: '/etc/shared.conf', service: ['web', 'api'] }, // array service
  ];

  it('no uploads → empty list', () => {
    expect(filterUploads(undefined)).toEqual([]);
    expect(filterUploads([])).toEqual([]);
  });

  it('no --only filter → everything', () => {
    expect(filterUploads(uploads)).toHaveLength(3);
  });

  it('uploads without service always apply', () => {
    const result = filterUploads(uploads, 'worker');
    expect(result.map(u => u.src)).toEqual(['global.conf']);
  });

  it('string service matches', () => {
    const result = filterUploads(uploads, 'web');
    expect(result.map(u => u.src)).toEqual(['global.conf', 'web.conf', 'shared.conf']);
  });

  it('array service matches any targeted service', () => {
    const result = filterUploads(uploads, 'api');
    expect(result.map(u => u.src)).toEqual(['global.conf', 'shared.conf']);
  });

  it('comma-separated filter with spaces', () => {
    const result = filterUploads(uploads, 'worker, web');
    expect(result).toHaveLength(3);
  });
});

describe('resolveFileDestPath', () => {
  it('trailing slash → dest dir + source basename', () => {
    expect(resolveFileDestPath('/etc/app/', 'config.yml')).toBe('/etc/app/config.yml');
  });

  it('no trailing slash → dest used verbatim (rename allowed)', () => {
    expect(resolveFileDestPath('/etc/app/renamed.yml', 'config.yml')).toBe('/etc/app/renamed.yml');
  });
});

describe('upload backup paths', () => {
  const base = '/var/lib/dockflow/upload-backups/demo/1.0.0';

  it('file backup mirrors the destination path under the backup dir', () => {
    expect(fileBackupPath(base, '/etc/app/config.yml')).toBe(`${base}/etc/app/config.yml`);
  });

  it('dir backup is a tar.gz named after the destination', () => {
    expect(dirBackupPath(base, '/srv/app')).toBe(`${base}/srv/app.tar.gz`);
  });

  it('invariant: rollback reads the exact path upload wrote', () => {
    // uploadFiles writes fileBackupPath(base, destPath); rollbackUploads
    // recomputes it from the same inputs — they must always agree.
    const destPath = resolveFileDestPath('/etc/nginx/', 'site.conf');
    expect(fileBackupPath(base, destPath)).toBe(`${base}/etc/nginx/site.conf`);
  });
});

describe('runWithConcurrency', () => {
  it('runs every task exactly once', async () => {
    const done: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      done.push(i);
    });
    await runWithConcurrency(tasks, 3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 12 }, () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    await runWithConcurrency(tasks, 4);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('propagates task errors', async () => {
    const tasks = [async () => {}, async () => { throw new Error('boom'); }];
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow('boom');
  });

  it('handles empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toBeUndefined();
  });
});

describe('uploadOwnedDir', () => {
  it('file destination → the directory holding it', () => {
    expect(uploadOwnedDir('/var/lib/app/seed/data.sql', false)).toBe('/var/lib/app/seed');
  });

  it('directory upload → the destination itself', () => {
    expect(uploadOwnedDir('/etc/nginx/conf.d', true)).toBe('/etc/nginx/conf.d');
  });

  it('trailing slash means a directory even for a single file', () => {
    expect(uploadOwnedDir('/etc/nginx/conf.d/', false)).toBe('/etc/nginx/conf.d');
  });

  it('strips the trailing slash of a directory upload', () => {
    expect(uploadOwnedDir('/srv/app/', true)).toBe('/srv/app');
  });

  it('file at the filesystem root', () => {
    expect(uploadOwnedDir('/motd', false)).toBe('/');
  });
});

describe('uploadName', () => {
  it('a project upload is named by its source path', () => {
    expect(uploadName({ src: '.dockflow/services/app.service', dest: '/etc/systemd/system/app.service' }))
      .toBe('.dockflow/services/app.service');
  });

  it('a plugin upload is named by its label, not by its in-memory key', () => {
    expect(uploadName({ src: '.dockflow/plugins/.instances/nginx/plugin/vhost.conf', dest: '/x', label: 'nginx › vhost.conf' }))
      .toBe('nginx › vhost.conf');
  });
});

describe('rolledBackError', () => {
  it('keeps the code and suggestion of the failure that triggered the rollback', () => {
    const cause = new DeployError('web is unhealthy', ErrorCode.HEALTH_CHECK_FAILED, 'Check the logs of web');
    const err = rolledBackError(cause, '1.4.1');
    expect(err.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(err.message).toBe('web is unhealthy; rolled back to 1.4.1');
    expect(err.suggestion).toBe('Check the logs of web');
  });

  it('reports a plain error as a failed deploy', () => {
    const err = rolledBackError(new Error('boom'), '1.4.1');
    expect(err.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(err.message).toBe('boom; rolled back to 1.4.1');
  });
});

describe('uploadFiles', () => {
  it('plans no host without uploads, so commit and rollback never connect to a node', async () => {
    const ctx = {
      stackName: 'shop-production',
      deployVersion: '1.4.2',
      config: { project_name: 'shop' },
      options: {},
      cluster: { manager: { name: 'manager', connection: {} }, otherManagers: [], workers: [] },
    } as unknown as DeployContext;
    const plan = await uploadFiles(ctx);
    expect(plan.hosts).toEqual([]);
  });
});

describe('convergenceError', () => {
  it('a Swarm rollback is a failed health check that points to the logs', () => {
    const error = convergenceError({ rolledBack: true, timedOut: false, errorDetail: 'web: task exited (1)' }, 'production');
    expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    expect(error.message).toBe('web: task exited (1)');
    expect(error.suggestion).toBe('The new version failed to start; see why with `dockflow logs production <service>`.');
  });

  it('an accessory rolled back points to the accessories logs', () => {
    const error = convergenceError({ rolledBack: true, timedOut: false }, 'production', 'accessories');
    expect(error.suggestion).toBe('The new version failed to start; see why with `dockflow accessories logs production <accessory>`.');
  });

  it('a stack that never converged is a failed deploy that points to diagnose', () => {
    const error = convergenceError({ rolledBack: false, timedOut: true }, 'production');
    expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
    expect(error.suggestion).toBe('Run `dockflow diagnose production` to see what keeps them from starting.');
  });
});

describe('runPostRollbackHealthChecks', () => {
  const connection = { host: 'node-1', port: 22, user: 'dockflow', privateKey: 'key' };
  const startedAt = new Date('2026-10-09T10:00:00Z');

  function backend(result: { healthy: boolean; message?: string }) {
    const calls: unknown[][] = [];
    const swarm = {
      checkInternalHealth: async (...args: unknown[]) => {
        calls.push(args);
        return result;
      },
    } as unknown as SwarmStack;
    return { swarm, calls };
  }

  const warnings = spyOn(output, 'printWarning').mockImplementation(() => {});
  const http = spyOn(HealthCheck.prototype, 'checkHTTPEndpoints').mockImplementation(async () => []);
  afterEach(() => {
    warnings.mockClear();
    http.mockClear();
  });

  it('judges only the tasks started by the rollback, and warns when they are unhealthy', async () => {
    const { swarm, calls } = backend({ healthy: false, message: 'web: 0/2' });

    await runPostRollbackHealthChecks(connection, swarm, 'shop-production', undefined, startedAt);

    expect(calls[0]?.[0]).toBe('shop-production');
    expect(calls[0]?.[4]).toBe(startedAt);
    expect(warnings).toHaveBeenCalledWith('Rolled-back version is unhealthy: web: 0/2');
    expect(http).not.toHaveBeenCalled();
  });

  it('checks the endpoints without rolling back a rollback', async () => {
    const { swarm } = backend({ healthy: true });
    const endpoints = [{ url: 'https://shop.example.com/health' }];

    await runPostRollbackHealthChecks(connection, swarm, 'shop-production', { endpoints, on_failure: 'rollback' } as never, startedAt);

    expect(http).toHaveBeenCalledWith(expect.objectContaining({ endpoints, on_failure: 'notify' }));
    expect(warnings).not.toHaveBeenCalled();
  });

  it('does nothing when health checks are disabled', async () => {
    const { swarm, calls } = backend({ healthy: false });

    await runPostRollbackHealthChecks(connection, swarm, 'shop-production', { enabled: false } as never, startedAt);

    expect(calls).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe('cleanupFailedImages', () => {
  const node = (host: string) => ({ name: host, connection: { host, port: 22, user: 'dockflow', privateKey: 'key' } }) as never;
  const built = { images: ['shop-web:1.2.0'], engine: 'docker', usedRegistry: false } as never;

  it('removes the images and the failed tasks\' stopped containers on every node', async () => {
    const calls: string[] = [];
    const exec = spyOn(ssh, 'sshExec').mockImplementation(async (conn, command) => {
      calls.push(`${conn.host}: ${command}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    try {
      await cleanupFailedImages(built, [node('manager'), node('worker-1')]);
    } finally {
      exec.mockRestore();
    }
    expect(calls).toEqual([`manager: ${removeImagesCommand(['shop-web:1.2.0'])}`, `worker-1: ${removeImagesCommand(['shop-web:1.2.0'])}`]);
  });

  it('leaves the nodes alone when the images went through a registry', async () => {
    const exec = spyOn(ssh, 'sshExec');
    try {
      await cleanupFailedImages({ images: ['shop-web:1.2.0'], engine: 'docker', usedRegistry: true } as never, [node('manager')]);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });
});

describe('failureOutcome', () => {
  const sent = { sent: true, swarmRolledBack: false };

  it('forgets a release that never reached Swarm', () => {
    expect(failureOutcome({ sent: false, swarmRolledBack: false }, 'rollback', true)).toBe('forget');
  });

  it('rolls back by default once the stack reached Swarm', () => {
    expect(failureOutcome(sent, undefined, true)).toBe('rollback');
    expect(failureOutcome({ sent: true, swarmRolledBack: true }, undefined, true)).toBe('rollback');
  });

  it('keeps the new release as current when it runs and no rollback is wanted or possible', () => {
    for (const onFailure of ['fail', 'notify', 'ignore'] as const) expect(failureOutcome(sent, onFailure, true)).toBe('keep');
    expect(failureOutcome(sent, 'rollback', false)).toBe('keep');
  });

  it('forgets the new release when Swarm put the previous one back by itself', () => {
    expect(failureOutcome({ sent: true, swarmRolledBack: true }, 'fail', true)).toBe('forget');
  });
});

describe('cleanupManager', () => {
  const node = (name: string) => ({ name, connection: { host: name, port: 22, user: 'dockflow', privateKey: 'key' } }) as never;
  const cluster = { manager: node('m1'), otherManagers: [node('m2'), node('m3')], workers: [node('w1')] } as never;

  it('keeps the manager the deploy went through while it answers', async () => {
    expect((await cleanupManager(cluster, async () => true))?.name).toBe('m1');
  });

  it('falls back to the first other manager that answers, never to a worker', async () => {
    const asked: string[] = [];
    const chosen = await cleanupManager(cluster, async (n) => {
      asked.push(n.name);
      return n.name === 'm3';
    });
    expect(chosen?.name).toBe('m3');
    expect(asked).toEqual(['m1', 'm2', 'm3']);
    expect(await cleanupManager(cluster, async () => false)).toBeNull();
  });
});

describe('releaseAccessoriesDigest', () => {
  const ACCESSORIES = 'services:\n  db:\n    image: postgres:16\n';

  function context(options: { accessories?: string; skip?: boolean; running?: string | null | Error }) {
    const deployed: unknown[] = [];
    const reads: string[] = [];
    const swarm = {
      accessoriesDigest: async (stackName: string) => {
        reads.push(stackName);
        if (options.running instanceof Error) throw options.running;
        return options.running ?? null;
      },
      deployAccessory: async (input: unknown) => {
        deployed.push(input);
        return { success: true, data: { deployed: true } };
      },
    };
    const ctx = {
      env: 'production',
      stackName: 'shop-production',
      config: {},
      skipAccessories: options.skip === true,
      forceAccessories: false,
      rendered: new Map(options.accessories === undefined ? [] : [[accessoriesKey(), options.accessories]]),
      swarm,
    } as unknown as DeployContext;
    return { ctx, deployed, reads };
  }

  it('is the digest of the accessories compose the deploy sends, so a release and the server compare', async () => {
    const { ctx, deployed } = context({ accessories: ACCESSORIES });

    const digest = await releaseAccessoriesDigest(ctx);
    await deployAccessories(ctx);

    const sent = (deployed[0] as { compose: Parameters<typeof serialize>[0] }).compose;
    expect(digest).toBe(accessoriesDigest(serialize(sent)));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('follows the content of the accessories', async () => {
    const first = await releaseAccessoriesDigest(context({ accessories: ACCESSORIES }).ctx);
    const second = await releaseAccessoriesDigest(context({ accessories: ACCESSORIES.replace('16', '17') }).ctx);
    expect(second).not.toBe(first);
  });

  it('is the digest on the server when the accessories are skipped', async () => {
    const { ctx, reads } = context({ accessories: ACCESSORIES, skip: true, running: 'on-the-server' });
    expect(await releaseAccessoriesDigest(ctx)).toBe('on-the-server');
    expect(reads).toEqual(['shop-production']);
  });

  it('is the digest on the server when the project declares no accessory', async () => {
    expect(await releaseAccessoriesDigest(context({ running: 'on-the-server' }).ctx)).toBe('on-the-server');
    expect(await releaseAccessoriesDigest(context({ accessories: '# nothing\n', running: 'on-the-server' }).ctx)).toBe('on-the-server');
  });

  it('is absent without accessories, locally or on the server, or when the server cannot be asked', async () => {
    expect(await releaseAccessoriesDigest(context({}).ctx)).toBeUndefined();
    expect(await releaseAccessoriesDigest(context({ running: new Error('ssh down') }).ctx)).toBeUndefined();
  });
});
