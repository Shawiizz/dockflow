/**
 * Operations API Routes
 *
 * SSE streaming endpoints for long-running deploy/build operations.
 * Uses Bun.spawn() to fork the CLI process and stream output as Server-Sent Events.
 *
 * POST /api/operations/deploy  - Start a deploy operation (SSE stream)
 * POST /api/operations/build   - Start a build operation (SSE stream)
 * GET  /api/operations/status  - Check if an operation is currently running
 * POST /api/operations/cancel  - Cancel the running operation
 */

import { join } from 'path';
import { jsonResponse, errorResponse } from '../server';
import type {
  DeployOperationRequest,
  BuildOperationRequest,
  OperationStatusResponse,
} from '../types';

/**
 * CORS headers (mirrored from server.ts for SSE responses)
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ─── Global operation mutex ──────────────────────────────────────────────────

interface RunningOperation {
  type: 'deploy' | 'build';
  environment: string;
  startedAt: string;
  process: ReturnType<typeof Bun.spawn>;
}

let currentOperation: RunningOperation | null = null;

// ─── CLI executable resolution ───────────────────────────────────────────────

/**
 * Determine the command prefix to invoke the Dockflow CLI.
 *
 * - Compiled binary: process.argv[0] is the binary itself.
 * - Running from source via `bun run src/index.ts`: argv[0] is "bun",
 *   argv[1] is the entry file.
 */
function getCliCommand(): string[] {
  const argv0 = process.argv[0];
  if (argv0.includes('bun')) {
    // Running from source: find the main entry file
    const mainFile = process.argv[1] || join(import.meta.dir, '../../index.ts');
    return [argv0, 'run', mainFile];
  }
  // Compiled binary
  return [argv0];
}

// ─── Route handler ───────────────────────────────────────────────────────────

/**
 * Handle /api/operations/* routes
 */
export async function handleOperationsRoutes(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // POST /api/operations/deploy
  if (pathname === '/api/operations/deploy' && method === 'POST') {
    return startDeployOperation(req);
  }

  // POST /api/operations/build
  if (pathname === '/api/operations/build' && method === 'POST') {
    return startBuildOperation(req);
  }

  // GET /api/operations/status
  if (pathname === '/api/operations/status' && method === 'GET') {
    return getOperationStatus();
  }

  // POST /api/operations/cancel
  if (pathname === '/api/operations/cancel' && method === 'POST') {
    return cancelOperation();
  }

  return errorResponse('Endpoint not found', 404);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an SSE response that streams stdout/stderr from a spawned process.
 */
function createSSEStream(proc: ReturnType<typeof Bun.spawn>, operationType: 'deploy' | 'build'): Response {
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      function sendEvent(event: string, data: unknown) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream may already be closed
        }
      }

      // Read stdout
      async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>, streamName: string) {
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            // Keep the last partial line in the buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim()) {
                sendEvent('log', { line, stream: streamName });
              }
            }
          }

          // Flush remaining buffer
          if (buffer.trim()) {
            sendEvent('log', { line: buffer, stream: streamName });
          }
        } catch {
          // Stream closed
        }
      }

      // Read both stdout and stderr concurrently
      const readers: Promise<void>[] = [];

      if (proc.stdout) {
        readers.push(readStream(proc.stdout.getReader(), 'stdout'));
      }
      if (proc.stderr) {
        readers.push(readStream(proc.stderr.getReader(), 'stderr'));
      }

      // Wait for all streams to finish
      await Promise.all(readers);

      // Wait for the process to exit
      const exitCode = await proc.exited;
      const duration = Date.now() - startTime;

      sendEvent('done', {
        exitCode,
        success: exitCode === 0,
        duration,
      });

      // Clear the global mutex
      currentOperation = null;

      controller.close();
    },

    cancel() {
      // If the client disconnects, kill the process
      try {
        proc.kill();
      } catch {
        // Process may already have exited
      }
      currentOperation = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders,
    },
  });
}

// ─── Endpoint implementations ────────────────────────────────────────────────

/**
 * Start a deploy operation and stream output as SSE
 */
async function startDeployOperation(req: Request): Promise<Response> {
  if (currentOperation) {
    return errorResponse(
      `An operation is already running: ${currentOperation.type} (${currentOperation.environment}, started ${currentOperation.startedAt})`,
      409,
    );
  }

  let body: DeployOperationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body', 400);
  }

  if (!body.environment) {
    return errorResponse('Missing required field: environment', 400);
  }

  // Build the CLI command arguments
  const cliCmd = getCliCommand();
  const args = [...cliCmd, 'deploy', body.environment];

  if (body.version) args.push(body.version);
  if (body.skipBuild) args.push('--skip-build');
  if (body.force) args.push('--force');
  if (body.accessories) args.push('--accessories');
  if (body.all) args.push('--all');
  if (body.skipAccessories) args.push('--skip-accessories');
  if (body.services) args.push('--services', body.services);
  if (body.dryRun) args.push('--dry-run');

  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  currentOperation = {
    type: 'deploy',
    environment: body.environment,
    startedAt: new Date().toISOString(),
    process: proc,
  };

  return createSSEStream(proc, 'deploy');
}

/**
 * Start a build operation and stream output as SSE
 */
async function startBuildOperation(req: Request): Promise<Response> {
  if (currentOperation) {
    return errorResponse(
      `An operation is already running: ${currentOperation.type} (${currentOperation.environment}, started ${currentOperation.startedAt})`,
      409,
    );
  }

  let body: BuildOperationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body', 400);
  }

  if (!body.environment) {
    return errorResponse('Missing required field: environment', 400);
  }

  // Build the CLI command arguments
  const cliCmd = getCliCommand();
  const args = [...cliCmd, 'build', body.environment];

  if (body.services) args.push('--services', body.services);
  if (body.push) args.push('--push');

  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  currentOperation = {
    type: 'build',
    environment: body.environment,
    startedAt: new Date().toISOString(),
    process: proc,
  };

  return createSSEStream(proc, 'build');
}

/**
 * Return the status of the current operation (if any)
 */
function getOperationStatus(): Response {
  if (!currentOperation) {
    return jsonResponse({
      running: false,
    } satisfies OperationStatusResponse);
  }

  return jsonResponse({
    running: true,
    type: currentOperation.type,
    environment: currentOperation.environment,
    startedAt: currentOperation.startedAt,
  } satisfies OperationStatusResponse);
}

/**
 * Cancel the running operation by killing the child process
 */
function cancelOperation(): Response {
  if (!currentOperation) {
    return jsonResponse({ success: false, message: 'No operation is currently running' });
  }

  const { type, environment } = currentOperation;

  try {
    currentOperation.process.kill();
  } catch {
    // Process may already have exited
  }

  currentOperation = null;

  return jsonResponse({
    success: true,
    message: `Cancelled ${type} operation for ${environment}`,
  });
}
