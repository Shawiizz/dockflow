/**
 * `dockflow diagnose <env>` (design-06 3.10): prints `StackBackend.diagnose`'s report. The backend
 * builds the sections and issues (Swarm and Kubernetes alike, core `DiagnosticReport`); this command
 * only owns the symbol/color mapping of each line's level and the summary, so both orchestrators
 * read the same way (CHANGED: works on k3s, the earlier Swarm-only refusal is gone).
 */

import type { Command } from 'commander';
import type { DiagnosticIssue, DiagnosticLineLevel } from '../../services/orchestrator/interfaces';
import { withServicesRequired } from '../../utils/errors';
import { colors, printBlank, printIntro, printRaw, printSection } from '../../utils/output';
import { withResolvedEnv } from '../../utils/validation';
import { openDay2 } from '../shared/day2';

export interface DiagnoseCommandOptions {
  server?: string;
  verbose?: boolean;
}

function renderLine(text: string, level: DiagnosticLineLevel): string {
  switch (level) {
    case 'ok':
      return colors.success(`✓ ${text}`);
    case 'warning':
      return colors.warning(`! ${text}`);
    case 'error':
      return colors.error(`✗ ${text}`);
    case 'pending':
      return colors.info(`○ ${text}`);
    case 'dim':
      return colors.dim(`· ${text}`);
    case 'plain':
      return text;
  }
}

function printDiagnosticSummary(issues: readonly DiagnosticIssue[]): void {
  printBlank();
  printSection('Summary');

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  if (errors.length === 0 && warnings.length === 0) {
    printRaw(colors.success('  No issues detected — stack appears healthy.'));
    return;
  }

  for (const { label, list, paint } of [
    { label: 'Errors', list: errors, paint: colors.error },
    { label: 'Warnings', list: warnings, paint: colors.warning },
  ] as const) {
    if (list.length === 0) continue;
    printRaw(`  ${paint(label)}: ${list.length}`);
    for (const issue of list) {
      printRaw(`    ${paint('•')} ${issue.message}`);
      if (issue.suggestion) printRaw(`      ${colors.dim('→')} ${colors.info(issue.suggestion)}`);
    }
  }
  printBlank();
}

export async function runDiagnose(env: string, options: DiagnoseCommandOptions): Promise<void> {
  const ctx = await openDay2(env, { server: options.server });
  printIntro(`Diagnosing: ${ctx.stackName}`);
  printBlank();

  const report = await ctx.orchestrator.stack.diagnose(ctx.appRef, { verbose: Boolean(options.verbose) });

  for (const section of report.sections) {
    printSection(section.title);
    for (const line of section.lines) printRaw(`  ${renderLine(line.text, line.level)}`);
  }

  printDiagnosticSummary(report.issues);
}

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose <env>')
    .description('Diagnose deployment issues and show why services may not be starting')
    .helpGroup('Inspect')
    .option('-s, --server <name>', 'Target manager (defaults to the first ready manager)')
    .option('-v, --verbose', 'Show all diagnostic details')
    .action(withServicesRequired(withResolvedEnv(runDiagnose)));
}
