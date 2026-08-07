/**
 * Operations API Routes
 *
 * SSE streaming endpoints for long-running deploy/build operations.
 * Uses Bun.spawn() to fork the CLI process and stream output as Server-Sent Events.
 *
 * A spawned process's output is buffered and broadcast to subscribers independently
 * of any single HTTP connection. Only POST /api/operations/cancel stops the process;
 * a client disconnecting does not. GET /api/operations/stream lets any client attach
 * or reattach at any time and replays the full buffered history before going live.
 *
 * POST /api/operations/deploy  - Start a deploy operation (SSE stream)
 * POST /api/operations/build   - Start a build operation (SSE stream)
 * GET  /api/operations/status  - Check if an operation is currently running
 * GET  /api/operations/stream  - Reattach to the current/last operation's output (SSE stream)
 * POST /api/operations/cancel  - Cancel the running operation
 */

import { join } from 'path';
import { jsonResponse, errorResponse } from '../server';
import type {
  DeployOperationRequest,
  BuildOperationRequest,
  OperationStatusResponse,
} from '../types';

// ─── Operation state ─────────────────────────────────────────────────────────

interface OpEvent {
  event: 'log' | 'done';
  data: unknown;
}

interface RunningOperation {
  type: 'deploy' | 'build';
  environment: string;
  startedAt: string;
  process: ReturnType<typeof Bun.spawn>;
  /** Every event emitted so far, replayed in full to anyone who (re)subscribes. */
  buffer: OpEvent[];
  /** Currently-attached SSE responses, notified as new events arrive. */
  subscribers: Set<(evt: OpEvent) => void>;
  finished: boolean;
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

  // GET /api/operations/stream
  if (pathname === '/api/operations/stream' && method === 'GET') {
    return attachToOperation();
  }

  // POST /api/operations/cancel
  if (pathname === '/api/operations/cancel' && method === 'POST') {
    return cancelOperation();
  }

  return errorResponse('Endpoint not found', 404);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Append an event to the operation's buffer and push it to every live subscriber. */
function broadcast(op: RunningOperation, evt: OpEvent): void {
  op.buffer.push(evt);
  for (const notify of op.subscribers) {
    try {
      notify(evt);
    } catch {
      // Subscriber's controller is gone — subscribeToOperation's own cancel()
      // handler is responsible for removing it from the set.
    }
  }
}

/**
 * Pump a spawned process's stdout/stderr into the operation's shared buffer.
 * Runs independently of any HTTP response — started once, right after spawn,
 * regardless of whether a client is currently attached.
 */
async function pumpOutput(op: RunningOperation): Promise<void> {
  const proc = op.process;
  const startTime = Date.now();

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
            broadcast(op, { event: 'log', data: { line, stream: streamName } });
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        broadcast(op, { event: 'log', data: { line: buffer, stream: streamName } });
      }
    } catch {
      // Stream closed
    }
  }

  const readers: Promise<void>[] = [];

  if (proc.stdout && typeof proc.stdout !== 'number') {
    readers.push(readStream(proc.stdout.getReader(), 'stdout'));
  }
  if (proc.stderr && typeof proc.stderr !== 'number') {
    readers.push(readStream(proc.stderr.getReader(), 'stderr'));
  }

  await Promise.all(readers);

  const exitCode = await proc.exited;
  const duration = Date.now() - startTime;

  broadcast(op, { event: 'done', data: { exitCode, success: exitCode === 0, duration } });
  op.finished = true;
}

/**
 * Create an SSE response attached to an operation: replays everything buffered
 * so far, then (if still running) streams new events live. Disconnecting only
 * detaches this listener — it never touches the underlying process.
 */
function subscribeToOperation(op: RunningOperation): Response {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let listener: ((evt: OpEvent) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      function send(evt: OpEvent) {
        const payload = `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Stream may already be closed
        }
      }

      // Catch up on everything that happened before this client (re)connected
      for (const evt of op.buffer) send(evt);

      if (op.finished) {
        controller.close();
        return;
      }

      // SSE keepalive: send a comment every 15s to prevent proxy/network timeouts
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      }, 15_000);

      listener = (evt) => {
        send(evt);
        if (evt.event === 'done') {
          if (heartbeat) clearInterval(heartbeat);
          if (listener) op.subscribers.delete(listener);
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      };
      op.subscribers.add(listener);
    },

    cancel() {
      // Detach this listener only — the process keeps running regardless.
      if (heartbeat) clearInterval(heartbeat);
      if (listener) op.subscribers.delete(listener);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/** Spawn the process, register it as the current operation, and start pumping its output. */
function launchOperation(type: 'deploy' | 'build', environment: string, args: string[]): RunningOperation {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '1', PYTHONUNBUFFERED: '1' },
  });

  const op: RunningOperation = {
    type,
    environment,
    startedAt: new Date().toISOString(),
    process: proc,
    buffer: [],
    subscribers: new Set(),
    finished: false,
  };

  currentOperation = op;
  void pumpOutput(op); // fire-and-forget — independent of the HTTP response below

  return op;
}

// ─── Endpoint implementations ────────────────────────────────────────────────

/**
 * Start a deploy operation and stream output as SSE
 */
async function startDeployOperation(req: Request): Promise<Response> {
  let body: DeployOperationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body', 400);
  }

  if (!body.environment) {
    return errorResponse('Missing required field: environment', 400);
  }

  // No `await` between this check and the assignment in launchOperation, so two
  // concurrent requests can't both pass the guard. A finished operation isn't a
  // conflict — it's kept around so late reconnects can still replay it.
  if (currentOperation && !currentOperation.finished) {
    return errorResponse(
      `An operation is already running: ${currentOperation.type} (${currentOperation.environment}, started ${currentOperation.startedAt})`,
      409,
    );
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

  const op = launchOperation('deploy', body.environment, args);

  return subscribeToOperation(op);
}

/**
 * Start a build operation and stream output as SSE
 */
async function startBuildOperation(req: Request): Promise<Response> {
  let body: BuildOperationRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid request body', 400);
  }

  if (!body.environment) {
    return errorResponse('Missing required field: environment', 400);
  }

  // Reserve the operation slot atomically (see startDeployOperation): no
  // `await` between this check and the assignment below.
  if (currentOperation && !currentOperation.finished) {
    return errorResponse(
      `An operation is already running: ${currentOperation.type} (${currentOperation.environment}, started ${currentOperation.startedAt})`,
      409,
    );
  }

  // Build the CLI command arguments
  const cliCmd = getCliCommand();
  const args = [...cliCmd, 'build', body.environment];

  if (body.services) args.push('--services', body.services);
  if (body.push) args.push('--push');

  const op = launchOperation('build', body.environment, args);

  return subscribeToOperation(op);
}

/**
 * Return the status of the current operation (if any) — including one that
 * just finished, so a client can decide whether to reattach via the stream
 * endpoint and recover its final output.
 */
function getOperationStatus(): Response {
  if (!currentOperation) {
    return jsonResponse({
      running: false,
    } satisfies OperationStatusResponse);
  }

  return jsonResponse({
    running: !currentOperation.finished,
    type: currentOperation.type,
    environment: currentOperation.environment,
    startedAt: currentOperation.startedAt,
  } satisfies OperationStatusResponse);
}

/**
 * Reattach to the current (or last) operation's output stream — replays the
 * full buffer, then continues live if it's still running.
 */
function attachToOperation(): Response {
  if (!currentOperation) {
    return errorResponse('No operation to attach to', 404);
  }
  return subscribeToOperation(currentOperation);
}

/**
 * Cancel the running operation by killing the child process
 */
function cancelOperation(): Response {
  if (!currentOperation || currentOperation.finished) {
    return jsonResponse({ success: false, message: 'No operation is currently running' });
  }

  const { type, environment } = currentOperation;

  try {
    currentOperation.process.kill();
  } catch {
    // Process may already have exited
  }

  return jsonResponse({
    success: true,
    message: `Cancelled ${type} operation for ${environment}`,
  });
}
