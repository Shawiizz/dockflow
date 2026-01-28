/**
 * Interactive prompts utilities
 */

import * as readline from 'readline';
import { colors } from '../../utils/output';

/**
 * Create readline interface
 */
export function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Prompt for input with default value
 */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createRL();
  const defaultStr = defaultValue ? ` [${defaultValue}]` : '';

  return new Promise((resolve) => {
    rl.question(`${colors.info(question)}${defaultStr}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for password (hidden input)
 */
export async function promptPassword(question: string): Promise<string> {
  const rl = createRL();

  return new Promise((resolve) => {
    process.stdout.write(`${colors.info(question)}: `);

    const stdin = process.stdin;
    const oldRawMode = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let password = '';

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) {
          stdin.setRawMode(oldRawMode ?? false);
        }
        process.stdout.write('\n');
        rl.close();
        resolve(password);
      } else if (c === '\u0003') {
        process.exit(1);
      } else if (c === '\u007F' || c === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += c;
      }
    };

    stdin.on('data', onData);
    stdin.resume();
  });
}

/**
 * Prompt for yes/no confirmation
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const defaultStr = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(`${question} (${defaultStr})`);

  if (!answer) {
    return defaultYes;
  }

  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * Interactive menu selection
 */
export async function selectMenu(title: string, options: string[]): Promise<number> {
  console.log('');
  console.log(colors.info(title));

  options.forEach((opt, idx) => {
    console.log(`  ${colors.warning(`${idx + 1})`)} ${opt}`);
  });

  const answer = await prompt('Select option', '1');
  const idx = parseInt(answer, 10) - 1;

  if (idx >= 0 && idx < options.length) {
    return idx;
  }

  return 0;
}

/**
 * Prompt for multiline input (for SSH key pasting)
 */
export async function promptMultiline(): Promise<string> {
  const rl = createRL();
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
