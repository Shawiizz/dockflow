#!/usr/bin/env bun
/**
 * Packages the e2e fixture charts (design-07 16.8) with the harness helm baked into the node image
 * and writes the repository indexes `.cache/charts/{public,private}` serve over plain HTTP (K78: an
 * `http://` repository is accepted with a warning, so the gated lanes need no TLS and no trusted CA
 * on the nodes).
 *
 * Chart versions come from `helm package --version`, never from editing Chart.yaml per version:
 * `e2e-web` branches its templates on `.Chart.Version` (which that flag sets) to add its 0.2.0-only
 * pod label, so one chart source produces both published versions.
 *
 * Usage: bun run testing/e2e/k3s/tools/package-charts.ts [--net <a.b.c>]
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { CACHE_DIR, exec, nodeImage } from "../../helpers/cluster";
import { chartRepoUrl, SHARED_LANE } from "../../helpers/topology";

const E2E_DIR = join(import.meta.dir, "..", "..");
const FIXTURES_CHARTS_DIR = join(E2E_DIR, "fixtures", "charts");
export const CHARTS_OUT_DIR = join(CACHE_DIR, "charts");

export interface ChartSpec {
  readonly chart: string;
  readonly versions: readonly string[];
}

/** Chart.yaml variants 0.1.0/0.2.0 via templates (16.2): one source per chart, several packaged versions. */
export const CHART_SOURCES: readonly ChartSpec[] = [
  { chart: "e2e-web", versions: ["0.1.0", "0.2.0"] },
  { chart: "e2e-pvc", versions: ["0.1.0"] },
  { chart: "e2e-broken", versions: ["0.1.0"] },
  { chart: "e2e-crd", versions: ["0.1.0"] },
];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** as the host user where there is one (Linux), so tests can rewrite the archives (E-51-14) */
const HOST_USER = process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];

async function harnessHelm(args: string[]): Promise<void> {
  await exec(
    [
      "docker", "run", "--rm",
      ...HOST_USER,
      "-e", "HELM_CACHE_HOME=/tmp/helm/cache",
      "-e", "HELM_CONFIG_HOME=/tmp/helm/config",
      "-e", "HELM_DATA_HOME=/tmp/helm/data",
      "--entrypoint", "/opt/e2e/bin/helm",
      "-v", `${FIXTURES_CHARTS_DIR}:/src:ro`,
      "-v", `${CHARTS_OUT_DIR}:/out`,
      nodeImage(),
      ...args,
    ],
    { timeoutMs: 120_000 },
  );
}

/** Packages every chart/version into `.cache/charts/public`, mirrors the archives into `/private`, indexes both. */
export async function packageCharts(net: string = SHARED_LANE.net): Promise<void> {
  const publicDir = join(CHARTS_OUT_DIR, "public");
  const privateDir = join(CHARTS_OUT_DIR, "private");
  // earlier runs may have left files a root container wrote
  for (const dir of [publicDir, privateDir]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  for (const { chart, versions } of CHART_SOURCES) {
    if (!existsSync(join(FIXTURES_CHARTS_DIR, chart, "Chart.yaml"))) {
      throw new Error(`Chart source missing: testing/e2e/fixtures/charts/${chart}/Chart.yaml`);
    }
    for (const version of versions) {
      log(`[package-charts] packaging ${chart} ${version}...`);
      await harnessHelm(["package", `/src/${chart}`, "--version", version, "-d", "/out/public"]);
    }
  }

  // /private serves the exact same archives, gated by basic auth (charts-nginx.conf) — mirrored
  // rather than repackaged, so both directories always agree byte for byte.
  for (const entry of readdirSync(publicDir)) {
    if (!entry.endsWith(".tgz")) continue;
    await Bun.write(join(privateDir, entry), Bun.file(join(publicDir, entry)));
  }

  log("[package-charts] indexing public and private...");
  await harnessHelm(["repo", "index", "/out/public", "--url", chartRepoUrl(net, "public")]);
  await harnessHelm(["repo", "index", "/out/private", "--url", chartRepoUrl(net, "private")]);
}

const USAGE = "Usage: bun run testing/e2e/k3s/tools/package-charts.ts [--net <a.b.c>]";

function parseArgs(argv: string[]): { net?: string } {
  const opts: { net?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--net") opts.net = argv[++i];
    else throw new Error(`Unknown argument ${argv[i]}\n${USAGE}`);
  }
  return opts;
}

if (import.meta.main) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    await packageCharts(opts.net);
    log("[package-charts] done.");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
