/**
 * /proc cmdline poller (16.11): watches a set of nodes for processes whose command line matches one
 * of the given needles while a scenario runs. Fixture secrets are named `E2E_SECRET_<PURPOSE>_7f3a9c`
 * (0's "Secret markers" rule) precisely so this can catch them appearing in `ps`/`/proc` output, which
 * is the actual risk INV-02 is guarding: a secret is safe in an argv assertion, unsafe on the wire of
 * a process the node's own users can list.
 *
 * A root shell loop (started detached with `docker exec -d`) appends every process's cmdline plus its
 * pid to a per-watch file every 100 ms; `stop()` kills the loop, greps the file for the needles and
 * deletes it.
 */

import { randomUUID } from "crypto";
import { exec, tryExec } from "./cluster";
import { currentTopology, type NodeKey } from "./topology";

export interface LeakHit {
  node: NodeKey;
  pid: string;
  match: string;
}

export interface Watch {
  /** stops the loop on every node, returns every line that matched a needle */
  stop(): Promise<LeakHit[]>;
}

function loopScript(file: string, pidFile: string): string {
  // NUL-separated argv, one cmdline per line with its pid appended after a literal ' #'.
  return (
    `echo $$ > '${pidFile}'; : > '${file}'; ` +
    `while :; do for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; ` +
    `echo " #\${p#/proc/}"; done; sleep 0.1; done >> '${file}'`
  );
}

/** Starts the poller on every node named; resolves once every loop has written its pid file. */
export function watchProcesses(nodes: readonly NodeKey[], needles: readonly RegExp[], intervalMs = 100): Watch {
  void intervalMs; // the poll interval is fixed in loopScript (100ms); kept for the documented signature
  const topo = currentTopology();
  const id = randomUUID().slice(0, 8);
  const file = `/tmp/e2e-cmdlines-${id}`;
  const pidFile = `${file}.pid`;
  const containers = nodes.map((key) => {
    const node = topo.nodes.find((candidate) => candidate.key === key);
    if (!node) throw new Error(`watchProcesses: topology ${topo.name} has no node ${key}`);
    return { key, container: node.container };
  });

  const started = Promise.all(
    containers.map(({ container }) =>
      exec(["docker", "exec", "-d", container, "sh", "-c", loopScript(file, pidFile)]),
    ),
  );

  return {
    async stop(): Promise<LeakHit[]> {
      await started;
      const hits: LeakHit[] = [];
      for (const { key, container } of containers) {
        await tryExec(["docker", "exec", container, "sh", "-c", `kill "$(cat '${pidFile}' 2>/dev/null)" 2>/dev/null; true`]);
        const read = await tryExec(["docker", "exec", container, "cat", file]);
        if (read.exitCode === 0) {
          for (const line of read.stdout.split("\n")) {
            if (line.trim() === "") continue;
            const sep = line.lastIndexOf(" #");
            const cmdline = sep === -1 ? line : line.slice(0, sep);
            const pid = sep === -1 ? "?" : line.slice(sep + 2).trim();
            for (const needle of needles) {
              if (needle.test(cmdline)) hits.push({ node: key, pid, match: cmdline.trim() });
            }
          }
        }
        await tryExec(["docker", "exec", container, "rm", "-f", file, pidFile]);
      }
      return hits;
    },
  };
}
