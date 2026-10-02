import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SSHExecResult, SSHKeyConnection } from '../types';

// ---------------------------------------------------------------------------
// SSH mock — must be installed before importing Lock. Each test scripts the
// result of a command by its text; commands are recorded in order.
// ---------------------------------------------------------------------------

type Responder = (cmd: string) => SSHExecResult | undefined;

const executedCommands: string[] = [];
let sshResponses: Responder = () => undefined;

const okResult = (stdout = ''): SSHExecResult => ({ stdout, stderr: '', exitCode: 0 });

const realSsh = await import('../utils/ssh');
mock.module('../utils/ssh', () => ({
  ...realSsh,
  sshExec: async (_conn: unknown, cmd: string): Promise<SSHExecResult> => {
    executedCommands.push(cmd);
    return sshResponses(cmd) ?? okResult();
  },
  sshExecChannel: async (_conn: unknown, cmd: string) => {
    executedCommands.push(cmd);
    return {
      stream: { end: (_data?: unknown) => {} },
      done: Promise.resolve(sshResponses(cmd) ?? okResult()),
    };
  },
}));

const { createLock } = await import('../services/lock');
const { DOCKFLOW_LOCKS_DIR } = await import('../constants');

const CONNECTION: SSHKeyConnection = { host: 'server.example.com', port: 22, user: 'deploy', privateKey: 'test-key' };
const LOCK_FILE = `${DOCKFLOW_LOCKS_DIR}/shop-production.lock`;

beforeEach(() => {
  executedCommands.length = 0;
  sshResponses = () => undefined;
});

describe('Lock.acquire', () => {
  it('creates the locks directory before writing anything, as a new server has none', async () => {
    sshResponses = (cmd) => (cmd.includes('set -C') ? okResult('ACQUIRED') : undefined);
    const result = await createLock(CONNECTION, 'shop-production').acquire({ version: '1.4.2' });
    expect(result.success).toBe(true);
    expect(executedCommands[0]).toStartWith(`mkdir -p "${DOCKFLOW_LOCKS_DIR}" && cat > "${LOCK_FILE}.tmp.`);
  });

  it('reports a write that failed, rather than a lock that is held', async () => {
    const denied = `mkdir: cannot create directory '${DOCKFLOW_LOCKS_DIR}': Permission denied`;
    sshResponses = (cmd) => (cmd.includes('cat >') ? { stdout: '', stderr: `${denied}\n`, exitCode: 1 } : undefined);
    const result = await createLock(CONNECTION, 'shop-production').acquire();
    expect(result).toEqual({ success: false, error: new Error(`Cannot write the lock file in ${DOCKFLOW_LOCKS_DIR}: ${denied}`) });
    expect(executedCommands.some((cmd) => cmd.includes('set -C'))).toBe(false);
  });

  it('fails a forced lock whose file could not be written', async () => {
    sshResponses = (cmd) => (cmd.includes('cat >') ? { stdout: '', stderr: 'No space left on device\n', exitCode: 1 } : undefined);
    const result = await createLock(CONNECTION, 'shop-production').acquire({ force: true });
    expect(result).toEqual({ success: false, error: new Error(`Cannot write the lock file in ${DOCKFLOW_LOCKS_DIR}: No space left on device`) });
    expect(executedCommands).toEqual([`mkdir -p "${DOCKFLOW_LOCKS_DIR}" && rm -f "${LOCK_FILE}"`, `mkdir -p "${DOCKFLOW_LOCKS_DIR}" && cat > "${LOCK_FILE}"`]);
  });
});
