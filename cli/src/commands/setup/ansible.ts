/**
 * Ansible execution utilities
 */

import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { printInfo, printSuccess, printError, printBlank, printDim, printRaw, createSpinner } from '../../utils/output';
import { DOCKFLOW_REPO, DOCKFLOW_DIR } from './constants';
import type { HostConfig } from './types';

/**
 * Clone or update the dockflow repository
 */
export async function ensureDockflowRepo(): Promise<string> {
  const spinner = createSpinner();
  spinner.start('Setting up Dockflow framework...');

  try {
    if (fs.existsSync(DOCKFLOW_DIR)) {
      const gitDir = path.join(DOCKFLOW_DIR, '.git');
      if (fs.existsSync(gitDir)) {
        spinner.text = 'Updating Dockflow framework...';
        
        const pullResult = spawnSync('git', ['pull', '--ff-only'], {
          cwd: DOCKFLOW_DIR,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (pullResult.status === 0) {
          spinner.succeed('Dockflow framework updated');
        } else {
          spinner.warn('Could not update Dockflow (using existing version)');
        }
      } else {
        spinner.text = 'Reinitializing Dockflow framework...';
        fs.rmSync(DOCKFLOW_DIR, { recursive: true, force: true });
        
        const cloneResult = spawnSync('git', ['clone', DOCKFLOW_REPO, DOCKFLOW_DIR], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (cloneResult.status !== 0) {
          spinner.fail(`Failed to clone: ${cloneResult.stderr}`);
          throw new Error('Clone failed');
        }
        spinner.succeed('Dockflow framework installed');
      }
    } else {
      spinner.text = 'Cloning Dockflow framework...';

      // Ensure parent directory exists
      if (!fs.existsSync(DOCKFLOW_DIR)) {
        fs.mkdirSync(DOCKFLOW_DIR, { recursive: true });
      }

      const cloneResult = spawnSync('git', ['clone', DOCKFLOW_REPO, DOCKFLOW_DIR], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (cloneResult.status !== 0) {
        spinner.fail(`Failed to clone: ${cloneResult.stderr}`);
        throw new Error('Clone failed');
      }
      spinner.succeed('Dockflow framework installed');
    }

    const ansibleDir = path.join(DOCKFLOW_DIR, 'ansible');
    if (!fs.existsSync(path.join(ansibleDir, 'configure_host.yml'))) {
      throw new Error('ansible/configure_host.yml not found in repository');
    }

    return ansibleDir;
  } catch (error) {
    spinner.fail(`Failed to setup Dockflow: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Install required Ansible roles
 */
export async function installAnsibleRoles(cwd: string): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start('Installing Ansible roles...');

  return new Promise((resolve) => {
    const proc = spawn('ansible-galaxy', ['role', 'install', 'geerlingguy.docker,7.4.1', '--force'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd
    });

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        spinner.succeed('Ansible roles installed');
        resolve(true);
      } else {
        // Check if role already exists locally
        const roleExists = fs.existsSync(path.join(cwd, 'roles', 'geerlingguy.docker'))
          || fs.existsSync(path.join(process.env.HOME || '/root', '.ansible', 'roles', 'geerlingguy.docker'));
        if (roleExists) {
          spinner.warn('Could not update Ansible roles (using existing version)');
          resolve(true);
        } else {
          spinner.fail(`Failed to install Ansible roles: ${stderr.trim()}`);
          resolve(false);
        }
      }
    });

    proc.on('error', () => {
      spinner.warn('ansible-galaxy not available, skipping role install');
      resolve(true);
    });
  });
}

/**
 * Run Ansible playbook for host configuration
 */
export async function runAnsiblePlaybook(config: HostConfig, ansibleDir: string): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start('Running Ansible playbook...');

  if (!ansibleDir) {
    spinner.fail('Cannot find ansible/configure_host.yml');
    printBlank();
    printInfo('The Ansible playbooks are required for setup.');
    printInfo('Please ensure the dockflow ansible directory is available.');
    printBlank();
    printInfo('Options:');
    printRaw('  1. Clone the dockflow repository and run from there');
    printRaw('  2. Copy the ansible/ directory next to the binary');
    printRaw('  3. Install to /opt/dockflow/ansible');
    printBlank();
    printDim('Example:');
    printDim('  git clone https://github.com/Shawiizz/dockflow.git');
    printDim('  cd dockflow');
    printDim('  ./dockflow-linux-x64 setup');
    return false;
  }

  printInfo(`Using Ansible directory: ${ansibleDir}`);

  const skipTags = ['deploy'];
  if (!config.installNginx) {
    skipTags.push('nginx');
  }
  if (!config.portainer.install) {
    skipTags.push('portainer');
  }

  const extraVars: string[] = [
    `ansible_python_interpreter=/usr/bin/python3`,
    `skip_docker_install=${config.skipDockerInstall}`
  ];

  if (config.deployPassword) {
    extraVars.push(`ansible_become_password=${config.deployPassword}`);
  }

  if (config.portainer.install) {
    extraVars.push(`portainer_install=true`);
    extraVars.push(`portainer_http_port=${config.portainer.port}`);
    if (config.portainer.password) {
      extraVars.push(`portainer_password=${config.portainer.password}`);
    }
    if (config.portainer.domain) {
      extraVars.push(`portainer_domain_name=${config.portainer.domain}`);
    }
  }

  spinner.stop();
  printInfo('Executing Ansible playbook...');
  printBlank();

  return new Promise((resolve) => {
    const args = [
      'ansible/configure_host.yml',
      '-i', 'localhost,',
      '-c', 'local',
      '--skip-tags', skipTags.join(','),
      '--extra-vars', extraVars.join(' ')
    ];

    // Use stdio: 'pipe' instead of 'inherit' to avoid non-blocking I/O issues
    // Ansible requires blocking I/O on stdin/stdout/stderr
    const proc = spawn('ansible-playbook', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.dirname(ansibleDir!),
      env: {
        ...process.env,
        ANSIBLE_HOST_KEY_CHECKING: 'False',
        ANSIBLE_CONFIG: path.join(path.dirname(ansibleDir!), 'ansible.cfg'),
        // Force unbuffered output for Python/Ansible
        PYTHONUNBUFFERED: '1',
        // Disable colour/interactive features to avoid PTY buffering issues
        ANSIBLE_NOCOLOR: '1',
        ANSIBLE_FORCE_COLOR: '0',
        // Reduce fact gathering to speed up execution
        ANSIBLE_GATHERING: 'smart',
      }
    });

    // Stream stdout and stderr to console
    proc.stdout?.on('data', (data) => {
      process.stdout.write(data);
    });

    proc.stderr?.on('data', (data) => {
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        printBlank();
        printSuccess('Ansible playbook completed successfully');
        resolve(true);
      } else {
        printBlank();
        printError(`Ansible playbook failed with code ${code}`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      printError(`Failed to run Ansible: ${err.message}`);
      resolve(false);
    });
  });
}
