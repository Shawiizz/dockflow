import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import {
  MAKE_TEMP_DIR_COMMAND,
  archFromMachine,
  buildBinaryDownloadUrl,
  buildForwardFlags,
  expectedBinaryVersion,
  installUploadCommand,
  isDevVersion,
  printsVersion,
  removeDirCommand,
  tempDirFrom,
  verifiedDownloadCommand,
} from '../commands/setup/forward';
import { resolveLocalBash } from '../services/hook';

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
      { user: 'dockflow', deployPassword: "P@ss word'$x" },
      REMOTE,
    ).join(' ');
    expect(flags).toContain("--password 'P@ss word'\\''$x'");
  });

  it('forwards provisioning options', () => {
    const flags = buildForwardFlags(
      {
        skipDockerInstall: true,
        nginx: true,
      },
      REMOTE,
    ).join(' ');
    expect(flags).toContain('--skip-docker-install');
    expect(flags).not.toContain('--orchestrator');
    expect(flags).toContain('--nginx');
  });

  it('no user flag → no password/generate-key forwarded', () => {
    const flags = buildForwardFlags({ deployPassword: 'x' }, REMOTE).join(' ');
    expect(flags).not.toContain('--user');
    expect(flags).not.toContain('--password');
    expect(flags).not.toContain('--generate-key');
  });
});

describe('buildForwardFlags --no-port-filter', () => {
  it('forwards the opt-out only when it was asked for', () => {
    expect(buildForwardFlags({ portFilter: false }, REMOTE)).toContain('--no-port-filter');
    expect(buildForwardFlags({ portFilter: true }, REMOTE)).not.toContain('--no-port-filter');
    expect(buildForwardFlags({}, REMOTE)).not.toContain('--no-port-filter');
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

describe('verifiedDownloadCommand', () => {
  const BINARY = 'fake binary\n';
  const HASH = createHash('sha256').update(BINARY).digest('hex');

  it('fetches the binary and the SHA256SUMS of the same release', () => {
    const program = verifiedDownloadCommand('https://github.com/o/r/releases/latest/download', '2.6.0', 'dockflow-linux-x64', '/tmp/dockflow');
    expect(program).toContain("curl -fsSL 'https://github.com/o/r/releases/download/2.6.0/dockflow-linux-x64' -o \"$f\"");
    expect(program).toContain("curl -fsSL 'https://github.com/o/r/releases/download/2.6.0/SHA256SUMS' -o \"$s\"");
  });

  // Runs the program for real against file:// URLs. Linux CI has bash, curl and sha256sum;
  // on Windows this needs Git Bash, and the tests are skipped without it.
  const bash = resolveLocalBash();
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-download-')).replace(/\\/g, '/');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** publish a release 2.6.0 under `dir`, then run the program that installs its binary into `dir`/dockflow */
  const install = async (sums: string | null) => {
    mkdirSync(join(dir, 'download', '2.6.0'), { recursive: true });
    writeFileSync(join(dir, 'download', '2.6.0', 'dockflow-linux-x64'), BINARY);
    if (sums !== null) writeFileSync(join(dir, 'download', '2.6.0', 'SHA256SUMS'), sums);
    const base = `file://${dir.startsWith('/') ? '' : '/'}${dir}/latest/download`;
    const program = verifiedDownloadCommand(base, '2.6.0', 'dockflow-linux-x64', `${dir}/dockflow`);
    const proc = Bun.spawn([bash as string, '-c', program], { stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return { exitCode: proc.exitCode, stderr, installed: existsSync(join(dir, 'dockflow')), sumsLeft: existsSync(join(dir, 'dockflow.sha256sums')) };
  };

  it.skipIf(!bash)('installs the binary whose SHA-256 the release publishes, executable', async () => {
    const result = await install(`${'0'.repeat(64)}  dockflow-macos-x64\n${HASH}  dockflow-linux-x64\n`);

    expect(result).toMatchObject({ exitCode: 0, installed: true, sumsLeft: false });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'dockflow')).mode & 0o111).not.toBe(0);
  });

  it.skipIf(!bash)('reads the binary-mode lines of sha256sum too', async () => {
    expect(await install(`${HASH} *dockflow-linux-x64\n`)).toMatchObject({ exitCode: 0, installed: true });
  });

  it.skipIf(!bash)('leaves nothing behind when the SHA-256 differs, and says so', async () => {
    const result = await install(`${'f'.repeat(64)}  dockflow-linux-x64\n`);

    expect(result).toMatchObject({ exitCode: 1, installed: false, sumsLeft: false });
    expect(result.stderr).toContain(`SHA-256 of dockflow-linux-x64 does not match the release: expected ${'f'.repeat(64)}, got ${HASH}`);
  });

  it.skipIf(!bash)('leaves nothing behind when the release lists no SHA-256 for the binary, or has no SHA256SUMS', async () => {
    expect(await install(`${HASH}  dockflow-linux-arm64\n`)).toMatchObject({ exitCode: 1, installed: false, sumsLeft: false });
    const missing = await install(null);
    expect(missing.exitCode).not.toBe(0);
    expect(missing).toMatchObject({ installed: false, sumsLeft: false });
  });
});

describe('archFromMachine', () => {
  it('maps the machines Dockflow publishes a binary for', () => {
    expect(archFromMachine('x86_64\n')).toBe('x64');
    expect(archFromMachine('amd64')).toBe('x64');
    expect(archFromMachine('aarch64')).toBe('arm64');
    expect(archFromMachine('arm64')).toBe('arm64');
  });

  it('refuses every other machine instead of guessing x64', () => {
    for (const machine of ['armv7l', 'i686', 'riscv64', 's390x', 'ppc64le', '', 'x86_64 extra']) {
      expect(archFromMachine(machine)).toBeNull();
    }
  });
});

describe('isDevVersion', () => {
  it('tells a development build from a release', () => {
    expect(isDevVersion('0.0.0')).toBe(true);
    expect(isDevVersion('2.6.0-dev.3')).toBe(true);
    expect(isDevVersion('')).toBe(true);
    expect(isDevVersion('2.6.0')).toBe(false);
  });
});

describe('expectedBinaryVersion', () => {
  it('is the CLI version, except for a downloaded binary of an unreleased CLI', () => {
    expect(expectedBinaryVersion('2.6.0', false)).toBe('2.6.0');
    expect(expectedBinaryVersion('2.6.0', true)).toBe('2.6.0');
    expect(expectedBinaryVersion('0.0.0-dev', false)).toBeNull();
    expect(expectedBinaryVersion('0.0.0-dev', true)).toBe('0.0.0-dev');
  });
});

describe('tempDirFrom and printsVersion', () => {
  it('accepts exactly one absolute path', () => {
    expect(tempDirFrom('/tmp/dockflow-setup.AbC123xy\n')).toBe('/tmp/dockflow-setup.AbC123xy');
    expect(tempDirFrom('')).toBeNull();
    expect(tempDirFrom('relative/dir\n')).toBeNull();
    expect(tempDirFrom('/tmp/a\n/tmp/b\n')).toBeNull();
  });

  it('looks for the version as a word of the first line', () => {
    expect(printsVersion('2.6.0\n', '2.6.0')).toBe(true);
    expect(printsVersion('dockflow 2.6.0\n', '2.6.0')).toBe(true);
    expect(printsVersion('2.6.01\n', '2.6.0')).toBe(false);
    expect(printsVersion('', '2.6.0')).toBe(false);
  });
});

describe('the commands of the private binary directory, in a real shell', () => {
  const bash = resolveLocalBash();
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-private-')).replace(/\\/g, '/');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sh = async (program: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawn([bash as string, '-c', program], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode: proc.exitCode };
  };

  it.skipIf(!bash)('mktemp makes a fresh private directory under $TMPDIR each time', async () => {
    const first = await sh(MAKE_TEMP_DIR_COMMAND, { TMPDIR: dir });
    const second = await sh(MAKE_TEMP_DIR_COMMAND, { TMPDIR: dir });
    const a = tempDirFrom(first.stdout);
    const b = tempDirFrom(second.stdout);
    expect(first.exitCode).toBe(0);
    expect(basename(a as string).startsWith('dockflow-setup.')).toBe(true);
    if (process.platform !== 'win32') expect(dirname(a as string)).toBe(dir);
    expect(b).not.toBe(a);
    if (process.platform !== 'win32') expect(statSync(a as string).mode & 0o777).toBe(0o700);
  });

  it('falls back to /tmp when TMPDIR is unset', () => {
    expect(MAKE_TEMP_DIR_COMMAND).toContain('${TMPDIR:-/tmp}/');
  });

  /** a directory whose name needs quoting, holding the upload */
  const withUpload = (content: string) => {
    const target = join(dir, "we ird'dir");
    mkdirSync(target);
    writeFileSync(join(target, 'dockflow.part'), content);
    return target;
  };

  it.skipIf(!bash)('installs an upload whose SHA-256 matches, executable by its owner only', async () => {
    const target = withUpload('binary\n');
    const result = await sh(installUploadCommand(target, createHash('sha256').update('binary\n').digest('hex')));
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(existsSync(join(target, 'dockflow'))).toBe(true);
    expect(existsSync(join(target, 'dockflow.part'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(target, 'dockflow')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!bash)('leaves nothing executable when the SHA-256 differs', async () => {
    const target = withUpload('tampered\n');
    const result = await sh(installUploadCommand(target, createHash('sha256').update('binary\n').digest('hex')));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SHA-256 of the uploaded binary does not match');
    expect(existsSync(join(target, 'dockflow'))).toBe(false);
    expect(existsSync(join(target, 'dockflow.part'))).toBe(false);
  });

  it.skipIf(!bash)('removes the directory and only it', async () => {
    const target = withUpload('x');
    writeFileSync(join(dir, 'neighbour'), 'keep');
    expect((await sh(removeDirCommand(target))).exitCode).toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, 'neighbour'))).toBe(true);
  });
});
