/**
 * Connection string management
 */

import chalk from 'chalk';
import { printHeader } from '../../utils/output';
import { 
  generateConnectionString as generateConnString,
  parseConnectionString as parseConnString
} from '../../utils/connection-parser';
import type { HostConfig } from './types';
import type { SSHKeyConnection } from '../../types';

// Re-export for backwards compatibility
export type { SSHKeyConnection as ConnectionInfo } from '../../types';

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

  console.log(chalk.yellow('━'.repeat(70)));
  console.log(chalk.yellow('SSH Private Key (KEEP SECURE):'));
  console.log(chalk.yellow('━'.repeat(70)));
  console.log(privateKey);
  console.log(chalk.yellow('━'.repeat(70)));
  console.log('');

  const connectionString = generateConnectionString({
    host: config.publicHost,
    port: config.sshPort,
    user: config.deployUser,
    privateKey: privateKey,
    password: config.deployPassword
  });

  console.log(chalk.red('╔' + '═'.repeat(70) + '╗'));
  console.log(chalk.red('║') + '                         ⚠️  DO NOT SHARE  ⚠️                          ' + chalk.red('║'));
  console.log(chalk.red('║') + '                                                                      ' + chalk.red('║'));
  console.log(chalk.red('║') + `  This connection string contains the SSH private key!                ` + chalk.red('║'));
  console.log(chalk.red('║') + `  Anyone with this string can access your server as: ${config.deployUser.padEnd(15)}   ` + chalk.red('║'));
  console.log(chalk.red('╚' + '═'.repeat(70) + '╝'));
  console.log('');

  console.log(chalk.cyan('Connection String (Base64):'));
  console.log(chalk.yellow('━'.repeat(70)));
  console.log(connectionString);
  console.log(chalk.yellow('━'.repeat(70)));
  console.log('');

  console.log(chalk.cyan('Deployment User:'), chalk.blue(config.deployUser));
  console.log('');
  console.log(chalk.yellow('Add this connection string to your CI/CD secrets:'));
  console.log(chalk.gray('   Secret name: [YOURENV]_CONNECTION'));
  console.log(chalk.gray('   (Replace [YOURENV] with your environment, e.g., PRODUCTION_CONNECTION)'));
  console.log('');
}
