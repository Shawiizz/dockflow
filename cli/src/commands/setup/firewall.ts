/**
 * Shared firewall helper for opening ports on remote hosts.
 * Used by both swarm.ts and k3s.ts setup commands.
 */

import { createSpinner } from '../../utils/output';
import { sshExec } from '../../utils/ssh';
import type { SSHKeyConnection } from '../../types';

export interface PortDefinition {
  port: number;
  protocol: string;
  description: string;
}

/**
 * Open firewall ports on a remote host.
 * Detects the firewall tool (ufw, firewalld, iptables) and opens the given ports.
 */
export async function openPorts(
  connection: SSHKeyConnection,
  serverName: string,
  ports: PortDefinition[],
): Promise<boolean> {
  const spinner = createSpinner();
  spinner.start(`Opening ports on ${serverName}...`);

  try {
    // Check which firewall is available
    const ufwCheck = await sshExec(connection, 'which ufw 2>/dev/null');
    const firewallCmdCheck = await sshExec(connection, 'which firewall-cmd 2>/dev/null');

    if (ufwCheck.stdout.trim()) {
      // UFW (Ubuntu/Debian)
      for (const { port, protocol } of ports) {
        await sshExec(connection, `sudo ufw allow ${port}/${protocol} 2>/dev/null || true`);
      }
      await sshExec(connection, 'sudo ufw reload 2>/dev/null || true');
    } else if (firewallCmdCheck.stdout.trim()) {
      // firewalld (RHEL/CentOS)
      for (const { port, protocol } of ports) {
        await sshExec(connection, `sudo firewall-cmd --permanent --add-port=${port}/${protocol} 2>/dev/null || true`);
      }
      await sshExec(connection, 'sudo firewall-cmd --reload 2>/dev/null || true');
    } else {
      // Try iptables as fallback
      for (const { port, protocol } of ports) {
        await sshExec(connection, `sudo iptables -I INPUT -p ${protocol} --dport ${port} -j ACCEPT 2>/dev/null || true`);
      }
    }

    spinner.succeed(`Ports opened on ${serverName}`);
    return true;
  } catch {
    spinner.warn(`Could not open ports on ${serverName} (may already be open or no firewall)`);
    return true; // Continue anyway
  }
}
