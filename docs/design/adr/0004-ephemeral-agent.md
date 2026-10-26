# ADR-0004: Deploys run in an ephemeral agent container on a manager

- Status: Accepted
- Date: 2026-10-25

## Context

In Dockflow 1.x, the CLI drives every step over SSH from the machine that runs it. Three problems follow:

- When the CI runner dies or the network drops mid-deploy, the cluster is left half-updated, with nobody to roll it back.
- Images to every node travel through the CLI's machine.
- Each step is one or more SSH round trips.

A permanent agent on every server would fix this, but it is a service to secure, upgrade and monitor, which the [vision](../vision.md#non-goals) excludes for v1.

## Decision

The CLI computes the plan, then hands it to an **agent** that runs on a manager for the duration of the run and exits.

1. The CLI connects to a manager over SSH and reaches its Docker socket through SSH stream forwarding ([ADR-0005](0005-engine-api.md)).
2. If the manager does not have the image `dockflow/agent:<version>`, the CLI creates it with the Engine API's image import. It sends a tar holding the Linux binary of its own version for the manager's architecture, with the entrypoint set to that binary. No registry is involved. How the CLI obtains that binary is in [ADR-0020](0020-releasing-dockflow.md). The agent then pushes its own image to the cluster registry ([ADR-0009](0009-images.md)), so jobs that use the Dockflow binary on other nodes, such as the port filter ([ADR-0014](0014-networking-port-filter.md)), can pull it.
3. The CLI creates a container `dockflow-run-<run-id>` from that image:
   - it mounts the Docker socket and joins the `dockflow-system` network ([ADR-0014](0014-networking-port-filter.md));
   - it is labelled `dockflow.kind=run`.
4. The CLI attaches to the container's stdin and writes one input document: the plan, plus the secret values it needs. It then closes stdin, so secrets never appear in the container's configuration, environment or logs.
5. The agent applies the plan through the local socket and writes [events](../spec/events-v1.md) to stdout, one JSON object per line. The CLI renders them.
6. If the CLI disconnects, the agent carries on: it finishes the run or rolls back. `dockflow attach` follows a run again from its container's logs.
7. Ctrl+C in the CLI sends SIGINT to the agent container through the API. The agent stops at the next step boundary and rolls back. A second Ctrl+C detaches the CLI and leaves the agent finishing its rollback. The agent is never killed by the CLI.
8. Finished run containers are kept for `dockflow attach` and inspection. The next run removes all but the 10 most recent.

Read-only commands (`status`, `releases`, `logs`) do not start an agent: the CLI calls the API of a manager directly.

The CLI needs SSH access to managers only. The exceptions are the commands whose purpose is a node itself: `dockflow ssh` and `host` hooks ([ADR-0022](0022-hooks.md)). `exec` into a container on a worker goes through a job on that worker ([ADR-0022](0022-hooks.md#running-inside-containers)), not through SSH.

## Consequences

- A deploy survives the death of whatever started it.
- Images and files reach workers from inside the cluster, not through the CLI's machine ([ADR-0009](0009-images.md)).
- The binary is uploaded once per Dockflow version per manager (about 20 MB).
- The agent can join overlay networks, so it can reach the proxy's admin API ([ADR-0011](0011-ingress-caddy.md)) and run HTTP health checks from inside the cluster ([ADR-0010](0010-rollout-health-jobs.md)).
- The agent runs with the Docker socket, so it is root on the manager. That is no more than the deploy user already has ([ADR-0013](0013-servers-access-security.md)).
- The CLI and the agent are the same binary at the same version: the protocol between them is internal and needs no compatibility.

## Alternatives considered

- **Everything from the CLI over SSH (1.x).** Rejected for the reasons in Context.
- **The agent as a host process (binary in a temp directory, run with `nohup` or `systemd-run`).** Rejected: it needs shell commands on the host, it cannot join overlay networks, and it is harder to clean up than a container.
- **A permanent agent as a global Swarm service.** Deferred. It may come later for scheduled jobs, behind its own ADR.

## Open questions

- Whether the input document goes through stdin attach or through a short-lived Swarm secret mounted into the agent. Stdin is preferred; M1 confirms it holds up when the SSH connection is slow.
