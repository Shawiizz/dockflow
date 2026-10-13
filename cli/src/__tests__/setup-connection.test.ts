import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { displayConnectionInfo } from '../commands/setup/connection';
import { parseConnectionString } from '../utils/connection-parser';
import * as hostKeys from '../utils/host-key';
import * as output from '../utils/output';
import type { HostConfig } from '../commands/setup/types';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
const CONFIG_KEY = 'SHA256:' + 'a'.repeat(43);
const SSHD_KEY = 'SHA256:' + 'b'.repeat(43);

const config: HostConfig = {
  publicHost: '203.0.113.7',
  sshPort: 22,
  deployUser: 'deploy',
  privateKeyPath: '/unused',
  skipDockerInstall: false,
  installNginx: false,
  portFilter: true,
};

const spies: { mockRestore(): void }[] = [];
afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));

/** The connection string `dockflow setup` prints, decoded. */
function printedConnection(sshdKey: string | null, given?: string) {
  spies.push(spyOn(hostKeys, 'localHostKey').mockReturnValue(sshdKey));
  const lines: string[] = [];
  spies.push(spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' '))));
  for (const name of ['printWarning', 'printDim', 'printError', 'printInfo'] as const) {
    spies.push(spyOn(output, name).mockImplementation((message: string) => void lines.push(message)));
  }

  displayConnectionInfo({ ...config, hostKey: given }, PRIVATE_KEY);

  const parsed = lines.map((line) => parseConnectionString(line.trim())).find((result) => result.success);
  if (!parsed?.success) throw new Error('no connection string was printed');
  return { connection: parsed.data, output: lines.join('\n') };
}

describe('the connection string dockflow setup prints', () => {
  it('pins the host key sshd presents on this machine', () => {
    const { connection, output } = printedConnection(SSHD_KEY);
    expect(connection.hostKey).toBe(SSHD_KEY);
    expect(output).toContain(SSHD_KEY);
  });

  it('pins the host key it was given instead', () => {
    expect(printedConnection(SSHD_KEY, CONFIG_KEY).connection.hostKey).toBe(CONFIG_KEY);
  });

  it('pins nothing, and says so, when no host key can be read', () => {
    const { connection, output } = printedConnection(null);
    expect(connection.hostKey).toBeUndefined();
    expect(output).toContain('does not pin it');
  });
});
