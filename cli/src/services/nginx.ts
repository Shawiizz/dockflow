/**
 * Nginx — deploy rendered nginx templates to /etc/nginx/sites-enabled/.
 *
 * Every file inside .dockflow/templates/nginx/ is treated as a nginx config
 * and deployed as-is (pure filename, no extension stripping).
 * Config is tested with `nginx -t` before reloading; rolled back on failure.
 */

import { basename } from 'path';
import type { SSHKeyConnection } from '../types';
import { sshExec, sshExecChannel } from '../utils/ssh';
import { printInfo, printWarning } from '../utils/output';
import { NGINX_SITES_ENABLED, DOCKFLOW_NGINX_TEMPLATES_DIR } from '../constants';
import type { RenderedFiles } from './compose';

export async function deployNginxTemplates(
  conn: SSHKeyConnection,
  rendered: RenderedFiles,
): Promise<void> {
  const prefix = DOCKFLOW_NGINX_TEMPLATES_DIR + '/';
  const entries = [...rendered.entries()].filter(([key]) => key.startsWith(prefix));

  if (entries.length === 0) return;

  printInfo(`Deploying ${entries.length} nginx template(s)...`);

  await sshExec(conn, `cp -r ${NGINX_SITES_ENABLED} /tmp/nginx-sites-enabled-backup 2>/dev/null || true`);

  for (const [key, content] of entries) {
    const dest = `${NGINX_SITES_ENABLED}/${basename(key)}`;
    const handle = await sshExecChannel(conn, `cat > "${dest}"`);
    handle.stream.end(content);
    await handle.done;
  }

  const test = await sshExec(conn, 'nginx -t 2>&1');
  if (test.exitCode !== 0) {
    await sshExec(conn,
      `rm -rf ${NGINX_SITES_ENABLED} && cp -r /tmp/nginx-sites-enabled-backup ${NGINX_SITES_ENABLED} 2>/dev/null || true`,
    );
    printWarning(`Nginx config test failed, rolled back:\n${test.stdout || test.stderr}`);
    return;
  }

  await sshExec(conn, 'nginx -s reload');
  printInfo('Nginx reloaded successfully.');
}
