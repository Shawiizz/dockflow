/**
 * Diagnose command - Diagnose deployment issues
 * 
 * Analyzes stack status, failed tasks, and common problems
 * to help identify why containers aren't starting.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { sshExec } from '../../utils/ssh';
import { printSection, printHeader, printInfo, printError, printSuccess, printWarning, printDebug } from '../../utils/output';
import { validateEnv } from '../../utils/validation';
import { createStackService } from '../../services';
import { DockerError, withErrorHandler } from '../../utils/errors';

interface DiagnosticIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  suggestion?: string;
}

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose <env>')
    .description('Diagnose deployment issues and show why containers may not be starting')
    .option('-s, --server <name>', 'Target server (defaults to first server for environment)')
    .option('-v, --verbose', 'Show all diagnostic details')
    .action(withErrorHandler(async (env: string, options: { server?: string; verbose?: boolean }) => {
      const { stackName, connection, serverName } = validateEnv(env, options.server);
      printDebug('Connection validated', { stackName, serverName });

      printHeader(`Diagnosing: ${stackName}`);
      console.log('');

      const issues: DiagnosticIssue[] = [];
      const stackService = createStackService(connection, stackName);

      // 1. Check if stack exists
      printSection('Stack Status');
      const stackExists = await stackService.exists();
      if (!stackExists) {
        printError('Stack does not exist');
        issues.push({
          severity: 'error',
          category: 'Stack',
          message: 'Stack not found',
          suggestion: `Run 'dockflow deploy ${env}' to deploy the stack`
        });
        printDiagnosticSummary(issues);
        return;
      }
      printSuccess('Stack exists');

      // 2. Get services and check replicas
      printSection('Services');
      const servicesResult = await stackService.getServices();
      if (!servicesResult.success) {
        printError(`Failed to get services: ${servicesResult.error.message}`);
      } else {
        for (const service of servicesResult.data) {
          const [current, desired] = service.replicas.split('/').map(s => parseInt(s.trim()));
          if (current === 0 && desired > 0) {
            console.log(`  ${chalk.red('✗')} ${service.name}: ${chalk.red(service.replicas)} replicas`);
            issues.push({
              severity: 'error',
              category: 'Replicas',
              message: `Service '${service.name}' has 0/${desired} replicas running`,
              suggestion: 'Check task errors below for details'
            });
          } else if (current < desired) {
            console.log(`  ${chalk.yellow('!')} ${service.name}: ${chalk.yellow(service.replicas)} replicas`);
            issues.push({
              severity: 'warning',
              category: 'Replicas',
              message: `Service '${service.name}' has only ${current}/${desired} replicas`,
            });
          } else {
            console.log(`  ${chalk.green('✓')} ${service.name}: ${chalk.green(service.replicas)} replicas`);
          }
        }
      }

      // 3. Get failed tasks
      printSection('Task Errors');
      const tasksResult = await stackService.getTasks();
      if (tasksResult.success) {
        const failedTasks = tasksResult.data.filter(t => 
          t.currentState.includes('Failed') || 
          t.currentState.includes('Rejected') ||
          t.error
        );

        // Get recent task history (including shutdown/failed)
        const recentFailures = tasksResult.data
          .filter(t => t.error || t.currentState.includes('Failed'))
          .slice(0, 10);

        if (recentFailures.length === 0) {
          printSuccess('No task errors found');
        } else {
          for (const task of recentFailures) {
            console.log(`  ${chalk.red('✗')} ${task.name}`);
            console.log(`    State: ${chalk.yellow(task.currentState)}`);
            if (task.error) {
              console.log(`    Error: ${chalk.red(task.error)}`);
              
              // Parse common errors
              const errorAnalysis = analyzeTaskError(task.error);
              issues.push({
                severity: 'error',
                category: 'Task',
                message: `${task.name}: ${task.error}`,
                suggestion: errorAnalysis.suggestion
              });
            }
            console.log('');
          }
        }
      }

      // 4. Check for pending/preparing tasks
      printSection('Pending Tasks');
      if (tasksResult.success) {
        const pendingTasks = tasksResult.data.filter(t => 
          t.currentState.includes('Pending') || 
          t.currentState.includes('Preparing') ||
          t.currentState.includes('Starting')
        );

        if (pendingTasks.length === 0) {
          printInfo('No pending tasks');
        } else {
          for (const task of pendingTasks) {
            console.log(`  ${chalk.yellow('○')} ${task.name}: ${task.currentState}`);
          }
          if (pendingTasks.some(t => t.currentState.includes('Pending'))) {
            issues.push({
              severity: 'warning',
              category: 'Scheduling',
              message: 'Some tasks are pending',
              suggestion: 'This may indicate resource constraints or scheduling issues'
            });
          }
        }
      }

      // 5. Check Docker events for recent errors
      if (options.verbose) {
        printSection('Recent Docker Events');
        try {
          const eventsResult = sshExec(
            connection,
            `docker events --since 5m --until 0s --filter "type=container" --filter "event=die" --filter "event=oom" --format '{{.Time}} {{.Actor.Attributes.name}} {{.Action}}' 2>/dev/null | tail -10`
          );
          if (eventsResult.stdout.trim()) {
            console.log(eventsResult.stdout);
          } else {
            printInfo('No recent container deaths');
          }
        } catch {
          printInfo('Could not retrieve Docker events');
        }
      }

      // 6. Check disk space
      printSection('System Resources');
      try {
        const dfResult = sshExec(connection, `df -h / | tail -1 | awk '{print $5}'`);
        const diskUsage = parseInt(dfResult.stdout.trim().replace('%', ''));
        if (diskUsage >= 90) {
          console.log(`  Disk usage: ${chalk.red(dfResult.stdout.trim())}`);
          issues.push({
            severity: 'error',
            category: 'System',
            message: `Disk usage is at ${diskUsage}%`,
            suggestion: `Run 'dockflow prune ${env}' to clean up unused Docker resources`
          });
        } else if (diskUsage >= 80) {
          console.log(`  Disk usage: ${chalk.yellow(dfResult.stdout.trim())}`);
          issues.push({
            severity: 'warning',
            category: 'System',
            message: `Disk usage is at ${diskUsage}%`,
            suggestion: 'Consider cleaning up unused Docker resources'
          });
        } else {
          console.log(`  Disk usage: ${chalk.green(dfResult.stdout.trim())}`);
        }
      } catch {
        printInfo('Could not check disk space');
      }

      // 7. Check memory
      try {
        const memResult = sshExec(connection, `free -m | awk 'NR==2{printf "%.0f", $3*100/$2}'`);
        const memUsage = parseInt(memResult.stdout.trim());
        if (memUsage >= 90) {
          console.log(`  Memory usage: ${chalk.red(memUsage + '%')}`);
          issues.push({
            severity: 'warning',
            category: 'System',
            message: `Memory usage is at ${memUsage}%`,
            suggestion: 'High memory usage may prevent containers from starting'
          });
        } else if (memUsage >= 80) {
          console.log(`  Memory usage: ${chalk.yellow(memUsage + '%')}`);
        } else {
          console.log(`  Memory usage: ${chalk.green(memUsage + '%')}`);
        }
      } catch {
        printInfo('Could not check memory usage');
      }

      // Print summary
      printDiagnosticSummary(issues);
    }));
}

/**
 * Analyze common task errors and provide suggestions
 */
function analyzeTaskError(error: string): { type: string; suggestion: string } {
  const errorLower = error.toLowerCase();

  if (errorLower.includes('bind source path does not exist')) {
    const pathMatch = error.match(/bind source path does not exist: ([^\s]+)/i);
    const path = pathMatch ? pathMatch[1] : 'the specified path';
    return {
      type: 'volume_missing',
      suggestion: `Create the directory on the server: mkdir -p ${path}`
    };
  }

  if (errorLower.includes('no such image') || errorLower.includes('image not found')) {
    return {
      type: 'image_missing',
      suggestion: 'The Docker image may not have been pushed. Try redeploying.'
    };
  }

  if (errorLower.includes('port is already allocated') || errorLower.includes('address already in use')) {
    return {
      type: 'port_conflict',
      suggestion: 'Another service is using this port. Check running containers with: docker ps'
    };
  }

  if (errorLower.includes('oom') || errorLower.includes('out of memory')) {
    return {
      type: 'oom',
      suggestion: 'Container ran out of memory. Increase memory limits or reduce memory usage.'
    };
  }

  if (errorLower.includes('permission denied')) {
    return {
      type: 'permission',
      suggestion: 'Check file/directory permissions on mounted volumes'
    };
  }

  if (errorLower.includes('no space left on device')) {
    return {
      type: 'disk_full',
      suggestion: `Clean up disk space: dockflow prune <env> or docker system prune`
    };
  }

  if (errorLower.includes('exec format error')) {
    return {
      type: 'arch_mismatch',
      suggestion: 'Image architecture does not match server. Rebuild for correct platform (linux/amd64 or linux/arm64)'
    };
  }

  if (errorLower.includes('network') && errorLower.includes('not found')) {
    return {
      type: 'network_missing',
      suggestion: 'Docker network may have been removed. Try redeploying the stack.'
    };
  }

  return {
    type: 'unknown',
    suggestion: 'Check Docker logs for more details: docker service logs <service_name>'
  };
}

/**
 * Print diagnostic summary with issues found
 */
function printDiagnosticSummary(issues: DiagnosticIssue[]): void {
  console.log('');
  printSection('Diagnostic Summary');

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    printSuccess('No issues detected. Stack appears healthy.');
    return;
  }

  if (errors.length > 0) {
    console.log(`  ${chalk.red('Errors:')} ${errors.length}`);
    for (const issue of errors) {
      console.log(`    ${chalk.red('•')} ${issue.message}`);
      if (issue.suggestion) {
        console.log(`      ${chalk.gray('→')} ${chalk.cyan(issue.suggestion)}`);
      }
    }
  }

  if (warnings.length > 0) {
    console.log(`  ${chalk.yellow('Warnings:')} ${warnings.length}`);
    for (const issue of warnings) {
      console.log(`    ${chalk.yellow('•')} ${issue.message}`);
      if (issue.suggestion) {
        console.log(`      ${chalk.gray('→')} ${chalk.cyan(issue.suggestion)}`);
      }
    }
  }

  console.log('');
}
