/**
 * Audit, metrics and history sync of a deploy: best-effort records written once it ends.
 */

import { getPerformer } from '../../utils/config';
import { printWarning } from '../../utils/output';
import * as HistorySync from '../../services/history-sync';
import type { SSHKeyConnection, ClusterConnection } from '../../types';
import type { DeployContext } from '../deploy-context';
import { activeNodes } from './shared';

/** Connections that receive history-sync writes (all nodes except the primary manager). */
function historySyncConns(cluster: ClusterConnection): SSHKeyConnection[] {
  return [...cluster.otherManagers, ...cluster.workers].map(n => n.connection);
}

export async function recordHistory(
  ctx: DeployContext,
  status: 'success' | 'failed',
  durationMs: number,
  auditMessage: string,
): Promise<void> {
  let auditLine = '';
  let metricsJson = '';

  const [auditResult, metricsResult] = await Promise.allSettled([
    ctx.audit.writeEntry(
      ctx.stackName,
      status === 'success' ? 'deployed' : 'failed',
      auditMessage,
      ctx.deployVersion,
    ),
    ctx.metrics.writeDeployment({
      stackName: ctx.stackName,
      version: ctx.deployVersion,
      env: ctx.env,
      branch: ctx.branchName,
      status,
      durationMs,
      performer: getPerformer(),
      buildSkipped: !!ctx.options.skipBuild,
      accessoriesDeployed: !ctx.skipAccessories,
      nodeCount: activeNodes(ctx.cluster).length,
    }),
  ]);

  if (auditResult.status === 'fulfilled') {
    auditLine = auditResult.value;
  } else {
    printWarning(`Audit write failed: ${auditResult.reason instanceof Error ? auditResult.reason.message : String(auditResult.reason)}`);
  }

  if (metricsResult.status === 'fulfilled') {
    metricsJson = metricsResult.value;
  } else {
    printWarning(`Metrics write failed: ${metricsResult.reason instanceof Error ? metricsResult.reason.message : String(metricsResult.reason)}`);
  }

  await HistorySync.syncToAllNodes(
    historySyncConns(ctx.cluster),
    ctx.stackName,
    auditLine,
    metricsJson,
  ).catch((e) =>
    printWarning(`History sync failed: ${e instanceof Error ? e.message : String(e)}`),
  );
}
