/**
 * Which container engine (docker or podman) a deploy builds and pushes with on the manager.
 */

import { sshExec } from '../../utils/ssh';
import type { SSHKeyConnection } from '../../types';

export async function detectContainerEngine(
  conn: SSHKeyConnection,
  configEngine?: 'docker' | 'podman',
): Promise<'docker' | 'podman'> {
  if (configEngine) return configEngine;
  const podman = await sshExec(conn, 'which podman 2>/dev/null');
  return podman.exitCode === 0 ? 'podman' : 'docker';
}
