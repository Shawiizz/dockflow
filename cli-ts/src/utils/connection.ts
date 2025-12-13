/**
 * Connection utilities
 * Functions for parsing and handling connection strings
 * 
 * @deprecated Use connection-parser.ts and ssh-keys.ts instead
 * This file is kept for backwards compatibility
 */

import { parseConnectionStringLegacy } from './connection-parser';
import { normalizePrivateKey } from './ssh-keys';
import type { SSHKeyConnection } from '../types';

// Re-export for backwards compatibility
export type ConnectionDetails = SSHKeyConnection;

/**
 * Parse base64-encoded connection string to get SSH details
 * @deprecated Use parseConnectionString from connection-parser.ts
 */
export function parseConnectionString(connectionString: string): ConnectionDetails | null {
  return parseConnectionStringLegacy(connectionString);
}

// Re-export normalizePrivateKey for backwards compatibility
export { normalizePrivateKey };
