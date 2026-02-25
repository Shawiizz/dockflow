/**
 * Connection string management
 */

import { printHeader, printBlank, printWarning, printError, printInfo, printDim, printRaw, colors } from '../../utils/output';
import { 
  generateConnectionString as generateConnString,
  parseConnectionString as parseConnString
} from '../../utils/connection-parser';
import type { HostConfig } from './types';
import type { SSHKeyConnection } from '../../types';

/**
 * Generate connection string (base64 encoded JSON)
 */
export function generateConnectionString(config: {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  password?: string;
}): string {
  return generateConnString(config as SSHKeyConnection);
}

/**
 * Parse connection string to ConnectionInfo
 */
export function parseConnectionString(connectionString: string): SSHKeyConnection | null {
  const result = parseConnString(connectionString);
  return result.success ? result.data : null;
}

/**
 * Display connection information
 */
export function displayConnectionInfo(config: HostConfig, privateKey: string): void {
  printBlank();
  printHeader('Connection Information');
  printBlank();

  printWarning('━'.repeat(70));
  printWarning('SSH Private Key (KEEP SECURE):');
  printWarning('━'.repeat(70));
  printRaw(privateKey);
  printWarning('━'.repeat(70));
  printBlank();

  const connectionString = generateConnectionString({
    host: config.publicHost,
    port: config.sshPort,
    user: config.deployUser,
    privateKey: privateKey,
    password: config.deployPassword
  });

  printError('╔' + '═'.repeat(70) + '╗');
  console.log(colors.error('║') + '                         ⚠️  DO NOT SHARE  ⚠️                          ' + colors.error('║'));
  console.log(colors.error('║') + '                                                                      ' + colors.error('║'));
  console.log(colors.error('║') + `  This connection string contains the SSH private key!                ` + colors.error('║'));
  console.log(colors.error('║') + `  Anyone with this string can access your server as: ${config.deployUser.padEnd(15)}   ` + colors.error('║'));
  printError('╚' + '═'.repeat(70) + '╝');
  printBlank();

  printInfo('Connection String (Base64):');
  printWarning('━'.repeat(70));
  printRaw(connectionString);
  printWarning('━'.repeat(70));
  printBlank();

  console.log(colors.info('Deployment User:'), colors.bold(config.deployUser));
  printBlank();
  printWarning('Add this connection string to your CI/CD secrets:');
  printDim('   Secret name: [YOURENV]_CONNECTION');
  printDim('   (Replace [YOURENV] with your environment, e.g., PRODUCTION_CONNECTION)');
  printBlank();
}
