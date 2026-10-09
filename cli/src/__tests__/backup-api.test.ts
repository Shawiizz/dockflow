import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as backupUtils from '../commands/backup/utils';
import { handleBackupRoutes } from '../api/routes/backup';
import * as helpers from '../api/routes/_helpers';
import { Backup, type BackupListEntry } from '../services/backup';
import * as lockModule from '../services/lock';
import { LockHeldError } from '../services/lock';
import { err, ok } from '../types';
import type { ClusterNode } from '../types';
import * as config from '../utils/config';
import { BackupError } from '../utils/errors';

const conn = { host: 'manager', port: 22, user: 'deploy', privateKey: 'key', stackName: 'shop' };
const worker: ClusterNode = { name: 'agent_1', connection: { host: 'worker', port: 22, user: 'deploy', privateKey: 'key' } };

function entry(id: string): BackupListEntry {
  return {
    id,
    service: 'db',
    dbType: 'postgres',
    timestamp: '2026-05-01T10:00:00.000Z',
    size: '1 KB',
    sizeBytes: 1024,
    compression: 'gzip',
    nodeHost: 'manager',
    nodePort: 22,
    filePath: `/b/${id}.sql.gz`,
    node: 'server_1',
  };
}

let spies: { mockRestore(): void }[] = [];
let released = 0;
let lockReply: Promise<unknown> = Promise.resolve();

beforeEach(() => {
  released = 0;
  lockReply = Promise.resolve(ok({}));
  spies = [
    spyOn(helpers, 'getManagerConnection').mockResolvedValue(conn),
    spyOn(config, 'loadConfig').mockReturnValue({ backup: { retention_count: 1 } } as never),
    spyOn(config, 'getStackName').mockReturnValue('shop-production'),
    spyOn(config, 'getAccessoriesStackName').mockReturnValue('shop-production-accessories'),
    spyOn(backupUtils, 'getBackupNodes').mockReturnValue([worker]),
    spyOn(backupUtils, 'requireBackupConfig').mockReturnValue({
      backupConfig: { type: 'postgres' },
      compression: 'gzip',
      source: 'accessories',
    }),
    spyOn(lockModule, 'createLock').mockImplementation(
      () =>
        ({
          acquire: () => lockReply as never,
          release: async () => {
            released++;
            return ok(undefined);
          },
        }) as never,
    ),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

const post = (path: string) => handleBackupRoutes(new Request(`http://localhost/api/backup/${path}`, { method: 'POST' }));

describe('POST /api/backup/restore', () => {
  it('restores the entry it resolved while holding the deploy lock, and releases it', async () => {
    const resolved = entry('20260501-100000-aaaa');
    const resolve = spyOn(Backup.prototype, 'resolveBackup').mockResolvedValue(ok(resolved));
    const restore = spyOn(Backup.prototype, 'restore').mockResolvedValue(ok(undefined));
    spies.push(resolve, restore);

    const response = await post('restore?env=production&service=db');
    expect(response.status).toBe(200);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0][1]).toBe(resolved);
    expect(lockModule.createLock).toHaveBeenCalledWith(conn, 'shop-production', undefined);
    expect(released).toBe(1);
  });

  it('answers 409 and restores nothing while a deploy holds the lock', async () => {
    spies.push(spyOn(Backup.prototype, 'resolveBackup').mockResolvedValue(ok(entry('20260501-100000-aaaa'))));
    const restore = spyOn(Backup.prototype, 'restore').mockResolvedValue(ok(undefined));
    spies.push(restore);
    lockReply = Promise.resolve(err(new LockHeldError('Deployment locked by bob')));

    const response = await post('restore?env=production&service=db');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Deployment locked by bob' });
    expect(restore).not.toHaveBeenCalled();
    expect(released).toBe(0);
  });

  it('releases the lock when the restore fails', async () => {
    spies.push(
      spyOn(Backup.prototype, 'resolveBackup').mockResolvedValue(ok(entry('20260501-100000-aaaa'))),
      spyOn(Backup.prototype, 'restore').mockResolvedValue(err(new BackupError('Restore failed: boom'))),
    );
    const response = await post('restore?env=production&service=db');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Restore failed: boom' });
    expect(released).toBe(1);
  });
});

describe('GET /api/backup/list', () => {
  it('names the servers that did not answer', async () => {
    spies.push(spyOn(Backup.prototype, 'list').mockResolvedValue(ok({ entries: [entry('a')], unreachable: [worker] })));
    const response = await handleBackupRoutes(new Request('http://localhost/api/backup/list?env=production&service=db'));
    expect(await response.json()).toMatchObject({ total: 1, unreachableNodes: ['agent_1'] });
  });

  it('says nothing when every server answered', async () => {
    spies.push(spyOn(Backup.prototype, 'list').mockResolvedValue(ok({ entries: [], unreachable: [] })));
    const response = await handleBackupRoutes(new Request('http://localhost/api/backup/list?env=production&service=db'));
    expect(Object.keys((await response.json()) as object)).toEqual(['backups', 'total']);
  });
});

describe('POST /api/backup/prune', () => {
  const report = { removed: 2, orphanFiles: 0, bytesFreed: 300 };

  it('a service whose prune fails fails the request instead of answering success', async () => {
    spies.push(spyOn(Backup.prototype, 'prune').mockResolvedValue(err(new Error('Cannot remove backups on agent_1: denied'))));
    const response = await post('prune?env=production&service=db');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Cannot remove backups on agent_1: denied' });
  });

  it('without a service, one failing service is reported with what was pruned elsewhere', async () => {
    const grouped = {
      stacks: [
        {
          backupService: new Backup(conn, 'shop-production-accessories'),
          byService: { db: [entry('a'), entry('b')], cache: [entry('c'), entry('d')] },
        },
      ],
      unreachable: [worker],
    };
    spies.push(spyOn(backupUtils, 'listGroupedFromAllStacks').mockResolvedValue(grouped));
    const prune = spyOn(Backup.prototype, 'prune');
    prune.mockResolvedValueOnce(ok(report)).mockResolvedValueOnce(err(new Error('denied')));
    spies.push(prune);

    const response = await post('prune?env=production');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Pruned 2 backup(s), but pruning failed for cache: denied' });
  });

  it('reports what it removed, the bytes freed and the servers it could not reach', async () => {
    const grouped = {
      stacks: [{ backupService: new Backup(conn, 'shop-production-accessories'), byService: { db: [entry('a'), entry('b')] } }],
      unreachable: [worker],
    };
    spies.push(spyOn(backupUtils, 'listGroupedFromAllStacks').mockResolvedValue(grouped), spyOn(Backup.prototype, 'prune').mockResolvedValue(ok(report)));
    const response = await post('prune?env=production');
    expect(await response.json()).toEqual({
      success: true,
      pruned: 2,
      message: 'Pruned 2 backup(s)',
      bytesFreed: 300,
      unreachableNodes: ['agent_1'],
    });
  });
});
