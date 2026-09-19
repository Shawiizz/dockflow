// `healthcheck` -> HealthSpec with Docker's timing defaults (design-01 5.7, D10). The probe fields
// and the startup-probe arithmetic are the translator's (design-02 5.6, K35); nothing here rounds
// to seconds. Pure.

import type { HealthSpec } from '../model/types';
import { childPath, HEALTHCHECK_DEFAULTS, isPlainMap, type NormalizeContext, type ServiceDraft } from './context';
import { isAbsent, readBool, readDuration, readInt, reportInvalidType } from './env';

const RETRIES_MAX = 2_147_483_647;

export interface HealthcheckResult {
  spec: HealthSpec | null;
  /** `disable: true` or `test: [NONE]` was written */
  disabled: boolean;
}

/** Docker: an absent or zero duration takes the default */
function durationOr(node: Record<string, unknown>, key: string, fallback: number, path: string, ctx: NormalizeContext): number {
  if (isAbsent(node[key])) return fallback;
  const ms = readDuration(node[key], childPath(path, key), ctx);
  return ms === null || ms === 0 ? fallback : ms;
}

function readTest(node: Record<string, unknown>, path: string, ctx: NormalizeContext): HealthSpec['test'] | 'none' | null {
  const testPath = childPath(path, 'test');
  const test = typeof node.test === 'string' ? ['CMD-SHELL', node.test] : node.test;
  if (isAbsent(test) || (Array.isArray(test) && test.length === 0)) {
    ctx.sink.warn(
      'healthcheck.inherits-image',
      path,
      'this healthcheck inherits the image HEALTHCHECK, which Kubernetes ignores: no probe is created',
      'Write the check command in `test`, or remove `healthcheck`.',
    );
    return null;
  }
  if (!Array.isArray(test) || test.some((t) => typeof t !== 'string')) {
    reportInvalidType(ctx, testPath, 'string or list', test);
    return null;
  }
  const words = test as string[];
  const emptyTest = (): null => {
    ctx.sink.error('healthcheck.empty-test', testPath, 'test has no command', 'Add the command, for example `["CMD", "curl", "-f", "http://localhost"]`.');
    return null;
  };
  switch (words[0]) {
    case 'NONE':
      return 'none';
    case 'CMD':
      if (words.length < 2 || words[1] === '') return emptyTest();
      return { type: 'exec', argv: words.slice(1) };
    case 'CMD-SHELL':
      if (words.length !== 2) {
        ctx.sink.error(
          'healthcheck.cmd-shell-arity',
          testPath,
          'CMD-SHELL takes exactly one command string',
          'Join the command into one string: `["CMD-SHELL", "<command and arguments>"]`.',
        );
        return null;
      }
      if (words[1].trim() === '') return emptyTest();
      return { type: 'shell', command: words[1] };
    default:
      ctx.sink.error('healthcheck.invalid-test', testPath, 'the first element of test must be CMD, CMD-SHELL or NONE');
      return null;
  }
}

/**
 * design-01 5.7. Absent -> null (no probes, C1). Timings are validated even when `test` is not
 * usable, so one pass reports every problem.
 */
export function readHealthcheck(value: unknown, path: string, ctx: NormalizeContext): HealthcheckResult {
  if (isAbsent(value)) return { spec: null, disabled: false };
  if (!isPlainMap(value)) {
    reportInvalidType(ctx, path, 'mapping', value);
    return { spec: null, disabled: false };
  }
  if (!isAbsent(value.disable) && readBool(value.disable, childPath(path, 'disable'), ctx) === true) {
    return { spec: null, disabled: true };
  }
  const test = readTest(value, path, ctx);
  if (test === 'none') return { spec: null, disabled: true };

  const intervalMs = durationOr(value, 'interval', HEALTHCHECK_DEFAULTS.intervalMs, path, ctx);
  const timeoutMs = durationOr(value, 'timeout', HEALTHCHECK_DEFAULTS.timeoutMs, path, ctx);
  const startPeriodMs = durationOr(value, 'start_period', HEALTHCHECK_DEFAULTS.startPeriodMs, path, ctx);
  const startIntervalMs = durationOr(value, 'start_interval', HEALTHCHECK_DEFAULTS.startIntervalMs, path, ctx);
  let retries = HEALTHCHECK_DEFAULTS.retries;
  if (!isAbsent(value.retries)) {
    // Docker: retries <= 0 takes the default; a negative value is refused by the schema
    const n = readInt(value.retries, childPath(path, 'retries'), 0, RETRIES_MAX, ctx);
    if (n !== null && n > 0) retries = n;
  }
  if (test === null) return { spec: null, disabled: false };
  return { spec: { test, intervalMs, timeoutMs, retries, startPeriodMs, startIntervalMs, path }, disabled: false };
}

/** design-01 5.7 signature: the HealthSpec alone */
export function normalizeHealthcheck(value: unknown, path: string, ctx: NormalizeContext): HealthSpec | null {
  return readHealthcheck(value, path, ctx).spec;
}

/** design-01 1.1 step 12 */
export function healthcheck(draft: ServiceDraft, node: Record<string, unknown>, ctx: NormalizeContext): void {
  if (ctx.isFatal(draft.path)) return;
  const result = readHealthcheck(node.healthcheck, childPath(draft.path, 'healthcheck'), ctx);
  draft.healthcheck = result.spec;
  draft.healthcheckDisabled = result.disabled;
}
