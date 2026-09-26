import { describe, expect, test } from 'bun:test';
import { k3sDistribution } from '../../../services/orchestrator/kubernetes/k3s/distribution';
import {
  escapeSudoersArgument,
  K3S_BINARY_PATH,
  K3S_IMAGE_COMMANDS,
  K3S_SUDO_COMMANDS,
  K3S_SUDOERS_ALIAS,
  K3S_SUDOERS_HEADER,
  renderK3sSudoers,
} from '../../../services/orchestrator/kubernetes/k3s/sudoers';

// design-05 13.1, line by line. A backslash in the file is written `\\` here.
const EXPECTED_DOCKFLOW = [
  '# Managed by Dockflow (dockflow setup, orchestrator k3s). Changes are overwritten.',
  'Cmnd_Alias DOCKFLOW_K3S_IMAGES = /usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned\\=pinned -, \\',
  '    /usr/local/bin/k3s crictl images -o json, \\',
  '    /usr/local/bin/k3s ctr -n k8s.io images ls, \\',
  '    /usr/local/bin/k3s ctr -n k8s.io images rm *, \\',
  '    /usr/local/bin/k3s crictl rmi --prune, \\',
  '    /usr/local/bin/k3s ctr -n k8s.io images tag --force *, \\',
  '    /usr/local/bin/k3s ctr -n k8s.io images label * io.cri-containerd.pinned\\=pinned',
  'Defaults!DOCKFLOW_K3S_IMAGES !requiretty',
  'dockflow ALL=(root) NOPASSWD: DOCKFLOW_K3S_IMAGES',
  '',
].join('\n');

// DESIGN-CORE 8.7 sudo command table, as invoked after `sudo -n`, plus the tag and pin of an
// image a node already holds under another name (an identical rebuild under a new version).
const CORE_COMMANDS = [
  '/usr/local/bin/k3s ctr -n k8s.io images import --label io.cri-containerd.pinned=pinned -',
  '/usr/local/bin/k3s crictl images -o json',
  '/usr/local/bin/k3s ctr -n k8s.io images ls',
  '/usr/local/bin/k3s ctr -n k8s.io images rm *',
  '/usr/local/bin/k3s crictl rmi --prune',
  '/usr/local/bin/k3s ctr -n k8s.io images tag --force *',
  '/usr/local/bin/k3s ctr -n k8s.io images label * io.cri-containerd.pinned=pinned',
];

function unescapeSudoers(text: string): string {
  return text.replace(/\\([\\,:=])/g, '$1');
}

/** The commands of the Cmnd_Alias, joined over the line continuations and unescaped. */
function aliasCommands(file: string): string[] {
  const joined = file.replace(/\\\n\s*/g, '');
  const line = joined.split('\n').find((l) => l.startsWith(`Cmnd_Alias ${K3S_SUDOERS_ALIAS} = `));
  if (line === undefined) throw new Error('no Cmnd_Alias line');
  const body = line.slice(`Cmnd_Alias ${K3S_SUDOERS_ALIAS} = `.length);
  // split on the unescaped commas only
  return body.split(/(?<!\\), /).map(unescapeSudoers);
}

describe('K3S_SUDO_COMMANDS', () => {
  test('are the commands of DESIGN-CORE 8.7 and the tag/pin pair, unescaped and in file order', () => {
    expect([...K3S_SUDO_COMMANDS]).toEqual(CORE_COMMANDS);
  });

  test('call k3s by its absolute path (RHEL secure_path omits /usr/local/bin)', () => {
    expect(K3S_BINARY_PATH).toBe('/usr/local/bin/k3s');
    for (const command of K3S_SUDO_COMMANDS) {
      expect(command.startsWith(`${K3S_BINARY_PATH} `)).toBe(true);
      expect(command).not.toContain('sudo');
    }
  });

  test('are frozen', () => {
    expect(Object.isFrozen(K3S_SUDO_COMMANDS)).toBe(true);
  });

  test('equal the command strings of the k3s distribution', () => {
    const lists = k3sDistribution.listImagesCommands();
    const removePrefix = k3sDistribution
      .removeImagesCommand(['dockflow.invalid/shop-web:1.4.2'])
      .replace(/ 'dockflow\.invalid\/shop-web:1\.4\.2'$/, '');
    const [tag, label] = k3sDistribution.tagImageCommands('dockflow.invalid/shop-web:1.4.1', 'dockflow.invalid/shop-web:1.4.2');
    expect([
      k3sDistribution.importImagesCommand(),
      lists.byConfigDigest,
      lists.byTargetDigest,
      `${removePrefix} *`,
      k3sDistribution.pruneImagesCommand(),
      tag.replace(/ '\S+' '\S+'$/, ' *'),
      label.replace(/ '\S+' /, ' * '),
    ]).toEqual([...K3S_SUDO_COMMANDS]);
    expect(removePrefix).toBe(K3S_IMAGE_COMMANDS.remove);
  });
});

describe('tagImageCommands', () => {
  test('tags one imported name onto another, then pins the new one', () => {
    expect(k3sDistribution.tagImageCommands('dockflow.invalid/shop-web:1.4.1', 'dockflow.invalid/shop-web:1.4.2')).toEqual([
      "/usr/local/bin/k3s ctr -n k8s.io images tag --force 'dockflow.invalid/shop-web:1.4.1' 'dockflow.invalid/shop-web:1.4.2'",
      "/usr/local/bin/k3s ctr -n k8s.io images label 'dockflow.invalid/shop-web:1.4.2' io.cri-containerd.pinned=pinned",
    ]);
  });

  test('refuses any name Dockflow did not import, source or target, since sudoers allows any', () => {
    expect(() => k3sDistribution.tagImageCommands('docker.io/library/redis:8', 'dockflow.invalid/shop-web:1.4.2')).toThrow(/not an image Dockflow imported/);
    expect(() => k3sDistribution.tagImageCommands('dockflow.invalid/shop-web:1.4.1', 'docker.io/rancher/mirrored-pause:3.6')).toThrow(/not an image Dockflow imported/);
    expect(() => k3sDistribution.tagImageCommands('dockflow.invalid/a:1', "dockflow.invalid/b:1'; rm -rf / #")).toThrow(/not an image Dockflow imported/);
  });
});

describe('renderK3sSudoers', () => {
  test('SU1: renders the file of design-05 13.1 byte for byte', () => {
    expect(renderK3sSudoers('dockflow')).toBe(EXPECTED_DOCKFLOW);
  });

  test('SU1: names the deploy user only on the grant line', () => {
    const file = renderK3sSudoers('deploytest');
    expect(file).toBe(EXPECTED_DOCKFLOW.replace('\ndockflow ALL=', '\ndeploytest ALL='));
    const lines = file.split('\n');
    expect(lines.filter((l) => l.includes('deploytest'))).toEqual([
      'deploytest ALL=(root) NOPASSWD: DOCKFLOW_K3S_IMAGES',
    ]);
  });

  test('SU1: escapes `=` in the pinned label and nowhere changes the invoked command', () => {
    const file = renderK3sSudoers('dockflow');
    expect(file).toContain('io.cri-containerd.pinned\\=pinned -');
    expect(file).not.toContain('io.cri-containerd.pinned=pinned');
    expect(aliasCommands(file)).toEqual([...K3S_SUDO_COMMANDS]);
  });

  test('starts with the Dockflow header and ends with exactly one newline', () => {
    const file = renderK3sSudoers('dockflow');
    expect(file.split('\n')[0]).toBe(K3S_SUDOERS_HEADER);
    expect(file.endsWith('\n')).toBe(true);
    expect(file.endsWith('\n\n')).toBe(false);
  });

  test('grants the commands as root only, without a password and without a TTY', () => {
    const file = renderK3sSudoers('dockflow');
    expect(file).toContain(`Defaults!${K3S_SUDOERS_ALIAS} !requiretty\n`);
    expect(file).toContain(`dockflow ALL=(root) NOPASSWD: ${K3S_SUDOERS_ALIAS}\n`);
    expect(file).not.toContain('(ALL)');
    expect(file).not.toContain('node-token');
    expect(file).not.toContain('images *');
  });

  test('SU2: rejects invalid user names before rendering anything', () => {
    const invalid = [
      'bad user',
      'a:b',
      'root,x',
      '',
      'Deploy',
      '1deploy',
      '-deploy',
      'a'.repeat(33),
      'deploy\nroot ALL=(ALL) NOPASSWD: ALL',
      'deploy ALL',
      'dé',
    ];
    for (const user of invalid) {
      let caught: unknown;
      try {
        renderK3sSudoers(user);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { suggestion?: string };
      expect(error.name).toBe('ConfigError');
      expect(error.message).toBe(`Deploy user ${JSON.stringify(user)} is not a valid Linux user name`);
      expect(error.suggestion).toBe(
        'Use a user name of lowercase letters, digits, `_` and `-` that starts with a letter or `_` (at most 32 characters).',
      );
    }
  });

  test('SU2: accepts valid Linux user names', () => {
    for (const user of ['deploytest', 'dockflow', '_svc', 'a', 'dock-flow_1', 'a'.repeat(32), 'root']) {
      expect(renderK3sSudoers(user)).toContain(`\n${user} ALL=(root) NOPASSWD: ${K3S_SUDOERS_ALIAS}\n`);
    }
  });
});

describe('escapeSudoersArgument', () => {
  test('escapes , : = and backslash', () => {
    expect(escapeSudoersArgument('a,b:c=d\\e')).toBe('a\\,b\\:c\\=d\\\\e');
  });

  test('leaves wildcards, dashes and paths alone', () => {
    for (const arg of ['*', '-', '--prune', '/usr/local/bin/k3s', 'k8s.io', 'json']) {
      expect(escapeSudoersArgument(arg)).toBe(arg);
    }
  });
});
