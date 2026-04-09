/**
 * Centralized interactive prompts module
 * Wraps @clack/prompts for a modern, Claude Code-like CLI experience
 */

import * as clack from '@clack/prompts';
import * as readline from 'readline';

/**
 * Handle user cancellation (Ctrl+C) during a prompt
 */
function handleCancel(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }
}

/**
 * Text input prompt
 */
export async function textPrompt(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (value: string) => string | void;
}): Promise<string> {
  if (!process.stdin.isTTY) {
    return opts.defaultValue ?? '';
  }

  const value = await clack.text({
    message: opts.message,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    validate: opts.validate as ((value: string | undefined) => string | Error | undefined) | undefined,
  });

  handleCancel(value);
  return value as string;
}

/**
 * Password input prompt (hidden)
 */
export async function passwordPrompt(opts: {
  message: string;
  validate?: (value: string) => string | void;
}): Promise<string> {
  if (!process.stdin.isTTY) {
    return '';
  }

  const value = await clack.password({
    message: opts.message,
    validate: opts.validate as ((value: string | undefined) => string | Error | undefined) | undefined,
  });

  handleCancel(value);
  return value as string;
}

/**
 * Yes/no confirmation prompt
 */
export async function confirmPrompt(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return opts.initialValue ?? false;
  }

  const value = await clack.confirm({
    message: opts.message,
    initialValue: opts.initialValue ?? true,
  });

  handleCancel(value);
  return value as boolean;
}

/**
 * Select prompt with arrow key navigation
 */
export async function selectPrompt<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValue?: T;
}): Promise<T> {
  if (!process.stdin.isTTY) {
    return opts.options[0].value;
  }

  const value = await clack.select({
    message: opts.message,
    options: opts.options as any,
    initialValue: opts.initialValue,
  });

  handleCancel(value);
  return value as T;
}

/**
 * Dangerous confirmation prompt — requires typing exact text to confirm
 */
export async function dangerousConfirmPrompt(opts: {
  message: string;
  expectedText: string;
}): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const value = await clack.text({
    message: opts.message,
    placeholder: opts.expectedText,
    validate: (input: string | undefined) => {
      if (input !== opts.expectedText) {
        return `Please type "${opts.expectedText}" to confirm`;
      }
    },
  });

  handleCancel(value);
  return value === opts.expectedText;
}

/**
 * Multi-line input prompt (for SSH key pasting etc.)
 * Uses custom readline since @clack/prompts doesn't support multi-line
 */
export async function multilinePrompt(opts: {
  message: string;
}): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  clack.log.info(opts.message);
  clack.log.info('Press Enter twice to finish.');

  const lines: string[] = [];
  let emptyLineCount = 0;

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (line === '') {
        emptyLineCount++;
        if (emptyLineCount >= 2) {
          rl.close();
          resolve(lines.join('\n'));
          return;
        }
      } else {
        emptyLineCount = 0;
      }
      lines.push(line);
    });

    rl.on('close', () => {
      resolve(lines.join('\n'));
    });
  });
}

// Re-export @clack visual helpers
export const intro = clack.intro;
export const outro = clack.outro;
export const note = clack.note;
export const log = clack.log;
export const spinner = clack.spinner;
