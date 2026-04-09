/**
 * SSH Key utilities
 *
 * Handles private key normalization and validation.
 */

/**
 * Normalize SSH private key format.
 * Handles escaped newlines and different line ending formats.
 */
export function normalizePrivateKey(privateKey: string): string {
  let normalized = privateKey
    .replace(/\\n/g, '\n')       // Handle escaped newlines
    .replace(/\r\n/g, '\n')      // Normalize Windows line endings
    .replace(/\r/g, '\n');       // Handle old Mac line endings

  // Ensure the key ends with a newline (required by SSH)
  if (!normalized.endsWith('\n')) {
    normalized += '\n';
  }

  return normalized;
}

/**
 * Validate SSH private key format
 */
export function isValidPrivateKey(key: string): boolean {
  const normalized = normalizePrivateKey(key);
  return normalized.includes('-----BEGIN') && normalized.includes('PRIVATE KEY-----');
}
