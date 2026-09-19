/**
 * Shells for the file stores (design-07 3.0, "local shell").
 *
 * `LocalShell` runs the stores' commands with `sh -c` on this machine inside a temporary directory
 * that stands in for `/var/lib/dockflow` (pass `shell.root` as the stores' `root`). POSIX only: the
 * stores rely on symlinks, hard links and file modes, so its tests are gated with
 * `test.if(hasPosixShell)`.
 *
 * `ScriptedShell` answers commands from a function, for the message rows that need a remote
 * failure (a read-only directory, an undeletable lock) no temporary directory can produce.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StoreShell, StoreShellResult } from '../../../services/orchestrator/stores/file-release-store';

/** the stores target Linux managers: `timeout`, `readlink` and `find -mmin` must exist as well */
export const hasPosixShell: boolean =
  process.platform !== 'win32' && ['sh', 'timeout', 'readlink', 'find'].every((tool) => Bun.which(tool) !== null);

export interface ShellCall {
  command: string;
  stdin: string | undefined;
}

export interface HeldCommand {
  /** resolves with the command once it is about to run */
  reached: Promise<string>;
  /** lets it run */
  release(): void;
}

interface Hold {
  matches: (command: string) => boolean;
  arrive: (command: string) => void;
  open: Promise<void>;
}

export class LocalShell implements StoreShell {
  readonly root: string;
  readonly calls: ShellCall[] = [];
  /** runs before every command; a throw makes that command fail like a dropped connection */
  onCommand: ((command: string) => void) | null = null;
  private readonly holds: Hold[] = [];

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'dockflow-store-'));
  }

  /** Holds the next command matching `matches` until `release()`, to interleave two stores. */
  hold(matches: (command: string) => boolean): HeldCommand {
    let arrive: (command: string) => void = () => {};
    let release: () => void = () => {};
    const reached = new Promise<string>((resolve) => {
      arrive = resolve;
    });
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({ matches, arrive, open });
    return { reached, release };
  }

  async run(command: string, stdin?: string): Promise<StoreShellResult> {
    this.calls.push({ command, stdin });
    this.onCommand?.(command);
    const index = this.holds.findIndex((hold) => hold.matches(command));
    if (index >= 0) {
      const [hold] = this.holds.splice(index, 1);
      hold.arrive(command);
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

  /** absolute path inside the temporary root */
  path(...segments: string[]): string {
    return join(this.root, ...segments);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export type ScriptedReply = Partial<StoreShellResult> | undefined;

export class ScriptedShell implements StoreShell {
  readonly calls: ShellCall[] = [];

  constructor(
    private readonly reply: (command: string, stdin: string | undefined) => ScriptedReply,
    readonly user?: string,
  ) {}

  async run(command: string, stdin?: string): Promise<StoreShellResult> {
    this.calls.push({ command, stdin });
    const answer = this.reply(command, stdin) ?? {};
    return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 };
  }
}
