// The exact commands the deploy user may run with `sudo -n` on a k3s node (DESIGN-CORE 8.7, D13)
// and the sudoers file granting them (design-05 13.1). Single source for setup, which validates
// and writes the file, and for the images backend, which runs them through `k3sDistribution`.

import { ConfigError } from '../../../../utils/errors';

/** Always absolute: RHEL's `secure_path` omits /usr/local/bin. */
export const K3S_BINARY_PATH = '/usr/local/bin/k3s';

const CTR_IMAGES = `${K3S_BINARY_PATH} ctr -n k8s.io images`;

/** Image commands as invoked after `sudo -n`, unescaped. */
export const K3S_IMAGE_COMMANDS = {
  /** reads a `docker save` tar on stdin; the pinned label keeps kubelet image GC away (DV5) */
  import: `${CTR_IMAGES} import --label io.cri-containerd.pinned=pinned -`,
  listByConfigDigest: `${K3S_BINARY_PATH} crictl images -o json`,
  listByTargetDigest: `${CTR_IMAGES} ls`,
  /** followed by the references; sudoers allows any, `removeImagesCommand` restricts them */
  remove: `${CTR_IMAGES} rm`,
  prune: `${K3S_BINARY_PATH} crictl rmi --prune`,
} as const;

/** The five commands of the sudoers file, in file order, unescaped. */
export const K3S_SUDO_COMMANDS: readonly string[] = Object.freeze([
  K3S_IMAGE_COMMANDS.import,
  K3S_IMAGE_COMMANDS.listByConfigDigest,
  K3S_IMAGE_COMMANDS.listByTargetDigest,
  `${K3S_IMAGE_COMMANDS.remove} *`,
  K3S_IMAGE_COMMANDS.prune,
]);

/** First line of the file; setup treats a file starting with it as Dockflow's (design-05 13.3). */
export const K3S_SUDOERS_HEADER =
  '# Managed by Dockflow (dockflow setup, orchestrator k3s). Changes are overwritten.';

export const K3S_SUDOERS_ALIAS = 'DOCKFLOW_K3S_IMAGES';

// What useradd accepts and sudoers can name without escaping (design-05 2.1).
const LINUX_USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Escapes the characters sudoers gives a meaning inside a command argument: `,` `:` `=` `\`. */
export function escapeSudoersArgument(arg: string): string {
  return arg.replace(/[\\,:=]/g, (c) => `\\${c}`);
}

function sudoersCommand(command: string): string {
  return command.split(' ').map(escapeSudoersArgument).join(' ');
}

/** The content of /etc/sudoers.d/dockflow-k3s for `deployUser` (design-05 13.1). */
export function renderK3sSudoers(deployUser: string): string {
  if (!LINUX_USER_NAME.test(deployUser)) {
    throw new ConfigError(
      `Deploy user ${JSON.stringify(deployUser)} is not a valid Linux user name`,
      'Use a user name of lowercase letters, digits, `_` and `-` that starts with a letter or `_` (at most 32 characters).',
    );
  }
  const commands = K3S_SUDO_COMMANDS.map(sudoersCommand).join(', \\\n    ');
  return [
    K3S_SUDOERS_HEADER,
    `Cmnd_Alias ${K3S_SUDOERS_ALIAS} = ${commands}`,
    `Defaults!${K3S_SUDOERS_ALIAS} !requiretty`,
    `${deployUser} ALL=(root) NOPASSWD: ${K3S_SUDOERS_ALIAS}`,
    '',
  ].join('\n');
}
