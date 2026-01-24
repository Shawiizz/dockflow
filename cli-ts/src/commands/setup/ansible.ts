/**
 * Ansible execution utilities
 */

import { spawnSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ora from 'ora';
import { printInfo, printSuccess, printError, colors } from '../../utils/output';
import { DOCKFLOW_REPO, DOCKFLOW_DIR } from './constants';
import type { HostConfig } from './types';

/**
 * Clone or update the dockflow repository
 */
export async function ensureDockflowRepo(): Promise<string> {
  const spinner = ora('Setting up Dockflow framework...').start();

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
      
      const parentDir = path.dirname(DOCKFLOW_DIR);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
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
  const spinner = ora('Installing Ansible roles...').start();

  return new Promise((resolve) => {
    const proc = spawn('ansible-galaxy', ['role', 'install', 'geerlingguy.docker'], {
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
        spinner.warn('Could not install Ansible roles (may already exist)');
        resolve(true);
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
  const spinner = ora('Running Ansible playbook...').start();

  if (!ansibleDir) {
    spinner.fail('Cannot find ansible/configure_host.yml');
    console.log('');
    printInfo('The Ansible playbooks are required for setup.');
    printInfo('Please ensure the dockflow ansible directory is available.');
    console.log('');
    console.log(colors.info('Options:'));
    console.log('  1. Clone the dockflow repository and run from there');
    console.log('  2. Copy the ansible/ directory next to the binary');
    console.log('  3. Install to /opt/dockflow/ansible');
    console.log('');
    console.log(colors.dim('Example:'));
    console.log(colors.dim('  git clone https://github.com/Shawiizz/dockflow.git'));
    console.log(colors.dim('  cd dockflow'));
    console.log(colors.dim('  ./dockflow-linux-x64 setup'));
    return false;
  }

  printInfo(`Using Ansible directory: ${ansibleDir}`);

  const skipTags = ['deploy'];
  if (!config.portainer.install) {
    skipTags.push('portainer', 'nginx');
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
  console.log('');

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
        PYTHONUNBUFFERED: '1'
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
        console.log('');
        printSuccess('Ansible playbook completed successfully');
        resolve(true);
      } else {
        console.log('');
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
