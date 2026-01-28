/**
 * Output formatting utilities
 * Unified output module for CLI feedback and debug logging
 */

import chalk from 'chalk';

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

// === User feedback ===
export function printSuccess(message: string): void {
  console.log(colors.success(`✓ ${message}`));
}

export function printError(message: string): void {
  console.error(colors.error(`✗ ${message}`));
}

export function printWarning(message: string): void {
  console.log(colors.warning(`⚠ ${message}`));
}

export function printInfo(message: string): void {
  console.log(colors.info(`→ ${message}`));
}

export function printStep(message: string): void {
  console.log(colors.info(`➜ ${message}`));
}

// === Debug output (verbose mode only) ===
export function printDebug(message: string, context?: Record<string, unknown>): void {
  if (!isVerbose()) return;
  
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
export function printHeader(title: string): void {
  const line = '='.repeat(56);
  console.log(colors.success(line));
  console.log(colors.success(`   ${title}`));
  console.log(colors.success(line));
}

export function printSection(title: string): void {
  console.log('');
  console.log(colors.info(`=== ${title} ===`));
}

export function printKeyValue(key: string, value: string): void {
  console.log(`${colors.dim(key + ':')} ${value}`);
}

// === Formatters ===

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

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

/**
 * Format duration in milliseconds to human readable
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return formatDuration(Math.round(ms / 1000));
}

// === Table & formatting helpers ===

/**
 * Print a horizontal separator line
 */
export function printSeparator(length: number = 50): void {
  console.log(colors.dim('─'.repeat(length)));
}

/**
 * Print a section title (bold cyan)
 */
export function printSectionTitle(title: string): void {
  console.log(colors.info(colors.bold(title)));
}

/**
 * Print a dim/muted message
 */
export function printDim(message: string): void {
  console.log(colors.dim(message));
}

/**
 * Print a key-value pair for table-like output
 */
export function printTableRow(label: string, value: string, labelWidth: number = 20): void {
  console.log(`  ${colors.bold(label.padEnd(labelWidth))} ${value}`);
}

/**
 * Print a status badge with icon
 */
export function printStatusBadge(status: 'success' | 'error' | 'warning' | 'info', text: string): string {
  const icons = { success: '✓', error: '✗', warning: '↩', info: '→' };
  const colorFn = colors[status];
  return colorFn(`${icons[status]} ${text}`);
}

