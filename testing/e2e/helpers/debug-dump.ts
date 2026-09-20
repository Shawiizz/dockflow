/**
 * Failure dumps (16.11): per node (journalctl, systemd, crictl/ctr images, ufw, df), cluster state
 * through harness kubectl/helm, and the last CLI invocation — written once per failing file/test to
 * `testing/e2e/.artifacts/<lane>/<label>/`, so a CI run leaves enough to diagnose without a live
 * cluster. Everything written is scrubbed of `E2E_SECRET_*` values first.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { lastCliInvocation } from "./cli";
import { tryExec } from "./cluster";
import { helm, kubectl } from "./k8s";
import { currentTopology, type Topology } from "./topology";

const E2E_DIR = join(import.meta.dir, "..");
const ARTIFACTS_DIR = process.env.DOCKFLOW_E2E_ARTIFACTS || join(E2E_DIR, ".artifacts");

const SECRET_RE = /E2E_SECRET_[A-Za-z0-9_]*/g;

function scrub(text: string): string {
  return text.replace(SECRET_RE, "***");
}

function slug(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "dump";
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), scrub(content));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NODE_COMMANDS: ReadonlyArray<{ file: string; argv: string[] }> = [
  { file: "journalctl.txt", argv: ["journalctl", "-u", "k3s", "-u", "k3s-agent", "--no-pager", "-n", "800"] },
  { file: "systemctl-failed.txt", argv: ["systemctl", "--failed"] },
  { file: "crictl-ps.txt", argv: ["/usr/local/bin/k3s", "crictl", "ps", "-a"] },
  { file: "crictl-images.txt", argv: ["/usr/local/bin/k3s", "crictl", "images"] },
  { file: "ctr-images.txt", argv: ["/usr/local/bin/k3s", "ctr", "-n", "k8s.io", "images", "ls"] },
  { file: "ufw-status.txt", argv: ["ufw", "status", "verbose"] },
  { file: "df.txt", argv: ["df", "-h"] },
];

const CLUSTER_COMMANDS: ReadonlyArray<{ file: string; args: string[] }> = [
  { file: "nodes.txt", args: ["get", "nodes", "-o", "wide"] },
  { file: "all.txt", args: ["get", "all,pvc,pv,leases,ingressroutes,middlewares", "-A", "-o", "wide"] },
  { file: "events.txt", args: ["get", "events", "-A", "--sort-by=.lastTimestamp"] },
  { file: "pods-describe.txt", args: ["describe", "pods", "-A"] },
  { file: "secrets.txt", args: ["get", "secrets", "-A", "-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,TYPE:.type"] },
];

async function dumpNode(dir: string, node: Topology["nodes"][number]): Promise<void> {
  for (const { file, argv } of NODE_COMMANDS) {
    const result = await tryExec(["docker", "exec", node.container, ...argv]);
    write(dir, `${node.key}.${file}`, `${result.stdout}${result.stderr}`);
  }
}

async function dumpCluster(dir: string): Promise<void> {
  for (const { file, args } of CLUSTER_COMMANDS) {
    try {
      write(dir, file, await kubectl(args, { allowFailure: true }));
    } catch (error) {
      write(dir, file, errorText(error));
    }
  }
  try {
    write(dir, "helm-list.txt", await helm(["list", "-A"]));
  } catch (error) {
    write(dir, "helm-list.txt", errorText(error));
  }
}

function dumpLastCliInvocation(dir: string): void {
  const invocation = lastCliInvocation();
  if (!invocation) return;
  const { args, result } = invocation;
  write(
    dir,
    "last-cli-invocation.txt",
    `dockflow ${args.join(" ")}\nexit ${result.exitCode} (${result.durationMs}ms)\n\n--- stdout ---\n${result.stdout}\n\n--- stderr ---\n${result.stderr}\n`,
  );
}

/** Writes a failure dump for `label` (a file name, or `<file>:<test name>`) under .artifacts/<lane>/<label>/. */
export async function dumpDebug(label: string): Promise<void> {
  const lane = process.env.DOCKFLOW_E2E_LANE ?? "unknown-lane";
  const dir = join(ARTIFACTS_DIR, lane, slug(label));
  mkdirSync(dir, { recursive: true });

  let topo: Topology | undefined;
  try {
    topo = currentTopology();
  } catch {
    topo = undefined; // no shared topology (e.g. the setup lane, or a preload failure before it started one)
  }

  if (topo) {
    await Promise.all(topo.nodes.map((node) => dumpNode(dir, node)));
    await dumpCluster(dir);
  }

  dumpLastCliInvocation(dir);
}
