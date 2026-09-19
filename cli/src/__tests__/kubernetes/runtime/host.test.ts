import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { HELM_CHARTS_DIR, HELM_TMP_DIR } from '../../../services/orchestrator/kubernetes/constants';
import { KubeError } from '../../../services/orchestrator/kubernetes/runtime/errors';
import {
  fileSha256Command,
  HOST_COMMAND_GUARD_S,
  helmTempDirCommand,
  hostCommands,
  installFileCommand,
  isHelmCallDir,
  LISTENING_PORTS_COMMAND,
  listenersOn,
  parseListeningPorts,
  parseSha256,
  parseTempDir,
  removeCachedChartCommand,
  removeTempDirCommand,
  touchCachedChartCommand,
  writeSecretFileCommand,
} from '../../../services/orchestrator/kubernetes/runtime/host';
import type { NodeShell } from '../../../services/orchestrator/kubernetes/runtime/node-shell';
import { TRAEFIK_CHART_PIN } from '../../../services/orchestrator/kubernetes/versions';
import { Redactor } from '../../../utils/redact';
import { fakeNode } from '../fakes/fake-kube-executor';
import { FakeNodeShell, type NodeShellStep, shellWords } from '../fakes/fake-node-shell';
import { assertExecutorInvariants } from '../support/invariants';

const CALL = '/var/lib/dockflow/helm/tmp/call.AbCdEfGhIj';
const PIN = TRAEFIK_CHART_PIN.sha256;
const DIGEST = 'b'.repeat(64);
const CACHED = `/var/lib/dockflow/helm/charts/sha256-${DIGEST}.tgz`;
const PASSWORD = 'repo-password-8812';
const redactor = new Redactor([PASSWORD]);

const SS_OUTPUT = [
  'LISTEN 0      4096         0.0.0.0:80         0.0.0.0:*',
  'LISTEN 0      511             [::]:443           [::]:*',
  'LISTEN 0      128                *:80               *:*',
  'LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*',
  'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      128   [::ffff:127.0.0.1]:9000        *:*',
  '',
].join('\n');

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let shells: FakeNodeShell[] = [];

afterEach(() => {
  assertExecutorInvariants({ nodeShell: shells, redactor });
  shells = [];
});

function setup(steps: NodeShellStep[] = [], interpret = true): { shell: FakeNodeShell; node: NodeShell } {
  const shell = new FakeNodeShell(steps, { redactor, interpretFileCommands: interpret });
  shells.push(shell);
  return { shell, node: shell.forNode(fakeNode('server_1')) };
}

/** the file names `find <dir> -name <glob> ! -name <glob> ...` selects among `names` */
function findSelects(command: string, dir: string, names: string[]): string[] {
  const words = shellWords(command);
  const start = words.findIndex((word, i) => word === 'find' && words[i + 1] === dir);
  expect(start).toBeGreaterThanOrEqual(0);
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (let i = start + 2; i < words.length && words[i] !== '}' && words[i] !== '2>'; i++) {
    const negated = words[i] === '!';
    const at = negated ? i + 1 : i;
    if (words[at] !== '-name') continue;
    const glob = new RegExp(`^${words[at + 1].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    (negated ? exclude : include).push(glob);
    i = at + 1;
  }
  return names.filter((name) => include.every((glob) => glob.test(name)) && !exclude.some((glob) => glob.test(name)));
}

describe('command builders', () => {
  it('creates a call directory with umask 077 after sweeping stale call directories and unused charts', () => {
    expect(helmTempDirCommand()).toBe(
      'umask 077 && mkdir -p /var/lib/dockflow/helm/tmp && ' +
        '{ find /var/lib/dockflow/helm/tmp -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || true; } && ' +
        `{ find /var/lib/dockflow/helm/charts -mindepth 1 -maxdepth 1 -name 'sha256-*.tgz' ! -name 'sha256-${PIN}.tgz' -mtime +30 -delete 2>/dev/null || true; } && ` +
        'mktemp -d /var/lib/dockflow/helm/tmp/call.XXXXXXXXXX',
    );
  });

  it('never sweeps the pinned Traefik chart setup placed in the cache', () => {
    const names = [`sha256-${PIN}.tgz`, `sha256-${DIGEST}.tgz`, 'traefik-41.6.0.tgz'];
    expect(findSelects(helmTempDirCommand(), HELM_CHARTS_DIR, names)).toEqual([`sha256-${DIGEST}.tgz`]);
  });

  it('builds the exact file commands, every path shell-quoted', () => {
    expect(writeSecretFileCommand(`${CALL}/repositories.yaml`)).toBe(`umask 077 && cat > '${CALL}/repositories.yaml'`);
    expect(removeTempDirCommand(CALL)).toBe(`rm -rf -- '${CALL}'`);
    expect(fileSha256Command(CACHED)).toBe(`sha256sum -- '${CACHED}' 2>/dev/null`);
    expect(installFileCommand(`${CALL}/web-1.2.0+build.3.tgz`, CACHED)).toBe(
      `mkdir -p -m 0700 '/var/lib/dockflow/helm/charts' && mv -f -- '${CALL}/web-1.2.0+build.3.tgz' '${CACHED}'`,
    );
    expect(touchCachedChartCommand(CACHED)).toBe(`touch -c -- '${CACHED}'`);
    expect(removeCachedChartCommand(CACHED)).toBe(`rm -f -- '${CACHED}'`);
    expect(LISTENING_PORTS_COMMAND).toBe('ss -Hltn');
  });

  it('removeTempDir refuses anything but a call directory', () => {
    for (const path of ['/', HELM_TMP_DIR, `${HELM_TMP_DIR}/`, `${CALL}/..`, `${HELM_TMP_DIR}/../tmp/call.AbCdEfGhIj`, `${HELM_TMP_DIR}/call.short`, `${CALL}/cache`, '/tmp/call.AbCdEfGhIj']) {
      expect(() => removeTempDirCommand(path)).toThrow(/removeTempDir refused/);
    }
    expect(isHelmCallDir(CALL)).toBe(true);
  });

  it('writeSecretFile refuses paths outside a call directory', () => {
    for (const path of ['/tmp/registry.json', `${HELM_TMP_DIR}/registry.json`, `${CALL}/../registry.json`, `${CALL}/cache/registry.json`, CALL, `${CALL}/.hidden`]) {
      expect(() => writeSecretFileCommand(path)).toThrow(/writeSecretFile refused/);
    }
  });

  it('installFile only moves call-directory files into the content-addressed cache', () => {
    expect(() => installFileCommand('/tmp/web-1.0.0.tgz', CACHED)).toThrow(/installFile refused \/tmp/);
    expect(() => installFileCommand(`${CALL}/web-1.0.0.tgz`, `${HELM_CHARTS_DIR}/web-1.0.0.tgz`)).toThrow(/installFile refused/);
    expect(() => installFileCommand(`${CALL}/web-1.0.0.tgz`, `${HELM_CHARTS_DIR}/sha256-${'B'.repeat(64)}.tgz`)).toThrow(/installFile refused/);
    expect(() => touchCachedChartCommand('/etc/passwd')).toThrow(/touchCachedChart refused/);
    expect(() => removeCachedChartCommand(`${HELM_CHARTS_DIR}/../tmp`)).toThrow(/removeCachedChart refused/);
    expect(() => fileSha256Command('relative.tgz')).toThrow(/fileSha256 refused/);
    expect(() => fileSha256Command(`${CALL}/../../x`)).toThrow(/fileSha256 refused/);
  });
});

describe('parsers', () => {
  it('parses the local address column of ss -Hltn', () => {
    expect(parseListeningPorts(SS_OUTPUT)).toEqual([
      { address: '0.0.0.0', port: 80, local: '0.0.0.0:80' },
      { address: '::', port: 443, local: '[::]:443' },
      { address: '*', port: 80, local: '*:80' },
      { address: '127.0.0.1', port: 8080, local: '127.0.0.1:8080' },
      { address: '127.0.0.53%lo', port: 53, local: '127.0.0.53%lo:53' },
      { address: '::ffff:127.0.0.1', port: 9000, local: '[::ffff:127.0.0.1]:9000' },
    ]);
  });

  it('matches listeners on 80 and 443 only', () => {
    expect(listenersOn(parseListeningPorts(SS_OUTPUT), [80, 443]).map((listener) => listener.local)).toEqual(['0.0.0.0:80', '[::]:443', '*:80']);
    expect(listenersOn(parseListeningPorts(SS_OUTPUT), [80])).toHaveLength(2);
  });

  it('ignores a header and malformed lines', () => {
    const text = 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 4096\nLISTEN 0 4096 0.0.0.0:http 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n';
    expect(parseListeningPorts(text)).toEqual([{ address: '0.0.0.0', port: 443, local: '0.0.0.0:443' }]);
  });

  it('reads the first 64 hex characters of sha256sum and null for a missing file', () => {
    expect(parseSha256({ exitCode: 0, stdout: `${DIGEST}  ${CACHED}\n`, stderr: '' })).toBe(DIGEST);
    expect(parseSha256({ exitCode: 0, stdout: `\\${DIGEST}  /var/lib/dockflow/helm/charts/odd\\nname\n`, stderr: '' })).toBe(DIGEST);
    expect(parseSha256({ exitCode: 1, stdout: '', stderr: '' })).toBeNull();
    expect(parseSha256({ exitCode: 0, stdout: 'not a hash\n', stderr: '' })).toBeNull();
  });

  it('accepts only a call directory from mktemp', () => {
    expect(parseTempDir(`${CALL}\n`)).toBe(CALL);
    expect(parseTempDir('/tmp/tmp.AbCdEfGhIj\n')).toBeNull();
    expect(parseTempDir('')).toBeNull();
  });
});

describe('hostCommands through FakeNodeShell', () => {
  it('runs the exact commands on the node file system: temp dir, secret file, archive install, cleanup', async () => {
    const { shell, node } = setup();
    const host = hostCommands(node);
    const fs = shell.fs('server_1');
    const tmp = await host.helmTempDir();
    expect(tmp).toBe('/var/lib/dockflow/helm/tmp/call.0000000001');
    expect(fs.mode(tmp)).toBe(0o700);
    await host.writeSecretFile(`${tmp}/repositories.yaml`, `password: ${PASSWORD}\n`);
    expect(fs.readText(`${tmp}/repositories.yaml`)).toBe(`password: ${PASSWORD}\n`);
    expect(fs.mode(`${tmp}/repositories.yaml`)).toBe(0o600);
    fs.write(`${tmp}/web-1.0.0.tgz`, 'archive');
    const digest = sha256('archive');
    expect(await host.fileSha256(`${tmp}/web-1.0.0.tgz`)).toBe(digest);
    const cached = `${HELM_CHARTS_DIR}/sha256-${digest}.tgz`;
    await host.installFile(`${tmp}/web-1.0.0.tgz`, cached);
    expect(fs.sha256(cached)).toBe(digest);
    await host.touchCachedChart(cached);
    await host.removeTempDir(tmp);
    expect(fs.exists(tmp)).toBe(false);
    expect(await host.fileSha256(`${tmp}/web-1.0.0.tgz`)).toBeNull();
    await host.removeCachedChart(cached);
    expect(fs.exists(cached)).toBe(false);

    expect(shell.calls.map((call) => call.script)).toEqual([
      helmTempDirCommand(),
      `umask 077 && cat > '${tmp}/repositories.yaml'`,
      `sha256sum -- '${tmp}/web-1.0.0.tgz' 2>/dev/null`,
      `mkdir -p -m 0700 '${HELM_CHARTS_DIR}' && mv -f -- '${tmp}/web-1.0.0.tgz' '${cached}'`,
      `touch -c -- '${cached}'`,
      `rm -rf -- '${tmp}'`,
      `sha256sum -- '${tmp}/web-1.0.0.tgz' 2>/dev/null`,
      `rm -f -- '${cached}'`,
    ]);
    expect(shell.calls.every((call) => call.kind === 'run' && call.node === 'server_1')).toBe(true);
    // the credential travels on stdin, never in the script
    expect(Buffer.from(shell.calls[1].stdin).toString('utf8')).toContain(PASSWORD);
    shell.assertDone();
  });

  it('passes the host command guard to the NodeShell', async () => {
    const guards: (number | null)[] = [];
    const { shell, node } = setup();
    const spied: NodeShell = {
      node: node.node,
      channel: (script) => node.channel(script),
      run: (script, options) => {
        guards.push(options.guardS);
        return node.run(script, options);
      },
    };
    await hostCommands(spied).fileSha256(CACHED);
    expect(guards).toEqual([HOST_COMMAND_GUARD_S]);
    expect(HOST_COMMAND_GUARD_S).toBe(45);
    shell.assertDone();
  });

  it('turns a failed write into a KubeError naming the node, never retried', async () => {
    const { shell, node } = setup(
      [{ script: /^umask 077 && mkdir -p/, respond: { exitCode: 1, stderr: "mkdir: cannot create directory '/var/lib/dockflow/helm/tmp': Permission denied\n" } }],
      false,
    );
    const error = await hostCommands(node)
      .helmTempDir()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).message).toBe(
      "Creating a Helm temporary directory failed on server_1 (exit 1): mkdir: cannot create directory '/var/lib/dockflow/helm/tmp': Permission denied",
    );
    expect((error as KubeError).node).toBe('server_1');
    expect(shell.calls).toHaveLength(1);
    shell.assertDone();
  });

  it('refuses a mktemp output that is not a call directory', async () => {
    const { shell, node } = setup([{ script: /mktemp -d/, respond: { exitCode: 0, stdout: '/tmp/elsewhere\n' } }], false);
    await expect(hostCommands(node).helmTempDir()).rejects.toThrow(/mktemp did not print a Helm call directory on server_1/);
    shell.assertDone();
  });

  it('retries a read once on a lost transport, never on a non-zero exit, and never retries a write', async () => {
    const { shell, node } = setup(
      [
        { id: 'lost', script: /^sha256sum/, respond: { transportError: true } },
        { id: 'answer', script: /^sha256sum/, respond: { exitCode: 0, stdout: `${DIGEST}  ${CACHED}\n` } },
        { id: 'missing', script: /^sha256sum/, respond: { exitCode: 1 } },
        { id: 'install lost', script: /^mkdir -p -m 0700/, respond: { transportError: true } },
      ],
      false,
    );
    const host = hostCommands(node);
    expect(await host.fileSha256(CACHED)).toBe(DIGEST);
    expect(await host.fileSha256(CACHED)).toBeNull();
    expect(shell.calls.map((call) => call.step)).toEqual(['lost', 'answer', 'missing']);
    await expect(host.installFile(`${CALL}/web-1.0.0.tgz`, CACHED)).rejects.toMatchObject({ reason: 'Unreachable' });
    expect(shell.calls).toHaveLength(4);
    shell.assertDone();
  });

  it('gives up after the second lost transport of a read', async () => {
    const { shell, node } = setup([{ script: /^ss -Hltn$/, respond: { transportError: true }, times: 2 }], false);
    await expect(hostCommands(node).listeningPorts()).rejects.toMatchObject({ reason: 'Unreachable' });
    expect(shell.calls).toHaveLength(2);
    shell.assertDone();
  });

  it('lists listeners, null when ss is missing, an error on any other failure', async () => {
    const { shell, node } = setup(
      [
        { script: /^ss -Hltn$/, respond: { exitCode: 0, stdout: SS_OUTPUT } },
        { script: /^ss -Hltn$/, respond: { exitCode: 127, stderr: 'sh: 1: ss: not found\n' } },
        { script: /^ss -Hltn$/, respond: { exitCode: 1, stderr: 'Cannot open netlink socket: Permission denied\n' } },
      ],
      false,
    );
    const host = hostCommands(node);
    expect(listenersOn((await host.listeningPorts()) ?? [], [80, 443])).toHaveLength(3);
    expect(await host.listeningPorts()).toBeNull();
    await expect(host.listeningPorts()).rejects.toThrow('Listing listening ports failed on server_1 (exit 1): Cannot open netlink socket: Permission denied');
    shell.assertDone();
  });

  it('runs on the node the NodeShell is bound to', async () => {
    const shell = new FakeNodeShell([{ node: 'server_2', script: /^ss -Hltn$/, respond: { exitCode: 0, stdout: SS_OUTPUT } }], { redactor });
    shells.push(shell);
    const host = hostCommands(shell.forNode(fakeNode('server_2')));
    expect(host.node.name).toBe('server_2');
    expect(await host.listeningPorts()).toHaveLength(6);
    expect(shell.calls[0].node).toBe('server_2');
    shell.assertDone();
  });
});
