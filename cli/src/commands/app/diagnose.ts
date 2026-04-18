import type { Command } from 'commander';
import { sshExec } from '../../utils/ssh';
import {
  printSection, printIntro, printInfo, printError,
  printSuccess, printDebug, printBlank, printRaw, printWarning, colors,
} from '../../utils/output';
import { validateEnv, withResolvedEnv } from '../../utils/validation';
import { SwarmStackBackend } from '../../services/orchestrator/swarm/swarm-stack';
import { loadConfig } from '../../utils/config';
import { withErrorHandler, DockerError, ConfigError } from '../../utils/errors';

interface DiagnosticIssue {
  severity: 'error' | 'warning';
  category: string;
  message: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Error pattern table — ordered from most to least specific
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  suggestion: string | ((m: RegExpMatchArray) => string);
}> = [
  {
    pattern: /bind source path does not exist:\s*(\S+)/i,
    suggestion: (m: RegExpMatchArray) => `Create the directory on the server: mkdir -p ${m[1]}`,
  },
  {
    pattern: /no such image|image not found/i,
    suggestion: 'The Docker image may not have been pushed. Try redeploying.',
  },
  {
    pattern: /port is already allocated|address already in use/i,
    suggestion: 'Another service is using this port. Check running containers with: docker ps',
  },
  {
    pattern: /\boom\b|out of memory/i,
    suggestion: 'Container ran out of memory. Increase memory limits or reduce memory usage.',
  },
  {
    pattern: /permission denied/i,
    suggestion: 'Check file/directory permissions on mounted volumes.',
  },
  {
    pattern: /no space left on device/i,
    suggestion: 'Clean up disk space: dockflow prune <env> or docker system prune',
  },
  {
    pattern: /exec format error/i,
    suggestion: 'Image architecture mismatch. Rebuild for the correct platform (linux/amd64 or linux/arm64).',
  },
  {
    pattern: /network .+ not found/i,
    suggestion: 'Docker network may have been removed. Try redeploying the stack.',
  },
];

function analyzeTaskError(error: string): string {
  for (const { pattern, suggestion } of ERROR_PATTERNS) {
    const match = error.match(pattern);
    if (match) {
      return typeof suggestion === 'function' ? suggestion(match) : suggestion;
    }
  }
  return 'Check Docker logs for more details: docker service logs <service_name>';
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose <env>')
    .description('Diagnose deployment issues and show why containers may not be starting')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('-v, --verbose', 'Show all diagnostic details')
    .action(withErrorHandler(withResolvedEnv(async (env: string, options: { server?: string; verbose?: boolean }) => {
      const { stackName, connection, serverName } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });

      const config = loadConfig();
      if (!config) throw new ConfigError('No dockflow config found');
      if ((config.orchestrator ?? 'swarm') !== 'swarm') {
        throw new DockerError(
          '`dockflow diagnose` is Swarm-only. For k3s, use `kubectl describe pods` or `kubectl get events`.',
        );
      }

      printIntro(`Diagnosing: ${stackName}`);
      printBlank();

      const issues: DiagnosticIssue[] = [];
      const orchestrator = new SwarmStackBackend(connection);

      // ── Stack existence ──────────────────────────────────────────────────
      printSection('Stack Status');
      const stackExists = await orchestrator.stackExists(stackName);
      if (!stackExists) {
        printError('Stack does not exist');
        issues.push({
          severity: 'error',
          category: 'Stack',
          message: 'Stack not found',
          suggestion: `Run 'dockflow deploy ${env}' to deploy the stack`,
        });
        printDiagnosticSummary(issues);
        return;
      }
      printSuccess('Stack exists');

      // ── Service replicas ─────────────────────────────────────────────────
      printSection('Services');
      const services = await orchestrator.getServices(stackName);
      for (const service of services) {
        const [current, desired] = service.replicas.split('/').map(s => parseInt(s.trim()));
        if (current === 0 && desired > 0) {
          printRaw(`  ${colors.error('✗')} ${service.name}: ${colors.error(service.replicas)} replicas`);
          issues.push({ severity: 'error', category: 'Replicas', message: `Service '${service.name}' has 0/${desired} replicas`, suggestion: 'Check task errors below' });
        } else if (current < desired) {
          printRaw(`  ${colors.warning('!')} ${service.name}: ${colors.warning(service.replicas)} replicas`);
          issues.push({ severity: 'warning', category: 'Replicas', message: `Service '${service.name}' has ${current}/${desired} replicas` });
        } else {
          printRaw(`  ${colors.success('✓')} ${service.name}: ${colors.success(service.replicas)} replicas`);
        }
      }

      // ── Failed tasks ─────────────────────────────────────────────────────
      printSection('Task Errors');
      const tasks = await orchestrator.getTasks(stackName);
      const failures = tasks
        .filter(t => t.error || t.currentState.includes('Failed'))
        .slice(0, 10);

      if (failures.length === 0) {
        printSuccess('No task errors found');
      } else {
        for (const task of failures) {
          printRaw(`  ${colors.error('✗')} ${task.name}`);
          printRaw(`    State: ${colors.warning(task.currentState)}`);
          if (task.error) {
            printRaw(`    Error: ${colors.error(task.error)}`);
            issues.push({
              severity: 'error',
              category: 'Task',
              message: `${task.name}: ${task.error}`,
              suggestion: analyzeTaskError(task.error),
            });
          }
          printBlank();
        }
      }

      // ── Pending tasks ────────────────────────────────────────────────────
      printSection('Pending Tasks');
      const pending = tasks.filter(t =>
        t.currentState.includes('Pending') ||
        t.currentState.includes('Preparing') ||
        t.currentState.includes('Starting'),
      );

      if (pending.length === 0) {
        printInfo('No pending tasks');
      } else {
        for (const task of pending) {
          printRaw(`  ${colors.warning('○')} ${task.name}: ${task.currentState}`);
        }
        if (pending.some(t => t.currentState.includes('Pending'))) {
          issues.push({ severity: 'warning', category: 'Scheduling', message: 'Some tasks are pending', suggestion: 'May indicate resource constraints or scheduling issues' });
        }
      }

      // ── Recent Docker events (verbose only) ──────────────────────────────
      if (options.verbose) {
        printSection('Recent Docker Events');
        try {
          const result = await sshExec(
            connection,
            `docker events --since 5m --until 0s --filter "type=container" --filter "event=die" --filter "event=oom" --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' 2>/dev/null | tail -10`,
          );
          if (result.stdout.trim()) {
            printRaw(result.stdout);
          } else {
            printInfo('No recent container deaths');
          }
        } catch {
          printInfo('Could not retrieve Docker events');
        }
      }

      // ── System resources ─────────────────────────────────────────────────
      printSection('System Resources');

      try {
        const df = await sshExec(connection, `df -h / | tail -1 | awk '{print $5}'`);
        const diskPct = parseInt(df.stdout.trim().replace('%', ''));
        if (diskPct >= 90) {
          printWarning(`Disk usage: ${colors.error(df.stdout.trim())}`);
          issues.push({ severity: 'error', category: 'System', message: `Disk at ${diskPct}%`, suggestion: `Run 'dockflow prune ${env}'` });
        } else if (diskPct >= 80) {
          printWarning(`Disk usage: ${colors.warning(df.stdout.trim())}`);
          issues.push({ severity: 'warning', category: 'System', message: `Disk at ${diskPct}%` });
        } else {
          printInfo(`Disk usage: ${colors.success(df.stdout.trim())}`);
        }
      } catch {
        printInfo('Could not check disk space');
      }

      try {
        const mem = await sshExec(connection, `free -m | awk 'NR==2{printf "%.0f", $3*100/$2}'`);
        const memPct = parseInt(mem.stdout.trim());
        if (memPct >= 90) {
          printError(`Memory usage: ${memPct}%`);
          issues.push({ severity: 'warning', category: 'System', message: `Memory at ${memPct}%`, suggestion: 'High usage may prevent containers from starting' });
        } else if (memPct >= 80) {
          printWarning(`Memory usage: ${memPct}%`);
        } else {
          printInfo(`Memory usage: ${memPct}%`);
        }
      } catch {
        printInfo('Could not check memory usage');
      }

      printDiagnosticSummary(issues);
    })));
}

function printDiagnosticSummary(issues: DiagnosticIssue[]): void {
  printBlank();
  printSection('Summary');

  const errors   = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    printSuccess('No issues detected — stack appears healthy.');
    return;
  }

  for (const { label, list, color } of [
    { label: 'Errors',   list: errors,   color: colors.error },
    { label: 'Warnings', list: warnings, color: colors.warning },
  ] as const) {
    if (list.length === 0) continue;
    printRaw(`  ${color(label)}: ${list.length}`);
    for (const issue of list) {
      printRaw(`    ${color('•')} ${issue.message}`);
      if (issue.suggestion) {
        printRaw(`      ${colors.dim('→')} ${colors.info(issue.suggestion)}`);
      }
    }
  }

  printBlank();
}
