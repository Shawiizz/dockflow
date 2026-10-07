import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SSHExecResult } from '../../types';
import type { RemoteShell } from '../../utils/remote-shell';

/** The stores target Linux managers: their commands run in a real shell, POSIX hosts only. */
export const hasPosixShell = process.platform !== 'win32' && ['sh', 'find'].every((tool) => Bun.which(tool) !== null);

export interface Call {
  command: string;
  stdin: string | undefined;
}

/** Runs commands with `sh -c` in a temporary directory; `hold` pauses one command to interleave two deploys. */
export class LocalShell implements RemoteShell {
  readonly root = mkdtempSync(join(tmpdir(), 'dockflow-store-'));
  private readonly holds: { matches: (command: string) => boolean; arrive: () => void; open: Promise<void> }[] = [];

  hold(matches: (command: string) => boolean): { reached: Promise<void>; release: () => void } {
    let arrive = () => {};
    let release = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({ matches, arrive, open });
    return { reached, release };
  }

  async run(command: string, stdin?: string): Promise<SSHExecResult> {
    const index = this.holds.findIndex((hold) => hold.matches(command));
    if (index >= 0) {
      const [hold] = this.holds.splice(index, 1);
      hold.arrive();
      await hold.open;
    }
    const child = Bun.spawn(['sh', '-c', command], {
      cwd: this.root,
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
}

