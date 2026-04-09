import { WritableSignal } from '@angular/core';

export interface PollingConfig<T> {
  /** Signal containing the list of items */
  items: () => T[];
  /** Find the item being acted on */
  findItem: (items: T[]) => T | undefined;
  /** Get the current state/status value from an item */
  getState: (item: T) => string | undefined;
  /** Signal to clear when action completes */
  actionLoading: WritableSignal<string | null>;
  /** Invalidate cache before re-loading */
  invalidateCache: () => void;
  /** Reload items silently */
  reload: () => void;
  /** Polling interval in ms (default 3000) */
  interval?: number;
  /** Max polling duration in ms (default 45000) */
  timeout?: number;
}

/**
 * Polls until an item's state changes after an action, then clears the loading state.
 * Returns a cleanup function to stop polling.
 */
export function pollUntilStateChange<T>(config: PollingConfig<T>): () => void {
  const interval = config.interval ?? 3000;
  const timeout = config.timeout ?? 45_000;
  const initialState = config.getState(config.findItem(config.items()) as T);
  let elapsed = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  timer = setInterval(() => {
    elapsed += interval;
    const currentItem = config.findItem(config.items());
    const currentState = currentItem ? config.getState(currentItem) : undefined;

    if (currentState !== initialState || elapsed >= timeout) {
      config.actionLoading.set(null);
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    config.invalidateCache();
    config.reload();
  }, interval);

  return () => {
    if (timer) { clearInterval(timer); timer = null; }
  };
}
