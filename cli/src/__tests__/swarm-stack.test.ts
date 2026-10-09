import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'crypto';
import { convergenceError } from '../commands/deploy-phases';
import { loadFromString, serialize } from '../services/compose';
import { SwarmStackBackend } from '../services/orchestrator/swarm/swarm-stack';
import type { SwarmClock } from '../services/orchestrator/swarm/swarm-stack-ops';
import type { SSHExecResult } from '../types';
import { DeployError, ErrorCode } from '../utils/errors';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';

const STACK = 'demo-production';
const conn = { host: '10.0.0.1', port: 22, user: 'deploy', privateKey: 'unused' };
const TAB = '\t';

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

type Answer = Reply | ((command: string) => Reply);

interface Call {
  kind: 'exec' | 'channel';
  command: string;
  stdin?: string;
}

/** Consecutive answers to the same kind of command; the last one repeats. */
function sequence(...replies: Reply[]): () => Reply {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)];
}

/** First matching rule answers; a command nobody scripted fails the test. */
class ScriptedSsh {
  readonly calls: Call[] = [];
  private readonly rules: { match: RegExp; answer: Answer }[] = [];

  on(match: RegExp, answer: Answer): this {
    this.rules.push({ match, answer });
    return this;
  }

  commands(kind?: Call['kind']): string[] {
    return this.calls.filter((call) => kind === undefined || call.kind === kind).map((call) => call.command);
  }

  indexOf(match: RegExp): number {
    return this.calls.findIndex((call) => match.test(call.command));
  }

  lastIndexOf(match: RegExp): number {
    return this.calls.map((call) => match.test(call.command)).lastIndexOf(true);
  }

  private reply(kind: Call['kind'], command: string): { call: Call; reply: Reply } {
    const call: Call = { kind, command };
    this.calls.push(call);
    const rule = this.rules.find((r) => r.match.test(command));
    if (!rule) throw new Error(`unscripted ${kind}: ${command}`);
    return { call, reply: typeof rule.answer === 'function' ? rule.answer(command) : rule.answer };
  }

  exec = async (_conn: unknown, command: string): Promise<SSHExecResult> => {
    const { reply } = this.reply('exec', command);
    return { exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };

  channel = async (_conn: unknown, command: string) => {
    const { call, reply } = this.reply('channel', command);
    const stream = {
      end: (data: string) => {
        call.stdin = data;
      },
    };
    const done = Promise.resolve({ exitCode: reply.exitCode ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
    return { stream, done };
  };
}

class FakeClock implements SwarmClock {
  readonly sleeps: number[] = [];
  private time = Date.parse('2026-09-19T12:00:00Z');
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
  }
}

const STACK_SERVICES_NAMES = /^docker stack services .+ --format '\{\{\.Name\}\}' 2>\/dev\/null \|\| true/;
const INSPECT_JSON = /docker service inspect \S+ --format '\{\{json \.UpdateStatus\}\}'/;
const REPLICAS = new RegExp(`^docker stack services .*${TAB}\\{\\{\\.Replicas\\}\\}`);
const UPDATE_STATES = /^for svc in /;
const FAILED_TASKS = /^docker stack ps .*desired-state=shutdown/;
const STACK_RM = /^docker stack rm /;
const STACK_LS_CHECK = /^docker stack ls --format '\{\{\.Name\}\}' \| grep -xF /;
const STACK_DEPLOY = /^docker stack deploy /;
const HASH_READ = /^cat '.*\.hash'/;
const HASH_WRITE = /\.hash'$/;

const web = (replicas: string) => `${STACK}_web${TAB}${replicas}`;
const states = (...pairs: [string, string][]) => pairs.map(([service, state]) => `${service}${TAB}${state}`).join('\n');

let script: ScriptedSsh;
let clock: FakeClock;
let warnings: string[];

beforeEach(() => {
  script = new ScriptedSsh();
  clock = new FakeClock();
  warnings = [];
  spyOn(ssh, 'sshExec').mockImplementation(script.exec as typeof ssh.sshExec);
  spyOn(ssh, 'sshExecChannel').mockImplementation(script.channel as unknown as typeof ssh.sshExecChannel);
  spyOn(output, 'printWarning').mockImplementation((message: string) => {
    warnings.push(message);
  });
  spyOn(output, 'printInfo').mockImplementation(() => {});
  spyOn(output, 'printSuccess').mockImplementation(() => {});
  spyOn(output, 'printDebug').mockImplementation(() => {});
  spyOn(output, 'createTimedSpinner').mockImplementation(
    () => ({ start() {}, succeed() {}, fail() {}, warn() {}, info() {}, stop() {}, update() {} }) as ReturnType<typeof output.createTimedSpinner>,
  );
});

afterEach(() => {
  spyOn(ssh, 'sshExec').mockRestore();
  spyOn(ssh, 'sshExecChannel').mockRestore();
  spyOn(output, 'printWarning').mockRestore();
  spyOn(output, 'printInfo').mockRestore();
  spyOn(output, 'printSuccess').mockRestore();
  spyOn(output, 'printDebug').mockRestore();
  spyOn(output, 'createTimedSpinner').mockRestore();
});

const backend = (): SwarmStackBackend => new SwarmStackBackend(conn, clock);

const appCompose = () => loadFromString('services:\n  web:\n    image: web:1\n  worker:\n    image: worker:1\n');

function expectDeployError(result: { success: boolean; error?: Error }, message: RegExp): void {
  expect(result.success).toBe(false);
  expect(result.error).toBeInstanceOf(DeployError);
  expect(result.error?.message).toMatch(message);
}

describe('SwarmStackBackend.deploy', () => {
  function scriptDeploy(listed = STACK): void {
    script
      .on(STACK_SERVICES_NAMES, { stdout: '' })
      .on(STACK_DEPLOY, {})
      .on(STACK_LS_CHECK, { stdout: listed });
  }

  it('pipes the rendered compose to docker stack deploy with prune and registry auth', async () => {
    scriptDeploy();
    const input = { stackName: STACK, env: 'production', compose: appCompose() };

    const result = await backend().deploy(input);

    expect(result.success).toBe(true);
    const [deploy] = script.calls.filter((call) => call.kind === 'channel');
    expect(deploy.command).toBe(`docker stack deploy --prune --with-registry-auth -c - '${STACK}'`);
    expect(deploy.stdin).toBe(backend().render(input));
  });

  it('does not prune when a services filter is given, and sends only those services', async () => {
    scriptDeploy();
    const input = { stackName: STACK, env: 'production', compose: appCompose(), servicesFilter: ['web'] };

    await backend().deploy(input);

    const [deploy] = script.calls.filter((call) => call.kind === 'channel');
    expect(deploy.command).not.toContain('--prune');
    expect(deploy.command).toContain('--with-registry-auth');
    expect(Object.keys(loadFromString(deploy.stdin ?? '').services)).toEqual(['web']);
  });

  it('prunes again when the services filter is empty', async () => {
    scriptDeploy();

    await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose(), servicesFilter: [] });

    expect(script.commands('channel')[0]).toContain('--prune');
  });

  it('creates external networks and volumes under their name, quoted, before the deploy', async () => {
    scriptDeploy();
    script.on(/^docker (network|volume) create /, {});
    const compose = loadFromString(
      [
        'services:',
        '  web:',
        '    image: web:1',
        'networks:',
        '  edge:',
        '    external: true',
        '    name: edge net',
        'volumes:',
        '  data:',
        '    external: true',
        '    name: "shared data"',
        '  local: {}',
        '',
      ].join('\n'),
    );

    await backend().deploy({ stackName: STACK, env: 'production', compose });

    const created = script.commands('exec').filter((command) => /^docker (network|volume) create /.test(command));
    expect(created.sort()).toEqual([
      "docker network create --driver overlay --attachable 'edge net' 2>/dev/null || true",
      "docker volume create 'shared data' 2>/dev/null || true",
    ]);
    expect(script.indexOf(/^docker (network|volume) create /)).toBeLessThan(script.indexOf(STACK_DEPLOY));
  });

  it('creates external resources from the whole compose, even for a services filter', async () => {
    scriptDeploy();
    script.on(/^docker network create /, {});
    const compose = loadFromString(
      'services:\n  web:\n    image: web:1\n  worker:\n    image: worker:1\nnetworks:\n  backend:\n    external: true\n',
    );

    await backend().deploy({ stackName: STACK, env: 'production', compose, servicesFilter: ['web'] });

    expect(script.commands('exec').some((command) => command.includes("'backend'"))).toBe(true);
  });

  it('quotes the stack name', async () => {
    scriptDeploy("it's here");

    await backend().deploy({ stackName: "it's here", env: 'production', compose: appCompose() });

    expect(script.commands('channel')[0]).toEndWith(`-c - 'it'\\''s here'`);
    expect(script.commands('exec').every((command) => !command.includes("it's here"))).toBe(true);
  });

  describe('a stuck stack', () => {
    function scriptStuck(inspect: string): void {
      script
        .on(STACK_SERVICES_NAMES, { stdout: `${STACK}_web\n${STACK}_worker\n` })
        .on(INSPECT_JSON, (command) => (command.includes('_web') ? { stdout: inspect } : { stdout: '{"State":"completed"}' }))
        .on(STACK_RM, {})
        .on(STACK_DEPLOY, {})
        .on(STACK_LS_CHECK, sequence({ stdout: '' }, { stdout: STACK }));
    }

    it.each(['paused', 'rollback_paused', 'PAUSED'])('is removed and gone before the deploy starts (%s)', async (state) => {
      scriptStuck(`{"State":"${state}"}`);

      const result = await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

      expect(result.success).toBe(true);
      expect(script.indexOf(STACK_RM)).toBeGreaterThanOrEqual(0);
      expect(script.indexOf(STACK_RM)).toBeLessThan(script.indexOf(STACK_LS_CHECK));
      expect(script.indexOf(STACK_LS_CHECK)).toBeLessThan(script.indexOf(STACK_DEPLOY));
      expect(script.calls[script.indexOf(STACK_RM)].command).toBe(`docker stack rm '${STACK}'`);
      expect(warnings.join('\n')).toContain(`${STACK}_web`);
      expect(warnings.join('\n')).not.toContain(`${STACK}_worker`);
    });

    it('is given a pause for Swarm to release its resources after the removal', async () => {
      scriptStuck('{"State":"paused"}');

      await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

      expect(clock.sleeps).toEqual([2000, 3000]);
    });

    it('is left alone when no service is paused or its status cannot be read', async () => {
      script
        .on(STACK_SERVICES_NAMES, { stdout: `${STACK}_web\n${STACK}_worker\n` })
        .on(INSPECT_JSON, (command) => (command.includes('_web') ? { stdout: '{"State":"updating"}' } : { stdout: 'not json' }))
        .on(STACK_DEPLOY, {})
        .on(STACK_LS_CHECK, { stdout: STACK });

      await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

      expect(script.indexOf(STACK_RM)).toBe(-1);
      expect(clock.sleeps).toEqual([]);
    });

    it('fails the deploy when the stack is still there after 60 seconds', async () => {
      script
        .on(STACK_SERVICES_NAMES, { stdout: `${STACK}_web\n` })
        .on(INSPECT_JSON, { stdout: '{"State":"paused"}' })
        .on(STACK_RM, { exitCode: 1, stderr: 'boom' })
        .on(STACK_LS_CHECK, { stdout: STACK });

      const result = await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

      expectDeployError(result, /still present after 60s/);
      expect(clock.sleeps).toHaveLength(30);
      expect(warnings.some((warning) => warning.includes('docker stack rm failed (exit 1): boom'))).toBe(true);
      expect(script.indexOf(STACK_DEPLOY)).toBe(-1);
    });
  });

  it('returns the docker error of a failed docker stack deploy', async () => {
    script
      .on(STACK_SERVICES_NAMES, { stdout: '' })
      .on(STACK_DEPLOY, { exitCode: 1, stderr: 'network not found\n' });

    const result = await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

    expectDeployError(result, /docker stack deploy failed \(exit 1\): network not found$/);
    expect(script.indexOf(STACK_LS_CHECK)).toBe(-1);
  });

  it('fails when the stack is missing right after the deploy', async () => {
    scriptDeploy('');

    const result = await backend().deploy({ stackName: STACK, env: 'production', compose: appCompose() });

    expectDeployError(result, new RegExp(`Stack ${STACK} not found after deploy`));
  });
});

describe('SwarmStackBackend.redeploy', () => {
  it('sends the stored compose as it is, with prune and registry auth', async () => {
    script
      .on(STACK_SERVICES_NAMES, { stdout: '' })
      .on(STACK_DEPLOY, {})
      .on(STACK_LS_CHECK, { stdout: STACK });

    const result = await backend().redeploy(STACK, 'services:\n  web:\n    image: web:0\n');

    expect(result.success).toBe(true);
    const [deploy] = script.calls.filter((call) => call.kind === 'channel');
    expect(deploy.command).toBe(`docker stack deploy --prune --with-registry-auth -c - '${STACK}'`);
    expect(deploy.stdin).toBe('services:\n  web:\n    image: web:0\n');
  });
});

describe('SwarmStackBackend.deployAccessory', () => {
  const accessories = () => loadFromString('services:\n  db:\n    image: db:1\n');
  const input = (force?: boolean) => ({ stackName: STACK, env: 'production', compose: accessories(), accessoryPath: 'accessories.yml', force });
  const hash = createHash('sha256').update(serialize(accessories())).digest('hex');
  const hashFile = `/var/lib/dockflow/accessories/${STACK}/.hash`;
  const accessoriesStack = `${STACK}-accessories`;

  function scriptAccessories(remoteHash: string, convergence: Reply = { stdout: `${accessoriesStack}_db${TAB}1/1` }, deploy: Reply = {}): void {
    script
      .on(HASH_READ, { stdout: remoteHash })
      .on(/^docker compose -f - pull/, {})
      .on(STACK_SERVICES_NAMES, { stdout: '' })
      .on(STACK_DEPLOY, deploy)
      .on(STACK_LS_CHECK, { stdout: accessoriesStack })
      .on(REPLICAS, convergence)
      .on(UPDATE_STATES, { stdout: '' })
      .on(/^mkdir -p /, {});
  }

  it('skips the deploy, and every remote change, when the recorded hash is the same', async () => {
    scriptAccessories(`${hash}\n`);

    const result = await backend().deployAccessory(input());

    expect(result).toEqual({ success: true, data: { deployed: false } });
    expect(script.commands()).toEqual([`cat '${hashFile}' 2>/dev/null || echo ""`]);
  });

  it('reads the hash from the application stack directory, not the accessories stack', async () => {
    scriptAccessories(hash);

    await backend().deployAccessory(input());

    expect(script.commands()[0]).toContain(hashFile);
    expect(script.commands()[0]).not.toContain(accessoriesStack);
  });

  it('deploys the accessories stack when the hash differs, and records it only after convergence', async () => {
    scriptAccessories('0000');

    const result = await backend().deployAccessory(input());

    expect(result).toEqual({ success: true, data: { deployed: true } });
    const deploy = script.calls.find((call) => STACK_DEPLOY.test(call.command));
    expect(deploy?.command).toBe(`docker stack deploy --prune --with-registry-auth -c - '${accessoriesStack}'`);
    expect(deploy?.stdin).toBe(serialize(accessories()));
    expect(script.calls.find((call) => /^docker compose -f - pull/.test(call.command))?.stdin).toBe(serialize(accessories()));

    const write = script.calls.length - 1;
    expect(script.calls[write].command).toBe(`mkdir -p '/var/lib/dockflow/accessories/${STACK}' && echo '${hash}' > '${hashFile}'`);
    expect(script.indexOf(STACK_DEPLOY)).toBeLessThan(script.lastIndexOf(REPLICAS));
    expect(script.lastIndexOf(REPLICAS)).toBeLessThan(write);
  });

  it('deploys when no hash is recorded yet', async () => {
    scriptAccessories('');

    await backend().deployAccessory(input());

    expect(script.indexOf(STACK_DEPLOY)).toBeGreaterThanOrEqual(0);
  });

  it('deploys without looking at the hash when forced', async () => {
    scriptAccessories(hash);

    const result = await backend().deployAccessory(input(true));

    expect(result.success).toBe(true);
    expect(script.indexOf(HASH_READ)).toBe(-1);
    expect(script.indexOf(STACK_DEPLOY)).toBeGreaterThanOrEqual(0);
    expect(script.calls[script.calls.length - 1].command).toContain(`> '${hashFile}'`);
  });

  it('does not record the hash when the accessories never converge', async () => {
    scriptAccessories('0000', { stdout: `${accessoriesStack}_db${TAB}0/1` });

    const result = await backend().deployAccessory(input());

    expectDeployError(result, /accessories convergence timeout after 300s.*db 0\/1/);
    expect(script.commands().some((command) => command.startsWith('mkdir -p '))).toBe(false);
  });

  it('does not record the hash when the stack deploy fails', async () => {
    scriptAccessories('0000', undefined, { exitCode: 1, stderr: 'invalid compose' });

    const result = await backend().deployAccessory(input());

    expectDeployError(result, /invalid compose/);
    expect(script.commands().some((command) => command.startsWith('mkdir -p '))).toBe(false);
  });

  it('creates the external networks and volumes of the accessories first', async () => {
    scriptAccessories('0000');
    script.on(/^docker network create /, {});
    const compose = loadFromString('services:\n  db:\n    image: db:1\nnetworks:\n  shared:\n    external: true\n');

    await backend().deployAccessory({ ...input(), compose });

    expect(script.indexOf(/^docker network create .*'shared'/)).toBeGreaterThanOrEqual(0);
  });
});

describe('SwarmStackBackend.waitConvergence', () => {
  const WEB = `${STACK}_web`;
  const WORKER = `${STACK}_worker`;

  it('converges once every service has all its replicas and no update is running', async () => {
    script
      .on(REPLICAS, { stdout: `${web('2/2')}\n${WORKER}${TAB}1/1\n` })
      .on(UPDATE_STATES, { stdout: states([WEB, 'complete'], [WORKER, '']) });

    const result = await backend().waitConvergence(STACK, 60, 5);

    expect(result).toEqual({ converged: true, rolledBack: false, timedOut: false });
    expect(clock.sleeps).toEqual([]);
  });

  it('waits for the rolling update to finish even when the replica counts already match', async () => {
    script
      .on(REPLICAS, { stdout: web('2/2') })
      .on(UPDATE_STATES, sequence({ stdout: states([WEB, 'updating']) }, { stdout: states([WEB, 'updating']) }, { stdout: states([WEB, 'completed']) }));

    const result = await backend().waitConvergence(STACK, 60, 5);

    expect(result.converged).toBe(true);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('polls until the replicas are all running', async () => {
    script
      .on(REPLICAS, sequence({ stdout: web('0/2') }, { stdout: web('1/2') }, { stdout: web('2/2') }))
      .on(UPDATE_STATES, sequence({ stdout: '' }, { stdout: '' }, { stdout: states([WEB, 'completed']) }));

    const result = await backend().waitConvergence(STACK, 60, 5);

    expect(result.converged).toBe(true);
    expect(clock.sleeps).toEqual([5000, 5000]);
  });

  it('keeps polling while the stack lists no service yet', async () => {
    script
      .on(REPLICAS, sequence({ stdout: '' }, { stdout: web('1/1') }))
      .on(UPDATE_STATES, { stdout: '' });

    const result = await backend().waitConvergence(STACK, 60, 5);

    expect(result.converged).toBe(true);
    expect(clock.sleeps).toEqual([5000]);
  });

  it('fails fast when Swarm rolled the update back, with the reason of the failed tasks', async () => {
    script
      .on(REPLICAS, { stdout: web('1/2') })
      .on(UPDATE_STATES, { stdout: states([WEB, 'rollback_started']) })
      .on(FAILED_TASKS, { stdout: `${WEB}.1|task: non-zero exit (1)\n${WEB}.2|\n` });

    const result = await backend().waitConvergence(STACK, 300, 5);

    expect(result.converged).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.errorDetail).toBe(`Swarm auto-rolled back services: ${WEB}\n\nFailed tasks:\n  ${WEB}.1: task: non-zero exit (1)`);
    expect(clock.sleeps).toEqual([]);
  });

  it('reports a rollback without the task section when the tasks cannot be listed', async () => {
    script
      .on(REPLICAS, { stdout: web('1/2') })
      .on(UPDATE_STATES, { stdout: states([WEB, 'rollback_completed']) })
      .on(FAILED_TASKS, { stdout: '' });

    const result = await backend().waitConvergence(STACK, 300, 5);

    expect(result.rolledBack).toBe(true);
    expect(result.errorDetail).toBe(`Swarm auto-rolled back services: ${WEB}`);
  });

  it('fails fast on a paused update, which is neither a rollback nor a timeout', async () => {
    script
      .on(REPLICAS, { stdout: web('1/2') })
      .on(UPDATE_STATES, { stdout: states([WEB, 'paused']) })
      .on(FAILED_TASKS, { stdout: '' });

    const result = await backend().waitConvergence(STACK, 300, 5);

    expect(result).toEqual({
      converged: false,
      rolledBack: false,
      timedOut: false,
      errorDetail: `Services stuck in paused: ${WEB}`,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it('times out with the services that never reached their replica count, polling at the interval', async () => {
    script
      .on(REPLICAS, { stdout: `${web('1/2')}\n${WORKER}${TAB}1/1` })
      .on(UPDATE_STATES, { stdout: states([WEB, ''], [WORKER, '']) });

    const result = await backend().waitConvergence(STACK, 20, 5);

    expect(result.converged).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.errorDetail).toBe('deployment convergence timeout after 20s. Non-converged services: ' + `${WEB} 1/2`);
    expect(clock.sleeps).toEqual([5000, 5000, 5000, 5000]);
  });

  it('times out when the stack never lists a service', async () => {
    script.on(REPLICAS, { stdout: '' });

    const result = await backend().waitConvergence(STACK, 10, 5);

    expect(result.timedOut).toBe(true);
    expect(result.errorDetail).toEndWith('Non-converged services: ');
  });

  it('looks only at the services of the filter', async () => {
    script
      .on(REPLICAS, { stdout: `${web('2/2')}\n${WORKER}${TAB}0/1` })
      .on(UPDATE_STATES, (command) => {
        expect(command).toContain(`'${WEB}'`);
        expect(command).not.toContain(WORKER);
        return { stdout: states([WEB, '']) };
      });

    const result = await backend().waitConvergence(STACK, 60, 5, ['web']);

    expect(result.converged).toBe(true);
  });

  it('quotes the stack name when it lists the services', async () => {
    script.on(REPLICAS, { stdout: '' });

    await backend().waitConvergence('my stack', 1, 1);

    expect(script.commands()[0]).toStartWith("docker stack services 'my stack' --format");
  });

  describe('what the deploy gets', () => {
    it('a rollback is a failed health check, with the logs to read', () => {
      const error = convergenceError({ rolledBack: true, timedOut: false, errorDetail: 'Swarm auto-rolled back services: x' }, 'production');

      expect(error.code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
      expect(error.message).toBe('Swarm auto-rolled back services: x');
      expect(error.suggestion).toContain('dockflow logs production');
    });

    it('a timeout or a paused update is a failed deploy, with diagnose', () => {
      for (const convergence of [
        { rolledBack: false, timedOut: true, errorDetail: 'deployment convergence timeout after 300s. Non-converged services: x 0/1' },
        { rolledBack: false, timedOut: false, errorDetail: 'Services stuck in paused: x' },
      ]) {
        const error = convergenceError(convergence, 'production');
        expect(error.code).toBe(ErrorCode.DEPLOY_FAILED);
        expect(error.message).toBe(convergence.errorDetail);
        expect(error.suggestion).toContain('dockflow diagnose production');
      }
    });

    it('end to end: a rollback result maps to a failed health check', async () => {
      script
        .on(REPLICAS, { stdout: web('1/2') })
        .on(UPDATE_STATES, { stdout: states([WEB, 'rollback_started']) })
        .on(FAILED_TASKS, { stdout: '' });

      const convergence = await backend().waitConvergence(STACK, 10, 5);

      expect(convergenceError(convergence, 'production').code).toBe(ErrorCode.HEALTH_CHECK_FAILED);
    });

    it('end to end: a timeout result maps to a failed deploy', async () => {
      script.on(REPLICAS, { stdout: web('1/2') }).on(UPDATE_STATES, { stdout: '' });

      const convergence = await backend().waitConvergence(STACK, 10, 5);

      expect(convergenceError(convergence, 'production').code).toBe(ErrorCode.DEPLOY_FAILED);
    });
  });
});

describe('SwarmStackBackend.checkInternalHealth', () => {
  const WEB = `${STACK}_web`;
  const started = new Date('2026-09-19T12:00:00Z');

  function scriptHealth(inspect: string, tasks = 'Running 10 seconds ago'): void {
    script
      .on(/^docker stack services \S+ --format '\{\{\.Name\}\}' 2>\/dev\/null \|\| echo ""/, { stdout: `${WEB}\n` })
      .on(/CompletedAt/, { stdout: inspect })
      .on(/^docker service ps /, { stdout: tasks });
  }

  it('is healthy when every running task is Running', async () => {
    scriptHealth('complete|2026-09-19T12:01:00Z');

    const result = await backend().checkInternalHealth(STACK, 30, 1, undefined, started);

    expect(result).toEqual({ healthy: true, rolledBack: false });
  });

  it('ignores a rollback that completed before this deploy started', async () => {
    scriptHealth('rollback_completed|2026-09-19T11:00:00.000000000Z');

    const result = await backend().checkInternalHealth(STACK, 30, 1, undefined, started);

    expect(result).toEqual({ healthy: true, rolledBack: false });
  });

  it('reports a rollback that completed after this deploy started', async () => {
    scriptHealth('rollback_completed|2026-09-19T12:00:30.000000000Z');

    const result = await backend().checkInternalHealth(STACK, 30, 1, undefined, started);

    expect(result.healthy).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.failedService).toBe(WEB);
    expect(result.message).toBe(`Swarm auto-rolled back: ${WEB}`);
  });

  it('reports a rollback whose completion time is unknown or when there is no start time', async () => {
    scriptHealth('rollback_completed|');
    expect((await backend().checkInternalHealth(STACK, 30, 1, undefined, started)).rolledBack).toBe(true);

    script.calls.length = 0;
    expect((await backend().checkInternalHealth(STACK, 30, 1)).rolledBack).toBe(true);
  });

  it('always reports a rollback in progress', async () => {
    scriptHealth('rollback_started|');

    const result = await backend().checkInternalHealth(STACK, 30, 1, undefined, new Date('2030-01-01T00:00:00Z'));

    expect(result.rolledBack).toBe(true);
  });

  it('times out naming the services that never ran', async () => {
    scriptHealth('', 'Starting 2 seconds ago');

    const result = await backend().checkInternalHealth(STACK, 3, 1, undefined, started);

    expect(result).toEqual({
      healthy: false,
      rolledBack: false,
      failedService: WEB,
      message: `Health check timeout after 3s. Unhealthy services: ${WEB}`,
    });
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
  });
});

describe('SwarmStackBackend.restart', () => {
  const listing = `${STACK}_web|web:1|1/1|\n${STACK}_worker|worker:1|2/2|\n`;

  it('updates every service of the stack in one chained command', async () => {
    script
      .on(/\{\{\.Image\}\}/, { stdout: listing })
      .on(/^docker service update /, {});

    await backend().restart(STACK);

    expect(script.commands('exec')[1]).toBe(`docker service update --force '${STACK}_web' && docker service update --force '${STACK}_worker'`);
  });

  it('asks for --detach on every update of the chain', async () => {
    script
      .on(/\{\{\.Image\}\}/, { stdout: listing })
      .on(/^docker service update /, {});

    await backend().restart(STACK, undefined, { detach: true });

    expect(script.commands('exec')[1]).toBe(
      `docker service update --force --detach '${STACK}_web' && docker service update --force --detach '${STACK}_worker'`,
    );
  });

  it('updates one service by its stack-qualified, quoted name', async () => {
    script.on(/^docker service update /, {});

    await backend().restart('my stack', 'web', { detach: true });

    expect(script.commands()).toEqual(["docker service update --force --detach 'my stack_web'"]);
  });

  it('refuses a stack without services', async () => {
    script.on(/\{\{\.Image\}\}/, { stdout: '' });

    await expect(backend().restart(STACK)).rejects.toMatchObject({ code: ErrorCode.STACK_NOT_FOUND });
    expect(script.commands()).toHaveLength(1);
  });

  it('raises the docker error of a failed update', async () => {
    script
      .on(/\{\{\.Image\}\}/, { stdout: listing })
      .on(/^docker service update /, { exitCode: 1, stderr: 'no such service' });

    await expect(backend().restart(STACK)).rejects.toThrow('no such service');
    await expect(backend().restart(STACK, 'web')).rejects.toThrow('no such service');
  });
});

describe('SwarmStackBackend service commands', () => {
  it('scales by the quoted, stack-qualified name, detached only on request', async () => {
    script.on(/^docker service scale /, {});

    await backend().scaleService('my stack', 'web', 3);
    await backend().scaleService('my stack', 'web', 0, { detach: true });

    expect(script.commands()).toEqual(["docker service scale 'my stack_web'=3", "docker service scale --detach 'my stack_web'=0"]);
  });

  it('raises the docker error of a failed scale or rollback', async () => {
    script.on(/^docker service (scale|rollback) /, { exitCode: 1, stderr: 'service not found' });

    await expect(backend().scaleService(STACK, 'web', 2)).rejects.toThrow('service not found');
    await expect(backend().rollbackService(STACK, 'web')).rejects.toThrow('service not found');
  });

  it('rolls a service back by its quoted name', async () => {
    script.on(/^docker service rollback /, {});

    await backend().rollbackService('my stack', 'web');

    expect(script.commands()).toEqual(["docker service rollback 'my stack_web'"]);
  });

  it('removes a stack by its quoted name and waits until it is gone', async () => {
    script.on(STACK_RM, {}).on(STACK_LS_CHECK, sequence({ stdout: 'my stack' }, { stdout: '' }));

    await backend().removeStack('my stack');

    expect(script.commands()).toEqual([
      "docker stack rm 'my stack'",
      `docker stack ls --format '{{.Name}}' | grep -xF 'my stack' || echo ""`,
      `docker stack ls --format '{{.Name}}' | grep -xF 'my stack' || echo ""`,
    ]);
    expect(clock.sleeps).toEqual([2000, 2000]);
  });
});

describe('SwarmStackBackend queries', () => {
  const dockerDown = {
    exitCode: 1,
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  };

  it('lists the services of a stack by their bare names', async () => {
    script.on(/^docker stack services /, { stdout: `${STACK}_web|web:1|2/2|*:3000->3000/tcp\n${STACK}_worker|worker:1|1/1|\n` });

    expect(await backend().getServices(STACK)).toEqual([
      { name: 'web', image: 'web:1', replicas: '2/2', ports: '*:3000->3000/tcp' },
      { name: 'worker', image: 'worker:1', replicas: '1/1', ports: '' },
    ]);
  });

  it('has no services in a stack docker finds nothing in', async () => {
    script.on(/^docker stack services /, { exitCode: 1, stderr: `Nothing found in stack: ${STACK}` });

    expect(await backend().getServices(STACK)).toEqual([]);
  });

  it('says Docker is not running instead of listing no services', async () => {
    script.on(/^docker stack services /, dockerDown);

    const error = await backend().getServices(STACK).catch((e: unknown) => e);

    expect(error).toMatchObject({ message: 'Docker is not running on 10.0.0.1', code: ErrorCode.DOCKER_NOT_AVAILABLE });
  });

  it('lets the same error out of every docker query', async () => {
    script.on(/^docker /, dockerDown);

    for (const query of [() => backend().listStacks(), () => backend().stackExists(STACK), () => backend().getContainers(STACK), () => backend().getTasks(STACK)]) {
      await expect(query()).rejects.toThrow('Docker is not running on 10.0.0.1');
    }
  });

  it('restart does not mistake a down Docker for a stack without services', async () => {
    script.on(/^docker stack services /, dockerDown);

    await expect(backend().restart(STACK)).rejects.toThrow('Docker is not running on 10.0.0.1');
  });

  it('tells whether a stack exists from the exact name', async () => {
    script.on(/^docker stack ls /, { stdout: `${STACK}\nother\n` });

    expect(await backend().stackExists(STACK)).toBe(true);
    expect(await backend().stackExists('demo')).toBe(false);
  });
});
