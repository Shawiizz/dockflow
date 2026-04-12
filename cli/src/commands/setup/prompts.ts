/**
 * Interactive prompts for setup commands
 */

import {
  textPrompt,
  passwordPrompt,
  confirmPrompt,
  selectPrompt,
  multilinePrompt as centralMultilinePrompt,
} from '../../utils/prompts';

/**
 * Prompt for input with default value
 */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  return textPrompt({
    message: question,
    defaultValue,
  });
}

/**
 * Prompt for password (hidden input)
 */
export async function promptPassword(question: string): Promise<string> {
  return passwordPrompt({
    message: question,
  });
}

/**
 * Prompt for yes/no confirmation
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  return confirmPrompt({
    message: question,
    initialValue: defaultYes,
  });
}

/**
 * Interactive menu selection with arrow keys
 * Returns the selected index (0-based)
 */
export async function selectMenu(title: string, options: string[]): Promise<number> {
  return selectPrompt<number>({
    message: title,
    options: options.map((label, idx) => ({ value: idx, label })),
    initialValue: 0,
  });
}

/**
 * Prompt for multiline input (for SSH key pasting)
 */
export async function promptMultiline(): Promise<string> {
  return centralMultilinePrompt({
    message: 'Paste your content below:',
  });
}
