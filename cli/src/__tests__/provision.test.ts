import { describe, expect, it } from 'bun:test';
import {
  buildPortainerVhost,
  DOCKFLOW_BASE_DIR,
  ensureDockflowDir,
  parseHtpasswdHash,
  provisionHost,
  provisionMessages,
  run,
} from '../commands/setup/provision';
import type { HostConfig } from '../commands/setup/types';
import { CLIError } from '../utils/errors';
import { FakeHostRunner } from './kubernetes/fakes/fake-host-runner';

describe('buildPortainerVhost', () => {
  it('proxies the domain to the local portainer port', () => {
    const vhost = buildPortainerVhost('portainer.example.com', 9100);
    expect(vhost).toContain('listen 80;');
    expect(vhost).toContain('server_name portainer.example.com;');
    expect(vhost).toContain('proxy_pass http://127.0.0.1:9100;');
    expect(vhost).toContain('proxy_set_header X-Forwarded-Proto $scheme;');
  });
});

describe('parseHtpasswdHash', () => {
  it('extracts the bcrypt hash from htpasswd output', () => {
    const out = 'admin:$2y$05$abcdefghijklmnopqrstuv\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$abcdefghijklmnopqrstuv');
  });

  it('tolerates leading noise lines (docker pull output)', () => {
    const out = 'Unable to find image locally\nadmin:$2y$05$hash\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$hash');
  });

  it('skips noise lines that contain colons', () => {
    const out = 'Status: Downloaded newer image\nadmin:$2y$05$hash\n';
    expect(parseHtpasswdHash(out)).toBe('$2y$05$hash');
  });

  it('returns null for non-credential output', () => {
    expect(parseHtpasswdHash('')).toBeNull();
    expect(parseHtpasswdHash('some error')).toBeNull();
    expect(parseHtpasswdHash('warning: something:else\n')).toBeNull();
  });
});

describe('run (reused by the k3s HostRunner)', () => {
  const bun = process.execPath;

  it('captures output, passes stdin and reports the exit code', () => {
    const echoed = run([bun, '-e', 'process.stdin.pipe(process.stdout)'], { quiet: true, input: 'hello' });
    expect(echoed).toMatchObject({ ok: true, exitCode: 0, stdout: 'hello', timedOut: false });
    const failed = run([bun, '-e', 'process.stderr.write("boom"); process.exit(3)'], { quiet: true });
    expect(failed).toMatchObject({ ok: false, exitCode: 3, stderr: 'boom', timedOut: false });
  });

  it('replaces the whole child environment when env is given', () => {
    process.env.DOCKFLOW_PROVISION_TEST_MARKER = 'leaked';
    try {
      const result = run([bun, '-e', 'process.stdout.write(`${process.env.ONLY ?? "-"}/${process.env.DOCKFLOW_PROVISION_TEST_MARKER ?? "-"}`)'], {
        quiet: true,
        env: { ONLY: 'set', PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
      });
      expect(result.stdout).toBe('set/-');
    } finally {
      delete process.env.DOCKFLOW_PROVISION_TEST_MARKER;
    }
  });

  it('reports a missing binary as 127 and a timeout as timedOut', () => {
    expect(run(['dockflow-no-such-command-xyz'], { quiet: true })).toMatchObject({ ok: false, exitCode: 127, timedOut: false });
    const slow = run([bun, '-e', 'setTimeout(() => {}, 10000)'], { quiet: true, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, exitCode: 124, timedOut: true });
  });
});

describe('ensureDockflowDir (19.2)', () => {
  it('runs mkdir, chown and chmod by argv: the user name never reaches a shell', async () => {
    const runner = new FakeHostRunner();
    runner.addUser('deploy');
    await ensureDockflowDir('deploy', runner);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ['mkdir', '-p', '--', DOCKFLOW_BASE_DIR],
      ['chown', '--', 'deploy:deploy', DOCKFLOW_BASE_DIR],
      ['chmod', '--', '0750', DOCKFLOW_BASE_DIR],
    ]);
    expect(runner.files.get(DOCKFLOW_BASE_DIR)).toMatchObject({ type: 'directory', mode: 0o750, uid: 1000, gid: 1000 });
    runner.assertDone();
  });

  it('fails with the command output', async () => {
    const runner = new FakeHostRunner();
    runner.on(['chown'], { exitCode: 1, stderr: "chown: invalid user: 'ghost:ghost'\n" });
    const error = await ensureDockflowDir('ghost', runner).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toBe("Failed to prepare /var/lib/dockflow: chown: invalid user: 'ghost:ghost'");
    runner.assertDone();
  });
});

describe('provisionHost with k3s (19.2)', () => {
  const config: HostConfig = {
    publicHost: '203.0.113.10',
    sshPort: 22,
    deployUser: 'deploy',
    privateKeyPath: '/root/.ssh/deploy_key',
    skipDockerInstall: false,
    orchestrator: 'k3s',
    installNginx: false,
    portainer: { install: true, port: 9000 },
  };

  it('refuses Portainer before touching the host', async () => {
    const error = await provisionHost(config).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toBe('Portainer requires Docker and is not supported with --orchestrator k3s');
  });

  it('says why Docker is skipped and warns about nginx and the proxy ports', () => {
    expect(provisionMessages.dockerSkippedK3s).toBe('Docker install skipped: k3s runs its own containerd');
    expect(provisionMessages.dockerSkippedK3s).not.toContain('setup k3s');
    expect(provisionMessages.nginxWithK3s).toContain('80 and 443');
    expect(provisionMessages.nginxWithK3s).toContain('proxy.enabled');
  });
});
