#!/usr/bin/env bun

/**
 * Development script that automatically sets DOCKFLOW_DEV_PATH
 * to the project root before running the CLI.
 * 
 * Also automatically adds --dev flag for deploy/build commands.
 * 
 * Usage from project directory:
 *   bun <path-to-dockflow>/cli-ts/scripts/dev.ts <command> [args]
 * 
 * Or set an alias:
 *   alias dockflow-dev='bun /path/to/dockflow/cli-ts/scripts/dev.ts'
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the root of the dockflow project (parent of cli-ts)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliTsDir = dirname(__dirname);
const dockflowRoot = resolve(cliTsDir, '..');

// Set the environment variable
process.env.DOCKFLOW_DEV_PATH = dockflowRoot;

// Get args
let args = process.argv.slice(2);

// Auto-add --dev flag for deploy/build commands if not already present
const command = args[0];
if ((command === 'deploy' || command === 'build') && !args.includes('--dev')) {
  args.push('--dev');
}

// Run the CLI with the same args - use current working directory
const proc = spawn('bun', ['run', resolve(cliTsDir, 'src/index.ts'), ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

proc.on('close', (code) => {
  process.exit(code ?? 0);
});
