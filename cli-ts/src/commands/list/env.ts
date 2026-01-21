/**
 * List env command - Show available environments and their configuration
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, loadServersConfig } from '../../utils/config';
import { printSection, printError } from '../../utils/output';
import type { ServerConfig } from '../../types';

interface EnvironmentInfo {
  name: string;
  servers: {
    name: string;
    role: string;
    host: string;
    port: number;
    user: string;
  }[];
}

function getEnvironmentsInfo(): EnvironmentInfo[] {
  const serversConfig = loadServersConfig();
  if (!serversConfig) {
    return [];
  }

  // Group servers by environment tag
  const envMap = new Map<string, EnvironmentInfo>();

  for (const [serverName, serverConfig] of Object.entries(serversConfig.servers)) {
    const defaults = serversConfig.defaults || { user: 'root', port: 22 };
    
    for (const tag of serverConfig.tags) {
      if (!envMap.has(tag)) {
        envMap.set(tag, { name: tag, servers: [] });
      }

      envMap.get(tag)!.servers.push({
        name: serverName,
        role: serverConfig.role || 'manager',
        host: serverConfig.host || `<from secrets>`,
        port: serverConfig.port || defaults.port || 22,
        user: serverConfig.user || defaults.user || 'root',
      });
    }
  }

  // Sort environments
  return Array.from(envMap.values()).sort((a, b) => {
    // Priority order: production, staging, then alphabetical
    const priority: Record<string, number> = { production: 0, staging: 1 };
    const aPriority = priority[a.name] ?? 99;
    const bPriority = priority[b.name] ?? 99;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.name.localeCompare(b.name);
  });
}

export function registerListEnvCommand(parent: Command): void {
  parent
    .command('env')
    .alias('envs')
    .alias('environments')
    .description('List available environments and their servers')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const environments = getEnvironmentsInfo();

      if (options.json) {
        console.log(JSON.stringify({
          project: config?.project_name || null,
          environments: environments.map(env => ({
            name: env.name,
            servers: env.servers
          }))
        }, null, 2));
        return;
      }

      console.log('');
      
      if (config?.project_name) {
        printSection(`Environments: ${config.project_name}`);
      } else {
        printSection('Environments');
      }
      console.log('');

      if (environments.length === 0) {
        printError('No environments found');
        console.log(chalk.gray('Create .dockflow/servers.yml to define your environments'));
        console.log('');
        console.log(chalk.gray('Example:'));
        console.log(chalk.gray('  defaults:'));
        console.log(chalk.gray('    user: deploy'));
        console.log(chalk.gray('    port: 22'));
        console.log(chalk.gray('  servers:'));
        console.log(chalk.gray('    prod-server:'));
        console.log(chalk.gray('      host: 192.168.1.100'));
        console.log(chalk.gray('      tags: [production]'));
        return;
      }

      for (const env of environments) {
        const envColor = env.name === 'production' 
          ? chalk.red 
          : env.name === 'staging' 
            ? chalk.yellow 
            : chalk.blue;
        
        const managerCount = env.servers.filter(s => s.role === 'manager').length;
        const workerCount = env.servers.filter(s => s.role === 'worker').length;
        
        let clusterInfo = '';
        if (managerCount > 0 || workerCount > 0) {
          const parts = [];
          if (managerCount > 0) parts.push(`${managerCount} manager${managerCount > 1 ? 's' : ''}`);
          if (workerCount > 0) parts.push(`${workerCount} worker${workerCount > 1 ? 's' : ''}`);
          clusterInfo = chalk.gray(` (${parts.join(', ')})`);
        }

        console.log(envColor(`● ${env.name}`) + clusterInfo);
        
        for (const server of env.servers) {
          const roleIcon = server.role === 'manager' ? '👑' : '⚙️';
          const hostInfo = server.host.startsWith('<') 
            ? chalk.gray(server.host) 
            : chalk.white(server.host);
          
          console.log(`  ${roleIcon} ${chalk.cyan(server.name.padEnd(20))} ${hostInfo}:${server.port} ${chalk.gray(`(${server.user})`)}`);
        }
        console.log('');
      }

      // Show deployment commands hint
      console.log(chalk.gray('─'.repeat(50)));
      console.log('');
      console.log(chalk.gray('Deploy to an environment:'));
      for (const env of environments.slice(0, 2)) {
        console.log(chalk.gray(`  dockflow deploy ${env.name}`));
      }
      console.log('');
    });
}
