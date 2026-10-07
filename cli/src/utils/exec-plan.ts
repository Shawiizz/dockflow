/**
 * How `dockflow exec` runs what it is given: an interactive shell, or a command with the TTY and
 * stdin the two ends allow. Pure, so the whole matrix is tested without a terminal.
 */

import { ValidationError } from './errors';

export interface ExecRequest {
  /** passed to `docker exec` as separate, quoted arguments */
  argv: string[];
  /** allocate a TTY (`-it`) */
  tty: boolean;
  /** forward this process's stdin (`-i`) */
  stdin: boolean;
  workdir?: string;
  user?: string;
  env?: Record<string, string>;
}

export type ExecPlan = { mode: 'shell'; shell: 'auto' | '/bin/sh' | '/bin/bash' } | { mode: 'command'; request: ExecRequest };

export interface ExecPlanOptions {
  sh?: boolean;
  workdir?: string;
  env?: readonly string[];
  user?: string;
  noTty?: boolean;
}

/** the subset of `process.stdin`/`process.stdout` planning needs */
export interface ExecStdio {
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

const SHELL_METACHARACTERS = /[\s|&;<>()$`\\"'*?~#]/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELLS: Record<string, '/bin/sh' | '/bin/bash'> = {
  sh: '/bin/sh',
  '/bin/sh': '/bin/sh',
  bash: '/bin/bash',
  '/bin/bash': '/bin/bash',
};

/** `--env KEY=VALUE`, repeatable; the value is never echoed on a bad key. */
export function parseExecEnv(pairs: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (!ENV_KEY.test(key)) {
      throw new ValidationError('--env expects KEY=VALUE with KEY matching [A-Za-z_][A-Za-z0-9_]*', `Fix the key \`${key}\`.`);
    }
    env[key] = eq === -1 ? '' : pair.slice(eq + 1);
  }
  return env;
}

/**
 * No command, or a lone shell name, opens a shell. A single argument holding spaces or shell
 * syntax runs through `sh -c` inside the container (never on the manager); several arguments pass
 * as they are. A TTY only when both ends are terminals; stdin is forwarded with a TTY or when piped.
 */
export function planExec(command: readonly string[], options: ExecPlanOptions, stdio: ExecStdio): ExecPlan {
  if (command.length === 0) return { mode: 'shell', shell: options.sh ? '/bin/sh' : 'auto' };
  if (command.length === 1 && SHELLS[command[0]]) return { mode: 'shell', shell: SHELLS[command[0]] };

  if (options.workdir !== undefined && !options.workdir.startsWith('/')) {
    throw new ValidationError(`--workdir must be an absolute path inside the container: ${options.workdir}`);
  }
  const env = parseExecEnv(options.env);
  const argv = command.length === 1 && SHELL_METACHARACTERS.test(command[0]) ? ['sh', '-c', command[0]] : [...command];
  const tty = !options.noTty && Boolean(stdio.stdin.isTTY) && Boolean(stdio.stdout.isTTY);
  const stdin = tty || !stdio.stdin.isTTY;

  return {
    mode: 'command',
    request: {
      argv,
      tty,
      stdin,
      ...(options.workdir !== undefined ? { workdir: options.workdir } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(options.user !== undefined ? { user: options.user } : {}),
    },
  };
}
