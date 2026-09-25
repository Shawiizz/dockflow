#!/usr/bin/env bun
/**
 * Coverage gate (design-07 2.3): reads cli/coverage/lcov.info and fails when a gated Kubernetes or
 * k3s-setup file's line or function coverage is below its threshold, or when a gated file has no
 * record in the report at all (bun only reports modules a test actually loaded, so an untested file
 * is silently missing rather than shown at 0%).
 *
 * Usage (from cli/): bun test src/ --coverage --coverage-reporter=lcov && bun run scripts/check-coverage.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const CLI_DIR = resolve(import.meta.dir, '..');
const LCOV_PATH = join(CLI_DIR, 'coverage', 'lcov.info');
const SRC_DIR = join(CLI_DIR, 'src');

const K = 'src/services/orchestrator/kubernetes';
const SETUP = 'src/commands/setup/k3s';

interface Gate {
  readonly patterns: readonly string[];
  readonly lines: number;
  readonly functions: number;
}

/** Table of design-07 2.3, patterns relative to cli/ (`**` = every file below, `*` = one path segment). */
const GATES: readonly Gate[] = [
  {
    patterns: [
      `${K}/model/**`,
      `${K}/normalize/**`,
      `${K}/translate/**`,
      `${K}/resources/registry.ts`,
      `${K}/naming.ts`,
      `${K}/labels.ts`,
      `${K}/yaml.ts`,
      `${K}/status/**`,
      `${K}/apply/*-plan.ts`,
      `${K}/apply/closure.ts`,
      `${K}/helm/resolve.ts`,
    ],
    lines: 95,
    functions: 95,
  },
  {
    patterns: [
      `${K}/runtime/**`,
      `${K}/apply/engine.ts`,
      `${K}/apply/prune.ts`,
      `${K}/apply/revert.ts`,
      `${K}/backends/**`,
      `${K}/k3s/**`,
    ],
    lines: 85,
    functions: 85,
  },
  {
    patterns: [`${SETUP}/plan.ts`, `${SETUP}/config.ts`, `${SETUP}/firewall.ts`, `${SETUP}/tokens.ts`, `${SETUP}/verify.ts`],
    lines: 95,
    functions: 95,
  },
  {
    patterns: [`${SETUP}/node.ts`, `${SETUP}/install.ts`, `${SETUP}/helm.ts`, `${SETUP}/identity.ts`, `${SETUP}/system.ts`, `${SETUP}/index.ts`],
    lines: 80,
    functions: 80,
  },
  {
    patterns: [
      'src/utils/hash.ts',
      'src/utils/redact.ts',
      'src/services/orchestrator/capabilities.ts',
      'src/services/orchestrator/target.ts',
      'src/services/orchestrator/format.ts',
      'src/services/orchestrator/diagnostics.ts',
    ],
    lines: 95,
    functions: 95,
  },
];

interface Coverage {
  linesFound: number;
  linesHit: number;
  funcsFound: number;
  funcsHit: number;
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

const toPosix = (path: string): string => path.split('\\').join('/');

/** Every `.ts` source file below `src/`, as a path relative to cli/ (posix separators), tests excluded. */
function walkSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      found.push(...walkSourceFiles(abs));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push(toPosix(relative(CLI_DIR, abs)));
  }
  return found;
}

/** `**` matches any suffix (any depth); a bare `*` matches within one path segment; everything else is literal. */
function patternToPredicate(pattern: string): (path: string) => boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -1); // keep the trailing '/'
    return (path) => path.startsWith(prefix);
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    const re = new RegExp(`^${escaped}$`);
    return (path) => re.test(path);
  }
  return (path) => path === pattern;
}

function gatedFiles(allFiles: readonly string[], gate: Gate): string[] {
  const predicates = gate.patterns.map(patternToPredicate);
  return allFiles.filter((file) => predicates.some((matches) => matches(file)));
}

function parseLcov(text: string): Map<string, Coverage> {
  const records = new Map<string, Coverage>();
  let file: string | null = null;
  let rec: Coverage = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      file = toPosix(line.slice(3));
    } else if (line.startsWith('FNF:')) {
      rec.funcsFound = Number(line.slice(4));
    } else if (line.startsWith('FNH:')) {
      rec.funcsHit = Number(line.slice(4));
    } else if (line.startsWith('LF:')) {
      rec.linesFound = Number(line.slice(3));
    } else if (line.startsWith('LH:')) {
      rec.linesHit = Number(line.slice(3));
    } else if (line === 'end_of_record') {
      if (file) records.set(file, rec);
      file = null;
      rec = { linesFound: 0, linesHit: 0, funcsFound: 0, funcsHit: 0 };
    }
  }
  return records;
}

const percent = (hit: number, found: number): number => (found === 0 ? 100 : (hit / found) * 100);

export function checkCoverage(lcovText: string, allFiles: readonly string[]): { ok: boolean; report: string[] } {
  const records = parseLcov(lcovText);
  const report: string[] = [];
  let failures = 0;
  let checked = 0;

  for (const gate of GATES) {
    for (const file of gatedFiles(allFiles, gate)) {
      checked++;
      const rec = records.get(file);
      if (!rec) {
        failures++;
        report.push(`MISSING  ${file}  no coverage record (not loaded by any test)`);
        continue;
      }
      const linePct = percent(rec.linesHit, rec.linesFound);
      const funcPct = percent(rec.funcsHit, rec.funcsFound);
      if (linePct < gate.lines) {
        failures++;
        report.push(`FAIL     ${file}  lines ${linePct.toFixed(1)}% < ${gate.lines}%`);
      }
      if (funcPct < gate.functions) {
        failures++;
        report.push(`FAIL     ${file}  functions ${funcPct.toFixed(1)}% < ${gate.functions}%`);
      }
    }
  }

  if (failures === 0) report.push(`ok       ${checked} gated files meet their coverage threshold`);
  return { ok: failures === 0, report };
}

export function main(): number {
  if (!existsSync(LCOV_PATH)) {
    err(`check-coverage: ${relative(CLI_DIR, LCOV_PATH)} not found`);
    err('Run `bun test src/ --coverage --coverage-reporter=lcov` in cli/ first.');
    return 1;
  }
  const lcovText = readFileSync(LCOV_PATH, 'utf8');
  const allFiles = walkSourceFiles(SRC_DIR);
  const { ok, report } = checkCoverage(lcovText, allFiles);
  for (const line of report) out(line);
  return ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    err(`check-coverage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
