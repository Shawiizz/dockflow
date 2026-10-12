import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { registerAccessoriesStopCommand } from '../commands/accessories/stop';
import * as accessories from '../commands/accessories/utils';
import * as serviceName from '../commands/app/service-name';
import * as factory from '../services/orchestrator/factory';
import * as config from '../utils/config';
import { ErrorCode } from '../utils/errors';
import * as output from '../utils/output';
import * as validation from '../utils/validation';

const STACK = 'shop-production-accessories';
const scaled: string[] = [];
let modes: Record<string, string> = {};
const spies: { mockRestore(): void }[] = [];

async function stop(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerAccessoriesStopCommand(program);
  await program.parseAsync(['stop', 'production', ...args, '-y'], { from: 'user' });
}

beforeEach(() => {
  scaled.length = 0;
  modes = { cache: 'replicated', agent: 'global' };
  const connection = { host: 'manager', port: 22, user: 'dockflow', privateKey: 'key' };
  spies.push(
    spyOn(validation, 'resolveEnv').mockResolvedValue({ connection } as never),
    spyOn(accessories, 'requireAccessoriesStack').mockResolvedValue({ stackName: STACK } as never),
    spyOn(config, 'loadConfig').mockReturnValue({ project_name: 'shop' } as never),
    spyOn(serviceName, 'serviceMode').mockImplementation(async (_conn, _stack, name) => modes[name] as never),
    spyOn(factory, 'createStackBackend').mockReturnValue({
      getServices: async () => [{ name: 'cache' }, { name: 'agent' }],
      scaleService: async (_stack: string, name: string) => {
        scaled.push(name);
      },
    } as never),
  );
  for (const name of ['printIntro', 'printBlank', 'printNote', 'printOutro', 'printWarning', 'printInfo'] as const) {
    spies.push(spyOn(output, name).mockImplementation(() => {}));
  }
  spies.push(spyOn(output, 'createSpinner').mockReturnValue({ start() {}, succeed() {}, fail() {} } as never));
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('accessories stop', () => {
  it('stops the replicated accessories and leaves a global one running, saying so', async () => {
    await stop();

    expect(scaled).toEqual(['cache']);
    expect(output.printWarning).toHaveBeenCalledWith('agent is not replicated and is left running');
  });

  it('refuses to stop a global accessory by name', async () => {
    let exitCode: number | undefined;
    spies.push(
      spyOn(output, 'printError').mockImplementation(() => {}),
      spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCode = code;
        throw new Error('exit');
      }) as never),
    );

    await stop('agent').catch(() => {});

    expect(scaled).toEqual([]);
    expect(exitCode).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});
