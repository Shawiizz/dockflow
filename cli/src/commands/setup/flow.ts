/**
 * Shared steps between the interactive and non-interactive local setup flows.
 */

import * as fs from 'fs';
import { printSection, printSuccess, printWarning, printInfo, printBlank } from '../../utils/output';
import { CLIError, ErrorCode } from '../../utils/errors';
import { checkDependencies, installDependencies, detectPackageManager } from './dependencies';
import { provisionHost } from './provision';
import { configureServiceAccess } from './user';
import { displayConnectionInfo } from './connection';
import type { HostConfig } from './types';

/**
 * Verify required dependencies and install the missing ones.
 * `confirmInstall` lets the interactive flow ask first; returning false
 * aborts the setup.
 */
export async function ensureSetupDependencies(
  confirmInstall?: () => Promise<boolean>,
): Promise<void> {
  const deps = checkDependencies();
  if (deps.ok) return;

  printInfo('Missing required dependencies:');
  deps.missing.forEach((m) => printWarning(`  - ${m}`));
  printBlank();

  const pm = detectPackageManager();
  if (!pm) {
    throw new CLIError(
      `Could not detect package manager. Please install dependencies manually: ${deps.missing.join(', ')}`,
      ErrorCode.COMMAND_FAILED,
    );
  }

  if (confirmInstall && !(await confirmInstall())) {
    throw new CLIError(
      'Please install the missing dependencies and try again.',
      ErrorCode.VALIDATION_FAILED,
    );
  }

  if (!installDependencies(deps.missingDeps)) {
    throw new CLIError(
      'Failed to install dependencies. Please install them manually and try again.',
      ErrorCode.COMMAND_FAILED,
    );
  }
  printBlank();

  const recheck = checkDependencies();
  if (!recheck.ok) {
    throw new CLIError(
      `Some dependencies are still missing: ${recheck.missing.join(', ')}`,
      ErrorCode.VALIDATION_FAILED,
    );
  }
}

/**
 * Provision the host, finalize service access for the deploy user, and
 * display the connection information. Common tail of both setup flows.
 */
export function completeSetup(config: HostConfig): void {
  provisionHost(config);

  // nginx may have just been installed — reconfigure service access now that
  // the binaries are available.
  configureServiceAccess(config.deployUser);

  printBlank();
  printSection('Setup Complete');
  printBlank();
  printSuccess('The machine has been successfully configured!');

  const privateKey = fs.readFileSync(config.privateKeyPath, 'utf-8');
  displayConnectionInfo(config, privateKey);
}
