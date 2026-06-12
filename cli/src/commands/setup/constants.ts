/**
 * Constants for setup commands
 */

import type { Dependency } from './types';

// Re-export from centralized constants
export { DOCKFLOW_RELEASE_URL } from '../../constants';

export const REQUIRED_DEPENDENCIES: Dependency[] = [
  {
    name: 'ssh',
    command: 'ssh -V',
    description: 'OpenSSH client',
    packages: {
      apt: ['openssh-client'],
      yum: ['openssh-clients'],
      dnf: ['openssh-clients'],
      pacman: ['openssh'],
      zypper: ['openssh'],
      apk: ['openssh-client']
    }
  },
  {
    name: 'ssh-keygen',
    command: 'ssh-keygen -V',
    description: 'SSH key generator',
    packages: {
      apt: ['openssh-client'],
      yum: ['openssh-clients'],
      dnf: ['openssh-clients'],
      pacman: ['openssh'],
      zypper: ['openssh'],
      apk: ['openssh-client']
    }
  },
  {
    name: 'curl',
    command: 'curl --version',
    description: 'curl (downloads the Docker install script)',
    packages: {
      apt: ['curl'],
      yum: ['curl'],
      dnf: ['curl'],
      pacman: ['curl'],
      zypper: ['curl'],
      apk: ['curl']
    }
  },
];

export const OPTIONAL_DEPENDENCIES: Dependency[] = [
  {
    name: 'git',
    command: 'git --version',
    description: 'Git (required on the server for remote_build)',
    packages: {
      apt: ['git'],
      yum: ['git'],
      dnf: ['git'],
      pacman: ['git'],
      zypper: ['git'],
      apk: ['git']
    }
  },
];
