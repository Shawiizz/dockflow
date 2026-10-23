/**
 * Upload phase: the pre-flight permission check on the destinations, then the transfer of files
 * and directories to every node, recording what a rollback must restore.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { pipeline } from 'stream/promises';
import { printDim, printWarning, formatBytes, createSpinner } from '../../utils/output';
import { walkDir } from '../../utils/fs';
import { packDirToTarGz, buildExcludeFilter } from '../../utils/tar';
import { raw, sh, sshExec, sshExecChannel } from '../../utils/ssh';
import { DeployError, ErrorCode } from '../../utils/errors';
import { DOCKFLOW_UPLOAD_BACKUPS_DIR } from '../../constants';
import type { SSHKeyConnection } from '../../types';
import type { UploadItem } from '../../utils/config';
import type { DeployContext } from '../deploy-context';
import { activeNodes } from './shared';
import {
  dirBackupPath, fileBackupPath, filterUploads, resolveFileDestPath, uploadName, uploadOwnedDir,
} from './upload-paths';
import type { UploadRollbackPlan } from './upload-paths';
import { posixRelative } from '../../utils/fs';

const UPLOAD_CONCURRENCY = 8;

/** Work-stealing concurrency pool: N workers drain a shared task queue. */
export async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let i = 0;
  const worker = async () => {
    let idx: number;
    while ((idx = i++) < tasks.length) await tasks[idx]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

async function streamDirToHost(
  srcDir: string,
  excludePatterns: string[],
  name: string,
  conn: SSHKeyConnection,
  destBase: string,
  compress: boolean,
  onProgress?: (bytesProcessed: number) => void,
  onExtracting?: () => void,
): Promise<void> {
  const extractCmd = compress ? sh`tar xzf - -C ${destBase}` : sh`tar xf - -C ${destBase}`;
  const { stream, done } = await sshExecChannel(conn, extractCmd);
  await pipeline(packDirToTarGz(srcDir, excludePatterns, onProgress, compress), stream as unknown as NodeJS.WritableStream);
  onExtracting?.();
  const result = await done;
  if (result.exitCode !== 0) {
    throw new DeployError(
      `upload: tar extraction failed at ${destBase} on ${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      ErrorCode.DEPLOY_FAILED,
    );
  }
}

function filterUploadsByService(ctx: DeployContext): UploadItem[] {
  return filterUploads(ctx.config.uploads, ctx.options.only);
}

/**
 * Pre-flight check, run before the build so permission errors surface early: one SSH call per node
 * verifies that every destination (or its nearest existing parent) is writable by the deploy user.
 */
export async function checkUploadPermissions(ctx: DeployContext): Promise<void> {
  const filtered = filterUploadsByService(ctx);
  if (filtered.length === 0) return;

  // Shell function that walks up to the first existing ancestor and checks writability.
  // Loop terminates at '/' which always exists as a directory.
  const checkFn =
    'check_path() {\n' +
    '  local dest="$1" label="$2"\n' +
    '  if [ -e "$dest" ]; then\n' +
    '    [ -w "$dest" ] || ERRORS="${ERRORS}$label: not writable: $dest\\n"\n' +
    '  else\n' +
    '    local p="$dest"\n' +
    '    while [ ! -d "$p" ]; do p=$(dirname "$p"); done\n' +
    '    [ -w "$p" ] || ERRORS="${ERRORS}$label: cannot create $dest (nearest existing parent: $p)\\n"\n' +
    '  fi\n' +
    '}';

  const checks = filtered
    .map(u => sh`check_path ${u.dest} ${uploadName(u)}`)
    .join('\n');

  // checkFn is the code's own constant and checks are made with sh: both go in as shell syntax
  const script = sh`${raw(
    'ERRORS=""\n' +
    checkFn + '\n' +
    checks + '\n' +
    '[ -z "$ERRORS" ] || { printf "%b" "$ERRORS"; exit 1; }',
  )}`;

  const nodes = activeNodes(ctx.cluster);
  const failures: string[] = [];
  printDim(`Checking upload permissions on ${nodes.length} node(s)...`);

  await Promise.all(nodes.map(async node => {
    const result = await sshExec(node.connection, script);
    if (result.exitCode !== 0) {
      const detail = (result.stdout.trim() || result.stderr.trim())
        .split('\n').map(l => `    ${l}`).join('\n');
      failures.push(`  ${node.name}:\n${detail}`);
    }
  }));

  if (failures.length > 0) {
    const user = ctx.cluster.manager.connection.user;
    const commands = filtered.map(u => {
      const srcAbs = resolve(ctx.projectRoot, u.src);
      const isDir = existsSync(srcAbs) && statSync(srcAbs).isDirectory();
      const owned = uploadOwnedDir(u.dest, isDir);
      return `  mkdir -p '${owned}' && chown ${isDir ? '-R ' : ''}${user}: '${owned}'`;
    });
    const destList = [...new Set(commands)].join('\n');
    throw new DeployError(
      `Upload permission check failed:\n${failures.join('\n')}`,
      ErrorCode.DEPLOY_FAILED,
      `Ensure the deploy user has write access to all upload destinations.\n` +
      `Run once on each failing server as root:\n${destList}`,
    );
  }
}

export async function uploadFiles(ctx: DeployContext): Promise<UploadRollbackPlan> {
  const backupBaseDir = `${DOCKFLOW_UPLOAD_BACKUPS_DIR}/${ctx.stackName}/${ctx.deployVersion}`;
  const filtered = filterUploadsByService(ctx);
  // nothing touches a node, so commit and rollback must not connect to any (a down node would fail them)
  if (filtered.length === 0) return { hosts: [], backupBaseDir };

  const plan: UploadRollbackPlan = {
    hosts: activeNodes(ctx.cluster).map(n => ({
      name: n.name, conn: n.connection, backedUp: [], created: [], backedUpDirs: [], createdDirs: [],
    })),
    backupBaseDir,
  };

  for (const upload of filtered) {

    const srcAbs = resolve(ctx.projectRoot, upload.src);
    const srcRel = posixRelative(ctx.projectRoot, srcAbs);
    // a plugin's rendered file exists only in memory, never on disk
    const inMemory = ctx.rendered.has(srcRel);
    if (!inMemory && !existsSync(srcAbs)) {
      printWarning(`upload: source not found, skipping: ${uploadName(upload)}`);
      continue;
    }

    const destBase = upload.dest.replace(/\/$/, '');

    if (!inMemory && statSync(srcAbs).isDirectory()) {
      const excludePatterns = upload.exclude ?? [];

      await Promise.all(plan.hosts.map(async hostState => {
        const { name, conn } = hostState;
        const backupPath = dirBackupPath(backupBaseDir, destBase);

        await sshExec(conn, sh`mkdir -p ${dirname(backupPath)}`);
        const backupResult = await sshExec(conn,
          sh`if [ -d ${destBase} ] && [ -n "$(ls -A ${destBase} 2>/dev/null)" ]; then tar czf ${backupPath} -C ${destBase} . 2>/dev/null && echo backed_up; else echo missing; fi`,
        );
        if (backupResult.stdout.trim() === 'backed_up') {
          hostState.backedUpDirs.push({ dest: destBase, backup: backupPath });
        } else {
          hostState.createdDirs.push(destBase);
        }

        const mkdirResult = await sshExec(conn, sh`mkdir -p ${destBase}`);
        if (mkdirResult.exitCode !== 0) {
          throw new DeployError(
            `upload: cannot create ${destBase} on ${name}: ${mkdirResult.stderr.trim() || `exit ${mkdirResult.exitCode}`}`,
            ErrorCode.DEPLOY_FAILED,
            `The deploy user must own the destination directory. Run once on the server as root:\n  mkdir -p '${destBase}' && chown ${conn.user}: '${destBase}'`,
          );
        }
      }));

      const compress = upload.compress !== false;
      const compressFlag = compress ? '' : ' [no compression]';

      if (plan.hosts.length === 1) {
        // single host: stream directly into SSH, no RAM buffer
        const { name, conn } = plan.hosts[0];
        const isExcluded = buildExcludeFilter(excludePatterns);
        const totalBytes = walkDir(srcAbs)
          .filter(f => !isExcluded(posixRelative(srcAbs, f)))
          .reduce((sum, f) => sum + statSync(f).size, 0);
        const totalStr = formatBytes(totalBytes);
        const spinner = createSpinner();
        spinner.start(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/${compressFlag}`);
        let lastTick = 0;
        await streamDirToHost(srcAbs, excludePatterns, name, conn, destBase, compress,
          (bytesProcessed) => {
            const now = Date.now();
            if (now - lastTick < 250) return;
            lastTick = now;
            const pct = Math.min(99, Math.round(bytesProcessed / (totalBytes || 1) * 100));
            spinner.update(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/ ${formatBytes(bytesProcessed)} / ${totalStr} (${pct}%)`);
          },
          () => spinner.update(`upload: unpacking on ${name}...`),
        );
        spinner.succeed(`upload: ${uploadName(upload)}/ -> ${name}:${destBase}/ done`);
        if (upload.permissions) await sshExec(conn, sh`chmod -R ${upload.permissions} ${destBase}`);
        if (upload.owner) await sshExec(conn, sh`chown -R ${upload.owner} ${destBase}`);
      } else {
        // multiple hosts: stream independently to each host in parallel, no RAM buffer
        printDim(`upload: ${uploadName(upload)}/ -> ${destBase}/${compressFlag} [${plan.hosts.length} hosts]`);
        await Promise.all(plan.hosts.map(async ({ name, conn }) => {
          await streamDirToHost(srcAbs, excludePatterns, name, conn, destBase, compress);
          printDim(`  upload: -> ${name}:${destBase}/ done`);
          if (upload.permissions) await sshExec(conn, sh`chmod -R ${upload.permissions} ${destBase}`);
          if (upload.owner) await sshExec(conn, sh`chown -R ${upload.owner} ${destBase}`);
        }));
      }
    } else {
      const destPath = resolveFileDestPath(upload.dest, basename(srcAbs));
      const backupPath = fileBackupPath(backupBaseDir, destPath);
      const renderedText = ctx.rendered.get(srcRel);
      const fileContent = renderedText !== undefined ? Buffer.from(renderedText) : readFileSync(srcAbs);

      await Promise.all(plan.hosts.map(async ({ name, conn }) => {
        const r = await sshExec(conn, sh`mkdir -p ${dirname(destPath)} ${dirname(backupPath)}`);
        if (r.exitCode !== 0) throw new DeployError(
          `upload: cannot create ${dirname(destPath)} on ${name}: ${r.stderr.trim() || `exit ${r.exitCode}`}`,
          ErrorCode.DEPLOY_FAILED,
          `The deploy user must own the destination directory. Run once on the server as root:\n  mkdir -p '${dirname(destPath)}' && chown ${conn.user}: '${dirname(destPath)}'`,
        );
      }));

      const tasks = plan.hosts.map(hostState => async () => {
        const { name, conn } = hostState;

        const backupResult = await sshExec(conn,
          sh`if test -f ${destPath}; then cp ${destPath} ${backupPath} && echo existed; else echo missing; fi`,
        );
        if (backupResult.stdout.trim() === 'existed') {
          hostState.backedUp.push(destPath);
        } else {
          hostState.created.push(destPath);
        }

        const result = await sshExec(conn, sh`cat > ${destPath}`, { stdin: fileContent });
        if (result.exitCode !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
          throw new DeployError(
            `upload: failed to transfer ${uploadName(upload)} → ${destPath} on ${name}: ${detail}`,
            ErrorCode.DEPLOY_FAILED,
            `Ensure ${conn.user} has write access to ${dirname(destPath)} on ${name}. Run once as root:\n  mkdir -p '${dirname(destPath)}' && chown ${conn.user}: '${dirname(destPath)}'`,
          );
        }

        if (upload.permissions) {
          const r = await sshExec(conn, sh`chmod ${upload.permissions} ${destPath}`);
          if (r.exitCode !== 0) throw new DeployError(
            `upload: chmod ${upload.permissions} failed on ${destPath} (${name}): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
            ErrorCode.DEPLOY_FAILED,
          );
        }
        if (upload.owner) {
          const r = await sshExec(conn, sh`chown ${upload.owner} ${destPath}`);
          if (r.exitCode !== 0) throw new DeployError(
            `upload: chown ${upload.owner} failed on ${destPath} (${name}): ${r.stderr.trim() || `exit ${r.exitCode}`}`,
            ErrorCode.DEPLOY_FAILED,
            `The deploy user needs sudo rights for chown. Either run once on the server as root:\n` +
            `  chown ${upload.owner} '${destPath}'\n` +
            `Or grant the deploy user the right permanently:\n` +
            `  echo '${conn.user} ALL=(ALL) NOPASSWD: /bin/chown * ${dirname(destPath)}/*' >> /etc/sudoers.d/dockflow`,
          );
        }
      });

      await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);
      printDim(`upload: ${uploadName(upload)} -> ${destPath}`);
    }
  }

  return plan;
}
