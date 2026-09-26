// `deploy --no-failover` (DESIGN-CORE 6.6): Commander names a negated option after its positive form,
// so the flag has to reach control-plane resolution as `failover: false`.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { registerDeployCommand, runDeploy } from '../../../commands/deploy';
import * as factory from '../../../services/orchestrator/factory';
import * as output from '../../../utils/output';

const STOP = new Error('stopped before any remote work');

let spies: { mockRestore(): void }[] = [];

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

function parsedOptions(args: string[]): Record<string, unknown> {
  const program = new Command();
  registerDeployCommand(program);
  const deploy = program.commands.find((command) => command.name() === 'deploy');
  if (!deploy) throw new Error('deploy is not registered');
  deploy.parseOptions(args);
  return deploy.opts();
}

async function failoverReachingResolution(args: string[]): Promise<unknown> {
  const opened = spyOn(factory, 'openOrchestrator').mockImplementation(async () => {
    throw STOP;
  });
  spies.push(opened, spyOn(output, 'printIntro').mockImplementation(() => {}), spyOn(output, 'printBlank').mockImplementation(() => {}));
  await expect(runDeploy('production', '1.0.0', parsedOptions(args))).rejects.toBe(STOP);
  return opened.mock.calls[0]?.[1]?.failover;
}

describe('deploy --no-failover', () => {
  it('disables failover probing', async () => {
    expect(await failoverReachingResolution(['--no-failover'])).toBe(false);
  });

  it('leaves it on by default', async () => {
    expect(await failoverReachingResolution([])).toBe(true);
  });
});
