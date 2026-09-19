#!/usr/bin/env bun
/**
 * Copies the validation message catalogue into the MCP package (design-07 20.1, U-ARCH-15):
 *   src/services/orchestrator/messages.ts -> packages/mcp-server/src/shared/messages.ts
 *
 * Usage (from cli/):
 *   bun run scripts/sync-mcp-messages.ts [--check]
 *
 * The MCP package cannot depend on cli/, so it compiles a committed copy: the source verbatim
 * behind a two-line generated header. --check writes nothing and exits 1 with a diff when the
 * committed copy is missing or stale.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_DIR = resolve(import.meta.dir, '..', '..');
const SOURCE = 'cli/src/services/orchestrator/messages.ts';
const TARGET = 'packages/mcp-server/src/shared/messages.ts';

const USAGE = `Usage (from cli/): bun run scripts/sync-mcp-messages.ts [--check]

  --check   compare the committed copy with the catalogue, print a diff and exit 1 when it is stale`;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** The header uses the source's line ending, so the copy stays byte-identical after it. */
export function renderCopy(source: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return (
    `// Generated from ${SOURCE} by cli/scripts/sync-mcp-messages.ts.${eol}` +
    `// Do not edit: change the source, then run \`bun run scripts/sync-mcp-messages.ts\` in cli/.${eol}` +
    source
  );
}

/** Line diff through the longest common subsequence; the files are a few hundred lines at most. */
export function formatDiff(committed: string, expected: string): string {
  const a = committed.split(/\r?\n/);
  const b = expected.split(/\r?\n/);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  // Same lines, different line endings
  if (lines.length === 0) lines.push('(line endings differ)');
  return lines.join('\n');
}

export function main(argv: string[], repoDir = REPO_DIR): number {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  if (unknown.length > 0) {
    err(`sync-mcp-messages: unknown argument ${unknown[0]}\n\n${USAGE}`);
    return 2;
  }

  const sourcePath = join(repoDir, SOURCE);
  const targetPath = join(repoDir, TARGET);
  const expected = renderCopy(readFileSync(sourcePath, 'utf8'));

  if (!argv.includes('--check')) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, expected);
    out(`wrote    ${TARGET}`);
    return 0;
  }

  if (!existsSync(targetPath)) {
    out(`missing  ${TARGET}`);
    out('Run `bun run scripts/sync-mcp-messages.ts` in cli/ and commit the copy.');
    return 1;
  }
  const committed = readFileSync(targetPath, 'utf8');
  if (committed === expected) {
    out(`ok       ${TARGET}`);
    return 0;
  }
  out(`differs  ${TARGET} (- committed, + expected)`);
  out(formatDiff(committed, expected));
  out('Run `bun run scripts/sync-mcp-messages.ts` in cli/ and commit the copy.');
  return 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    err(`sync-mcp-messages: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
