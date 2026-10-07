#!/usr/bin/env bun

/**
 * Runs the CLI from source, in the current directory.
 *
 * Usage from a project directory:
 *   bun <path-to-dockflow>/cli/scripts/dev.ts <command> [args]
 *
 * Or set an alias:
 *   alias dockflow-dev='bun /path/to/dockflow/cli/scripts/dev.ts'
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));

const proc = spawn('bun', ['run', resolve(cliDir, 'src/index.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  shell: true
});

proc.on('close', (code) => {
  process.exit(code ?? 0);
});
