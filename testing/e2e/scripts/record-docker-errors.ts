/**
 * Records the exact text Docker prints for about a dozen failures, on the e2e Swarm cluster, into
 * cli/src/__tests__/fixtures/docker-errors/. The unit tests (docker-errors.test.ts) feed these texts
 * to the classifiers that read Docker's output, so a Docker release that rewords a message shows up
 * as a failing test instead of a silently wrong hint.
 *
 *   bun run testing/e2e/scripts/record-docker-errors.ts [--only name,name]
 *
 * The cluster must be up (a Swarm suite run leaves it up; the script starts it when it is not).
 * Everything it creates is named dockflow-check-* and removed at the end, whatever happens.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { exec, startCluster, tryExec, waitForSwarm, poll } from "../helpers/cluster";
import { MANAGER_CONTAINER, WORKER_CONTAINER } from "../helpers/connection";

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "..", "cli", "src", "__tests__", "fixtures", "docker-errors");
const PREFIX = "dockflow-check-";
const REGISTRY = "localhost:35000";
const IMAGE = "nginx:alpine";

type Kind = "task-error" | "stderr";

interface Recording {
  kind: Kind;
  exitCode: number;
  command: string;
  text: string;
}

interface Case {
  name: string;
  run(): Promise<Recording>;
}

interface IndexFile {
  note: string;
  docker: string;
  cases: Record<string, { kind: Kind; exitCode: number; origin: "hand-written" | "recorded"; command: string }>;
}

interface DockerOptions {
  input?: string;
  env?: readonly string[];
  user?: string;
  container?: string;
}

/** A docker command inside a node (the manager unless told otherwise); never throws. */
function docker(args: readonly string[], options: DockerOptions = {}) {
  const flags = [
    ...(options.input === undefined ? [] : ["-i"]),
    ...(options.env ?? []).flatMap((entry) => ["-e", entry]),
    ...(options.user === undefined ? [] : ["-u", options.user]),
  ];
  return tryExec(["docker", "exec", ...flags, options.container ?? MANAGER_CONTAINER, "docker", ...args], {
    input: options.input,
  });
}

async function mustSucceed(what: string, args: readonly string[], options?: DockerOptions): Promise<string> {
  const result = await docker(args, options);
  if (result.exitCode !== 0) throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout;
}

/** The first non-empty line `docker service ps` reports in the Error column, once a task has one. */
async function taskError(service: string, createArgs: readonly string[], describe: string): Promise<Recording> {
  await mustSucceed(`creating ${service}`, ["service", "create", "--detach", "--name", service, "--restart-condition", "none", ...createArgs]);
  try {
    const text = await poll<string>(`${service} reported no task error`, 90_000, 2000, async () => {
      const ps = await docker(["service", "ps", "--no-trunc", "--format", "{{.Error}}", service]);
      const line = ps.stdout.split("\n").find((candidate) => candidate.trim() !== "");
      return line === undefined ? { waiting: "no task error yet" } : { value: `${line}\n` };
    });
    return {
      kind: "task-error",
      exitCode: 0,
      command: `docker service ps --no-trunc --format '{{.Error}}' <${describe}>`,
      text,
    };
  } finally {
    await docker(["service", "rm", service]);
  }
}

/** A command that must fail: its stderr is the recording. */
async function failure(args: readonly string[], command: string, options?: DockerOptions): Promise<Recording> {
  const result = await docker(args, options);
  if (result.exitCode === 0) throw new Error(`${command} succeeded, it was meant to fail (stdout: ${result.stdout.trim()})`);
  if (result.stderr.trim() === "") throw new Error(`${command} failed (exit ${result.exitCode}) without a word on stderr`);
  return { kind: "stderr", exitCode: result.exitCode, command, text: result.stderr };
}

const CASES: Case[] = [
  {
    name: "no-suitable-node",
    run: () =>
      taskError(
        `${PREFIX}placement`,
        ["--constraint", "node.labels.dockflow-check==never", IMAGE],
        "service created with a constraint no node satisfies",
      ),
  },
  {
    name: "image-manifest-unknown",
    run: async () => {
      const registry = await fetch(`http://${REGISTRY}/v2/`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (registry?.status !== 200) throw new Error(`the e2e registry does not answer on ${REGISTRY}: start the cluster with startCluster()`);
      return taskError(
        `${PREFIX}manifest`,
        ["--no-resolve-image", "--constraint", "node.role==manager", `${REGISTRY}/${PREFIX}app:missing`],
        "service whose image tag is not in the e2e registry",
      );
    },
  },
  {
    name: "image-pull-denied",
    run: () =>
      taskError(`${PREFIX}pull`, ["--no-resolve-image", `${PREFIX}missing-repository:1`], "service whose image repository does not exist"),
  },
  {
    name: "container-exit-nonzero",
    run: () => taskError(`${PREFIX}exit`, [IMAGE, "sh", "-c", "exit 3"], "service whose container exits with code 3"),
  },
  {
    name: "oom-killed",
    run: () =>
      taskError(
        `${PREFIX}oom`,
        ["--limit-memory", "8m", IMAGE, "sh", "-c", "a=xxxxxxxx; while true; do a=$a$a; done"],
        "service killed for exceeding --limit-memory",
      ),
  },
  {
    name: "network-external-missing",
    run: () =>
      failure(
        ["stack", "deploy", "-c", "-", `${PREFIX}network`],
        "docker stack deploy -c - <stack whose external network does not exist>",
        {
          input: [
            "services:",
            "  web:",
            `    image: ${IMAGE}`,
            "    networks: [outside]",
            "networks:",
            "  outside:",
            "    external: true",
            `    name: ${PREFIX}missing-net`,
            "",
          ].join("\n"),
        },
      ),
  },
  {
    name: "volume-in-use",
    run: async () => {
      await mustSucceed("creating the volume", ["volume", "create", `${PREFIX}vol`]);
      await mustSucceed("starting the container that mounts it", ["run", "-d", "--name", `${PREFIX}holder`, "-v", `${PREFIX}vol:/data`, IMAGE]);
      return failure(["volume", "rm", `${PREFIX}vol`], "docker volume rm <volume a container still mounts>");
    },
  },
  {
    name: "stack-deploy-unsupported-options",
    run: () =>
      failure(
        ["stack", "deploy", "-c", "-", `${PREFIX}unsupported`],
        "docker stack deploy -c - <stack with a build key and no image>",
        { input: ["services:", "  web:", "    build: .", ""].join("\n") },
      ),
  },
  {
    name: "stack-deploy-deprecated-options",
    run: () =>
      failure(
        ["stack", "deploy", "-c", "-", `${PREFIX}deprecated`],
        "docker stack deploy -c - <stack with a build key, a container_name and no image>",
        { input: ["services:", "  web:", "    build: .", `    container_name: ${PREFIX}name`, ""].join("\n") },
      ),
  },
  {
    name: "service-scale-global",
    run: async () => {
      await mustSucceed("creating the global service", ["service", "create", "--detach", "--mode", "global", "--name", `${PREFIX}global`, IMAGE]);
      return failure(["service", "scale", "--detach", `${PREFIX}global=2`], "docker service scale --detach <global service>=2");
    },
  },
  {
    name: "worker-not-manager",
    run: () => failure(["service", "ls"], "docker service ls, run on the worker", { container: WORKER_CONTAINER }),
  },
  {
    name: "daemon-unreachable",
    run: () => failure(["ps"], "docker ps with DOCKER_HOST pointing at a closed port", { env: ["DOCKER_HOST=tcp://127.0.0.1:1"] }),
  },
  {
    name: "socket-permission-denied",
    run: () => failure(["ps"], "docker ps as a user that cannot read the Docker socket", { user: "nobody" }),
  },
];

/** Removes what a case, or an earlier run that died, left behind. */
async function cleanUp(): Promise<void> {
  const script = [
    `for s in $(docker service ls --format '{{.Name}}' | grep '^${PREFIX}'); do docker service rm "$s"; done`,
    `for s in $(docker stack ls --format '{{.Name}}' | grep '^${PREFIX}'); do docker stack rm "$s"; done`,
    `for c in $(docker ps -aq --filter 'name=${PREFIX}'); do docker rm -f "$c"; done`,
    `for v in $(docker volume ls -q --filter 'name=${PREFIX}'); do docker volume rm "$v"; done`,
    "true",
  ].join("; ");
  await tryExec(["docker", "exec", MANAGER_CONTAINER, "sh", "-c", script]);
}

async function clusterIsUp(): Promise<boolean> {
  const state = await tryExec(["docker", "inspect", "-f", "{{.State.Running}}", MANAGER_CONTAINER]);
  return state.exitCode === 0 && state.stdout.trim() === "true";
}

function selectedCases(): Case[] {
  const flag = process.argv.indexOf("--only");
  if (flag === -1) return CASES;
  const names = (process.argv[flag + 1] ?? "").split(",").filter(Boolean);
  const unknown = names.filter((name) => !CASES.some((entry) => entry.name === name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(`--only takes names among: ${CASES.map((entry) => entry.name).join(", ")}${unknown.length > 0 ? ` (unknown: ${unknown.join(", ")})` : ""}`);
  }
  return CASES.filter((entry) => names.includes(entry.name));
}

async function main(): Promise<void> {
  const cases = selectedCases();

  if (!(await clusterIsUp())) {
    console.log("The e2e cluster is not running: starting it (it stays up afterwards).");
    await startCluster();
    await waitForSwarm(2);
  }

  const index = JSON.parse(readFileSync(join(FIXTURES_DIR, "index.json"), "utf-8")) as IndexFile;
  const recorded: string[] = [];
  const failed: string[] = [];

  await cleanUp();
  try {
    for (const entry of cases) {
      console.log(`[${entry.name}]`);
      try {
        const recording = await entry.run();
        // a node that cannot apply cgroup limits (the DinD nodes) answers that instead of an OOM kill
        const name = entry.name === "oom-killed" && /cgroup/.test(recording.text) ? "cgroup-limits-unsupported" : entry.name;
        writeFileSync(join(FIXTURES_DIR, `${name}.txt`), recording.text);
        index.cases[name] = {
          kind: recording.kind,
          exitCode: recording.exitCode,
          origin: "recorded",
          command: recording.command,
        };
        recorded.push(name);
        console.log(recording.text.trimEnd().split("\n").map((line) => `    ${line}`).join("\n"));
      } catch (error) {
        failed.push(entry.name);
        console.error(`    NOT RECORDED: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await cleanUp();
      }
    }
  } finally {
    await cleanUp();
  }

  if (recorded.length > 0) {
    index.docker = (await exec(["docker", "exec", MANAGER_CONTAINER, "docker", "version", "--format", "{{.Server.Version}}"])).trim();
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(join(FIXTURES_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  }

  console.log(`\nRecorded ${recorded.length} of ${cases.length} case(s) with Docker ${index.docker}.`);
  if (failed.length > 0) {
    console.error(`Not recorded (the hand-written text stays): ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("Now run: cd cli && bun test src/__tests__/docker-errors.test.ts");
}

await main();
