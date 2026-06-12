import { describe, expect, it } from 'bun:test';
import { buildForwardFlags, buildBinaryDownloadUrl } from '../commands/setup/forward';

const REMOTE = { host: '203.0.113.7', port: 22 };

describe('buildForwardFlags', () => {
  it('always forwards host/port defaults from the SSH target', () => {
    const flags = buildForwardFlags({}, REMOTE);
    expect(flags.join(' ')).toBe("--host '203.0.113.7' --port '22'");
  });

  it('explicit --host/--port win over the connection defaults', () => {
    const flags = buildForwardFlags({ host: 'public.example.com', port: '2222' }, REMOTE).join(' ');
    expect(flags).toContain("--host 'public.example.com'");
    expect(flags).toContain("--port '2222'");
  });

  it('forwards identity flags so a deploy user can be created remotely', () => {
    const flags = buildForwardFlags(
      { user: 'dockflow', deployPassword: 'secret', yes: true },
      REMOTE,
    ).join(' ');
    expect(flags).toContain("--user 'dockflow'");
    expect(flags).toContain("--password 'secret'");
    expect(flags).toContain('--generate-key');
    expect(flags).toContain('--yes');
  });

  it('quotes values containing spaces and shell metacharacters', () => {
    const flags = buildForwardFlags(
      { portainer: true, portainerPassword: "P@ss word'$x" },
      REMOTE,
    ).join(' ');
    expect(flags).toContain("--portainer-password 'P@ss word'\\''$x'");
  });

  it('forwards provisioning options including the previously-missing domain', () => {
    const flags = buildForwardFlags(
      {
        skipDockerInstall: true,
        orchestrator: 'k3s',
        nginx: true,
        portainer: true,
        portainerPort: '9100',
        portainerDomain: 'portainer.example.com',
      },
      REMOTE,
    ).join(' ');
    expect(flags).toContain('--skip-docker-install');
    expect(flags).toContain("--orchestrator 'k3s'");
    expect(flags).toContain('--nginx');
    expect(flags).toContain("--portainer-port '9100'");
    expect(flags).toContain("--portainer-domain 'portainer.example.com'");
  });

  it('no user flag → no password/generate-key forwarded', () => {
    const flags = buildForwardFlags({ deployPassword: 'x' }, REMOTE).join(' ');
    expect(flags).not.toContain('--user');
    expect(flags).not.toContain('--password');
    expect(flags).not.toContain('--generate-key');
  });
});

describe('buildBinaryDownloadUrl', () => {
  const BASE = 'https://github.com/Shawiizz/dockflow/releases/latest/download';

  it('pins the URL to the CLI version', () => {
    expect(buildBinaryDownloadUrl(BASE, '2.1.0', 'dockflow-linux-x64')).toBe(
      'https://github.com/Shawiizz/dockflow/releases/download/2.1.0/dockflow-linux-x64',
    );
  });

  it('dev builds fall back to the latest release', () => {
    expect(buildBinaryDownloadUrl(BASE, '0.0.0-dev', 'dockflow-linux-x64')).toBe(`${BASE}/dockflow-linux-x64`);
    expect(buildBinaryDownloadUrl(BASE, '', 'dockflow-linux-x64')).toBe(`${BASE}/dockflow-linux-x64`);
  });
});
