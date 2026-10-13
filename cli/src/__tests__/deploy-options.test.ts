import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerDeployCommand, runDeploy } from '../commands/deploy';
import { ConfigError } from '../utils/errors';

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

describe('deploy --server', () => {
  it('names the manager to deploy through', () => {
    expect(parseDeployOptions(['-s', 'manager-2']).server).toBe('manager-2');
  });
});

describe('deploy --render', () => {
  it('is an option of the dry run', () => {
    expect(parseDeployOptions(['--dry-run', '--render'])).toMatchObject({ dryRun: true, render: true });
  });

  it('is refused without --dry-run, before anything connects', async () => {
    const failure = await runDeploy('production', undefined, { render: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe('--render only works with --dry-run');
  });
});
