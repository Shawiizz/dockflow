/**
 * Failure dump of the Swarm suite: what the manager and the worker say about the cluster, written to
 * `.artifacts/<lane>/` so a CI run that failed leaves enough to diagnose it without the cluster.
 * The last CLI invocations are in `.artifacts/last-cli-invocations.txt` (helpers/cli.ts). Everything
 * written is scrubbed of `E2E_SECRET_*` values.
 *
 * Usage: bun run testing/e2e/helpers/debug-dump.ts [lane]
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tryExec } from "./cluster";
import { ARTIFACTS_DIR, scrub } from "./artifacts";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "./connection";

const NODES = [MANAGER_CONTAINER, WORKER_CONTAINER];

const NODE_COMMANDS: ReadonlyArray<{ file: string; argv: string[] }> = [
  { file: "docker-info.txt", argv: ["docker", "info"] },
  { file: "docker-images.txt", argv: ["docker", "images"] },
  { file: "docker-ps.txt", argv: ["docker", "ps", "-a"] },
  { file: "journalctl-docker.txt", argv: ["journalctl", "-u", "docker", "--no-pager", "-n", "500"] },
  { file: "iptables-docker-user.txt", argv: ["iptables", "-S", "DOCKER-USER"] },
  { file: "ufw-status.txt", argv: ["ufw", "status", "verbose"] },
  { file: "df.txt", argv: ["df", "-h"] },
];

const MANAGER_COMMANDS: ReadonlyArray<{ file: string; argv: string[] }> = [
  { file: "node-ls.txt", argv: ["docker", "node", "ls"] },
  { file: "service-ls.txt", argv: ["docker", "service", "ls"] },
  { file: "overlay-networks.txt", argv: ["docker", "network", "ls", "--filter", "driver=overlay"] },
];

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), scrub(content));
}

async function inContainer(container: string, argv: string[]): Promise<string> {
  const result = await tryExec(["docker", "exec", container, ...argv], { timeoutMs: 60_000 });
  return `${result.stdout}${result.stderr}`;
}

async function dumpServices(dir: string): Promise<void> {
  const ids = (await inContainer(MANAGER_CONTAINER, ["docker", "service", "ls", "-q"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const id of ids) {
    const name = (await inContainer(MANAGER_CONTAINER, ["docker", "service", "inspect", id, "--format", "{{.Spec.Name}}"])).trim();
    const label = name.replace(/[^a-zA-Z0-9._-]+/g, "_") || id;
    write(dir, `service.${label}.ps.txt`, await inContainer(MANAGER_CONTAINER, ["docker", "service", "ps", "--no-trunc", id]));
    write(dir, `service.${label}.labels.txt`, await inContainer(MANAGER_CONTAINER, ["docker", "service", "inspect", id, "--format", "{{json .Spec.Labels}}"]));
    write(dir, `service.${label}.logs.txt`, await inContainer(MANAGER_CONTAINER, ["docker", "service", "logs", "--tail", "200", "--timestamps", id]));
  }
}

/** Write the cluster state under `.artifacts/<lane>/`. Every step tolerates a cluster that is gone. */
export async function dumpDebug(lane: string): Promise<string> {
  const dir = join(ARTIFACTS_DIR, lane);
  mkdirSync(dir, { recursive: true });

  const host = await tryExec(["docker", "ps", "-a"]);
  write(dir, "host-docker-ps.txt", `${host.stdout}${host.stderr}`);

  for (const container of NODES) {
    const logs = await tryExec(["docker", "logs", "--tail", "500", container]);
    write(dir, `${container}.container-logs.txt`, `${logs.stdout}${logs.stderr}`);
    for (const { file, argv } of NODE_COMMANDS) {
      write(dir, `${container}.${file}`, await inContainer(container, argv));
    }
  }
  for (const { file, argv } of MANAGER_COMMANDS) {
    write(dir, file, await inContainer(MANAGER_CONTAINER, argv));
  }
  await dumpServices(dir);
  return dir;
}

if (import.meta.main) {
  const lane = process.argv[2] ?? "swarm";
  console.log(`[dump] ${await dumpDebug(lane)}`);
}
