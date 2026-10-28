#!/usr/bin/env node
// Runs the dockflow binary of this platform, installed as the optional dependency
// @dockflow-tools/cli-<os>-<arch> (ADR-0020): no postinstall script, nothing downloaded at install.
'use strict';

const { spawn } = require('child_process');

const platforms = {
  'linux x64': 'linux-x64',
  'linux arm64': 'linux-arm64',
  'darwin x64': 'darwin-x64',
  'darwin arm64': 'darwin-arm64',
  'win32 x64': 'win32-x64',
  // Windows on ARM runs the x64 binary
  'win32 arm64': 'win32-x64',
};

const platform = platforms[`${process.platform} ${process.arch}`];
if (!platform) {
  console.error(`dockflow: no binary for ${process.platform}/${process.arch}`);
  process.exit(1);
}
const pkg = `@dockflow-tools/cli-${platform}`;
let bin;
try {
  bin = require.resolve(`${pkg}/bin/dockflow${process.platform === 'win32' ? '.exe' : ''}`);
} catch {
  console.error(`dockflow: the package ${pkg} is not installed; reinstall @dockflow-tools/cli without --omit=optional`);
  process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });
// Ctrl+C reaches the binary from the terminal already, and it may still be rolling a deploy back:
// wait for it. Signals sent to this process alone are passed on.
process.on('SIGINT', () => {});
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('error', (err) => {
  console.error(`dockflow: cannot run ${bin}: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 + (require('os').constants.signals[signal] || 0) : 1);
});
