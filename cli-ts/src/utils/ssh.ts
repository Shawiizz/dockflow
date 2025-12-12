/**
 * SSH utilities using native ssh command
 * Supports all key types including ed25519
 */

import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ConnectionInfo } from "./config";

/**
 * Creates a temporary SSH key file from the connection info
 */
function createTempKeyFile(privateKey: string): string {
  const tempDir = os.tmpdir();
  const keyFile = path.join(tempDir, `dockflow_key_${Date.now()}`);
  
  // Normalize line endings to Unix format (required for SSH keys)
  const normalizedKey = privateKey.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Ensure key ends with newline
  const finalKey = normalizedKey.endsWith('\n') ? normalizedKey : normalizedKey + '\n';
  
  // Write key with proper permissions
  fs.writeFileSync(keyFile, finalKey, { mode: 0o600 });
  
  return keyFile;
}

/**
 * Clean up temporary key file
 */
function cleanupKeyFile(keyFile: string): void {
  try {
    if (fs.existsSync(keyFile)) {
      fs.unlinkSync(keyFile);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Build SSH command arguments
 */
function buildSSHArgs(conn: ConnectionInfo, keyFile: string): string[] {
  const args = [
    "-i", keyFile,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-p", conn.port?.toString() || "22",
    `${conn.user}@${conn.host}`
  ];
  
  return args;
}

/**
 * Get the SSH command name based on platform
 */
function getSSHCommand(): string {
  // On Windows, we can use OpenSSH that comes with Windows 10+
  // or Git Bash's ssh
  return "ssh";
}

/**
 * Execute a command via SSH (streaming output to console)
 */
export async function sshExecStream(
  conn: ConnectionInfo,
  command: string,
  options: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const keyFile = createTempKeyFile(conn.privateKey);
  
  try {
    const sshArgs = [...buildSSHArgs(conn, keyFile), command];
    const ssh = getSSHCommand();
    
    return new Promise((resolve, reject) => {
      const proc = spawn(ssh, sshArgs, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      
      let stdout = "";
      let stderr = "";
      
      proc.stdout.on("data", (data) => {
        const str = data.toString();
        stdout += str;
        if (options.onStdout) {
          options.onStdout(str);
        } else {
          // Default: stream to console
          process.stdout.write(str);
        }
      });
      
      proc.stderr.on("data", (data) => {
        const str = data.toString();
        stderr += str;
        if (options.onStderr) {
          options.onStderr(str);
        } else {
          // Default: stream to console
          process.stderr.write(str);
        }
      });
      
      proc.on("error", (err) => {
        cleanupKeyFile(keyFile);
        reject(new Error(`SSH command failed: ${err.message}`));
      });
      
      proc.on("close", (code) => {
        cleanupKeyFile(keyFile);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1
        });
      });
    });
  } catch (error) {
    cleanupKeyFile(keyFile);
    throw error;
  }
}

/**
 * Execute a command via SSH (synchronous, for simple commands)
 */
export function sshExec(
  conn: ConnectionInfo,
  command: string
): { stdout: string; stderr: string; exitCode: number } {
  const keyFile = createTempKeyFile(conn.privateKey);
  
  try {
    const sshArgs = [...buildSSHArgs(conn, keyFile), command];
    const ssh = getSSHCommand();
    
    const result = spawnSync(ssh, sshArgs, {
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    
    cleanupKeyFile(keyFile);
    
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 1
    };
  } catch (error) {
    cleanupKeyFile(keyFile);
    throw error;
  }
}

/**
 * Open an interactive SSH session
 */
export function sshShell(conn: ConnectionInfo): Promise<number> {
  const keyFile = createTempKeyFile(conn.privateKey);
  
  return new Promise((resolve, reject) => {
    const sshArgs = buildSSHArgs(conn, keyFile);
    const ssh = getSSHCommand();
    
    const proc = spawn(ssh, sshArgs, {
      stdio: "inherit",
      shell: false
    });
    
    proc.on("error", (err) => {
      cleanupKeyFile(keyFile);
      reject(new Error(`SSH failed: ${err.message}`));
    });
    
    proc.on("close", (code) => {
      cleanupKeyFile(keyFile);
      resolve(code ?? 0);
    });
  });
}

/**
 * Execute an interactive command via SSH (e.g., docker exec -it)
 */
export function executeInteractiveSSH(
  conn: ConnectionInfo,
  command: string
): Promise<number> {
  const keyFile = createTempKeyFile(conn.privateKey);
  
  return new Promise((resolve, reject) => {
    const sshArgs = [...buildSSHArgs(conn, keyFile), "-t", command];
    const ssh = getSSHCommand();
    
    const proc = spawn(ssh, sshArgs, {
      stdio: "inherit",
      shell: false
    });
    
    proc.on("error", (err) => {
      cleanupKeyFile(keyFile);
      reject(new Error(`SSH failed: ${err.message}`));
    });
    
    proc.on("close", (code) => {
      cleanupKeyFile(keyFile);
      resolve(code ?? 0);
    });
  });
}

/**
 * Test SSH connection
 */
export async function testConnection(conn: ConnectionInfo): Promise<boolean> {
  try {
    const result = await sshExecStream(conn, "echo ok");
    return result.exitCode === 0 && result.stdout.trim() === "ok";
  } catch {
    return false;
  }
}
