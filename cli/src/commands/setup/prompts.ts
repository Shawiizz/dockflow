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

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  return textPrompt({
    message: question,
    defaultValue,
  });
}

export async function promptPassword(question: string): Promise<string> {
  return passwordPrompt({
    message: question,
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  return confirmPrompt({
    message: question,
    initialValue: defaultYes,
  });
}

export async function selectMenu(title: string, options: string[]): Promise<number> {
  return selectPrompt<number>({
    message: title,
    options: options.map((label, idx) => ({ value: idx, label })),
    initialValue: 0,
  });
}

export async function promptMultiline(): Promise<string> {
  return centralMultilinePrompt({
    message: 'Paste your content below:',
  });
}
