import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command, type Option } from 'commander';
import { registerAllCommands } from '../commands/register-all';

// The CLI page documents what the commander program defines: every command and every long option
// appears in the section of its command, and no command or option of the page is gone from the CLI.

const PAGE = readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'app', 'en', 'cli', 'page.mdx'), 'utf8');

/** Commands that exist for the CLI's own help and are not documented */
const UNDOCUMENTED_COMMANDS = new Set(['help']);

/** Commands whose options are spread over several sections: their scope is the whole H2 block */
const WIDE_SCOPE = new Set(['setup']);

const program = new Command();
registerAllCommands(program);

interface Block {
  level: number;
  heading: string;
  lines: string[];
}

function isHidden(command: Command): boolean {
  return (command as unknown as { _hidden?: boolean })._hidden === true;
}

function visibleOptions(command: Command): Option[] {
  return command.options.filter((option) => !option.hidden && option.long);
}

function descendants(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...descendants(child)]);
}

function documentedCommands(parent: Command, path: string[] = []): { command: Command; path: string[] }[] {
  return parent.commands
    .filter((command) => !UNDOCUMENTED_COMMANDS.has(command.name()) && !isHidden(command))
    .flatMap((command) => [{ command, path: [...path, command.name()] }, ...documentedCommands(command, [...path, command.name()])]);
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let inFence = false;
  let current: Block = { level: 0, heading: '', lines: [] };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6}) (.*)$/.exec(line) : null;
    if (heading) {
      blocks.push(current);
      current = { level: heading[1].length, heading: heading[2], lines: [] };
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks;
}

const BLOCKS = splitBlocks(PAGE);

/** The fenced lines starting with `dockflow `, with the index of their block */
function fencedUsageLines(): { block: number; line: string }[] {
  const found: { block: number; line: string }[] = [];
  BLOCKS.forEach((block, index) => {
    let inFence = false;
    for (const line of block.lines) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      else if (inFence && line.startsWith('dockflow ')) found.push({ block: index, line });
    }
  });
  return found;
}

const USAGE = fencedUsageLines();

function findScope(path: string[]): string[] | null {
  const words = path.join(' ');
  const usage = USAGE.find(({ line }) => line === `dockflow ${words}` || line.startsWith(`dockflow ${words} `));
  if (!usage) return null;
  if (WIDE_SCOPE.has(path[0]) && path.length === 1) {
    let start = usage.block;
    while (BLOCKS[start].level > 2) start--;
    const lines: string[] = [];
    for (let i = start; i < BLOCKS.length && (i === start || BLOCKS[i].level > 2); i++) lines.push(...BLOCKS[i].lines);
    return lines;
  }
  return BLOCKS[usage.block].lines;
}

const scopes = new Map<string, string[] | null>();

function scopeOf(path: string[]): string[] | null {
  const key = path.join(' ');
  if (!scopes.has(key)) scopes.set(key, findScope(path));
  return scopes.get(key)!;
}

function optionsOfTableRows(lines: string[]): string[] {
  let inFence = false;
  const found: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const cell = /^\|\s*`([^`]*)`/.exec(line);
    if (cell) found.push(...(cell[1].match(/--[a-z][a-z-]*/g) ?? []));
  }
  return found;
}

function mentions(lines: string[], option: string): boolean {
  return new RegExp(`${option}(?![\\w-])`).test(lines.join('\n'));
}

describe('CLI page and the commander program', () => {
  const documented = documentedCommands(program);

  it('walks a program that has commands', () => {
    expect(documented.length).toBeGreaterThan(40);
  });

  for (const { command, path } of documented) {
    const name = `dockflow ${path.join(' ')}`;

    if (command.commands.length === 0) {
      it(`${name} has a usage line and a section`, () => {
        expect(scopeOf(path), `${name} is not documented: add a code block starting with "${name}" to docs/app/en/cli/page.mdx`).not.toBeNull();
      });
    }

    it(`${name}: aliases appear on the page`, () => {
      for (const alias of command.aliases()) {
        const shown = PAGE.includes(`\`${alias}\``) || USAGE.some(({ line }) => line.split(/\s+/).includes(alias));
        expect(shown, `alias ${alias} of ${name} is not on the page`).toBe(true);
      }
    });

    const scope = command.commands.length === 0 || WIDE_SCOPE.has(path[0]) ? scopeOf(path) : null;
    if (!scope) continue;

    const sharing = documented.filter((other) => scopeOf(other.path) === scope).map((other) => other.command);
    const owners = WIDE_SCOPE.has(path[0]) && path.length === 1 ? [command, ...descendants(command)] : [command];

    it(`${name}: every long option is in its section`, () => {
      for (const owner of owners) {
        for (const option of visibleOptions(owner)) {
          expect(mentions(scope, option.long!), `${option.long} of ${name} is missing from its section of docs/app/en/cli/page.mdx`).toBe(true);
        }
      }
    });

    it(`${name}: every option of its section exists`, () => {
      const known = new Set([...owners, ...sharing].flatMap((owner) => visibleOptions(owner).map((option) => option.long)));
      for (const option of optionsOfTableRows(scope)) {
        expect(known.has(option), `${option} is documented for ${name} and the command has no such option`).toBe(true);
      }
    });
  }

  it('documents the global options', () => {
    for (const option of visibleOptions(program)) {
      expect(mentions(PAGE.split(/\r?\n/),option.long!), `${option.long}`).toBe(true);
    }
  });

  it('only shows commands the program defines', () => {
    const unknown: string[] = [];
    for (const { line } of USAGE) {
      let current: Command = program;
      for (const token of line.split(/\s+/).slice(1)) {
        if (!/^[a-z][a-z-]*$/.test(token)) break;
        if (current === program && token === 'help') break;
        const next = current.commands.find((child) => child.name() === token || child.aliases().includes(token));
        if (!next) {
          if (current === program || current.commands.length > 0) unknown.push(line);
          break;
        }
        current = next;
      }
    }
    expect(unknown).toEqual([]);
  });
});
