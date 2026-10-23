import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { registerBackupRestoreCommand } from '../commands/backup/restore';
import * as backupUtils from '../commands/backup/utils';
import { Backup, type BackupListEntry } from '../services/backup';
import * as backupModule from '../services/backup';
import * as lockModule from '../services/lock';
import { ok } from '../types';
import * as config from '../utils/config';
import { BackupError, ErrorCode } from '../utils/errors';
import * as output from '../utils/output';
import * as prompts from '../utils/prompts';
import * as validation from '../utils/validation';

const connection = { host: 'manager', port: 22, user: 'deploy', privateKey: 'key' };
const entry = {
  id: '20260501-100000-aaaa',
  service: 'db',
  dbType: 'postgres',
  timestamp: '2026-05-01T10:00:00.000Z',
  size: '1 KB',
  sizeBytes: 1024,
  compression: 'gzip',
  nodeHost: 'manager',
  nodePort: 22,
  filePath: '/b/x.sql.gz',
} as BackupListEntry;

const spies: { mockRestore(): void }[] = [];
let exitCode: number | undefined;
let errors: string[] = [];

async function restore(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerBackupRestoreCommand(program);
  await program.parseAsync(['restore', 'production', 'db', ...args], { from: 'user' }).catch(() => {});
}

beforeEach(() => {
  exitCode = undefined;
  errors = [];
  spies.push(
    spyOn(validation, 'resolveEnv').mockResolvedValue({ connection } as never),
    spyOn(config, 'loadConfig').mockReturnValue({ project_name: 'shop' } as never),
    spyOn(config, 'getStackName').mockReturnValue('shop-production'),
    spyOn(backupUtils, 'getBackupNodes').mockReturnValue([]),
    spyOn(backupUtils, 'requireBackupConfig').mockReturnValue({ backupConfig: { type: 'postgres' }, compression: 'gzip', source: 'accessories' }),
    spyOn(backupUtils, 'resolveBackupStack').mockReturnValue('shop-production-accessories'),
    spyOn(Backup.prototype, 'resolveBackup').mockResolvedValue(ok(entry)),
    spyOn(Backup.prototype, 'replicaRefusal').mockResolvedValue(null),
    spyOn(Backup.prototype, 'restore').mockResolvedValue(ok(undefined)),
    spyOn(backupModule, 'restoreTypeMismatch').mockReturnValue(null),
    spyOn(lockModule, 'createEnvLock').mockResolvedValue({
      acquire: async () => ok({}),
      keepAlive: () => {},
      release: async () => ok(undefined),
    } as never),
    spyOn(prompts, 'dangerousConfirmPrompt').mockResolvedValue(true),
    spyOn(process.stderr, 'write').mockImplementation(((text: string) => {
      errors.push(String(text));
      return true;
    }) as never),
    spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error('exit');
    }) as never),
  );
  for (const name of ['printIntro', 'printOutro', 'printBlank', 'printInfo', 'printWarning', 'printRaw', 'printDim'] as const) {
    spies.push(spyOn(output, name).mockImplementation(() => {}));
  }
  spies.push(spyOn(output, 'createSpinner').mockReturnValue({ start() {}, succeed() {}, fail() {} } as never));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('backup restore of a replicated service', () => {
  it('refuses before the confirmation, with the way out, and restores nothing', async () => {
    spies.push(
      spyOn(Backup.prototype, 'replicaRefusal').mockResolvedValue(
        new BackupError('db runs 2 replicas; a restore writes into one of them only', { code: ErrorCode.RESTORE_FAILED, suggestion: 'Scale it to 1.' }),
      ),
    );

    await restore();

    expect(exitCode).toBe(ErrorCode.RESTORE_FAILED);
    expect(errors.join('\n')).toContain('db runs 2 replicas; a restore writes into one of them only');
    expect(errors.join('\n')).toContain('Scale it to 1.');
    expect(prompts.dangerousConfirmPrompt).not.toHaveBeenCalled();
    expect(Backup.prototype.restore).not.toHaveBeenCalled();
    expect(lockModule.createEnvLock).not.toHaveBeenCalled();
  });

  it('gives the accessory hint for an accessory and the scale command for a service', async () => {
    await restore('-y');
    expect(Backup.prototype.replicaRefusal).toHaveBeenCalledWith('db', expect.stringContaining('accessories.yml'));

    spies.push(
      spyOn(backupUtils, 'requireBackupConfig').mockReturnValue({ backupConfig: { type: 'postgres' }, compression: 'gzip', source: 'services' }),
    );
    await restore('-y');
    expect(Backup.prototype.replicaRefusal).toHaveBeenLastCalledWith('db', 'Run `dockflow scale production db 1`, restore, then scale it back.');
  });

  it('restores a single-replica service as before', async () => {
    await restore('-y');
    expect(exitCode).toBeUndefined();
    expect(Backup.prototype.restore).toHaveBeenCalledTimes(1);
  });
});
