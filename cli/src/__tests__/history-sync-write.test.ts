import { describe, expect, it } from 'bun:test';
import { writeNodeHistory } from '../commands/app/history-sync';
import type { RemoteShell } from '../utils/remote-shell';

function shell(exitCode = 0): { calls: { command: string; stdin?: string }[]; shell: RemoteShell } {
  const calls: { command: string; stdin?: string }[] = [];
  return {
    calls,
    shell: {
      async run(command, stdin) {
        calls.push({ command, stdin });
        return { stdout: '', stderr: exitCode ? 'No space left on device' : '', exitCode };
      },
    },
  };
}

describe('writeNodeHistory', () => {
  it('sends the history on stdin, never in the command', async () => {
    const audit = 'x'.repeat(200_000);
    const { calls, shell: node } = shell();

    expect(await writeNodeHistory(node, 'shop-production', audit, '{"id":"1"}')).toBe(true);

    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/var/lib/dockflow/audit' && cat > '/var/lib/dockflow/audit/shop-production.log'",
      "mkdir -p '/var/lib/dockflow/metrics/shop-production' && cat > '/var/lib/dockflow/metrics/shop-production/deployments.json'",
    ]);
    expect(calls[0].stdin).toBe(`${audit}\n`);
  });

  it('reports a write the node refused', async () => {
    expect(await writeNodeHistory(shell(1).shell, 'shop-production', 'line', '')).toBe(false);
  });
});
