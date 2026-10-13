/**
 * History Sync command - Replicate deployment history across all cluster nodes
 *
 * Reads the full audit log and metrics from the node that has the most data,
 * then writes it to all other nodes. Deduplicates by exact line match (audit)
 * and by metric ID (metrics JSONL).
 */

import type { Command } from 'commander';
import { shellQuote, sshExec } from '../../utils/ssh';
import { sshShell, type RemoteShell } from '../../utils/remote-shell';
import { printSuccess, printInfo, printBlank, printWarning, printDebug, createSpinner } from '../../utils/output';
import { validateEnv, getAllNodeConnections, withResolvedEnv } from '../../utils/validation';
import { DockerError, withErrorHandler } from '../../utils/errors';
import { DOCKFLOW_AUDIT_DIR, DOCKFLOW_METRICS_DIR } from '../../constants';
import type { SSHKeyConnection } from '../../types';

interface NodeData {
  connection: SSHKeyConnection;
  auditLines: string[];
  metricsLines: string[];
}

/**
 * Read history data from a single node
 */
async function readNodeHistory(
  conn: SSHKeyConnection,
  stackName: string,
): Promise<{ auditLines: string[]; metricsLines: string[] } | null> {
  try {
    const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
    const metricsFile = `${DOCKFLOW_METRICS_DIR}/${stackName}/deployments.json`;

    const [auditResult, metricsResult] = await Promise.all([
      sshExec(conn, `cat "${auditFile}" 2>/dev/null || echo ""`),
      sshExec(conn, `cat "${metricsFile}" 2>/dev/null || echo ""`),
    ]);

    return {
      auditLines: auditResult.stdout.trim().split('\n').filter(l => l.trim()),
      metricsLines: metricsResult.stdout.trim().split('\n').filter(l => l.trim()),
    };
  } catch {
    return null;
  }
}

/**
 * Write the full history to a node (replace content)
 */
export async function writeNodeHistory(
  shell: RemoteShell,
  stackName: string,
  auditContent: string,
  metricsContent: string,
): Promise<boolean> {
  try {
    const auditFile = `${DOCKFLOW_AUDIT_DIR}/${stackName}.log`;
    const metricsFile = `${DOCKFLOW_METRICS_DIR}/${stackName}/deployments.json`;
    const metricsDir = `${DOCKFLOW_METRICS_DIR}/${stackName}`;

    // the content goes on stdin: a history is no command-line argument (size limit, process list)
    const write = async (dir: string, file: string, content: string): Promise<boolean> =>
      (await shell.run(`mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(file)}`, `${content}\n`)).exitCode === 0;
    if (auditContent && !(await write(DOCKFLOW_AUDIT_DIR, auditFile, auditContent))) return false;
    if (metricsContent && !(await write(metricsDir, metricsFile, metricsContent))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Deduplicate metrics JSONL lines by ID field
 */
function deduplicateMetrics(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.id && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        result.push(line);
      } else if (!parsed.id) {
        result.push(line);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result;
}

export function registerHistorySyncCommand(program: Command): void {
  program
    .command('history-sync <env>')
    .description('Sync deployment history across all cluster nodes')
    .helpGroup('Inspect')
    .option('--debug', 'Enable debug output')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { debug?: boolean }) => {
      const { stackName } = validateEnv(env);
      const connections = getAllNodeConnections(env);

      if (connections.length < 2) {
        printWarning('Only one node found — nothing to sync.');
        return;
      }

      printInfo(`Syncing history for ${stackName} across ${connections.length} nodes...`);
      printBlank();

      // 1. Read history from all nodes
      const spinner = createSpinner();
      spinner.start('Reading history from all nodes...');
      const nodeData: NodeData[] = [];

      for (const conn of connections) {
        const data = await readNodeHistory(conn, stackName);
        if (data) {
          nodeData.push({ connection: conn, ...data });
          if (options.debug) {
            printDebug(`  ${conn.host}: ${data.auditLines.length} audit, ${data.metricsLines.length} metrics`);
          }
        } else {
          if (options.debug) {
            printDebug(`  ${conn.host}: unreachable`);
          }
        }
      }

      if (nodeData.length === 0) {
        spinner.fail('No reachable nodes found');
        throw new DockerError('All nodes are unreachable');
      }

      spinner.succeed(`Read history from ${nodeData.length}/${connections.length} nodes`);

      // 2. Merge: union of all audit lines (deduplicate exact match), deduplicate metrics by ID
      const allAuditLines = new Set<string>();
      const allMetricsLines: string[] = [];

      for (const nd of nodeData) {
        for (const line of nd.auditLines) {
          allAuditLines.add(line);
        }
        allMetricsLines.push(...nd.metricsLines);
      }

      // Sort audit lines by timestamp (they start with ISO date)
      const mergedAudit = Array.from(allAuditLines).sort();
      const mergedMetrics = deduplicateMetrics(allMetricsLines).sort((a, b) => {
        try {
          const ta = JSON.parse(a).timestamp || '';
          const tb = JSON.parse(b).timestamp || '';
          return ta.localeCompare(tb);
        } catch {
          return 0;
        }
      });

      printInfo(`Merged: ${mergedAudit.length} audit entries, ${mergedMetrics.length} metric entries`);

      // 3. Write merged data to all reachable nodes
      const writeSpinner = createSpinner();
      writeSpinner.start('Writing merged history to all nodes...');
      const auditContent = mergedAudit.join('\n');
      const metricsContent = mergedMetrics.join('\n');
      let synced = 0;
      let failed = 0;

      for (const nd of nodeData) {
        const ok = await writeNodeHistory(sshShell(nd.connection), stackName, auditContent, metricsContent);
        if (ok) {
          synced++;
        } else {
          failed++;
          printWarning(`  Failed to write to ${nd.connection.host}`);
        }
      }

      if (failed > 0) {
        writeSpinner.warn(`Synced to ${synced}/${nodeData.length} nodes (${failed} failed)`);
      } else {
        writeSpinner.succeed(`Synced to ${synced} nodes`);
      }

      printBlank();
      printSuccess(`History sync complete for ${stackName}`);
    })));
}
