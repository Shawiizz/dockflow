/**
 * Output formatting utilities
 * Unified output module for CLI feedback and debug logging
 */

import chalk from 'chalk';
import * as clack from '@clack/prompts';

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

// === JSON mode (suppress all output except printJSON/printRaw) ===
let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
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

// === User feedback ===
export function printSuccess(message: string): void {
  if (jsonMode) return;
  clack.log.success(message);
}

export function printError(message: string): void {
  if (jsonMode) return;
  process.stderr.write(colors.error(`  ✘  ${message}`) + '\n');
}

export function printWarning(message: string): void {
  if (jsonMode) return;
  clack.log.warn(message);
}

export function printInfo(message: string): void {
  if (jsonMode) return;
  clack.log.info(message);
}

// === Debug output (verbose mode only) ===
export function printDebug(message: string, context?: Record<string, unknown>): void {
  if (jsonMode || !isVerbose()) return;
  
  let output = colors.dim(`[debug] ${message}`);
  if (context && Object.keys(context).length > 0) {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    output += colors.dim(` (${contextStr})`);
  }
  console.log(output);
}

// === Sections & headers ===
export function printSection(title: string): void {
  if (jsonMode) return;
  clack.log.step(title);
}

// === Formatters ===

/**
 * Format duration in seconds to human readable
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// === Table & formatting helpers ===

/**
 * Print a horizontal separator line
 */
export function printSeparator(length: number = 50): void {
  if (jsonMode) return;
  console.log(colors.dim('─'.repeat(length)));
}

/**
 * Print a dim/muted message
 */
export function printDim(message: string): void {
  if (jsonMode) return;
  console.log(colors.dim(message));
}

/**
 * Print a key-value pair for table-like output
 */
export function printTableRow(label: string, value: string, labelWidth: number = 20): void {
  if (jsonMode) return;
  console.log(`  ${colors.bold(label.padEnd(labelWidth))} ${value}`);
}

/**
 * Print a blank line
 */
export function printBlank(): void {
  if (jsonMode) return;
  console.log('');
}

/**
 * Print JSON data (pretty-printed)
 */
export function printJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print raw text (passthrough output)
 */
export function printRaw(text: string): void {
  console.log(text);
}

/**
 * Format bytes into a human-readable string (e.g. "12.5 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format an ISO timestamp as a human-readable relative time (e.g. "5m ago", "3d ago")
 */
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

// === @clack visual helpers ===

/**
 * Display a styled intro banner (clack-style)
 */
export function printIntro(title: string): void {
  if (jsonMode) return;
  clack.intro(colors.bold(title));
}

/**
 * Display a styled outro message
 */
export function printOutro(message: string): void {
  if (jsonMode) return;
  clack.outro(message);
}

/**
 * Display a boxed note section
 */
export function printNote(message: string, title?: string): void {
  if (jsonMode) return;
  clack.note(message, title);
}

/**
 * Create a clack taskLog for streaming subprocess output.
 * Rolling window of `limit` lines, clears on success, keeps full log on error.
 */
export function createTaskLog(title: string, limit: number = 5) {
  return clack.taskLog({ title, limit });
}

/**
 * Create a clack spinner with ora-compatible API
 * stop()    → success (◆)
 * cancel()  → warning (◼)
 * error()   → failure (✘)
 * message() → update mid-spin
 */
export function createSpinner() {
  const s = clack.spinner();
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

