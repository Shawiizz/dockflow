import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run, type RunOptions, type RunResult } from '../commands/setup/provision';
import {
  authorizeKey,
  checkUserPassword,
  configureServiceAccess,
  ensureDeployUser,
  type HostEnv,
  type HostUser,
  isDockflowUserSudoers,
  keyBlobOf,
  nginxUserFrom,
  parsePasswdLine,
  passwordCheckArgv,
  sudoersTempPath,
  USER_SUDOERS_HEADER,
  userSudoersPath,
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

describe('userSudoersPath', () => {
  it('keeps a plain name and spells out the dots sudo would skip', () => {
    expect(userSudoersPath('/etc/sudoers.d', 'deploy')).toBe('/etc/sudoers.d/deploy');
    expect(userSudoersPath('/etc/sudoers.d', 'john.doe')).toBe('/etc/sudoers.d/john_dot_doe');
    expect(userSudoersPath('/etc/sudoers.d', 'a.b.c')).toBe('/etc/sudoers.d/a_dot_b_dot_c');
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

    describe('a user name with a dot, which sudo skips in a file name', () => {
      const DOTTED = 'john.doe';
      const dottedRule = `${DOTTED} ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload`;
      const readable = () => join(sudoersDir(), 'john_dot_doe');
      const unread = () => join(sudoersDir(), DOTTED);

      it('writes the rules under a name without a dot', () => {
        withNginx();
        configureServiceAccess(DOTTED, host());
        expect(readFileSync(readable(), 'utf8')).toBe(`${USER_SUDOERS_HEADER}\n${dottedRule}\n`);
        expect(readdirSync(sudoersDir())).toEqual(['john_dot_doe']);
      });

      it('removes the dotted file an older version wrote, if it was Dockflow\'s', () => {
        withNginx();
        writeFileSync(unread(), `${dottedRule}\n`);
        configureServiceAccess(DOTTED, host());
        expect(readdirSync(sudoersDir())).toEqual(['john_dot_doe']);
      });

      it('keeps a dotted file the operator wrote, and does not mistake it for the new one', () => {
        withNginx();
        writeFileSync(unread(), `${DOTTED} ALL=(ALL) ALL\n`);
        configureServiceAccess(DOTTED, host());
        expect(readFileSync(unread(), 'utf8')).toBe(`${DOTTED} ALL=(ALL) ALL\n`);
        expect(readFileSync(readable(), 'utf8')).toContain(dottedRule);
        expect(warnings).toEqual([]);
      });

      it('leaves a hand-edited file under the new name alone', () => {
        withNginx();
        writeFileSync(readable(), `${DOTTED} ALL=(ALL) NOPASSWD: ALL\n`);
        configureServiceAccess(DOTTED, host());
        expect(readFileSync(readable(), 'utf8')).toBe(`${DOTTED} ALL=(ALL) NOPASSWD: ALL\n`);
        expect(warnings).toHaveLength(1);
      });

      it('removes the file under the new name when nothing is left to grant', () => {
        writeFileSync(readable(), `${USER_SUDOERS_HEADER}\n${dottedRule}\n`);
        commands['visudo -c'] = {};
        configureServiceAccess(DOTTED, host());
        expect(readdirSync(sudoersDir())).toEqual([]);
      });
    });

    describe('when a group or permission change fails', () => {
      const failure = (setup: () => void) => {
        setup();
        try {
          configureServiceAccess('deploy', host());
        } catch (error) {
          return error as CLIError;
        }
        throw new Error('configureServiceAccess did not throw');
      };

      it('fails naming the nginx group command and its error, and writes no sudoers rule', () => {
        const error = failure(() => {
          withNginx();
          commands['usermod -aG www-data deploy'] = { exitCode: 6, stderr: "usermod: group 'www-data' does not exist\n" };
        });
        expect(error).toBeInstanceOf(CLIError);
        expect(error.message).toBe(
          "Could not give deploy its nginx group membership: \`usermod -aG www-data deploy\` failed: usermod: group 'www-data' does not exist",
        );
        expect(error.suggestion).toContain('run setup again');
        expect(existsSync(userFile())).toBe(false);
        expect(warnings).toEqual([]);
      });

      it('fails on the docker group', () => {
        const error = failure(() => {
          commands['getent group docker'] = { exitCode: 0 };
          commands['usermod -aG docker deploy'] = { exitCode: 1, stderr: 'usermod: cannot lock /etc/group\n' };
        });
        expect(error.message).toContain('\`usermod -aG docker deploy\` failed: usermod: cannot lock /etc/group');
      });

      it('fails on chgrp and on chmod of sites-enabled, naming each', () => {
        const chgrp = failure(() => {
          withNginx();
          commands[`chgrp -R -- www-data ${sitesEnabled}`] = { exitCode: 1, stderr: 'chgrp: Operation not permitted\n' };
        });
        expect(chgrp.message).toContain(`\`chgrp -R -- www-data ${sitesEnabled}\` failed: chgrp: Operation not permitted`);

        const chmod = failure(() => {
          commands[`chgrp -R -- www-data ${sitesEnabled}`] = { exitCode: 0 };
          commands[`chmod -R g+rwX -- ${sitesEnabled}`] = { exitCode: 1 };
        });
        expect(chmod.message).toContain(`\`chmod -R g+rwX -- ${sitesEnabled}\` failed: exit 1`);
      });
    });
  });
});

describe('passwordCheckArgv', () => {
  it('runs su directly for a user that is not root', () => {
    expect(passwordCheckArgv('deploy', 1000)).toEqual(['su', '-c', 'true', '-', 'deploy']);
  });

  it('runs su as nobody through setpriv for root, which would authenticate anything', () => {
    expect(passwordCheckArgv('deploy', 0)).toEqual([
      'setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--', 'su', '-c', 'true', '-', 'deploy',
    ]);
  });

  it('keeps a hostile user name as one element', () => {
    expect(passwordCheckArgv("x'; id #", 1000).at(-1)).toBe("x'; id #");
  });
});

describe('checkUserPassword', () => {
  const result = (over: Partial<RunResult>): RunResult => ({ ok: false, exitCode: 1, stdout: '', stderr: '', timedOut: false, ...over });
  const check = (answer: RunResult, euid = 1000) => {
    const calls: { argv: readonly string[]; opts?: RunOptions }[] = [];
    const verdict = checkUserPassword('deploy', 'hunter2', (argv, opts) => {
      calls.push({ argv, opts });
      return answer;
    }, euid);
    return { verdict, calls };
  };

  it('sends the password on stdin and never in the arguments', () => {
    const { verdict, calls } = check(result({ ok: true, exitCode: 0 }));
    expect(verdict).toEqual({ verdict: true });
    expect(calls[0].opts?.input).toBe('hunter2\n');
    expect(calls[0].argv.join(' ')).not.toContain('hunter2');
  });

  it('is false for a wrong password', () => {
    expect(check(result({ stderr: 'su: Authentication failure\n' })).verdict).toEqual({ verdict: false });
  });

  it('is unverified, never true, when su needs a terminal', () => {
    expect(check(result({ stderr: 'su: must be run from a terminal\n' })).verdict).toEqual({ verdict: 'unverified', reason: 'su needs a terminal' });
  });

  it('is unverified when su does not answer, or setpriv is missing', () => {
    expect(check(result({ exitCode: 124, timedOut: true })).verdict).toEqual({ verdict: 'unverified', reason: 'su did not answer' });
    expect(check(result({ exitCode: 127, stderr: 'setpriv: command not found' }), 0).verdict).toEqual({
      verdict: 'unverified',
      reason: 'setpriv is not installed',
    });
  });

  it('is false for an empty user or password without running anything', () => {
    let ran = false;
    const runCommand = () => {
      ran = true;
      return result({ ok: true, exitCode: 0 });
    };
    expect(checkUserPassword('', 'x', runCommand, 1000)).toEqual({ verdict: false });
    expect(checkUserPassword('deploy', '', runCommand, 1000)).toEqual({ verdict: false });
    expect(ran).toBe(false);
  });
});

describe.skipIf(!posix)('checkUserPassword with fake su and setpriv in a real shell', () => {
  const PASSWORD = `it's "quoted" $(id) \`id\` ; & | *`;
  let dir = '';
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-su-'));
    writeFileSync(join(dir, 'password'), PASSWORD);
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    script('su', 'printf "%s\\n" "$@" > "$DOCKFLOW_TEST_DIR/su-args"\nread -r typed\n[ "$typed" = "$(cat "$DOCKFLOW_TEST_DIR/password")" ]');
    script('setpriv', 'printf "%s\\n" "$@" > "$DOCKFLOW_TEST_DIR/setpriv-args"\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"');
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
    process.env.DOCKFLOW_TEST_DIR = dir;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.DOCKFLOW_TEST_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a password full of shell metacharacters reaches su intact', () => {
    expect(checkUserPassword('deploy', PASSWORD, run, 1000)).toEqual({ verdict: true });
    expect(checkUserPassword('deploy', 'wrong', run, 1000)).toEqual({ verdict: false });
    expect(readFileSync(join(dir, 'su-args'), 'utf8')).toBe('-c\ntrue\n-\ndeploy\n');
  });

  it('as root su goes through setpriv as nobody', () => {
    expect(checkUserPassword('deploy', PASSWORD, run, 0)).toEqual({ verdict: true });
    expect(readFileSync(join(dir, 'setpriv-args'), 'utf8')).toContain('--reuid=65534\n--regid=65534\n--clear-groups\n--\nsu\n');
  });
});

describe('parsePasswdLine and keyBlobOf', () => {
  it('reads uid, gid and home of a getent line', () => {
    expect(parsePasswdLine('deploy:x:1001:1002:Deploy,,,:/srv/deploy:/bin/bash\n')).toEqual({ name: 'deploy', uid: 1001, gid: 1002, home: '/srv/deploy' });
    expect(parsePasswdLine('')).toBeNull();
    expect(parsePasswdLine('deploy:x:abc:1002::/home/deploy:/bin/sh')).toBeNull();
  });

  it('takes the blob out of an authorized_keys line', () => {
    expect(keyBlobOf('ssh-ed25519 AAAAC3Nza dockflow-deploy')).toBe('AAAAC3Nza');
    expect(keyBlobOf('ssh-ed25519')).toBe('');
  });
});

describe.skipIf(!posix)('deploy user', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeDeployKeyBlobForTestsOnly0123456789ab dockflow-deploy';
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  let dir = '';
  let calls: { argv: readonly string[]; input?: string }[] = [];
  let users: Set<string>;
  let failing: Record<string, RunResult>;

  const homeOf = (name: string) => join(dir, 'home', name);
  const fakeRun = (argv: readonly string[], opts?: RunOptions): RunResult => {
    calls.push({ argv: [...argv], input: opts?.input });
    const ok = (stdout = ''): RunResult => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false });
    const scripted = failing[argv[0]];
    if (scripted) return scripted;
    if (argv[0] === 'getent') {
      return users.has(argv[2])
        ? ok(`${argv[2]}:x:${uid}:${gid}::${homeOf(argv[2])}:/bin/bash\n`)
        : { ok: false, exitCode: 2, stdout: '', stderr: '', timedOut: false };
    }
    if (argv[0] === 'useradd') {
      const name = argv.at(-1) as string;
      users.add(name);
      mkdirSync(homeOf(name), { recursive: true });
    }
    return ok();
  };
  const host = () => ({ run: fakeRun });
  const user = (name: string): HostUser => ({ name, uid, gid, home: homeOf(name) });
  const keysOf = (name: string) => readFileSync(join(homeOf(name), '.ssh', 'authorized_keys'), 'utf8');
  const modeOf = (path: string) => lstatSync(path).mode & 0o7777;
  const failure = (stderr: string): RunResult => ({ ok: false, exitCode: 1, stdout: '', stderr, timedOut: false });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockflow-user-'));
    calls = [];
    users = new Set();
    failing = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('ensureDeployUser', () => {
    it('creates the user, sets its password through stdin and authorizes the key as files', () => {
      const password = `p'a"ss $(id) \`id\` ;|&`;
      const result = ensureDeployUser('ops', password, KEY, host());
      expect(result).toMatchObject({ created: true, keyAdded: true });
      expect(calls.map((call) => call.argv)).toEqual([
        ['getent', 'passwd', 'ops'],
        ['useradd', '-m', '-U', '-s', '/bin/bash', '--', 'ops'],
        ['chpasswd'],
        ['getent', 'passwd', 'ops'],
        ['usermod', '-aG', 'docker', 'ops'],
      ]);
      expect(calls[2].input).toBe(`ops:${password}\n`);
      expect(calls.some((call) => call.argv.some((arg) => arg.includes(password) || arg.includes(keyBlobOf(KEY))))).toBe(false);
      expect(calls.some((call) => ['sh', 'bash'].includes(call.argv[0]))).toBe(false);
      expect(modeOf(join(homeOf('ops'), '.ssh'))).toBe(0o700);
      expect(modeOf(join(homeOf('ops'), '.ssh', 'authorized_keys'))).toBe(0o600);
      expect(keysOf('ops')).toBe(`${KEY}\n`);
    });

    it('takes the home from getent, not from /home/<name>', () => {
      ensureDeployUser('ops', 'pw', KEY, host());
      expect(existsSync(join(homeOf('ops'), '.ssh', 'authorized_keys'))).toBe(true);
      expect(existsSync('/home/ops')).toBe(false);
    });

    it('leaves an existing user and its password alone, and adds the key once', () => {
      users.add('ops');
      mkdirSync(homeOf('ops'), { recursive: true });
      expect(ensureDeployUser('ops', 'another-password', KEY, host())).toMatchObject({ created: false, keyAdded: true });
      expect(ensureDeployUser('ops', 'another-password', KEY, host())).toMatchObject({ created: false, keyAdded: false });
      expect(calls.some((call) => ['useradd', 'chpasswd'].includes(call.argv[0]))).toBe(false);
      expect(keysOf('ops')).toBe(`${KEY}\n`);
    });

    it('stops with the command output when useradd or chpasswd fails', () => {
      failing.useradd = failure("useradd: invalid user name 'a b'\n");
      expect(() => ensureDeployUser('a b', 'pw', KEY, host())).toThrow("Failed to create user a b: useradd: invalid user name 'a b'");
      failing = { chpasswd: failure('chpasswd: PAM: Authentication token manipulation error\n') };
      expect(() => ensureDeployUser('ops', 'pw', KEY, host())).toThrow('Failed to set the password of ops: chpasswd: PAM');
    });

    it('refuses a password that would add a second line to chpasswd, before creating anything', () => {
      expect(() => ensureDeployUser('ops', 'pw\nroot:owned', KEY, host())).toThrow('line break');
      expect(calls.some((call) => call.argv[0] === 'useradd')).toBe(false);
    });
  });

  describe('authorizeKey', () => {
    it('appends to an existing file, on its own line, without duplicating a known blob whatever its comment', () => {
      mkdirSync(join(homeOf('ops'), '.ssh'), { recursive: true, mode: 0o755 });
      writeFileSync(join(homeOf('ops'), '.ssh', 'authorized_keys'), 'ssh-rsa AAAAB3other operator@laptop', { mode: 0o644 });
      expect(authorizeKey(user('ops'), KEY)).toBe(true);
      expect(keysOf('ops')).toBe(`ssh-rsa AAAAB3other operator@laptop\n${KEY}\n`);
      expect(authorizeKey(user('ops'), KEY.replace('dockflow-deploy', 'another-comment'))).toBe(false);
      expect(keysOf('ops').split('\n').filter((line) => line !== '')).toHaveLength(2);
      expect(modeOf(join(homeOf('ops'), '.ssh'))).toBe(0o700);
      expect(modeOf(join(homeOf('ops'), '.ssh', 'authorized_keys'))).toBe(0o600);
    });

    it('does not write through a ~/.ssh symlink the user planted', () => {
      mkdirSync(homeOf('ops'), { recursive: true });
      mkdirSync(join(dir, 'elsewhere'), { mode: 0o755 });
      symlinkSync(join(dir, 'elsewhere'), join(homeOf('ops'), '.ssh'));
      expect(() => authorizeKey(user('ops'), KEY)).toThrow('Refusing to touch');
      expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
      expect(modeOf(join(dir, 'elsewhere'))).toBe(0o755);
    });

    it('does not write through an authorized_keys symlink the user planted', () => {
      mkdirSync(join(homeOf('ops'), '.ssh'), { recursive: true });
      writeFileSync(join(dir, 'shadow'), 'root:secret\n', { mode: 0o640 });
      symlinkSync(join(dir, 'shadow'), join(homeOf('ops'), '.ssh', 'authorized_keys'));
      expect(() => authorizeKey(user('ops'), KEY)).toThrow('Refusing to touch');
      expect(readFileSync(join(dir, 'shadow'), 'utf8')).toBe('root:secret\n');
      expect(modeOf(join(dir, 'shadow'))).toBe(0o640);
    });

    it('refuses a key that is not one line', () => {
      expect(() => authorizeKey(user('ops'), `${KEY}\ncommand="id" ssh-rsa AAAA x`)).toThrow('single');
      expect(() => authorizeKey(user('ops'), 'not-a-key')).toThrow('single');
    });
  });
});
