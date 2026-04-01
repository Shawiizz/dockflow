/**
 * Hook Service
 *
 * Replaces the Ansible role `hooks`.
 * Runs user-defined shell scripts at four deploy phases:
 *   - pre-build  (local)
 *   - post-build (local)
 *   - pre-deploy (remote)
 *   - post-deploy (remote)
 *
 * Hooks are non-fatal by default — failures log warnings but
 * do not block the deploy.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SSHKeyConnection } from '../types';
import { sshExec } from '../utils/ssh';
import { shellEscape } from '../utils/ssh';
import { printDebug, printDim, printRaw, printWarning } from '../utils/output';
import type { DockflowConfig } from '../utils/config';
import { DOCKFLOW_STACKS_DIR } from '../constants';

export type HookPhase = 'pre-build' | 'post-build' | 'pre-deploy' | 'post-deploy';

const DEFAULT_HOOK_TIMEOUT_S = 300;

export class HookService {
  /**
   * Run a local hook script (pre-build, post-build).
   *
   * Hook path: {projectRoot}/.dockflow/hooks/{phase}.sh
   * Silently returns if the file doesn't exist or hooks are disabled.
   * Non-zero exit → printWarning (non-fatal).
   */
  static async runLocal(
    phase: HookPhase,
    projectRoot: string,
    config: DockflowConfig,
  ): Promise<void> {
    if (config.hooks?.enabled === false) return;

    const hookPath = join(projectRoot, '.dockflow', 'hooks', `${phase}.sh`);
    if (!existsSync(hookPath)) {
      printDebug(`No ${phase} hook found`);
      return;
    }

    const timeout = (config.hooks?.timeout ?? DEFAULT_HOOK_TIMEOUT_S) * 1000;

    printDim(`Running ${phase} hook...`);

    try {
      const proc = Bun.spawn(['bash', hookPath], {
        cwd: projectRoot,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Set up timeout
      const timer = setTimeout(() => {
        proc.kill();
      }, timeout);

      const stdoutReader = proc.stdout.getReader();
      const stderrReader = proc.stderr.getReader();
      const decoder = new TextDecoder();

      const readStream = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          buf += text;
          printRaw(text);
        }
        return buf;
      };

      await Promise.all([readStream(stdoutReader), readStream(stderrReader)]);
      await proc.exited;
      clearTimeout(timer);

      if (proc.exitCode !== 0) {
        printWarning(`${phase} hook exited with code ${proc.exitCode}`);
      } else {
        printDebug(`${phase} hook completed`);
      }
    } catch (error) {
      printWarning(`${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run a remote hook script (pre-deploy, post-deploy).
   *
   * 1. Reads the hook file locally
   * 2. Uploads it to /tmp on the remote
   * 3. Executes it with a timeout
   * 4. Cleans up the temp file
   *
   * Non-zero exit → printWarning (non-fatal).
   */
  static async runRemote(
    phase: HookPhase,
    connection: SSHKeyConnection,
    stackName: string,
    projectRoot: string,
    config: DockflowConfig,
  ): Promise<void> {
    if (config.hooks?.enabled === false) return;

    const hookPath = join(projectRoot, '.dockflow', 'hooks', `${phase}.sh`);
    if (!existsSync(hookPath)) {
      printDebug(`No ${phase} hook found`);
      return;
    }

    const timeout = config.hooks?.timeout ?? DEFAULT_HOOK_TIMEOUT_S;
    const tmpPath = `/tmp/dockflow_hook_${phase}_${Date.now()}.sh`;
    const stackDir = `${DOCKFLOW_STACKS_DIR}/${stackName}/current`;

    printDim(`Running remote ${phase} hook...`);

    try {
      // Read hook content
      const hookContent = readFileSync(hookPath, 'utf-8');
      const escapedContent = shellEscape(hookContent);

      // Upload
      await sshExec(
        connection,
        `cat > "${tmpPath}" << 'DOCKFLOW_HOOK_EOF'\n${hookContent}\nDOCKFLOW_HOOK_EOF`,
      );
      await sshExec(connection, `chmod +x "${tmpPath}"`);

      // Execute with timeout
      const result = await sshExec(
        connection,
        `cd "${stackDir}" 2>/dev/null || cd /tmp; timeout ${timeout} "${tmpPath}" 2>&1`,
      );

      if (result.stdout.trim()) {
        printRaw(result.stdout.trim());
      }

      if (result.exitCode !== 0) {
        printWarning(`Remote ${phase} hook exited with code ${result.exitCode}`);
      } else {
        printDebug(`Remote ${phase} hook completed`);
      }
    } catch (error) {
      printWarning(`Remote ${phase} hook failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Cleanup
      await sshExec(connection, `rm -f "${tmpPath}"`).catch(() => {});
    }
  }
}
