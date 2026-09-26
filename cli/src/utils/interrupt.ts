/**
 * The one owner of SIGINT and SIGTERM. A command that must clean up before it exits (deploy, a
 * command holding the deploy lock, `logs --follow`) registers a handler for the duration of that
 * work, and the first signal runs the registered handlers instead of exiting: they stop the work
 * at a safe point and the command ends on its own. A signal with nothing registered, or a second
 * one while the handlers clean up, exits at once; the `exit` hooks (SSH connections) still run.
 */

type Handler = () => void;

const handlers = new Set<Handler>();
let installed = false;

export const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;

/** What a signal does; the listeners call it with the process's own `exit`, the tests with theirs. */
export function dispatchInterrupt(exitCode: number, exit: (code: number) => void = (code) => process.exit(code)): void {
  if (handlers.size === 0) {
    exit(exitCode);
    return;
  }
  const pending = [...handlers];
  handlers.clear();
  for (const handler of pending) handler();
}

export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('SIGINT', () => dispatchInterrupt(SIGINT_EXIT_CODE));
  process.on('SIGTERM', () => dispatchInterrupt(SIGTERM_EXIT_CODE));
}

/** Runs `handler` on the next SIGINT or SIGTERM instead of exiting; the returned function unregisters it. */
export function onInterrupt(handler: Handler): () => void {
  installSignalHandlers();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
