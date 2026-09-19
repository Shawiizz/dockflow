import { afterEach, describe, expect, it } from 'bun:test';
import { SUDOERS_K3S_FILE } from '../../../commands/setup/k3s/constants';
import {
  checkUserPassword,
  configureServiceAccess,
  ensureDeployUser,
  findLegacySudoRules,
  isDockflowUserSudoers,
  keyBlobOf,
  legacyRulesIn,
  passwordCheckArgv,
  USER_SUDOERS_HEADER,
  userMessages,
  validateUserPassword,
  writeSudoersFile,
} from '../../../commands/setup/user';
import { NGINX_SITES_ENABLED } from '../../../constants';
import { K3S_SUDO_COMMANDS, renderK3sSudoers } from '../../../services/orchestrator/kubernetes/k3s/sudoers';
import { CLIError } from '../../../utils/errors';
import { Redactor } from '../../../utils/redact';
import { FakeHostRunner } from '../fakes/fake-host-runner';
import { assertExecutorInvariants, assertNoSecretLeak } from '../support/invariants';

const KEY = 'server_1';
const USER = 'deploy';
const USER_FILE = `/etc/sudoers.d/${USER}`;
const LEGACY = [
  `${USER} ALL=(ALL) NOPASSWD: /usr/local/bin/k3s ctr -n k8s.io images *`,
  `${USER} ALL=(ALL) NOPASSWD: /bin/cat /var/lib/rancher/k3s/server/node-token`,
].join('\n');
const NGINX_RULE = `${USER} ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload`;
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeDeployKeyBlobForTestsOnly0123456789ab dockflow-deploy';

let runners: FakeHostRunner[] = [];
let secrets: string[] = [];

function host(options: ConstructorParameters<typeof FakeHostRunner>[0] = {}): FakeHostRunner {
  const runner = new FakeHostRunner(options);
  runner.addUser(USER);
  runners.push(runner);
  return runner;
}

function withNginx(runner: FakeHostRunner): FakeHostRunner {
  runner.commands.set('nginx', '/usr/sbin/nginx');
  runner.seedDir(NGINX_SITES_ENABLED);
  runner.addGroup('www-data');
  return runner;
}

function sudoersTexts(runner: FakeHostRunner): string[] {
  return [...runner.files.keys()].filter((path) => path.startsWith('/etc/sudoers.d/')).map((path) => runner.text(path) ?? '');
}

afterEach(() => {
  const hostRunner = runners;
  const redactor = new Redactor(secrets);
  runners = [];
  secrets = [];
  assertExecutorInvariants({ hostRunner, redactor });
});

describe('writeSudoersFile (13.2, U-SETUP-SUDO-02)', () => {
  it('writes a 0440 root temp file, checks it with visudo -cf, then renames it; identical content is not rewritten', async () => {
    const runner = host();
    const content = renderK3sSudoers(USER);
    expect(await writeSudoersFile(SUDOERS_K3S_FILE, content, { runner, key: KEY, user: USER })).toBe('written');
    expect(runner.commandsStartingWith('visudo')).toEqual([['visudo', '-cf', '/etc/sudoers.d/.dockflow-k3s.tmp']]);
    expect(runner.files.get(SUDOERS_K3S_FILE)).toMatchObject({ type: 'file', mode: 0o440, uid: 0, gid: 0 });
    expect(runner.text(SUDOERS_K3S_FILE)).toBe(content);
    expect(runner.files.has('/etc/sudoers.d/.dockflow-k3s.tmp')).toBe(false);
    runner.calls.length = 0;
    expect(await writeSudoersFile(SUDOERS_K3S_FILE, content, { runner, key: KEY, user: USER })).toBe('unchanged');
    expect(runner.calls).toEqual([]);
    runner.assertDone();
  });

  it('SU3 a visudo failure keeps the old file and removes the temp file', async () => {
    const runner = host();
    const old = renderK3sSudoers('olduser');
    runner.seedFile(SUDOERS_K3S_FILE, old, { mode: 0o440 });
    runner.visudoRejects.set('/etc/sudoers.d/.dockflow-k3s.tmp', '/etc/sudoers.d/.dockflow-k3s.tmp:2:30: syntax error');
    const error = await writeSudoersFile(SUDOERS_K3S_FILE, renderK3sSudoers(USER), { runner, key: KEY, user: USER }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CLIError);
    expect((error as CLIError).message).toBe(
      'The generated sudoers rules for deploy are invalid on server_1: /etc/sudoers.d/.dockflow-k3s.tmp:2:30: syntax error',
    );
    expect(runner.text(SUDOERS_K3S_FILE)).toBe(old);
    expect(runner.files.has('/etc/sudoers.d/.dockflow-k3s.tmp')).toBe(false);
    runner.assertDone();
  });

  it('the fake visudo grammar accepts the rendered file and rejects an unescaped =', async () => {
    const runner = host();
    const broken = renderK3sSudoers(USER).replace('pinned\\=pinned', 'pinned=pinned');
    await expect(writeSudoersFile(SUDOERS_K3S_FILE, broken, { runner, key: KEY, user: USER })).rejects.toThrow('unescaped =');
    runner.assertDone();
  });
});

describe('configureServiceAccess (13.3, K57b)', () => {
  it('SU5 / U-SETUP-SUDO-04 on k3s with nginx: the user file holds only the nginx rule, dockflow-k3s the five image commands', async () => {
    const runner = withNginx(host());
    const rules = await configureServiceAccess(USER, 'k3s', { runner, key: KEY });
    expect(rules).toEqual([NGINX_RULE]);
    expect(runner.text(USER_FILE)).toBe(`${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`);
    expect(runner.text(USER_FILE)).not.toContain('k3s');
    expect(runner.text(SUDOERS_K3S_FILE)).toBe(renderK3sSudoers(USER));
    expect(runner.text(SUDOERS_K3S_FILE)).not.toContain('nginx');
    for (const command of K3S_SUDO_COMMANDS) expect(runner.text(SUDOERS_K3S_FILE)).toContain(command.split(' ')[0]);
    expect(runner.groups.get('www-data')?.members.has(USER)).toBe(true);
    expect(runner.groups.get('docker')).toBeUndefined();
    expect(runner.commandsStartingWith('usermod', '-aG', 'docker')).toEqual([]);
    runner.assertDone();
  });

  it('SU6 a host without nginx: the legacy user file is removed, visudo -c runs afterwards, nothing root-equivalent remains', async () => {
    for (const orchestrator of ['k3s', 'swarm'] as const) {
      const runner = host();
      runner.seedFile(USER_FILE, `${LEGACY}\n`, { mode: 0o440 });
      expect(await findLegacySudoRules(runner)).toEqual([USER_FILE]);
      expect(await configureServiceAccess(USER, orchestrator, { runner, key: KEY })).toEqual([]);
      expect(runner.files.has(USER_FILE)).toBe(false);
      const argvs = runner.calls.map((call) => call.argv.join(' '));
      expect(argvs).toContain('visudo -c');
      for (const text of sudoersTexts(runner)) {
        expect(text).not.toContain('images *');
        expect(text).not.toContain('node-token');
      }
      expect(await findLegacySudoRules(runner)).toEqual([]);
      runner.assertDone();
    }
  });

  it('SU6 the same run on a host with nginx rewrites the file with only the nginx rule', async () => {
    for (const orchestrator of ['k3s', 'swarm'] as const) {
      const runner = withNginx(host());
      runner.seedFile(USER_FILE, `${LEGACY}\n${NGINX_RULE}\n`, { mode: 0o440 });
      await configureServiceAccess(USER, orchestrator, { runner, key: KEY });
      expect(runner.text(USER_FILE)).toBe(`${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`);
      for (const text of sudoersTexts(runner)) {
        expect(text).not.toContain('images *');
        expect(text).not.toContain('node-token');
      }
      runner.assertDone();
    }
  });

  it('SU6 a file with an operator line is left byte-identical and its legacy lines are reported', async () => {
    const runner = withNginx(host());
    const edited = `${LEGACY}\n${USER} ALL=(ALL) ALL\n`;
    runner.seedFile(USER_FILE, edited, { mode: 0o440 });
    const warnings: string[] = [];
    await configureServiceAccess(USER, 'k3s', { runner, key: KEY, onWarning: (message) => warnings.push(message) });
    expect(runner.text(USER_FILE)).toBe(edited);
    expect(warnings).toEqual([userMessages.userSudoersForeign(USER_FILE, KEY)]);
    const legacy = await findLegacySudoRules(runner);
    expect(legacy).toEqual([USER_FILE]);
    expect(userMessages.legacySudoRules(KEY, legacy)).toEqual({
      message: 'Legacy root-equivalent sudo rules are still present on server_1 (/etc/sudoers.d/deploy)',
      suggestion: 'Inspect them with `sudo cat /etc/sudoers.d/deploy` and delete them; Dockflow no longer needs them.',
    });
    expect(legacyRulesIn(edited)).toEqual(LEGACY.split('\n'));
    runner.assertDone();
  });

  it('SU4 Swarm removes a Dockflow-headed dockflow-k3s file and keeps a foreign file with the same name', async () => {
    const ours = host();
    ours.seedFile(SUDOERS_K3S_FILE, renderK3sSudoers(USER), { mode: 0o440 });
    await configureServiceAccess(USER, 'swarm', { runner: ours, key: KEY });
    expect(ours.files.has(SUDOERS_K3S_FILE)).toBe(false);
    ours.assertDone();

    const foreign = host();
    const text = 'deploy ALL=(root) NOPASSWD: /usr/local/bin/k3s crictl ps\n';
    foreign.seedFile(SUDOERS_K3S_FILE, text, { mode: 0o440 });
    await configureServiceAccess(USER, 'swarm', { runner: foreign, key: KEY });
    expect(foreign.text(SUDOERS_K3S_FILE)).toBe(text);
    foreign.assertDone();
  });

  it('Swarm adds the deploy user to docker; k3s never does', async () => {
    const runner = host();
    runner.addGroup('docker');
    await configureServiceAccess(USER, 'swarm', { runner, key: KEY });
    expect(runner.groups.get('docker')?.members.has(USER)).toBe(true);
    expect(runner.files.has(SUDOERS_K3S_FILE)).toBe(false);
    runner.assertDone();
  });

  it('a root deploy user gets no sudoers file on k3s, and a warning', async () => {
    const runner = host();
    const warnings: string[] = [];
    await configureServiceAccess('root', 'k3s', { runner, key: KEY, onWarning: (message) => warnings.push(message) });
    expect(runner.files.has(SUDOERS_K3S_FILE)).toBe(false);
    expect(warnings).toEqual(['The deploy user on server_1 is root; Dockflow recommends a dedicated user']);
    runner.assertDone();
  });

  it('a failing group change throws instead of warning', async () => {
    const runner = withNginx(host());
    runner.on(['usermod', '-aG'], { exitCode: 6, stderr: "usermod: group 'www-data' does not exist\n" });
    await expect(configureServiceAccess(USER, 'k3s', { runner, key: KEY })).rejects.toThrow(
      "Service access: nginx group membership failed: usermod: group 'www-data' does not exist",
    );
    runner.assertDone();
  });

  it('recognises Dockflow-owned user files', () => {
    expect(isDockflowUserSudoers(`${USER_SUDOERS_HEADER}\n${NGINX_RULE}\n`)).toBe(true);
    expect(isDockflowUserSudoers(`${LEGACY}\n${NGINX_RULE}\n`)).toBe(true);
    expect(isDockflowUserSudoers(`${LEGACY}\n${USER} ALL=(ALL) ALL\n`)).toBe(false);
  });
});

describe('deploy user (4.3, 19.3)', () => {
  it('creates a passwordless user and authorizes the key with files only, once', async () => {
    const runner = new FakeHostRunner();
    runners.push(runner);
    const result = await ensureDeployUser('ops', PUBLIC_KEY, { runner, passwordless: true });
    expect(result.created).toBe(true);
    expect(result.keyAdded).toBe(true);
    expect(runner.commandsStartingWith('useradd')).toEqual([['useradd', '-m', '-U', '-s', '/bin/bash', 'ops']]);
    expect(runner.commandsStartingWith('usermod')).toEqual([['usermod', '-p', '*', 'ops']]);
    const user = runner.users.get('ops');
    expect(runner.files.get('/home/ops/.ssh')).toMatchObject({ type: 'directory', mode: 0o700, uid: user?.uid, gid: user?.gid });
    expect(runner.files.get('/home/ops/.ssh/authorized_keys')).toMatchObject({ type: 'file', mode: 0o600, uid: user?.uid, gid: user?.gid });
    expect(runner.text('/home/ops/.ssh/authorized_keys')).toBe(`${PUBLIC_KEY}\n`);
    expect(runner.calls.some((call) => call.argv.some((arg) => arg.includes(keyBlobOf(PUBLIC_KEY))))).toBe(false);
    expect(runner.calls.some((call) => call.argv[0] === 'sh' || call.argv[0] === 'bash')).toBe(false);

    const again = await ensureDeployUser('ops', PUBLIC_KEY, { runner, passwordless: true });
    expect(again).toMatchObject({ created: false, keyAdded: false });
    expect(runner.text('/home/ops/.ssh/authorized_keys')).toBe(`${PUBLIC_KEY}\n`);
    runner.assertDone();
  });

  it('appends to an existing authorized_keys without duplicating a known blob, whatever its comment', async () => {
    const runner = host();
    runner.seedDir('/home/deploy/.ssh', { mode: 0o700, uid: 1000, gid: 1000 });
    runner.seedFile('/home/deploy/.ssh/authorized_keys', 'ssh-rsa AAAAB3other operator@laptop', { mode: 0o600, uid: 1000, gid: 1000 });
    await ensureDeployUser(USER, PUBLIC_KEY, { runner });
    expect(runner.text('/home/deploy/.ssh/authorized_keys')).toBe(`ssh-rsa AAAAB3other operator@laptop\n${PUBLIC_KEY}\n`);
    await ensureDeployUser(USER, PUBLIC_KEY.replace('dockflow-deploy', 'another-comment'), { runner });
    expect(runner.text('/home/deploy/.ssh/authorized_keys')?.split('\n').filter((line) => line !== '')).toHaveLength(2);
    runner.assertDone();
  });

  it('never writes through a symlink the deploy user planted in its home', async () => {
    const runner = host();
    runner.seedFile('/etc/shadow', 'root:$6$secret:19000::::::\n', { mode: 0o640 });
    runner.seedSymlink('/home/deploy/.ssh', '/etc');
    await expect(ensureDeployUser(USER, PUBLIC_KEY, { runner })).rejects.toThrow('Refusing to follow the symbolic link /home/deploy/.ssh');
    expect(runner.files.get('/etc')).toMatchObject({ mode: 0o755, uid: 0 });

    const planted = host();
    planted.seedDir('/home/deploy/.ssh', { mode: 0o700, uid: 1000, gid: 1000 });
    planted.seedFile('/etc/shadow', 'root:$6$secret:19000::::::\n', { mode: 0o640 });
    planted.seedSymlink('/home/deploy/.ssh/authorized_keys', '/etc/shadow');
    await expect(ensureDeployUser(USER, PUBLIC_KEY, { runner: planted })).rejects.toThrow('symbolic link');
    expect(planted.text('/etc/shadow')).toBe('root:$6$secret:19000::::::\n');
    runner.assertDone();
    planted.assertDone();
  });

  it('sets a new user password through chpasswd stdin, never argv; an existing user keeps its password', async () => {
    const password = "p'a\"ss $(id) word";
    secrets.push(password);
    const runner = new FakeHostRunner();
    runners.push(runner);
    await ensureDeployUser('ops', PUBLIC_KEY, { runner, password });
    expect(runner.calls.find((call) => call.argv[0] === 'chpasswd')?.input).toBe(`ops:${password}\n`);
    expect(runner.users.get('ops')?.password).toBe(password);
    const warnings: string[] = [];
    await ensureDeployUser('ops', PUBLIC_KEY, { runner, password: 'another-password', onWarning: (message) => warnings.push(message) });
    expect(runner.users.get('ops')?.password).toBe(password);
    expect(warnings).toEqual(['User ops already exists — password left unchanged']);
    assertNoSecretLeak(runner, [password]);
    runner.assertDone();
  });
});

describe('SU7 validateUserPassword (K57a, U-SETUP-PW-01)', () => {
  const TRICKY = `it's "quoted" $(id) and\nmultiline`;

  it('as non-root the argv is exactly su -c true - <user>, the password on stdin only', async () => {
    secrets.push(TRICKY);
    const runner = host({ euid: 1000 });
    const user = runner.users.get(USER);
    if (user) user.password = TRICKY;
    expect(await validateUserPassword(USER, TRICKY, runner)).toBe(true);
    expect(await validateUserPassword(USER, 'wrong-password', runner)).toBe(false);
    expect(runner.calls[0].argv).toEqual(['su', '-c', 'true', '-', USER]);
    expect(runner.calls[0].input).toBe(`${TRICKY}\n`);
    expect(runner.calls.some((call) => call.argv.some((arg) => arg.includes('bash') || arg.includes(TRICKY)))).toBe(false);
    assertNoSecretLeak(runner, [TRICKY]);
    runner.assertDone();
  });

  it('as root it runs su as nobody through setpriv, because root authenticates nothing', async () => {
    secrets.push('correct-horse');
    const runner = host({ euid: 0 });
    const user = runner.users.get(USER);
    if (user) user.password = 'correct-horse';
    expect(await validateUserPassword(USER, 'correct-horse', runner)).toBe(true);
    expect(runner.calls[0].argv).toEqual(['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', '--', 'su', '-c', 'true', '-', USER]);
    expect(passwordCheckArgv(USER, 0)).toEqual(runner.calls[0].argv);
    expect(passwordCheckArgv(USER, 1000)).toEqual(['su', '-c', 'true', '-', USER]);
    runner.assertDone();
  });

  it('is unverified, never true, when su needs a terminal or setpriv is missing', async () => {
    const terminal = host({ euid: 0 });
    terminal.suNeedsTerminal = true;
    expect(await checkUserPassword(USER, 'anything-at-all', terminal)).toEqual({ verdict: 'unverified', reason: 'su needs a terminal' });
    terminal.assertDone();

    const noSetpriv = host({ euid: 0 });
    noSetpriv.setprivInstalled = false;
    expect(await validateUserPassword(USER, 'anything-at-all', noSetpriv)).toBe('unverified');
    expect(await checkUserPassword(USER, 'anything-at-all', noSetpriv)).toEqual({ verdict: 'unverified', reason: 'setpriv is not installed' });
    expect(userMessages.passwordUnverified(USER, 'setpriv is not installed')).toBe(
      'The password of deploy could not be verified on this host (setpriv is not installed)',
    );
    noSetpriv.assertDone();
  });

  it('an empty user or password is false without running anything', async () => {
    const runner = host();
    expect(await validateUserPassword('', 'x', runner)).toBe(false);
    expect(await validateUserPassword(USER, '', runner)).toBe(false);
    expect(runner.calls).toEqual([]);
    runner.assertDone();
  });
});
