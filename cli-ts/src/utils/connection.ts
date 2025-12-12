/**
 * Connection utilities
 * Functions for parsing and handling connection strings
 */

export interface ConnectionDetails {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  password?: string;
}

/**
 * Parse base64-encoded connection string to get SSH details
 */
export function parseConnectionString(connectionString: string): ConnectionDetails | null {
  try {
    const json = Buffer.from(connectionString, 'base64').toString('utf-8');
    const data = JSON.parse(json);
    return {
      host: data.host,
      port: parseInt(data.port) || 22,
      user: data.user,
      privateKey: data.privateKey,
      password: data.password,
    };
  } catch {
    return null;
  }
}

/**
 * Normalize private key for SSH usage
 * Handles escaped newlines and different line ending formats
 */
export function normalizePrivateKey(privateKey: string): string {
  let normalized = privateKey
    .replace(/\\n/g, '\n') // Handle escaped newlines
    .replace(/\r\n/g, '\n') // Normalize Windows line endings
    .replace(/\r/g, '\n'); // Handle old Mac line endings

  // Ensure the key ends with a newline
  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }

  return normalized;
}
