import { describe, expect, test } from 'bun:test';
import type { Diagnostic } from '../../../services/orchestrator/diagnostics';
import type { HealthSpec } from '../../../services/orchestrator/kubernetes/model/types';
import type { ServiceDraft } from '../../../services/orchestrator/kubernetes/normalize/context';
import {
  healthcheck as normalizeHealth,
  normalizeHealthcheck,
  readHealthcheck,
} from '../../../services/orchestrator/kubernetes/normalize/healthcheck';
import { normalizeContext, serviceDraft } from '../support/builders';

/** design-01 codes healthcheck.ts may emit (5.7 and the value layer it reads through) */
const HEALTHCHECK_CODES = new Set([
  'healthcheck.inherits-image',
  'healthcheck.empty-test',
  'healthcheck.cmd-shell-arity',
  'healthcheck.invalid-test',
  'values.invalid-type',
  'values.invalid-boolean',
  'values.yaml11-boolean',
  'values.invalid-duration',
  'values.negative-duration',
  'values.duration-too-large',
  'values.invalid-integer',
]);

const emitted = new Set<string>();

function run(healthcheck: unknown): { draft: ServiceDraft; diagnostics: Diagnostic[] } {
  const ctx = normalizeContext();
  const draft = serviceDraft('web', ctx);
  normalizeHealth(draft, healthcheck === undefined ? {} : { healthcheck }, ctx);
  const diagnostics = ctx.sink.list();
  for (const d of diagnostics) emitted.add(d.code);
  return { draft, diagnostics };
}

const brief = (ds: Diagnostic[]): [string, string, string][] => ds.map((d) => [d.severity, d.code, d.path]);

/** A HealthSpec with Docker's defaults (D10) and the given handler. */
function spec(test: HealthSpec['test'], timings: Partial<Omit<HealthSpec, 'test' | 'path'>> = {}): HealthSpec {
  return {
    test,
    intervalMs: 30_000,
    timeoutMs: 30_000,
    retries: 3,
    startPeriodMs: 0,
    startIntervalMs: 5_000,
    path: 'services.web.healthcheck',
    ...timings,
  };
}

const CMD_X = ['CMD', 'x'];

describe('healthcheck -> HealthSpec (design-01 5.7)', () => {
  test('HC-01: no healthcheck, no probes', () => {
    const { draft, diagnostics } = run(undefined);
    expect(draft.healthcheck).toBeNull();
    expect(draft.healthcheckDisabled).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(run(null).draft.healthcheck).toBeNull();
  });

  test('HC-02: a string test and CMD-SHELL are shell handlers', () => {
    const string = run({ test: 'pg_isready -U app' });
    expect(string.draft.healthcheck).toEqual(spec({ type: 'shell', command: 'pg_isready -U app' }));
    expect(string.diagnostics).toEqual([]);
    const shell = run({ test: ['CMD-SHELL', 'curl -f http://localhost || exit 1'] });
    expect(shell.draft.healthcheck).toEqual(spec({ type: 'shell', command: 'curl -f http://localhost || exit 1' }));
    expect(shell.diagnostics).toEqual([]);
  });

  test('HC-03: CMD is an exec handler with the remaining elements', () => {
    const { draft, diagnostics } = run({ test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/health'] });
    expect(draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['wget', '-qO-', 'http://localhost:3000/health'] }));
    expect(diagnostics).toEqual([]);
  });

  test('HC-04: NONE and disable: true give no probes and are recorded as disabled', () => {
    for (const hc of [{ test: ['NONE'] }, { disable: true, test: CMD_X }]) {
      const { draft, diagnostics } = run(hc);
      expect(draft.healthcheck).toBeNull();
      expect(draft.healthcheckDisabled).toBe(true);
      expect(diagnostics).toEqual([]);
    }
    const kept = run({ disable: false, test: CMD_X });
    expect(kept.draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }));
    expect(kept.draft.healthcheckDisabled).toBe(false);
  });

  test('disable: YAML 1.1 spellings are warned, other values refused', () => {
    const yes = run({ disable: 'yes', test: CMD_X });
    expect(yes.draft.healthcheck).toBeNull();
    expect(brief(yes.diagnostics)).toEqual([['warning', 'values.yaml11-boolean', 'services.web.healthcheck.disable']]);
    const bad = run({ disable: 'maybe', test: CMD_X });
    expect(bad.draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }));
    expect(brief(bad.diagnostics)).toEqual([['error', 'values.invalid-boolean', 'services.web.healthcheck.disable']]);
  });

  test('HC-05: no test inherits the image HEALTHCHECK, which Kubernetes ignores', () => {
    for (const hc of [{ interval: '10s' }, { test: [] }]) {
      const { draft, diagnostics } = run(hc);
      expect(draft.healthcheck).toBeNull();
      expect(draft.healthcheckDisabled).toBe(false);
      expect(diagnostics).toEqual([
        {
          severity: 'warning',
          code: 'healthcheck.inherits-image',
          path: 'services.web.healthcheck',
          message: 'this healthcheck inherits the image HEALTHCHECK, which Kubernetes ignores: no probe is created',
          hint: 'Write the check command in `test`, or remove `healthcheck`.',
        },
      ]);
    }
  });

  test('HC-06: an empty CMD, a CMD-SHELL with several strings and an unknown first element are refused', () => {
    const empty: Diagnostic = {
      severity: 'error',
      code: 'healthcheck.empty-test',
      path: 'services.web.healthcheck.test',
      message: 'test has no command',
      hint: 'Add the command, for example `["CMD", "curl", "-f", "http://localhost"]`.',
    };
    for (const words of [['CMD'], ['CMD', ''], ['CMD-SHELL', '  ']]) {
      const { draft, diagnostics } = run({ test: words });
      expect(draft.healthcheck).toBeNull();
      expect(diagnostics).toEqual([empty]);
    }
    for (const words of [['CMD-SHELL', 'a', 'b'], ['CMD-SHELL']]) {
      expect(run({ test: words }).diagnostics).toEqual([
        {
          severity: 'error',
          code: 'healthcheck.cmd-shell-arity',
          path: 'services.web.healthcheck.test',
          message: 'CMD-SHELL takes exactly one command string',
          hint: 'Join the command into one string: `["CMD-SHELL", "<command and arguments>"]`.',
        },
      ]);
    }
    const shell = run({ test: ['SHELL', 'x'] });
    expect(shell.draft.healthcheck).toBeNull();
    expect(shell.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'healthcheck.invalid-test',
        path: 'services.web.healthcheck.test',
        message: 'the first element of test must be CMD, CMD-SHELL or NONE',
      },
    ]);
  });

  test('HC-07: zero durations and zero retries take the Docker defaults', () => {
    const { draft, diagnostics } = run({ test: CMD_X, interval: '0s', timeout: '5s', retries: 0 });
    expect(draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }, { intervalMs: 30_000, timeoutMs: 5_000, retries: 3 }));
    expect(diagnostics).toEqual([]);
    expect(run({ test: CMD_X, interval: '0', start_interval: '0s' }).draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }));
    expect(run({ test: CMD_X, retries: '5' }).draft.healthcheck?.retries).toBe(5);
  });

  test('HC-07: negative or non-integer retries are refused and keep the default', () => {
    for (const retries of [-1, 1.5, 'three']) {
      const { draft, diagnostics } = run({ test: CMD_X, retries });
      expect(draft.healthcheck?.retries).toBe(3);
      expect(diagnostics).toEqual([
        {
          severity: 'error',
          code: 'values.invalid-integer',
          path: 'services.web.healthcheck.retries',
          message: `expected an integer between 0 and 2147483647, got ${retries}`,
          hint: 'Write a whole number.',
        },
      ]);
    }
  });

  test('HC-08: start_period and start_interval are stored in milliseconds, unrounded (probe arithmetic is the translator’s)', () => {
    expect(run({ test: CMD_X, start_period: '40s' }).draft.healthcheck).toEqual(
      spec({ type: 'exec', argv: ['x'] }, { startPeriodMs: 40_000, startIntervalMs: 5_000 }),
    );
    const subSecond = run({ test: CMD_X, interval: '1500ms', start_period: '500ms', start_interval: '2s', timeout: '1m30s' });
    expect(subSecond.draft.healthcheck).toEqual(
      spec({ type: 'exec', argv: ['x'] }, { intervalMs: 1_500, startPeriodMs: 500, startIntervalMs: 2_000, timeoutMs: 90_000 }),
    );
  });

  test('durations that are not valid are refused and keep the default', () => {
    const { draft, diagnostics } = run({ test: CMD_X, interval: 30, timeout: '-1s', start_interval: '9999999999h' });
    expect(draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }));
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-duration',
        path: 'services.web.healthcheck.interval',
        message: '30 is not a duration',
        hint: 'Use a duration such as `30s`, `1m30s` or `500ms`.',
      },
      {
        severity: 'error',
        code: 'values.duration-too-large',
        path: 'services.web.healthcheck.start_interval',
        message: '9999999999h is too large',
      },
      {
        severity: 'error',
        code: 'values.negative-duration',
        path: 'services.web.healthcheck.timeout',
        message: '-1s must not be negative',
      },
    ]);
  });

  test('timings are checked even when the test is refused, so one pass reports every problem', () => {
    expect(brief(run({ test: ['SHELL', 'x'], interval: 'soon' }).diagnostics)).toEqual([
      ['error', 'values.invalid-duration', 'services.web.healthcheck.interval'],
      ['error', 'healthcheck.invalid-test', 'services.web.healthcheck.test'],
    ]);
  });

  test('a healthcheck or a test of another type is refused', () => {
    expect(run('CMD x').diagnostics).toEqual([
      {
        severity: 'error',
        code: 'values.invalid-type',
        path: 'services.web.healthcheck',
        message: 'expected mapping, got string',
        hint: 'See the Compose specification for the accepted forms.',
      },
    ]);
    expect(brief(run({ test: 5 }).diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.healthcheck.test']]);
    const items = run({ test: ['CMD', 1] });
    expect(items.draft.healthcheck).toBeNull();
    expect(brief(items.diagnostics)).toEqual([['error', 'values.invalid-type', 'services.web.healthcheck.test']]);
  });

  test('x-* keys inside healthcheck are silent by spec', () => {
    const { draft, diagnostics } = run({ test: CMD_X, 'x-note': 'checked by the platform team' });
    expect(draft.healthcheck).toEqual(spec({ type: 'exec', argv: ['x'] }));
    expect(diagnostics).toEqual([]);
  });

  test('the design-01 5.7 signature returns the HealthSpec alone', () => {
    const ctx = normalizeContext();
    expect(normalizeHealthcheck({ test: 'true' }, 'services.api.healthcheck', ctx)).toEqual({
      ...spec({ type: 'shell', command: 'true' }),
      path: 'services.api.healthcheck',
    });
    expect(normalizeHealthcheck({ test: ['NONE'] }, 'services.api.healthcheck', ctx)).toBeNull();
    expect(readHealthcheck({ test: ['NONE'] }, 'services.api.healthcheck', ctx)).toEqual({ spec: null, disabled: true });
    expect(ctx.sink.list()).toEqual([]);
  });
});

describe('handler contract', () => {
  test('a service marked fatal is skipped', () => {
    const ctx = normalizeContext();
    const draft = serviceDraft('web', ctx);
    ctx.markFatal(draft.path);
    normalizeHealth(draft, { healthcheck: { test: ['SHELL'] } }, ctx);
    expect(ctx.sink.list()).toEqual([]);
    expect(draft.healthcheck).toBeNull();
  });

  test('every code emitted in this file is a design-01 code of healthcheck.ts, and every such code is exercised', () => {
    expect([...emitted].filter((code) => !HEALTHCHECK_CODES.has(code))).toEqual([]);
    expect([...HEALTHCHECK_CODES].filter((code) => !emitted.has(code))).toEqual([]);
  });
});
