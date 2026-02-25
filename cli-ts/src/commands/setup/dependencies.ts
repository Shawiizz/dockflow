/**
 * Dependency checking utilities
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { printSection, printInfo, printSuccess, printError, printWarning, printBlank, colors } from '../../utils/output';
import { REQUIRED_DEPENDENCIES, OPTIONAL_DEPENDENCIES } from './constants';
import type { Dependency, DependencyCheckResult } from './types';

type PackageManager = 'apt' | 'yum' | 'dnf' | 'pacman' | 'zypper' | 'apk';

/**
 * Check if a command exists on the system
 */
export function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${command}`], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return result.status === 0;
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return os.platform() === 'linux';
}

/**
 * Detect the package manager available on the system
 */
export function detectPackageManager(): PackageManager | null {
  if (commandExists('apt-get')) return 'apt';
  if (commandExists('dnf')) return 'dnf';
  if (commandExists('yum')) return 'yum';
  if (commandExists('pacman')) return 'pacman';
  if (commandExists('zypper')) return 'zypper';
  if (commandExists('apk')) return 'apk';
  return null;
}

/**
 * Get the distribution name
 */
export function getDistroName(): string {
  try {
    if (fs.existsSync('/etc/os-release')) {
      const content = fs.readFileSync('/etc/os-release', 'utf-8');
      const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
      if (match) return match[1];
    }
  } catch {
    // Ignore errors
  }
  return 'Linux';
}

/**
 * Get the install command for a package manager
 */
function getInstallCommand(pm: PackageManager): { update: string; install: string } {
  switch (pm) {
    case 'apt':
      return { update: 'apt-get update', install: 'apt-get install -y' };
    case 'yum':
      return { update: 'yum makecache', install: 'yum install -y' };
    case 'dnf':
      return { update: 'dnf makecache', install: 'dnf install -y' };
    case 'pacman':
      return { update: 'pacman -Sy', install: 'pacman -S --noconfirm' };
    case 'zypper':
      return { update: 'zypper refresh', install: 'zypper install -y' };
    case 'apk':
      return { update: 'apk update', install: 'apk add' };
  }
}

/**
 * Collect unique packages to install for missing dependencies
 */
function collectPackagesToInstall(deps: Dependency[], pm: PackageManager): string[] {
  const packages = new Set<string>();
  for (const dep of deps) {
    const pkgList = dep.packages[pm];
    if (pkgList) {
      pkgList.forEach(pkg => packages.add(pkg));
    }
  }
  return Array.from(packages);
}

/**
 * Install missing dependencies
 */
export function installDependencies(deps: Dependency[]): boolean {
  const pm = detectPackageManager();
  if (!pm) {
    printError('Could not detect package manager');
    return false;
  }

  const packages = collectPackagesToInstall(deps, pm);
  if (packages.length === 0) {
    printWarning('No packages found for this distribution');
    return false;
  }

  const distro = getDistroName();
  const cmds = getInstallCommand(pm);

  printInfo(`Detected: ${distro} (${pm})`);
  printInfo(`Installing: ${packages.join(', ')}`);
  printBlank();

  // Update package cache
  printInfo('Updating package cache...');
  const updateResult = spawnSync('sudo', cmds.update.split(' '), {
    encoding: 'utf-8',
    stdio: 'inherit'
  });

  if (updateResult.status !== 0) {
    printWarning('Package cache update failed, continuing anyway...');
  }

  // Install packages
  printInfo('Installing packages...');
  const installArgs = [...cmds.install.split(' '), ...packages];
  const installResult = spawnSync('sudo', installArgs, {
    encoding: 'utf-8',
    stdio: 'inherit'
  });

  if (installResult.status !== 0) {
    printError('Package installation failed');
    return false;
  }

  printSuccess('Dependencies installed successfully');
  return true;
}

/**
 * Check all required dependencies
 */
export function checkDependencies(): DependencyCheckResult {
  const missing: string[] = [];
  const missingDeps: Dependency[] = [];

  for (const dep of REQUIRED_DEPENDENCIES) {
    if (!commandExists(dep.name)) {
      missing.push(`${dep.name} (${dep.description})`);
      missingDeps.push(dep);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    missingDeps
  };
}

/**
 * Display dependency check results
 */
export function displayDependencyStatus(): void {
  printSection('Dependency Check');

  for (const dep of REQUIRED_DEPENDENCIES) {
    const exists = commandExists(dep.name);
    const status = exists ? colors.success('✓') : colors.error('✗');
    console.log(`  ${status} ${dep.name} - ${dep.description}`);
  }

  printBlank();
  printInfo('Optional:');
  for (const dep of OPTIONAL_DEPENDENCIES) {
    const exists = commandExists(dep.name);
    const status = exists ? colors.success('✓') : colors.warning('○');
    console.log(`  ${status} ${dep.name} - ${dep.description}`);
  }
  printBlank();
}
