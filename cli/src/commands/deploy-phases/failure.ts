/**
 * What a failed deploy does: pick the manager to clean up through, decide the fate of the release,
 * remove the images it built and word the error of a rollback.
 */

import { sshExec } from '../../utils/ssh';
import { CLIError, DeployError, ErrorCode } from '../../utils/errors';
import { removeImagesCommand } from '../../services/release';
import type { ClusterConnection, ClusterNode } from '../../types';
import type { HealthCheckConfig } from '../../utils/config';
import type { AppProgress } from './app';
import type { BuildResult } from './build';

/**
 * The manager a failed deploy cleans up through: the one it deployed through while it answers,
 * otherwise the first other manager that does; null when none answers.
 */
export async function cleanupManager(
  cluster: ClusterConnection,
  answers: (node: ClusterNode) => Promise<boolean> = (node) => sshExec(node.connection, 'true').then((r) => r.exitCode === 0, () => false),
): Promise<ClusterNode | null> {
  for (const node of [cluster.manager, ...cluster.otherManagers]) {
    if (await answers(node)) return node;
  }
  return null;
}

export type FailureOutcome = 'rollback' | 'keep' | 'forget';

/**
 * What a failed deploy does with its release: roll back to the previous one, keep the new one as
 * current because it is what runs, or forget it because it never ran.
 */
export function failureOutcome(app: AppProgress, onFailure: HealthCheckConfig['on_failure'] = 'rollback', hasPrevious = true): FailureOutcome {
  if (!app.sent) return 'forget';
  if (onFailure === 'rollback' && hasPrevious) return 'rollback';
  return app.swarmRolledBack ? 'forget' : 'keep';
}

/**
 * Remove images from all cluster nodes after a failed deployment.
 * Skipped when a registry was used — images live in the registry, not just on nodes.
 * Best-effort: the failed tasks' stopped containers go first; a running container keeps its image.
 */
export async function cleanupFailedImages(
  buildResult: BuildResult,
  nodes: ClusterNode[],
): Promise<void> {
  if (buildResult.usedRegistry || buildResult.images.length === 0) return;

  const command = removeImagesCommand(buildResult.images);
  await Promise.allSettled(nodes.map((node) => sshExec(node.connection, command)));
}

/** The error of a rolled-back deploy: its cause's code, message and suggestion, then where it went back to. */
export function rolledBackError(err: unknown, rolledBackTo: string): DeployError {
  const cause = CLIError.from(err, ErrorCode.DEPLOY_FAILED);
  return new DeployError(`${cause.message}; rolled back to ${rolledBackTo}`, cause.code, cause.suggestion);
}
