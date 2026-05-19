/**
 * Nginx — deploy rendered nginx templates to /etc/nginx/sites-enabled/.
 *
 * Every file inside .dockflow/templates/nginx/ is treated as a nginx config
 * and deployed as-is (pure filename, no extension stripping).
 * Config is tested with `nginx -t` before reloading; rolled back on failure.
 *
 * Permission model:
 *   - File writes: deploy user must be in the nginx group with group-write on sites-enabled
 *     (configured by `dockflow setup`)
 *   - nginx -t / nginx -s reload: restricted sudo (configured by `dockflow setup`)
 */

import { basename } from 'path';
import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { printInfo, printWarning } from '../utils/output';
import { DeployError, ErrorCode } from '../utils/errors';
import { NGINX_SITES_ENABLED, DOCKFLOW_NGINX_TEMPLATES_DIR } from '../constants';
import type { RenderedFiles } from './compose';

const NGINX_BACKUP_DIR = '/tmp/dockflow-nginx-backup';

function isSudoPermissionError(stderr: string): boolean {
  return stderr.includes('is not allowed') || stderr.includes('not in the sudoers') || stderr.includes('command not found');
}

export async function deployNginxTemplates(
  conn: SSHKeyConnection,
  rendered: RenderedFiles,
): Promise<void> {
  const prefix = DOCKFLOW_NGINX_TEMPLATES_DIR + '/';
  const entries = [...rendered.entries()].filter(([key]) => key.startsWith(prefix));

  if (entries.length === 0) return;

  printInfo(`Deploying ${entries.length} nginx template(s)...`);

  await sshExec(conn, `rm -rf '${NGINX_BACKUP_DIR}' && mkdir -p '${NGINX_BACKUP_DIR}'`);

  // Backup files that already exist (so rollback can restore them precisely)
  const previouslyExisted = new Set<string>();
  for (const [key] of entries) {
    const dest = `${NGINX_SITES_ENABLED}/${basename(key)}`;
    const backup = `${NGINX_BACKUP_DIR}/${basename(key)}`;
    const r = await sshExec(conn, `[ -f '${dest}' ] && cp '${dest}' '${backup}' && echo existed || true`);
    if (r.stdout.trim() === 'existed') previouslyExisted.add(dest);
  }

  // Write new configs — no sudo: deploy user has group-write on sites-enabled
  for (const [key, content] of entries) {
    const dest = `${NGINX_SITES_ENABLED}/${basename(key)}`;
    const { stream, done } = await sshExecChannel(conn, `cat > '${dest}'`);
    stream.end(content);
    const result = await done;
    if (result.exitCode !== 0) {
      await rollback(conn, entries.map(([k]) => `${NGINX_SITES_ENABLED}/${basename(k)}`), previouslyExisted);
      const detail = result.stderr.trim() || `exit ${result.exitCode}`;
      const groupResult = await sshExec(conn, `nginx -T 2>/dev/null | awk '/^user[[:space:]]/{gsub(";","",$2); print $2; exit}'`);
      const nginxGroup = groupResult.stdout.trim() || (await sshExec(conn, `getent group nginx >/dev/null 2>&1 && echo nginx || echo www-data`)).stdout.trim() || 'www-data';
      throw new DeployError(
        `Nginx template write failed on ${conn.host}: ${detail}`,
        ErrorCode.DEPLOY_FAILED,
        `The deploy user needs group-write access to ${NGINX_SITES_ENABLED}.\n` +
        `Run once on the server as root:\n` +
        `  usermod -aG ${nginxGroup} ${conn.user}\n` +
        `  chgrp -R ${nginxGroup} ${NGINX_SITES_ENABLED}\n` +
        `  chmod -R g+rwX ${NGINX_SITES_ENABLED}\n` +
        `  Then re-run dockflow deploy — each deploy opens a fresh SSH connection that picks up the new group.`,
      );
    }
  }

  // Test config — needs restricted sudo (nginx -t only)
  const test = await sshExec(conn, 'sudo nginx -t 2>&1');
  if (test.exitCode !== 0) {
    await rollback(conn, entries.map(([k]) => `${NGINX_SITES_ENABLED}/${basename(k)}`), previouslyExisted);
    const detail = test.stdout.trim() || test.stderr.trim();
    if (isSudoPermissionError(detail)) {
      throw new DeployError(
        `nginx -t failed — sudo not configured on ${conn.host}`,
        ErrorCode.DEPLOY_FAILED,
        `The deploy user needs restricted sudo for nginx. Run once on the server:\n` +
        `  NGINX=$(which nginx)\n` +
        `  echo "${conn.user} ALL=(ALL) NOPASSWD: $NGINX -t, $NGINX -s reload" > /etc/sudoers.d/dockflow-nginx\n` +
        `  chmod 440 /etc/sudoers.d/dockflow-nginx`,
      );
    }
    printWarning(`Nginx config test failed, rolled back:\n${detail}`);
    return;
  }

  // Reload — needs restricted sudo (nginx -s reload only)
  const reload = await sshExec(conn, 'sudo nginx -s reload');
  if (reload.exitCode !== 0) {
    const detail = reload.stderr.trim() || reload.stdout.trim();
    if (isSudoPermissionError(detail)) {
      throw new DeployError(
        `nginx reload failed — sudo not configured on ${conn.host}`,
        ErrorCode.DEPLOY_FAILED,
        `The deploy user needs restricted sudo for nginx. Run once on the server:\n` +
        `  NGINX=$(which nginx)\n` +
        `  echo "${conn.user} ALL=(ALL) NOPASSWD: $NGINX -t, $NGINX -s reload" > /etc/sudoers.d/dockflow-nginx\n` +
        `  chmod 440 /etc/sudoers.d/dockflow-nginx`,
      );
    }
    printWarning(`Nginx reload failed: ${detail}`);
  }

  await sshExec(conn, `rm -rf '${NGINX_BACKUP_DIR}'`);
  printInfo('Nginx reloaded successfully.');
}

async function rollback(
  conn: SSHKeyConnection,
  dests: string[],
  previouslyExisted: Set<string>,
): Promise<void> {
  for (const dest of dests) {
    const backup = `${NGINX_BACKUP_DIR}/${basename(dest)}`;
    if (previouslyExisted.has(dest)) {
      await sshExec(conn, `cp '${backup}' '${dest}'`);
    } else {
      await sshExec(conn, `rm -f '${dest}'`);
    }
  }
  await sshExec(conn, `rm -rf '${NGINX_BACKUP_DIR}'`);
}
