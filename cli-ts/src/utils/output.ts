/**
 * Output formatting utilities
 * Unified output module for CLI feedback and debug logging
 *
 * Convention (Unix standard, same as gh/kubectl):
 *   stdout → data only (printJSON, printRaw)
 *   stderr → everything decorative (status, warnings, spinners, etc.)
 *
 * This separation alone keeps stdout clean for --json piping.
 * No need for jsonMode guards — tools only read stdout.
 */

import chalk from 'chalk';
import * as clack from '@clack/prompts';

// Shared clack option to route decorative output to stderr
const STDERR_OPTS = { output: process.stderr } as const;

// === Verbose mode ===
let verboseMode = false;

export function setVerbose(enabled: boolean): void {
  verboseMode = enabled;
  if (enabled) {
    process.env.VERBOSE = 'true';
  }
}

export function isVerbose(): boolean {
  return verboseMode || process.env.VERBOSE === 'true' || process.env.DEBUG === 'true';
}

// === Colors ===
export const colors = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,
  dim: chalk.gray,
  bold: chalk.bold,
  primary: chalk.blue,
};

// Helper: write a line to stderr
function stderrLine(text: string): void {
  process.stderr.write(text + '\n');
}

// === User feedback (stderr) ===
export function printSuccess(message: string): void {
  clack.log.success(message, STDERR_OPTS);
}

export function printError(message: string): void {
  stderrLine(colors.error(`  ✘  ${message}`));
}

export function printWarning(message: string): void {
  clack.log.warn(message, STDERR_OPTS);
}

export function printInfo(message: string): void {
  clack.log.info(message, STDERR_OPTS);
}

// === Debug output (verbose mode only, stderr) ===
export function printDebug(message: string, context?: Record<string, unknown>): void {
  if (!isVerbose()) return;

  let output = colors.dim(`[debug] ${message}`);
  if (context && Object.keys(context).length > 0) {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    output += colors.dim(` (${contextStr})`);
  }
  stderrLine(output);
}

// === Sections & headers (stderr) ===
export function printSection(title: string): void {
  clack.log.step(title, STDERR_OPTS);
}

// === Formatters ===

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// === Table & formatting helpers (stderr) ===

export function printSeparator(length: number = 50): void {
  stderrLine(colors.dim('─'.repeat(length)));
}

export function printDim(message: string): void {
  stderrLine(colors.dim(message));
}

export function printTableRow(label: string, value: string, labelWidth: number = 20): void {
  stderrLine(`  ${colors.bold(label.padEnd(labelWidth))} ${value}`);
}

export function printBlank(): void {
  stderrLine('');
}

// === Data output (stdout — never suppressed) ===

export function printJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printRaw(text: string): void {
  console.log(text);
}

// === Value formatters ===

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// === @clack visual helpers (stderr) ===

export function printIntro(title: string): void {
  clack.intro(colors.bold(title), STDERR_OPTS);
}

export function printOutro(message: string): void {
  clack.outro(message, STDERR_OPTS);
}

export function printNote(message: string, title?: string): void {
  clack.note(message, title, STDERR_OPTS);
}

export function createTaskLog(title: string, limit: number = 5) {
  return clack.taskLog({ title, limit, output: process.stderr });
}

export function createSpinner() {
  const s = clack.spinner({ output: process.stderr });
  return {
    start:   (msg: string)   => s.start(msg),
    succeed: (msg: string)   => s.stop(msg),
    fail:    (msg: string)   => s.error(msg),
    warn:    (msg: string)   => s.cancel(msg),
    info:    (msg: string)   => s.stop(msg),
    stop:    (msg?: string)  => s.stop(msg),
    update:  (msg: string)   => s.message(msg),
    set text(msg: string)    { s.message(msg); },
  };
}

/**
 * Create a spinner with a built-in elapsed time indicator (e.g. "[5s]", "[1m 30s]").
 * Uses @clack/prompts native `indicator: 'timer'` mode.
 */
export function createTimedSpinner() {
  const s = clack.spinner({ output: process.stderr, indicator: 'timer' });
  return {
    start:   (msg: string)   => s.start(msg),
    succeed: (msg: string)   => s.stop(msg),
    fail:    (msg: string)   => s.error(msg),
    warn:    (msg: string)   => s.cancel(msg),
    info:    (msg: string)   => s.stop(msg),
    stop:    (msg?: string)  => s.stop(msg),
    update:  (msg: string)   => s.message(msg),
  };
}
