#!/usr/bin/env bun
/**
 * Lane runner (design-07 16.9): `bun run run.ts <lane> [--file <name>]`.
 *
 * 1. prepares the lane once (setup.ts's `prepareLane`);
 * 2. lists `<dir>/*.test.ts` sorted by file name — fixed here, never bun's inode order;
 * 3. runs each file in its own `bun test` process (a leak watcher for E2E_SECRET_ around it on a
 *    shared-cluster lane), with DOCKFLOW_E2E_PREPARED=1 so the file's own preload only re-attaches;
 * 4. a `failFast` lane (every shared-cluster lane) stops at the first failing file: the remaining
 *    files are reported "not run", and run.ts exits with that file's code — one honest failure and
 *    one debug dump instead of a cascade in the files after it;
 * 5. a non-failFast lane (k3s-setup, nightly) runs every file regardless, since each owns its own
 *    containers; run.ts exits non-zero when any file failed.
 *
 * `--bail` is deliberately not used (0.2: it counts failing tests, not files, so it would cut a file
 * short on its first failed assertion and hide the rest of that file's results).
 */

import { appendFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { dumpDebug } from "../helpers/debug-dump";
import { watchProcesses } from "../helpers/leak-watch";
import { TOPOLOGIES } from "../helpers/topology";
import { isLaneName, LANE_NAMES, LANES, type Lane, type LaneName } from "./lanes";

const K3S_DIR = import.meta.dir;
const ARTIFACTS_DIR = process.env.DOCKFLOW_E2E_ARTIFACTS || join(K3S_DIR, "..", ".artifacts");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function testFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function runFile(lane: LaneName, dir: string, file: string): Promise<number> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const outfile = join(ARTIFACTS_DIR, `junit-${lane}-${file.replace(/[\\/]/g, "_")}.xml`);
  const proc = Bun.spawn(
    ["bun", "test", join(dir, file), "--timeout", "600000", "--reporter", "junit", "--reporter-outfile", outfile],
    {
      cwd: K3S_DIR,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, DOCKFLOW_E2E_LANE: lane, DOCKFLOW_E2E_PREPARED: "1" },
    },
  );
  return proc.exited;
}

function appendSummary(lines: string[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`);
}

async function runLane(laneName: LaneName, lane: Lane, onlyFile?: string): Promise<number> {
  const dir = join(K3S_DIR, lane.dir);
  const files = testFiles(dir).filter((file) => !onlyFile || file === onlyFile || file === `${onlyFile}.test.ts`);
  if (files.length === 0) throw new Error(`Lane ${laneName} has no test files matching in ${lane.dir}`);

  const watchNodes = lane.topology ? TOPOLOGIES[lane.topology].nodes.map((n) => n.key) : [];
  const started = Date.now();
  let firstFailureCode: number | null = null;
  let firstFailureFile: string | null = null;
  const notRun: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    if (lane.failFast && firstFailureFile !== null) {
      notRun.push(file);
      continue;
    }
    log(`\n=== ${laneName}: ${file} ===`);
    const watch = watchNodes.length > 0 ? watchProcesses(watchNodes, [/E2E_SECRET_/]) : null;
    const code = await runFile(laneName, dir, file);
    const leaks = watch ? await watch.stop() : [];
    if (leaks.length > 0) {
      log(`[run] ${file}: leaked secret material found on ${leaks.map((h) => `${h.node}#${h.pid}`).join(", ")}`);
    }
    const fileFailed = code !== 0 || leaks.length > 0;
    if (fileFailed) {
      failed.push(file);
      // A failing test's own afterEach already dumps under `<file>:<test name>` (16.9); this is the
      // fallback for what that cannot cover — a crashed process, a timeout, or a leak this loop found
      // that the file itself never saw.
      await dumpDebug(file).catch((error: unknown) => log(`[run] debug dump for ${file} failed: ${errorText(error)}`));
      if (firstFailureFile === null) {
        firstFailureFile = file;
        firstFailureCode = code !== 0 ? code : 1;
      }
    }
  }

  const budgetMs = lane.budgetMin * 60_000;
  const elapsedMs = Date.now() - started;
  if (elapsedMs > budgetMs) {
    log(`[run] ${laneName} took ${(elapsedMs / 60_000).toFixed(1)} min, over its ${lane.budgetMin} min budget.`);
  }

  if (notRun.length > 0) {
    log(`[run] ${laneName} stopped after ${firstFailureFile} failed. Not run: ${notRun.join(", ")}`);
    appendSummary([
      `### ${laneName}`,
      `Stopped after \`${firstFailureFile}\` failed.`,
      ...notRun.map((f) => `- \`${f}\`: not run (lane stopped after ${firstFailureFile} failed)`),
    ]);
  } else if (failed.length > 0) {
    appendSummary([`### ${laneName}`, ...failed.map((f) => `- \`${f}\`: failed`)]);
  }

  return firstFailureCode ?? 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const USAGE = "Usage: bun run run.ts <lane> [--file <name>]";

function parseArgs(argv: string[]): { lane: LaneName; file?: string } {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const laneArg = positional[0];
  if (!laneArg || !isLaneName(laneArg)) {
    throw new Error(`${USAGE}\nKnown lanes: ${LANE_NAMES.join(", ")}`);
  }
  const fileIndex = argv.indexOf("--file");
  const file = fileIndex !== -1 ? argv[fileIndex + 1] : undefined;
  return { lane: laneArg, file };
}

async function main(): Promise<void> {
  const { lane: laneName, file } = parseArgs(process.argv.slice(2));
  process.env.DOCKFLOW_E2E_LANE = laneName;
  const lane = LANES[laneName];

  process.env.DOCKFLOW_E2E_SETUP_IMPORT_ONLY = "1";
  const { prepareLane } = await import("./setup");
  delete process.env.DOCKFLOW_E2E_SETUP_IMPORT_ONLY;
  await prepareLane(lane);
  // so the leak watcher this process wraps around each file (currentTopology()) resolves correctly;
  // each spawned file's own preload sets this again in its own process regardless.
  if (lane.topology) process.env.DOCKFLOW_E2E_TOPOLOGY = lane.topology;

  const code = await runLane(laneName, lane, file);
  process.exit(code);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${errorText(error)}\n`);
  process.exit(1);
}
