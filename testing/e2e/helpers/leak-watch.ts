/**
 * Watches the command lines of every process on some nodes while a scenario runs, and reports the
 * ones that contain a secret. A command line is readable by every user of the node (`ps`,
 * `/proc/<pid>/cmdline`), so a secret handed to a program as an argument is a leak even when the
 * program never prints it.
 *
 * On each node a detached root shell loop greps all `/proc/<pid>/cmdline` files for the secrets,
 * every 20 ms, and appends what matches to a file. The secrets reach the node on stdin and are
 * matched through a file (`grep -f`), so neither the loop nor the grep carries one in its own
 * command line. `stop()` ends the loops, reads the files and deletes them.
 */

import { randomUUID } from "crypto";
import { scrub } from "./artifacts";
import { exec, poll, tryExec } from "./cluster";

export interface WatchedSecret {
  /** Names the secret in a report, which never prints its value */
  label: string;
  value: string;
}

export interface LeakHit {
  container: string;
  pid: string;
  secret: string;
  /** The command line with every watched value masked */
  commandLine: string;
}

export interface Watch {
  /** Ends the polling and returns every process seen with a secret in its command line */
  stop(): Promise<LeakHit[]>;
}

const POLL_SECONDS = "0.02";

function pollScript(needles: string, found: string, pidFile: string): string {
  return [
    `echo $$ > ${pidFile}`,
    `: > ${found}`,
    `while :; do grep -a -F -f ${needles} /proc/[0-9]*/cmdline >> ${found} 2>/dev/null; sleep ${POLL_SECONDS}; done`,
  ].join("; ");
}

/** The processes found, from the lines `grep` wrote: `/proc/<pid>/cmdline:<command line>` */
export function parseFound(container: string, text: string, secrets: readonly WatchedSecret[]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const line of text.split("\n")) {
    const match = /^\/proc\/(\d+)\/cmdline:(.*)$/.exec(line);
    if (!match) continue;
    const commandLine = match[2].replaceAll("\0", " ");
    for (const secret of secrets) {
      if (commandLine.includes(secret.value)) {
        hits.push({ container, pid: match[1], secret: secret.label, commandLine: mask(commandLine, secrets).slice(0, 300) });
      }
    }
  }
  return hits;
}

function mask(text: string, secrets: readonly WatchedSecret[]): string {
  let masked = text;
  for (const secret of secrets) masked = masked.split(secret.value).join(`<${secret.label}>`);
  return scrub(masked);
}

/** Starts the polling on every container; resolves once each node has its loop running. */
export async function watchCommandLines(containers: readonly string[], secrets: readonly WatchedSecret[]): Promise<Watch> {
  const values = secrets.map((secret) => secret.value);
  if (values.some((value) => value.trim() === "" || value.includes("\n"))) {
    throw new Error("watchCommandLines: a secret must be one non-empty line, an empty one would match every process");
  }

  const id = randomUUID().slice(0, 8);
  const needles = `/tmp/e2e-needles-${id}`;
  const found = `/tmp/e2e-found-${id}`;
  const pidFile = `/tmp/e2e-poll-${id}.pid`;

  await Promise.all(
    containers.map(async (container) => {
      await exec(["docker", "exec", "-i", container, "sh", "-c", `cat > ${needles}`], { input: `${values.join("\n")}\n` });
      await exec(["docker", "exec", "-d", container, "bash", "-c", pollScript(needles, found, pidFile)]);
      await poll(`the process poller on ${container} did not start`, 10_000, 100, async () => {
        const started = await tryExec(["docker", "exec", container, "test", "-s", pidFile]);
        return started.exitCode === 0 ? { value: true } : { waiting: "no pid file yet" };
      });
    }),
  );

  return {
    async stop(): Promise<LeakHit[]> {
      const hits: LeakHit[] = [];
      for (const container of containers) {
        await tryExec(["docker", "exec", container, "sh", "-c", `kill "$(cat ${pidFile} 2>/dev/null)" 2>/dev/null; true`]);
        const read = await tryExec(["docker", "exec", container, "cat", found]);
        if (read.exitCode === 0) hits.push(...parseFound(container, read.stdout, secrets));
        await tryExec(["docker", "exec", container, "rm", "-f", needles, found, pidFile]);
      }
      return hits;
    },
  };
}
