/**
 * CLI Constants
 *
 * Centralized magic numbers and configuration defaults
 */

/** Minutes after which a deployment lock is considered stale */
export const LOCK_STALE_THRESHOLD_MINUTES = 30;

/** Max polling attempts when waiting for stack removal */
export const STACK_REMOVAL_MAX_ATTEMPTS = 30;

/** Delay (ms) between stack removal polling attempts */
export const STACK_REMOVAL_POLL_INTERVAL_MS = 2000;
