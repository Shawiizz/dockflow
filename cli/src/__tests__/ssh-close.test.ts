import { describe, expect, it } from 'bun:test';
import { type AddressInfo, createServer, type Socket } from 'net';
import { utils } from 'ssh2';
import type * as SshModule from '../utils/ssh';

// Other files mock utils/ssh; the query suffix loads its own instance, whose pool this file closes.
const UNMOCKED_SSH = '../utils/ssh/index.ts?unmocked';
const { closeAllConnections, sshExec } = (await import(UNMOCKED_SSH)) as typeof SshModule;

describe('closeAllConnections: a handshake in progress', () => {
  it('is abandoned at once, not retried until its timeouts run out (a down node kept each command alive ~30s)', async () => {
    const sockets = new Set<Socket>();
    // accepts TCP and never speaks SSH, as a host that went down behind a provider network can
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    const port = await new Promise<number>((resolve) => {
      silent.listen(0, '127.0.0.1', () => resolve((silent.address() as AddressInfo).port));
    });
    const privateKey = utils.generateKeyPairSync('ed25519').private;
    try {
      const pending = sshExec({ host: '127.0.0.1', port, user: 'deploy', privateKey }, 'never-runs').then(
        () => undefined,
        (error: unknown) => error,
      );
      await Bun.sleep(100);
      const closedAt = Date.now();
      closeAllConnections();
      expect(await pending).toBeInstanceOf(Error);
      expect(Date.now() - closedAt).toBeLessThan(1000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
