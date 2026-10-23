/**
 * Network detection utilities
 */

import { spawnSync } from 'child_process';
import * as os from 'os';

/** The public IPv4 address as the internet sees it, else the first local address, else 127.0.0.1. */
export function detectPublicIP(): string {
  const methods = [
    "curl -4 -s --max-time 5 ifconfig.me 2>/dev/null",
    "curl -4 -s --max-time 5 icanhazip.com 2>/dev/null",
    "curl -4 -s --max-time 5 ipecho.net/plain 2>/dev/null",
    "curl -4 -s --max-time 5 api.ipify.org 2>/dev/null",
    "hostname -I 2>/dev/null | awk '{print $1}'"
  ];

  for (const method of methods) {
    const result = spawnSync('sh', ['-c', method], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }

  return '127.0.0.1';
}

/** The port sshd listens on; 22 when it cannot be found. */
export function detectSSHPort(): number {
  const result = spawnSync('sh', ['-c', "ss -tlnp 2>/dev/null | grep sshd | awk '{print $4}' | grep -oE '[0-9]+$' | head -1"], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status === 0 && result.stdout.trim()) {
    const port = parseInt(result.stdout.trim(), 10);
    if (!isNaN(port) && port > 0 && port <= 65535) {
      return port;
    }
  }

  return 22;
}

export function getCurrentUser(): string {
  return os.userInfo().username;
}
