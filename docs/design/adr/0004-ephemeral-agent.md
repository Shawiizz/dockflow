# ADR-0004: Deploys run in an ephemeral agent container on the server

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server)

## Context

In Dockflow 1.x, the CLI drives every step over SSH from the machine that runs it. Three problems follow:

- When the CI runner dies or the network drops mid-deploy, the server is left half-updated, with nobody to roll it back.
- Each step is one or more SSH round trips.
- Long waits (health checks, draining) depend on the connection staying up.

A permanent agent on the server would fix this, but it is a service to secure, upgrade and monitor.

## Decision

The CLI computes the plan, then hands it to an **agent** that runs on the server for the duration of the run and exits.

1. The CLI connects to the server over SSH and reaches its Docker socket through SSH stream forwarding ([ADR-0005](0005-engine-api.md)).
2. If the server does not have the image `dockflow/agent:<version>`, the CLI creates it with the Engine API's image import. It sends a tar holding the Linux binary of its own version for the server's architecture, with the entrypoint set to that binary. No registry is involved. How the CLI obtains that binary is in [ADR-0020](0020-releasing-dockflow.md).
3. The CLI creates a container `dockflow-run-<run-id>` from that image. The container:
   - mounts the Docker socket and `/var/lib/dockflow`, where the state lives ([ADR-0007](0007-state-on-the-server.md));
   - is labelled `dockflow.kind=run`.
4. The CLI attaches to the container's stdin and writes one input document: the plan, the secret values it needs and the files to upload. It then closes stdin, so secrets never appear in the container's configuration, environment or logs.
5. The agent applies the plan through the local socket and writes [events](../spec/events-v1.md) to stdout, one JSON object per line. The CLI renders them.
6. If the CLI disconnects, the agent carries on: it finishes the run or rolls back. `dockflow attach` follows a run again from its container's logs.
7. **Ctrl+C:**
   - the first one makes the CLI send SIGINT to the agent container through the API, and the agent stops at the next step boundary and rolls back;
   - a second one detaches the CLI and leaves the agent finishing its rollback;
   - the agent is never killed by the CLI.
8. Finished run containers are kept for `dockflow attach` and inspection. The next run removes all but the 10 most recent.

Read-only commands (`status`, `releases`, `logs`, `ps`) do not start an agent: the CLI calls the server's Docker API directly. Interactive commands (`exec`, `ssh`) use the API or SSH directly.

## Consequences

- A deploy survives the death of whatever started it.
- The agent can join the app's networks, so it runs HTTP health checks from inside the server's Docker networks ([ADR-0010](0010-rollout-health-jobs.md)) and talks to the switch's admin API ([ADR-0011](0011-switch-and-edge.md)).
- The binary is uploaded once per Dockflow version per server (about 20 MB).
- The agent runs with the Docker socket, so it is root on the server. That is no more than the deploy user already has ([ADR-0013](0013-servers-access-security.md)).
- The CLI and the agent are the same binary at the same version, so the protocol between them is internal and needs no compatibility.

## Alternatives considered

- **Everything from the CLI over SSH (1.x).** Rejected for the reasons in Context.
- **The agent as a host process** (a binary in a temporary directory, run with `nohup` or `systemd-run`). Rejected: it needs shell commands on the host, it cannot join Docker networks, and it is harder to clean up than a container.
- **A permanent agent.** Not needed. The only permanent pieces Dockflow installs are the switch ([ADR-0011](0011-switch-and-edge.md)) and an optional watchdog ([ADR-0010](0010-rollout-health-jobs.md)).

## Open questions

- Whether the input document goes through stdin attach or through a file in `/var/lib/dockflow` readable by root only. Stdin is preferred; M1 confirms it holds up for large uploads on a slow connection.
