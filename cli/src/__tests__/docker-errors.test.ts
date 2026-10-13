import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { analyzeTaskError } from '../commands/app/diagnose';
import { SwarmStackBackend } from '../services/orchestrator/swarm/swarm-stack';
import { stackDeployFailure, SwarmStackOps, type SwarmClock } from '../services/orchestrator/swarm/swarm-stack-ops';
import { dockerQueryError } from '../services/orchestrator/swarm/swarm-utils';
import type { SSHExecResult } from '../types';
import { DeployError, ErrorCode } from '../utils/errors';
import * as output from '../utils/output';
import * as ssh from '../utils/ssh';

/**
 * The texts in fixtures/docker-errors are what Docker printed for real failures (recorded by
 * testing/e2e/scripts/record-docker-errors.ts), so these tests break when a Docker release rewords
 * a message the classifiers read.
 */
const DIR = join(import.meta.dir, 'fixtures', 'docker-errors');

interface CaseInfo {
  kind: 'task-error' | 'stderr';
  exitCode: number;
  origin: 'hand-written' | 'recorded';
  command: string;
}

const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf-8')) as { cases: Record<string, CaseInfo> };

function recorded(name: string): string {
  return readFileSync(join(DIR, `${name}.txt`), 'utf-8').replace(/\r\n/g, '\n');
}

function namesOfKind(kind: CaseInfo['kind']): string[] {
  return Object.entries(index.cases)
    .filter(([, info]) => info.kind === kind)
    .map(([name]) => name);
}

const TASK_ERRORS = namesOfKind('task-error');
const STACK_DEPLOY_FAILURES = ['network-external-missing', 'stack-deploy-unsupported-options', 'stack-deploy-deprecated-options'];
const FALLBACK = 'Check Docker logs for more details: docker service logs <service_name>';

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? '';

describe('the recorded Docker errors', () => {
  it('has a text for every case of the index and a case for every text', () => {
    const files = readdirSync(DIR)
      .filter((file) => file.endsWith('.txt'))
      .map((file) => file.slice(0, -'.txt'.length))
      .sort();

    expect(files).toEqual(Object.keys(index.cases).sort());
    for (const name of files) expect(recorded(name).trim()).not.toBe('');
  });

  it('says how each text was obtained', () => {
    for (const [name, info] of Object.entries(index.cases)) {
      expect({ name, command: info.command.length > 0, origin: ['hand-written', 'recorded'].includes(info.origin) }).toEqual({
        name,
        command: true,
        origin: true,
      });
    }
  });
});

describe('analyzeTaskError on recorded task errors', () => {
  it('gives a hint for each of them, never the generic fallback', () => {
    for (const name of TASK_ERRORS) {
      expect({ name, hint: analyzeTaskError(recorded(name).trim()) }).not.toEqual({ name, hint: FALLBACK });
    }
  });

  it('names the scheduling reason when no node can take the task', () => {
    expect(analyzeTaskError(recorded('no-suitable-node').trim())).toStartWith('No node can run the task (');
  });

  it('points to the registry for an image that is missing or refused', () => {
    expect(analyzeTaskError(recorded('image-manifest-unknown').trim())).toMatch(/cannot be pulled|not have been pushed/);
    expect(analyzeTaskError(recorded('image-pull-denied').trim())).toMatch(/cannot be pulled|not have been pushed/);
  });

  it('reads the exit code of a container that stopped', () => {
    expect(analyzeTaskError(recorded('container-exit-nonzero').trim())).toContain('exited with code 3');
  });

  it('says a container killed for its memory ran out of it', () => {
    expect(analyzeTaskError(recorded('oom-killed').trim())).toMatch(/memory/);
    expect(analyzeTaskError(recorded('cgroup-limits-unsupported').trim())).toMatch(/cannot apply resource limits/);
  });
});

describe('dockerQueryError on recorded docker failures', () => {
  const failed = (name: string) => ({ stdout: '', stderr: recorded(name), exitCode: index.cases[name].exitCode });

  it('says Docker is not running when the daemon does not answer', () => {
    const error = dockerQueryError('h', failed('daemon-unreachable'), 'docker ps');
    expect(error.message).toBe('Docker is not running on h');
    expect(error.code).toBe(ErrorCode.DOCKER_NOT_AVAILABLE);
  });

  it('says a worker is not a manager', () => {
    expect(dockerQueryError('h', failed('worker-not-manager'), 'docker service ls').message).toBe('h is not a Swarm manager');
  });

  it('says the SSH user may not use Docker when it cannot read the socket', () => {
    expect(dockerQueryError('h', failed('socket-permission-denied'), 'docker ps').message).toBe('The SSH user of h is not allowed to use Docker');
  });

  it('keeps the reason of any other docker failure', () => {
    expect(dockerQueryError('h', failed('volume-in-use'), 'docker volume rm').message).toMatch(/^docker volume rm failed on h: .*volume is in use/);
    expect(dockerQueryError('h', failed('service-scale-global'), 'docker service scale').message).toMatch(
      /^docker service scale failed on h: .*scale can only be used with replicated/,
    );
  });

  it('never answers with an empty reason', () => {
    for (const name of namesOfKind('stderr').filter((candidate) => !STACK_DEPLOY_FAILURES.includes(candidate))) {
      const message = dockerQueryError('h', failed(name), 'docker call').message;
      expect({ name, empty: message.trim() === '' || message.endsWith(': ') }).toEqual({ name, empty: false });
    }
  });
});

describe('stackDeployFailure on recorded stack deploy output', () => {
  it('keeps the whole message of a deploy that printed no warning', () => {
    expect(stackDeployFailure(recorded('network-external-missing'))).toBe(recorded('network-external-missing').trim());
  });

  it('drops the warning about unsupported options and keeps the error', () => {
    const cause = stackDeployFailure(recorded('stack-deploy-unsupported-options'));
    expect(cause).not.toContain('Ignoring unsupported options');
    expect(cause).toBe(lastLine(recorded('stack-deploy-unsupported-options')));
  });

  it('drops the warnings about unsupported and deprecated options and ends with the error', () => {
    const cause = stackDeployFailure(recorded('stack-deploy-deprecated-options'));
    expect(cause).not.toContain('Ignoring unsupported options');
    expect(cause).not.toContain('Ignoring deprecated options');
    expect(cause).toEndWith(lastLine(recorded('stack-deploy-deprecated-options')));
  });
});

const conn = { host: '10.0.0.1', port: 22, user: 'deploy', privateKey: 'unused' };
const STACK = 'demo-production';
const WEB = `${STACK}_web`;
const TAB = '\t';

class FakeClock implements SwarmClock {
  private time = Date.parse('2026-09-19T12:00:00Z');
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

type Answer = Partial<SSHExecResult>;

/** The first rule that matches the command answers; a command nobody scripted gets an empty success. */
function scriptSsh(rules: [RegExp, Answer][]): { commands: string[] } {
  const commands: string[] = [];
  const answer = (command: string): SSHExecResult => {
    commands.push(command);
    const rule = rules.find(([match]) => match.test(command));
    return { exitCode: 0, stdout: '', stderr: '', ...rule?.[1] };
  };
  spyOn(ssh, 'sshExec').mockImplementation((async (_conn: unknown, command: string) => answer(command)) as typeof ssh.sshExec);
  spyOn(ssh, 'sshExecChannel').mockImplementation((async (_conn: unknown, command: string) => ({
    stream: { end: () => {} },
    done: Promise.resolve(answer(command)),
  })) as unknown as typeof ssh.sshExecChannel);
  return { commands };
}

beforeEach(() => {
  spyOn(output, 'printWarning').mockImplementation(() => {});
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

describe('a failed docker stack deploy', () => {
  for (const name of STACK_DEPLOY_FAILURES) {
    it(`reports the cause of ${name}`, async () => {
      scriptSsh([[/^docker stack deploy /, { exitCode: index.cases[name].exitCode, stderr: recorded(name) }]]);

      const failure = await new SwarmStackOps(conn, new FakeClock()).deployStack(STACK, 'services: {}\n').catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toBe(`docker stack deploy failed (exit ${index.cases[name].exitCode}): ${stackDeployFailure(recorded(name))}`);
      expect(failure.message).not.toContain('Ignoring unsupported options');
    });
  }
});

describe('docker service scale on a global service', () => {
  it('raises the message Docker gave', async () => {
    scriptSsh([[/docker service scale /, { exitCode: index.cases['service-scale-global'].exitCode, stderr: recorded('service-scale-global') }]]);

    const failure = await new SwarmStackBackend(conn, new FakeClock()).scaleService(STACK, 'web', 2).catch((error) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.message.trim()).toBe(recorded('service-scale-global').trim());
  });
});

describe('the convergence timeout with recorded task errors', () => {
  const REPLICAS = new RegExp(`^docker stack services .*${TAB}\\{\\{\\.Replicas\\}\\}`);
  const UPDATE_STATES = /^for svc in /;

  for (const desired of ['running', 'shutdown'] as const) {
    for (const name of TASK_ERRORS) {
      it(`quotes ${name} among the errors of the ${desired === 'running' ? 'tasks that never started' : 'tasks that failed'}`, async () => {
        const tasks = `${WEB}.1|${recorded(name).trim()}\n${WEB}.2|\n`;
        scriptSsh([
          [REPLICAS, { stdout: `${WEB}${TAB}0/2\n` }],
          [UPDATE_STATES, { stdout: '' }],
          [new RegExp(`^docker stack ps .*desired-state=${desired}`), { stdout: tasks }],
        ]);

        const result = await new SwarmStackBackend(conn, new FakeClock()).waitConvergence(STACK, 10, 5);

        expect(result.timedOut).toBe(true);
        expect(result.errorDetail).toBe(
          `deployment convergence timeout after 10s. Non-converged services: ${WEB} 0/2\n\nTask errors:\n  ${WEB}.1: ${recorded(name).trim()}`,
        );
      });
    }
  }
});
