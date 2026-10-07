/**
 * Shared firewall helper for opening ports on remote hosts.
 * Used by both swarm.ts and k3s.ts setup commands.
 */

import { createSpinner, printDim } from '../../utils/output';
import { sshExec } from '../../utils/ssh';
import type { SSHKeyConnection } from '../../types';

export interface PortDefinition {
  port: number;
  protocol: string;
  description: string;
}

export type FirewallTool = 'ufw' | 'firewalld' | 'iptables';

/**
 * The commands that open `ports` with `tool`, as the deploy user runs them over SSH: `sudo -n`
 * fails at once instead of waiting for a password the session cannot type.
 */
export function openPortCommands(tool: FirewallTool, ports: readonly PortDefinition[]): string[] {
  switch (tool) {
    case 'ufw':
      return [...ports.map(({ port, protocol }) => `sudo -n ufw allow ${port}/${protocol}`), 'sudo -n ufw reload'];
    case 'firewalld':
      return [
        ...ports.map(({ port, protocol }) => `sudo -n firewall-cmd --permanent --add-port=${port}/${protocol}`),
        'sudo -n firewall-cmd --reload',
      ];
    case 'iptables':
      // checked first, so running setup again does not stack duplicate rules
      return ports.map(({ port, protocol }) => {
        const rule = `INPUT -p ${protocol} --dport ${port} -j ACCEPT`;
        return `sudo -n iptables -C ${rule} 2>/dev/null || sudo -n iptables -I ${rule}`;
      });
  }
}

/** ufw and firewall-cmd live in /usr/sbin, which a regular user's PATH lacks on some distributions */
async function detectFirewall(connection: SSHKeyConnection): Promise<FirewallTool> {
  const has = async (tool: string) =>
    (await sshExec(connection, `PATH="$PATH:/usr/sbin:/sbin" command -v ${tool}`)).stdout.trim() !== '';
  if (await has('ufw')) return 'ufw';
  if (await has('firewall-cmd')) return 'firewalld';
  return 'iptables';
}

/**
 * Open firewall ports on a remote host with the firewall tool it has (ufw, firewalld, else
 * iptables). Returns false, after printing the commands to run as root, when one of them failed.
 */
export async function openPorts(
  connection: SSHKeyConnection,
  serverName: string,
  ports: PortDefinition[],
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Opening ports on ${serverName}...`);

  try {
    const tool = await detectFirewall(connection);
    const commands = openPortCommands(tool, ports);
    for (const command of commands) {
      const result = await sshExec(connection, command);
      if (result.exitCode !== 0) {
        const cause = (result.stderr || result.stdout).trim() || `exit code ${result.exitCode}`;
        spinner.warn(`Could not open the ports on ${serverName}: ${cause}`);
        printDim(`Run as root on ${serverName}:\n${commands.map((c) => `  ${c.replace(/sudo -n /g, '')}`).join('\n')}`);
        return false;
      }
    }
    spinner.succeed(`Ports opened on ${serverName} (${tool})`);
    return true;
  } catch (error) {
    spinner.warn(`Could not open the ports on ${serverName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
