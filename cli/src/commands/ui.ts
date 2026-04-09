/**
 * UI command - Launch the Dockflow WebUI
 *
 * Starts a local Bun HTTP server that serves the Angular frontend
 * and exposes API endpoints to interact with the Dockflow CLI.
 */

import type { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import { printIntro, printSuccess, printInfo, printWarning, printBlank } from '../utils/output';
import { getProjectRoot, loadConfig } from '../utils/config';
import { loadSecrets } from '../utils/secrets';
import { withErrorHandler } from '../utils/errors';

interface UIOptions {
  port: string;
  open: boolean;
}

/**
 * Open URL in default browser (cross-platform)
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  
  let command: string;
  let args: string[];
  
  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  
  const proc = Bun.spawn([command, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  
  await proc.exited;
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      fetch() {
        return new Response('test');
      },
    });
    server.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port)) && port < startPort + 100) {
    port++;
  }
  return port;
}

/**
 * Register the UI command
 */
export function registerUICommand(program: Command): void {
  program
    .command('ui')
    .description('Launch the Dockflow WebUI dashboard')
    .option('-p, --port <port>', 'Port to listen on', '4200')
    .option('--no-open', 'Do not open browser automatically')
    .action(withErrorHandler(async (options: UIOptions) => {
      const requestedPort = parseInt(options.port, 10);
      
      printIntro('Dockflow WebUI');
      printBlank();
      
      // Load secrets from .env.dockflow or CI environment
      loadSecrets();
      
      // Check for .dockflow directory (optional, UI can work without it)
      const projectRoot = getProjectRoot();
      const dockflowDir = join(projectRoot, '.dockflow');
      
      if (existsSync(dockflowDir)) {
        const config = loadConfig({ silent: true });
        if (config) {
          printInfo(`Project: ${config.project_name}`);
        }
      } else {
        printWarning('No .dockflow directory found in current directory');
        printInfo('You can open a project from the UI or run "dockflow init" first');
      }

      printBlank();

      // Find available port
      const port = await findAvailablePort(requestedPort);
      if (port !== requestedPort) {
        printWarning(`Port ${requestedPort} is in use, using ${port} instead`);
      }
      
      // Start the server
      const { startWebServer } = await import('../api/server');
      await startWebServer(port);
      
      const url = `http://localhost:${port}`;
      
      printBlank();
      printSuccess(`API server running on port ${port}`);
      printInfo(`Open the UI at ${url}`);
      printBlank();
      printInfo('Press Ctrl+C to stop the server');
      printBlank();
      
      // Open browser
      if (options.open) {
        await openBrowser(url);
      }
      
      // Keep the process running
      await new Promise(() => {});
    }));
}
