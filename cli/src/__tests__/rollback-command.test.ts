import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { registerRollbackCommand } from '../commands/app/rollback';
import * as nodes from '../commands/app/nodes';
import * as phases from '../commands/deploy-phases';
import { Audit } from '../services/audit';
import { Metrics } from '../services/metrics';
import * as notification from '../services/notification';
import * as factory from '../services/orchestrator/factory';
import { Release } from '../services/release';
import * as lockModule from '../services/lock';
import { ok } from '../types';
import * as output from '../utils/output';
import * as validation from '../utils/validation';

const connection = { host: 'manager', port: 22, user: 'dockflow', privateKey: 'key' };
const worker = { host: 'worker', port: 22, user: 'dockflow', privateKey: 'key' };

const spies: { mockRestore(): void }[] = [];
let registry: unknown;
let rollback: ReturnType<typeof spyOn<Release, 'rollback'>>;

async function run(): Promise<void> {
  const program = new Command().exitOverride();
  registerRollbackCommand(program);
  await program.parseAsync(['rollback', 'production'], { from: 'user' });
}

beforeEach(() => {
  registry = undefined;
  rollback = spyOn(Release.prototype, 'rollback').mockResolvedValue('1.0.0');
  spies.push(
    rollback,
    spyOn(validation, 'resolveEnv').mockImplementation(
      async () => ({ config: { project_name: 'shop', registry }, stackName: 'shop-production', connection, serverName: 'server_1' }) as never,
    ),
    spyOn(nodes, 'nodesOf').mockReturnValue([
      { name: 'server_1', connection },
      { name: 'agent_1', connection: worker },
    ]),
    spyOn(factory, 'createStackBackend').mockReturnValue({} as never),
    spyOn(lockModule, 'createLock').mockReturnValue({
      acquire: async () => ok({}),
      keepAlive: () => {},
      release: async () => ok(undefined),
    } as never),
    spyOn(phases, 'runPostRollbackHealthChecks').mockResolvedValue(undefined),
    spyOn(Audit.prototype, 'writeEntry').mockResolvedValue(undefined as never),
    spyOn(Metrics.prototype, 'writeDeployment').mockResolvedValue(undefined as never),
    spyOn(notification, 'notify').mockResolvedValue(undefined as never),
    spyOn(output, 'createSpinner').mockReturnValue({ start() {}, succeed() {}, fail() {} } as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('rollback of the whole stack', () => {
  it('has the images checked on every node of the environment when no registry holds them', async () => {
    await run();

    const options = rollback.mock.calls[0][4];
    expect(options?.imageNodes?.map((node) => node.name)).toEqual(['server_1', 'agent_1']);
  });

  it('leaves the nodes to pull the images when a registry is used', async () => {
    registry = { enabled: true, url: 'registry.example.com', password: 'secret' };

    await run();

    expect(rollback.mock.calls[0][4]?.imageNodes).toBeUndefined();
  });
});
