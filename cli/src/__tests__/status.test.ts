import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { runStatus, type EnvReading, type StatusDeps } from '../commands/app/status';
import { CLIError, ErrorCode } from '../utils/errors';
import * as output from '../utils/output';

const reading: EnvReading = { version: '1.4.2', deployedAt: new Date().toISOString(), services: { running: 2, desired: 2 } };

function deps(read: StatusDeps['read'], budgetMs = 8000): StatusDeps {
  return { availableEnvironments: () => ['production', 'staging'], read, budgetMs };
}

const rows: string[] = [];
const printed = spyOn(output, 'printRaw').mockImplementation((text: string) => {
  rows.push(text);
});
spyOn(output, 'printIntro').mockImplementation(() => {});
spyOn(output, 'printSection').mockImplementation(() => {});

afterEach(() => {
  rows.length = 0;
  printed.mockClear();
});

describe('status', () => {
  it('an unknown environment fails with NO_SERVERS_FOR_ENV and prints no table', async () => {
    const failure = await runStatus('preprod', deps(async () => reading)).catch((e) => e);
    expect(failure).toBeInstanceOf(CLIError);
    expect(failure.code).toBe(ErrorCode.NO_SERVERS_FOR_ENV);
    expect(rows).toEqual([]);
  });

  it('a named environment that cannot be read fails with its own error', async () => {
    const down = new CLIError('connect ECONNREFUSED', ErrorCode.CONNECTION_FAILED);
    const failure = await runStatus('production', deps(async () => { throw down; })).catch((e) => e);
    expect(failure).toBe(down);
  });

  it('a named environment that does not answer in time fails with a connection error', async () => {
    const failure = await runStatus('production', deps(() => new Promise(() => {}), 20)).catch((e) => e);
    expect(failure.code).toBe(ErrorCode.CONNECTION_FAILED);
  });

  it('the summary of every environment keeps an unavailable row and succeeds', async () => {
    await runStatus(undefined, deps(async (env) => {
      if (env === 'staging') throw new CLIError('No manager', ErrorCode.NO_SERVERS_FOR_ENV);
      return reading;
    }));
    expect(rows.some((row) => row.includes('production') && row.includes('1.4.2'))).toBe(true);
    expect(rows.some((row) => row.includes('staging') && row.includes('no manager configured'))).toBe(true);
  });

  it('clears its budget timer once the environment answers, so the process can exit', async () => {
    const created = spyOn(globalThis, 'setTimeout');
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      await runStatus('production', deps(async () => reading, 61_000));
      const index = created.mock.calls.findIndex((call) => call[1] === 61_000);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = created.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      expect(cleared.mock.calls.map((call) => call[0])).toContain(timer);
    } finally {
      created.mockRestore();
      cleared.mockRestore();
    }
  });
});
