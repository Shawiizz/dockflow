#!/usr/bin/env bun
/**
 * Regenerates golden expectations (DESIGN-CORE 8.9; design-07 6.4). The single update mechanism:
 * `golden.test.ts` never writes a file and no environment variable switches it into an update mode.
 *
 * Usage (from cli/):
 *   bun run scripts/update-golden.ts [case ...]
 *
 * With no arguments every case under src/__tests__/kubernetes/golden/ is rewritten. Each case is
 * rendered through the exact path golden.test.ts uses (renderCase); a load-time case is left alone
 * (nothing to write, design-07 6.4). After writing, the golden suite runs against what was just
 * written, and `git status --porcelain` over the golden directory reports what changed.
 */

import { $ } from 'bun';
import { discoverCases, renderCase, writeExpectations } from '../src/__tests__/kubernetes/support/golden';

if (process.env.CI) {
  process.stderr.write('update-golden refuses to run when CI is set\n');
  process.exit(1);
}

const cliDir = `${import.meta.dir}/..`;
const wanted = process.argv.slice(2);
const cases = (await discoverCases()).filter((c) => wanted.length === 0 || wanted.includes(c.name));
const unknown = wanted.filter((name) => !cases.some((c) => c.name === name));
if (unknown.length > 0) {
  process.stderr.write(`Unknown golden case(s): ${unknown.join(', ')}\n`);
  process.exit(1);
}

for (const c of cases) {
  process.stdout.write(`rendering ${c.name}...\n`);
  // renderCase is the exact path golden.test.ts uses (6.2); a load-time case has nothing to write.
  await writeExpectations(c, await renderCase(c));
}

const testResult = Bun.spawnSync(['bun', 'test', 'src/__tests__/kubernetes/golden.test.ts'], { cwd: cliDir, stdout: 'inherit', stderr: 'inherit' });
const status = await $`git status --porcelain -- src/__tests__/kubernetes/golden`.cwd(cliDir).text();
process.stdout.write(status.length > 0 ? `Changed expectations:\n${status}` : 'No expectation changed\n');
process.exit(testResult.exitCode);
