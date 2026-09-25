// U-DOCS-04 (design-07 14.3): every command path and long option registered with Commander appears
// in docs/app/en/cli/page.mdx. The live surface is built the same way cli/src/index.ts does (same
// register*Command calls, same order) minus the `.parse()` call, so a renamed or added flag is
// caught here without needing to keep a second, hand-written list in sync.
//
// docs/cli-undocumented.json is the allowlist of entries the page is not required to carry, and it
// may only shrink: an allowlisted entry the page now documents fails the test, which is the signal
// to remove it from the file. A hidden option (`.hideHelp()`, e.g. setup's internal
// `--k3s-plan`/`--binary`) is never part of the required surface at all — publishing it would defeat
// hiding it, so the allowlist has no business naming one.

import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerAccessoriesCommands } from '../../../commands/accessories';
import { registerAppCommands } from '../../../commands/app/index';
import { registerBackupCommands } from '../../../commands/backup';
import { registerBuildCommand } from '../../../commands/build';
import { registerCompletionCommand } from '../../../commands/completion';
import { registerConfigCommand } from '../../../commands/config';
import { registerDeployCommand } from '../../../commands/deploy';
import { registerHelmCommands } from '../../../commands/helm';
import { registerInitCommand } from '../../../commands/init';
import { registerListCommands } from '../../../commands/list';
import { registerLockCommands } from '../../../commands/lock';
import { registerPluginsCommands } from '../../../commands/plugins';
import { registerSetupCommand } from '../../../commands/setup';
import { registerUICommand } from '../../../commands/ui';
import { registerValidateCommand } from '../../../commands/validate';
import { registerVolumesCommands } from '../../../commands/volumes';

const REPO_DIR = resolve(import.meta.dir, '..', '..', '..', '..', '..');
const CLI_PAGE = join(REPO_DIR, 'docs', 'app', 'en', 'cli', 'page.mdx');
const ALLOWLIST_PATH = join(import.meta.dir, '..', 'docs', 'cli-undocumented.json');

interface Allowlist {
  /** full `dockflow ...` command paths the page is not required to spell out */
  commands: string[];
  /** bare long flags (e.g. `--dry-run`) the page is not required to mention */
  options: string[];
}

/** Builds the exact program cli/src/index.ts assembles, without the process-parsing `.parse()` call. */
function buildProgram(): Command {
  const program = new Command();
  program
    .name('dockflow')
    .option('-v, --version', 'Show version information')
    .option('--no-color', 'Disable colored output')
    .option('--verbose', 'Enable verbose/debug output');

  registerAppCommands(program);
  registerAccessoriesCommands(program);
  registerBackupCommands(program);
  registerLockCommands(program);
  registerListCommands(program);
  registerVolumesCommands(program);
  registerHelmCommands(program);
  registerPluginsCommands(program);
  registerConfigCommand(program);
  registerDeployCommand(program);
  registerBuildCommand(program);
  registerSetupCommand(program);
  registerInitCommand(program);
  registerUICommand(program);
  registerValidateCommand(program);
  registerCompletionCommand(program);
  return program;
}

interface Surface {
  /** every `dockflow <path...>` command and subcommand, `help` excluded */
  commandPaths: string[];
  /** every non-hidden long flag registered anywhere, deduplicated (`--json` documented once covers every command) */
  options: string[];
}

function surfaceOf(program: Command): Surface {
  const commandPaths: string[] = [];
  const options = new Set<string>();

  const collect = (cmd: Command): void => {
    for (const option of cmd.options) {
      if (option.hidden || !option.long) continue;
      options.add(option.long);
    }
  };

  const walk = (cmd: Command, prefix: string): void => {
    const path = `${prefix} ${cmd.name()}`;
    commandPaths.push(path);
    collect(cmd);
    for (const sub of cmd.commands) {
      if (sub.name() === 'help') continue;
      walk(sub, path);
    }
  };

  collect(program);
  for (const cmd of program.commands) {
    if (cmd.name() === 'help') continue;
    walk(cmd, 'dockflow');
  }
  return { commandPaths, options: [...options].sort() };
}

/** Escapes a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-token match: `--all` must not match inside `--all-tasks`, nor `--port` inside `--portainer-port`. */
function pageHasFlag(page: string, flag: string): boolean {
  return new RegExp(`(?<![\\w-])${escapeRegExp(flag)}(?![\\w-])`).test(page);
}

describe('U-DOCS-04 CLI reference sync', () => {
  const program = buildProgram();
  const surface = surfaceOf(program);
  const page = readFileSync(CLI_PAGE, 'utf8');
  const allowlist: Allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));

  test('the live CLI registers at least one command and one option (sanity)', () => {
    expect(surface.commandPaths.length).toBeGreaterThan(10);
    expect(surface.options.length).toBeGreaterThan(10);
  });

  test('the allowlist only shrinks: every entry is still live and still undocumented', () => {
    for (const path of allowlist.commands) {
      expect(surface.commandPaths, `${path} is allowlisted but is no longer a live command path`).toContain(path);
      expect(page.includes(path), `${path} is allowlisted as undocumented but the page now documents it; remove it from ${ALLOWLIST_PATH}`).toBe(
        false,
      );
    }
    for (const flag of allowlist.options) {
      expect(surface.options, `${flag} is allowlisted but no longer a live option`).toContain(flag);
      expect(pageHasFlag(page, flag), `${flag} is allowlisted as undocumented but the page now documents it; remove it from ${ALLOWLIST_PATH}`).toBe(
        false,
      );
    }
  });

  test('every command path is documented or allowlisted', () => {
    const missing = surface.commandPaths.filter((path) => !allowlist.commands.includes(path) && !page.includes(path));
    expect(missing, `Add these command paths to ${CLI_PAGE}, or to the allowlist.`).toEqual([]);
  });

  test('every long option is documented or allowlisted', () => {
    const missing = surface.options.filter((flag) => !allowlist.options.includes(flag) && !pageHasFlag(page, flag));
    expect(missing, `Add these options to ${CLI_PAGE}, or to the allowlist.`).toEqual([]);
  });

  test('a hidden option is never required, even if it were also allowlisted', () => {
    const hidden = ['--k3s-plan', '--binary'];
    for (const flag of hidden) {
      expect(surface.options, `${flag} should stay hidden (.hideHelp()), not part of the required surface`).not.toContain(flag);
    }
  });
});
