import { describe, expect, it } from 'bun:test';
import { connectionFailure } from '../utils/ssh';
import { ConnectionError, ErrorCode } from '../utils/errors';

const conn = { host: 'node-1', port: 22, user: 'dockflow', privateKey: 'key' };

describe('connectionFailure', () => {
  it('turns a refused key into a connection error that points to dockflow setup', () => {
    const failure = connectionFailure(conn, new Error('All configured authentication methods failed'));

    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).code).toBe(ErrorCode.SSH_AUTH_FAILED);
    expect((failure as ConnectionError).message).toBe(
      'SSH authentication as dockflow on node-1 was refused: All configured authentication methods failed',
    );
    expect((failure as ConnectionError).suggestion).toContain('dockflow setup');
  });

  it('leaves an unreachable host as it is', () => {
    const refused = new Error('connect ECONNREFUSED 10.0.0.1:22');

    expect(connectionFailure(conn, refused)).toBe(refused);
  });
});
