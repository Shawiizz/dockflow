import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerDeployCommand } from '../commands/deploy';

function parseDeployOptions(argv: string[]): Record<string, unknown> {
  const program = new Command();
  registerDeployCommand(program);
  const deploy = program.commands.find((command) => command.name() === 'deploy')!;
  deploy.parseOptions(argv);
  return deploy.opts();
}

describe('deploy options', () => {
  it('--no-failover reaches deploy as failover: false', () => {
    expect(parseDeployOptions(['--no-failover']).failover).toBe(false);
    expect(parseDeployOptions([]).failover).toBe(true);
  });
});
