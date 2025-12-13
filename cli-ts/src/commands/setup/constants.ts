/**
 * Constants for setup commands
 */

import type { Dependency } from './types';

// Re-export from centralized constants
export { 
  DOCKFLOW_REPO, 
  DOCKFLOW_DIR, 
  DOCKFLOW_RELEASE_URL 
} from '../../constants';

export const REQUIRED_DEPENDENCIES: Dependency[] = [
  { 
    name: 'ansible', 
    command: 'ansible --version', 
    description: 'Ansible automation tool',
    packages: {
      apt: ['ansible'],
      yum: ['ansible'],
      dnf: ['ansible'],
      pacman: ['ansible'],
      zypper: ['ansible'],
      apk: ['ansible']
    }
  },
  { 
    name: 'ansible-playbook', 
    command: 'ansible-playbook --version', 
    description: 'Ansible playbook runner',
    packages: {
      apt: ['ansible'],
      yum: ['ansible'],
      dnf: ['ansible'],
      pacman: ['ansible'],
      zypper: ['ansible'],
      apk: ['ansible']
    }
  },
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
    name: 'git', 
    command: 'git --version', 
    description: 'Git version control',
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

export const OPTIONAL_DEPENDENCIES: Dependency[] = [
  { 
    name: 'ansible-galaxy', 
    command: 'ansible-galaxy --version', 
    description: 'Ansible Galaxy (for roles)',
    packages: {
      apt: ['ansible'],
      yum: ['ansible'],
      dnf: ['ansible'],
      pacman: ['ansible'],
      zypper: ['ansible'],
      apk: ['ansible']
    }
  },
];
