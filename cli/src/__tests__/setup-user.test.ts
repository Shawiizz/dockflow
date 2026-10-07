import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run, type RunOptions, type RunResult } from '../commands/setup/provision';
import {
  configureServiceAccess,
  type HostEnv,
  isDockflowUserSudoers,
  nginxUserFrom,
  sudoersTempPath,
  USER_SUDOERS_HEADER,
  writeSudoersFile,
} from '../commands/setup/user';
import { CLIError } from '../utils/errors';

const posix = process.platform !== 'win32' && typeof process.getuid === 'function';

const NGINX_RULE = 'deploy ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload';
const PORTS_RULE = 'deploy ALL=(ALL) NOPASSWD: /usr/local/sbin/dockflow-public-ports';

describe('isDockflowUserSudoers', () => {
  it('owns a file with the header, whatever follows', () => {
    expect(isDockflowUserSudoers(`${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`)).toBe(true);
    expect(isDockflowUserSudoers(`${USER_SUDOERS_HEADER}\n`)).toBe(true);
  });

  it('owns a headerless file made only of the rules older versions wrote', () => {
    expect(isDockflowUserSudoers(`${NGINX_RULE}\n`)).toBe(true);
    expect(isDockflowUserSudoers(`${NGINX_RULE}\n${PORTS_RULE}\n`)).toBe(true);
    expect(isDockflowUserSudoers('deploy ALL=(ALL) NOPASSWD: /sbin/nginx -t, /sbin/nginx -s reload\n')).toBe(true);
    expect(isDockflowUserSudoers('')).toBe(true);
  });

  it('leaves to the operator any file with another rule or a comment of their own', () => {
    expect(isDockflowUserSudoers(`${NGINX_RULE}\ndeploy ALL=(ALL) NOPASSWD: ALL\n`)).toBe(false);
    expect(isDockflowUserSudoers('deploy ALL=(ALL) ALL\n')).toBe(false);
    expect(isDockflowUserSudoers(`# kept for the on-call team\n${NGINX_RULE}\n`)).toBe(false);
    expect(isDockflowUserSudoers('deploy ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload, /bin/sh\n')).toBe(false);
  });
});

describe('sudoersTempPath', () => {
  it('is a dot file in the same directory, which sudo never reads', () => {
    expect(sudoersTempPath('/etc/sudoers.d/deploy')).toBe('/etc/sudoers.d/.deploy.tmp');
  });
});

describe('nginxUserFrom', () => {
  it('reads the user directive of the dump', () => {
    expect(nginxUserFrom('# configuration file /etc/nginx/nginx.conf:\nuser www-data;\nworker_processes auto;\n')).toBe('www-data');
    expect(nginxUserFrom('events {}\n')).toBeNull();
  });
});

describe.skipIf(!posix)('sudoers files on disk', () => {
  let dir = '';
  let calls: string[][] = [];
  let warnings: string[] = [];
  let visudoVerdict: (content: string) => { ok: boolean; stderr: string } = () => ({ ok: true, stderr: '' });
  let commands: Record<string, Partial<RunResult>> = {};
  let publicPortsBin = '';
  let sitesEnabled = '';

  const sudoersDir = () => join(dir, 'sudoers.d');
  const userFile = () => join(sudoersDir(), 'deploy');

  const fakeRun = (argv: readonly string[], _opts?: RunOptions): RunResult => {
    calls.push([...argv]);
    if (argv[0] === 'visudo' && argv[1] === '-cf') {
      const verdict = visudoVerdict(readFileSync(argv[2], 'utf8'));
      return { ok: verdict.ok, exitCode: verdict.ok ? 0 : 1, stdout: '', stderr: verdict.stderr, timedOut: false };
    }
    const scripted = commands[argv.join(' ')];
    const succeedsByDefault = ['usermod', 'chgrp', 'chmod'].includes(argv[0]);
    const exitCode = scripted?.exitCode ?? (scripted === undefined && !succeedsByDefault ? 1 : 0);
    return { ok: exitCode === 0, exitCode, stdout: scripted?.stdout ?? '', stderr: scripted?.stderr ?? '', timedOut: false };
  };

  const host = (): HostEnv => ({
    run: fakeRun,
    sudoersDir: sudoersDir(),
    sudoersOwner: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
    sitesEnabled,
    publicPortsBin,
    warn: (message) => warnings.push(message),
  });

  const withNginx = () => {
    mkdirSync(sitesEnabled, { recursive: true });
    commands['which nginx'] = { stdout: '/usr/sbin/nginx\n' };
    commands['/usr/sbin/nginx -T'] = { stdout: 'user www-data;\n' };
  };
  const withFilter = () => writeFileSync(publicPortsBin, '#!/bin/sh\n');
  const commandsRun = (name: string) => calls.filter((argv) => argv[0] === name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-sudoers-'));
    mkdirSync(sudoersDir());
    calls = [];
    warnings = [];
    commands = {};
    visudoVerdict = () => ({ ok: true, stderr: '' });
    publicPortsBin = join(dir, 'dockflow-public-ports');
    sitesEnabled = join(dir, 'sites-enabled');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('writeSudoersFile', () => {
    it('checks a 0440 temp file with visudo -cf, then renames it into place', () => {
      let seen: { mode: number; content: string } | undefined;
      visudoVerdict = (content) => {
        const tmp = calls.find((argv) => argv[0] === 'visudo')?.[2] ?? '';
        seen = { mode: lstatSync(tmp).mode & 0o7777, content };
        return { ok: true, stderr: '' };
      };
      expect(writeSudoersFile(userFile(), 'deploy ALL=(ALL) NOPASSWD: /bin/true\n', host())).toBe('written');
      expect(calls).toEqual([['visudo', '-cf', join(sudoersDir(), '.deploy.tmp')]]);
      expect(seen).toEqual({ mode: 0o440, content: 'deploy ALL=(ALL) NOPASSWD: /bin/true\n' });
      expect(readFileSync(userFile(), 'utf8')).toBe('deploy ALL=(ALL) NOPASSWD: /bin/true\n');
      expect(lstatSync(userFile()).mode & 0o7777).toBe(0o440);
      expect(readdirSync(sudoersDir())).toEqual(['deploy']);
    });

    it('does not rewrite identical content', () => {
      writeSudoersFile(userFile(), 'a\n', host());
      calls = [];
      expect(writeSudoersFile(userFile(), 'a\n', host())).toBe('unchanged');
      expect(calls).toEqual([]);
    });

    it('rewrites identical content that has the wrong mode', () => {
      writeSudoersFile(userFile(), 'a\n', host());
      chmodSync(userFile(), 0o666);
      expect(writeSudoersFile(userFile(), 'a\n', host())).toBe('written');
      expect(lstatSync(userFile()).mode & 0o7777).toBe(0o440);
    });

    it('keeps the old file and removes the temp file when visudo rejects the new one', () => {
      writeFileSync(userFile(), 'old rule\n');
      visudoVerdict = () => ({ ok: false, stderr: '>>> /etc/sudoers.d/.deploy.tmp: syntax error near line 1 <<<\n' });
      let error: unknown;
      try {
        writeSudoersFile(userFile(), 'broken rule\n', host());
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CLIError);
      expect((error as CLIError).message).toContain('syntax error near line 1');
      expect((error as CLIError).suggestion).toContain('visudo -c');
      expect(readFileSync(userFile(), 'utf8')).toBe('old rule\n');
      expect(readdirSync(sudoersDir())).toEqual(['deploy']);
    });

    it.skipIf(Bun.which('visudo') === null)('accepts rules the real visudo parses and refuses the ones it does not', () => {
      const real = { ...host(), run };
      writeSudoersFile(userFile(), `${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`, real);
      expect(readFileSync(userFile(), 'utf8')).toContain(NGINX_RULE);
      expect(() => writeSudoersFile(userFile(), 'deploy ALL=(ALL NOPASSWD /usr/sbin/nginx\n', real)).toThrow('visudo rejected');
      expect(readFileSync(userFile(), 'utf8')).toContain(NGINX_RULE);
      expect(readdirSync(sudoersDir())).toEqual(['deploy']);
    });

    it('replaces a temp file left by an interrupted run', () => {
      writeFileSync(join(sudoersDir(), '.deploy.tmp'), 'stale');
      writeSudoersFile(userFile(), 'fresh\n', host());
      expect(readFileSync(userFile(), 'utf8')).toBe('fresh\n');
      expect(readdirSync(sudoersDir())).toEqual(['deploy']);
    });
  });

  describe('configureServiceAccess', () => {
    it('writes the nginx and filter rules under the header', () => {
      withNginx();
      withFilter();
      configureServiceAccess('deploy', host());
      expect(readFileSync(userFile(), 'utf8')).toBe(
        `${USER_SUDOERS_HEADER}\ndeploy ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload\ndeploy ALL=(ALL) NOPASSWD: ${publicPortsBin}\n`,
      );
      expect(lstatSync(userFile()).mode & 0o7777).toBe(0o440);
      expect(commandsRun('usermod')).toEqual([['usermod', '-aG', 'www-data', 'deploy']]);
      expect(warnings).toEqual([]);
    });

    it('a second run changes nothing and does not run visudo', () => {
      withNginx();
      configureServiceAccess('deploy', host());
      calls = [];
      configureServiceAccess('deploy', host());
      expect(commandsRun('visudo')).toEqual([]);
    });

    it('takes over a file in the shape older versions wrote, and adds the header', () => {
      withNginx();
      writeFileSync(userFile(), `${NGINX_RULE}\n`);
      configureServiceAccess('deploy', host());
      expect(readFileSync(userFile(), 'utf8')).toBe(`${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`);
      expect(warnings).toEqual([]);
    });

    it('leaves a file the operator edited byte-identical, and says so', () => {
      withNginx();
      const edited = `${NGINX_RULE}\ndeploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart app\n`;
      writeFileSync(userFile(), edited);
      const before = lstatSync(userFile());
      configureServiceAccess('deploy', host());
      expect(readFileSync(userFile(), 'utf8')).toBe(edited);
      expect(lstatSync(userFile()).mtimeMs).toBe(before.mtimeMs);
      expect(commandsRun('visudo')).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('edited outside Dockflow');
      expect(warnings[0]).toContain(userFile());
    });

    it('does not follow a symlink standing where the file goes', () => {
      withNginx();
      writeFileSync(join(dir, 'target'), 'keep me\n');
      symlinkSync(join(dir, 'target'), userFile());
      configureServiceAccess('deploy', host());
      expect(readFileSync(join(dir, 'target'), 'utf8')).toBe('keep me\n');
      expect(lstatSync(userFile()).isSymbolicLink()).toBe(true);
    });

    it('removes its own file when nothing is left to grant, then checks that sudoers still parses', () => {
      writeFileSync(userFile(), `${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`);
      commands['visudo -c'] = { stdout: '/etc/sudoers: parsed OK\n' };
      configureServiceAccess('deploy', host());
      expect(existsSync(userFile())).toBe(false);
      expect(calls.at(-1)).toEqual(['visudo', '-c']);
      expect(warnings).toEqual([]);
    });

    it('keeps a hand-edited file when nothing is left to grant', () => {
      writeFileSync(userFile(), 'deploy ALL=(ALL) NOPASSWD: ALL\n');
      configureServiceAccess('deploy', host());
      expect(readFileSync(userFile(), 'utf8')).toBe('deploy ALL=(ALL) NOPASSWD: ALL\n');
      expect(warnings).toEqual([]);
      expect(commandsRun('visudo')).toEqual([]);
    });

    it('touches nothing on a host with no sudoers file and nothing to grant', () => {
      configureServiceAccess('deploy', host());
      expect(calls.some((argv) => argv[0] === 'visudo')).toBe(false);
      expect(readdirSync(sudoersDir())).toEqual([]);
    });

    it('warns when removing the file leaves a sudoers configuration visudo rejects', () => {
      writeFileSync(userFile(), `${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`);
      commands['visudo -c'] = { exitCode: 1, stderr: 'parse error in /etc/sudoers.d/other near line 3\n' };
      configureServiceAccess('deploy', host());
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('does not parse after removing');
      expect(warnings[0]).toContain('parse error in /etc/sudoers.d/other near line 3');
    });

    it('warns, and keeps the previous file, when visudo rejects the rules', () => {
      withNginx();
      writeFileSync(userFile(), `${USER_SUDOERS_HEADER}\n${PORTS_RULE}\n`);
      visudoVerdict = () => ({ ok: false, stderr: 'syntax error\n' });
      configureServiceAccess('deploy', host());
      expect(readFileSync(userFile(), 'utf8')).toBe(`${USER_SUDOERS_HEADER}\n${PORTS_RULE}\n`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('syntax error');
    });

    it('still warns, and goes on, when a group change fails', () => {
      withNginx();
      commands['usermod -aG www-data deploy'] = { exitCode: 6, stderr: "usermod: group 'www-data' does not exist\n" };
      configureServiceAccess('deploy', host());
      expect(warnings[0]).toBe("Service access: nginx group membership failed: usermod: group 'www-data' does not exist");
      expect(existsSync(userFile())).toBe(true);
    });
  });
});
