# ADR-0003: Swarm as the only orchestrator, behind an `Engine` port

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow targets one to ten servers per cluster. Docker Swarm gives multi-node scheduling, overlay networks, encrypted secrets, a replicated Raft store, rolling updates and rollback, all built into Docker. It sees few new features; Mirantis commits to supporting it until at least 2030.

Writing an orchestrator (as Kamal and Uncloud do) is out of scope ([vision](../vision.md#non-goals)). Kubernetes is too heavy for the target users.

## Decision

Swarm is the only orchestrator in v1. A one-server environment is a one-node Swarm.

The code that knows Swarm sits behind a port, `Engine`, defined in terms of the domain model (services, jobs, networks, volumes, secrets, configs, observed task states). The planner and the domain model never import Swarm or Moby types. The Swarm adapter is the only implementation in v1.

Compose files are loaded with compose-go and converted to Swarm service specs by Dockflow's own converter, written for v2, which uses `docker/cli`'s stack converter as a reference for behaviour but not as a dependency.

## Consequences

- Swarm features come for free: placement, rolling update, rollback, health-gated tasks, secrets, configs.
- Compose keys that Swarm has no equivalent for (`depends_on`, `container_name`, host-IP port bindings, `privileged`, …) are listed in the [configuration spec](../spec/config-v1.md#compose-support), each with an error or a warning. Nothing is silently dropped.
- If Swarm declines, a second adapter (plain Compose per host, or something else) can be written without touching the planner. It is not planned.
- The converter is code Dockflow owns, roughly 800 to 1,200 lines, tested with golden files.

## Alternatives considered

- **A plain Compose backend per host.** Fully Compose-compatible, but zero-downtime rollout, rollback and cross-host networking would have to be written by hand.
- **Both backends in v1.** Rejected: too much surface for one maintainer.
- **`docker stack deploy`.** Rejected: it is a CLI, not an API ([ADR-0005](0005-engine-api.md)), it cannot run jobs as part of a deploy, and its errors are text.

## Open questions

- The minimum Docker Engine version. Target: Docker 27 and later. Decided in M1 from the API features the adapter uses.
