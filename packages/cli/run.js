#!/usr/bin/env node

/**
 * Dockflow CLI - Binary runner (bin entry)
 *
 * Locates the downloaded binary and executes it,
 * forwarding all arguments and exit code.
 */

const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

function getBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return join(__dirname, 'bin', `dockflow${ext}`);
}

function main() {
  const binaryPath = getBinaryPath();

  if (!existsSync(binaryPath)) {
    // Binary not found — run installer (handles npx or skipped postinstall)
    console.log('Dockflow binary not found, downloading...');
    try {
      execFileSync(process.execPath, [join(__dirname, 'install.js')], { stdio: 'inherit' });
    } catch {
      process.exit(1);
    }

    if (!existsSync(binaryPath)) {
      console.error('Failed to install Dockflow binary. Run "node install.js" manually.');
      process.exit(1);
    }
  }

  try {
    execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
  } catch (err) {
    // Forward the exit code from the binary
    process.exit(err.status ?? 1);
  }
}

main();
