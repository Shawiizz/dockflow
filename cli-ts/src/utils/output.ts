/**
 * Output formatting utilities
 */

import chalk from 'chalk';

export const colors = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,
  dim: chalk.gray,
  bold: chalk.bold,
};

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
