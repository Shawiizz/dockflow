/** Interactive prompts over @clack/prompts. Without a TTY a prompt does not ask: it answers with its default. */

import * as clack from '@clack/prompts';
import type { Option } from '@clack/prompts';
import * as readline from 'readline';

/** A cancelled prompt (Ctrl+C) ends the process with exit code 0. */
function handleCancel(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }
}

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
    placeholder: opts.placeholder ?? opts.defaultValue,
    defaultValue: opts.defaultValue,
    validate: opts.validate as ((value: string | undefined) => string | Error | undefined) | undefined,
  });

  handleCancel(value);
  return value as string;
}

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
    options: opts.options as Option<T>[],
    initialValue: opts.initialValue,
  });

  handleCancel(value);
  return value as T;
}

/** Confirms by typing `expectedText`; without a TTY the answer is no. */
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

/** Multi-line input (an SSH key, say) through readline, which clack cannot do; two empty lines end it. */
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

export async function multiselectPrompt<T>(opts: {
  message: string;
  options: { value: T; label: string; hint?: string }[];
  initialValues?: T[];
  required?: boolean;
}): Promise<T[]> {
  if (!process.stdin.isTTY) {
    return opts.initialValues ?? opts.options.map(o => o.value);
  }

  const value = await clack.multiselect<T>({
    message: opts.message,
    options: opts.options as Option<T>[],
    initialValues: opts.initialValues,
    required: opts.required ?? false,
  });

  handleCancel(value);
  return value as T[];
}

export const intro = clack.intro;
export const outro = clack.outro;
export const note = clack.note;
export const log = clack.log;
export const spinner = clack.spinner;
