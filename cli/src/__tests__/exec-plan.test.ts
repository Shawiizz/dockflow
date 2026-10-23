import { describe, expect, it } from 'bun:test';
import { dockerExecCommand } from '../services/swarm/containers';
import { ValidationError } from '../utils/errors';
import { parseExecEnv, planExec } from '../utils/exec-plan';

describe('planExec', () => {
  const ttyBoth = { stdin: { isTTY: true }, stdout: { isTTY: true } };

  it('no command opens an auto-detected shell', () => {
    expect(planExec([], {}, ttyBoth)).toEqual({ mode: 'shell', shell: 'auto' });
  });

  it('--sh with no command opens /bin/sh directly', () => {
    expect(planExec([], { sh: true }, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
  });

  it('bash and /bin/bash open the bash shell', () => {
    expect(planExec(['bash'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/bash' });
    expect(planExec(['/bin/bash'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/bash' });
  });

  it('sh and /bin/sh open the sh shell', () => {
    expect(planExec(['sh'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
    expect(planExec(['/bin/sh'], {}, ttyBoth)).toEqual({ mode: 'shell', shell: '/bin/sh' });
  });

  it('a single argument with shell metacharacters runs through sh -c', () => {
    const plan = planExec(['ls | wc -l'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['sh', '-c', 'ls | wc -l']);
  });

  it('a single argument containing only spaces also runs through sh -c', () => {
    const plan = planExec(['echo hi'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['sh', '-c', 'echo hi']);
  });

  it('two arguments are passed through untouched', () => {
    const plan = planExec(['echo', 'hi'], {}, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.argv).toEqual(['echo', 'hi']);
  });

  it('the tty/stdin matrix follows the local TTYs', () => {
    const cases: { stdio: typeof ttyBoth; tty: boolean; stdin: boolean }[] = [
      { stdio: { stdin: { isTTY: true }, stdout: { isTTY: true } }, tty: true, stdin: true },
      { stdio: { stdin: { isTTY: false }, stdout: { isTTY: false } }, tty: false, stdin: true },
      { stdio: { stdin: { isTTY: true }, stdout: { isTTY: false } }, tty: false, stdin: false },
      { stdio: { stdin: { isTTY: false }, stdout: { isTTY: true } }, tty: false, stdin: true },
    ];
    for (const { stdio, tty, stdin } of cases) {
      const plan = planExec(['id'], {}, stdio);
      if (plan.mode !== 'command') throw new Error('expected mode command');
      expect(plan.request.tty).toBe(tty);
      expect(plan.request.stdin).toBe(stdin);
    }
  });

  it('--no-tty forces a non-interactive session even with two TTYs', () => {
    const plan = planExec(['id'], { noTty: true }, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.tty).toBe(false);
    expect(plan.request.stdin).toBe(false);
  });

  it('refuses a relative --workdir before any SSH', () => {
    expect(() => planExec(['ls'], { workdir: 'relative/path' }, ttyBoth)).toThrow(ValidationError);
  });

  it('refuses a bad --env key without echoing the value', () => {
    let caught: unknown;
    try {
      planExec(['ls'], { env: ['1BAD=supersecret'] }, ttyBoth);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).not.toContain('supersecret');
    expect((caught as ValidationError).suggestion).not.toContain('supersecret');
  });

  it('keeps = characters inside the value', () => {
    const plan = planExec(['ls'], { env: ['KEY=a=b=c'] }, ttyBoth);
    if (plan.mode !== 'command') throw new Error('expected mode command');
    expect(plan.request.env).toEqual({ KEY: 'a=b=c' });
  });
});

describe('dockerExecCommand', () => {
  it('quotes every element, so nothing runs on the manager', () => {
    expect(dockerExecCommand('c0ffee', ['sh', '-c', 'a; b'], { stdin: true, workdir: '/srv/app', user: 'www', env: { A: 'x y' } })).toBe(
      "docker exec -i -w '/srv/app' -u 'www' -e 'A=x y' 'c0ffee' 'sh' '-c' 'a; b'",
    );
  });

  it('asks for a TTY only when the plan has one', () => {
    expect(dockerExecCommand('c0ffee', ['id'], { tty: true, stdin: true })).toBe("docker exec -it 'c0ffee' 'id'");
    expect(dockerExecCommand('c0ffee', ['id'])).toBe("docker exec 'c0ffee' 'id'");
  });
});

describe('parseExecEnv', () => {
  it('keeps every = after the first in the value, and an empty value without one', () => {
    expect(parseExecEnv(['DSN=postgres://u:p@db/x?a=b', 'EMPTY'])).toEqual({ DSN: 'postgres://u:p@db/x?a=b', EMPTY: '' });
  });

  it('is empty without --env', () => {
    expect(parseExecEnv(undefined)).toEqual({});
  });
});
