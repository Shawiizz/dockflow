/**
 * SSH utilities using native ssh command.
 * Supports all key types including ed25519.
 */

import { spawn, spawnSync } from "child_process";
import type { SSHKeyConnection } from "../types";
import { 
  createTempKeyFile, 
  cleanupKeyFile, 
  buildSSHArgs, 
  getSSHCommand 
} from "./ssh-keys";
import { unwrap } from "../types";

// Re-export ConnectionInfo for backwards compatibility
export type { SSHKeyConnection as ConnectionInfo } from "../types";

// Internal type alias for cleaner code
type ConnectionInfo = SSHKeyConnection;

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
  const keyFileResult = createTempKeyFile(conn.privateKey);
  const keyFile = unwrap(keyFileResult);
  
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
  const keyFileResult = createTempKeyFile(conn.privateKey);
  const keyFile = unwrap(keyFileResult);
  
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
  const keyFileResult = createTempKeyFile(conn.privateKey);
  const keyFile = unwrap(keyFileResult);
  
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
  const keyFileResult = createTempKeyFile(conn.privateKey);
  const keyFile = unwrap(keyFileResult);
  
  return new Promise((resolve, reject) => {
    const sshArgs = [...buildSSHArgs(conn, keyFile, { allocateTTY: true }), command];
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
    const result = await sshExecStream(conn, "echo ok", {
      onStdout: () => {}, // Suppress output during testing
      onStderr: () => {},
    });
    return result.exitCode === 0 && result.stdout.trim() === "ok";
  } catch {
    return false;
  }
}
