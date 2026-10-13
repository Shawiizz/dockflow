import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerAccessoriesCommands } from '../commands/accessories';
import { registerLockCommands } from '../commands/lock';

function subcommand(program: Command, ...path: string[]): Command {
  let current = program;
  for (const name of path) {
    current = current.commands.find((command) => command.name() === name)!;
  }
  return current;
}

function longOptions(command: Command): string[] {
  return command.options.map((option) => option.long ?? '');
}

describe('options that did nothing are gone', () => {
  it('lock release has no --force', () => {
    const program = new Command();
    registerLockCommands(program);
    const options = longOptions(subcommand(program, 'lock', 'release'));
    expect(options).toContain('--server');
    expect(options).not.toContain('--force');
  });

  it('accessories logs has no --raw', () => {
    const program = new Command();
    registerAccessoriesCommands(program);
    const options = longOptions(subcommand(program, 'accessories', 'logs'));
    expect(options).toContain('--follow');
    expect(options).not.toContain('--raw');
  });
});
