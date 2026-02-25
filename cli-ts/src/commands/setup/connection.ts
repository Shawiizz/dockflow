/**
 * Connection string management
 */

import { printHeader, colors } from '../../utils/output';
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
  console.log('');
  printHeader('Connection Information');
  console.log('');

  console.log(colors.warning('━'.repeat(70)));
  console.log(colors.warning('SSH Private Key (KEEP SECURE):'));
  console.log(colors.warning('━'.repeat(70)));
  console.log(privateKey);
  console.log(colors.warning('━'.repeat(70)));
  console.log('');

  const connectionString = generateConnectionString({
    host: config.publicHost,
    port: config.sshPort,
    user: config.deployUser,
    privateKey: privateKey,
    password: config.deployPassword
  });

  console.log(colors.error('╔' + '═'.repeat(70) + '╗'));
  console.log(colors.error('║') + '                         ⚠️  DO NOT SHARE  ⚠️                          ' + colors.error('║'));
  console.log(colors.error('║') + '                                                                      ' + colors.error('║'));
  console.log(colors.error('║') + `  This connection string contains the SSH private key!                ` + colors.error('║'));
  console.log(colors.error('║') + `  Anyone with this string can access your server as: ${config.deployUser.padEnd(15)}   ` + colors.error('║'));
  console.log(colors.error('╚' + '═'.repeat(70) + '╝'));
  console.log('');

  console.log(colors.info('Connection String (Base64):'));
  console.log(colors.warning('━'.repeat(70)));
  console.log(connectionString);
  console.log(colors.warning('━'.repeat(70)));
  console.log('');

  console.log(colors.info('Deployment User:'), colors.bold(config.deployUser));
  console.log('');
  console.log(colors.warning('Add this connection string to your CI/CD secrets:'));
  console.log(colors.dim('   Secret name: [YOURENV]_CONNECTION'));
  console.log(colors.dim('   (Replace [YOURENV] with your environment, e.g., PRODUCTION_CONNECTION)'));
  console.log('');
}
