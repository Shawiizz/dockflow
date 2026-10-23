/**
 * Ends of an upload: restore every backed-up file and directory (rollback), or drop the backups
 * once the deploy is good (commit).
 */

import { sh, sshExec } from '../../utils/ssh';
import { DeployError, ErrorCode } from '../../utils/errors';
import { fileBackupPath } from './upload-paths';
import type { UploadRollbackPlan } from './upload-paths';

export async function rollbackUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(async ({ conn, backedUp, created, backedUpDirs, createdDirs }) => {
    for (const destPath of backedUp) {
      const backupPath = fileBackupPath(plan.backupBaseDir, destPath);
      const r = await sshExec(conn, sh`cp ${backupPath} ${destPath} && rm -f ${backupPath}`);
      if (r.exitCode !== 0) throw new DeployError(
        `upload rollback: failed to restore '${destPath}': ${r.stderr.trim() || `exit ${r.exitCode}`}`,
        ErrorCode.DEPLOY_FAILED,
      );
    }
    for (const destPath of created) {
      await sshExec(conn, sh`rm -f ${destPath}`);
    }
    for (const { dest, backup } of backedUpDirs) {
      // extract to a temp dir first: if extraction fails, the original dest is untouched
      const tmp = `${dest}.dockflow-restore-${Date.now()}`;
      const r = await sshExec(conn, sh`mkdir -p ${tmp} && tar xzf ${backup} -C ${tmp}`);
      if (r.exitCode !== 0) {
        await sshExec(conn, sh`rm -rf ${tmp}`);
        throw new DeployError(
          `upload rollback: failed to extract backup for '${dest}': ${r.stderr.trim() || `exit ${r.exitCode}`}`,
          ErrorCode.DEPLOY_FAILED,
        );
      }
      // the swap is the destructive step of the restore: if it fails the destination may be
      // gone, so it must never fail silently
      const swap = await sshExec(conn, sh`rm -rf ${dest} && mv ${tmp} ${dest}`);
      if (swap.exitCode !== 0) {
        throw new DeployError(
          `upload rollback: failed to restore '${dest}': ${swap.stderr.trim() || `exit ${swap.exitCode}`}\n` +
          `The extracted backup is still available at '${tmp}' on the server.`,
          ErrorCode.DEPLOY_FAILED,
        );
      }
    }
    for (const dest of createdDirs) {
      await sshExec(conn, sh`rm -rf ${dest}`);
    }
    await sshExec(conn, sh`rm -rf ${plan.backupBaseDir}`);
  }));
}

export async function commitUploads(plan: UploadRollbackPlan): Promise<void> {
  await Promise.all(plan.hosts.map(({ conn }) =>
    sshExec(conn, sh`rm -rf ${plan.backupBaseDir}`),
  ));
}
