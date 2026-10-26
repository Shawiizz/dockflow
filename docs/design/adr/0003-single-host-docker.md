# ADR-0003: One server per environment, Docker Engine only, no orchestrator

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (Swarm dropped for a single-server design, by decision of the project owner)

## Context

Dockflow 1.x runs on Docker Swarm. A first draft of this ADR kept Swarm as the only orchestrator. The project owner then decided against any cluster orchestrator, for three reasons:

- **Real usage is single-server.** All eight real projects run on one server each, and multi-node clustering is a need imagined for others, not observed.
- **Swarm is in maintenance.** Mirantis supports it until at least 2030, but it gets few new features.
- **Kubernetes costs too much.** The `k8s-rewrite` branch of 1.x (about 38,000 lines of code and 94,000 of tests) showed what supporting Kubernetes next to another orchestrator costs.

Swarm also limits Compose, even on one node:
- no `depends_on`;
- no ports bound to an IP, which is how a database published as `5432:5432` became public in one real project;
- no `devices`, `privileged` or `network_mode`;
- no `container_name`;
- `build` must be handled outside.

## Decision

- **An environment is one server** running Docker Engine. Dockflow drives it through the Engine API ([ADR-0005](0005-engine-api.md)) with plain containers, networks and volumes.
- **No orchestrator.** Swarm and Kubernetes are not used.
- **An app environment is a Compose project.** Its containers, networks and volumes carry Compose's own labels (`com.docker.compose.project`, `com.docker.compose.service`, …), so `docker compose -p <app>-<env> ps`, `logs` and `top` work on the server.
- **Dockflow rebuilds what Swarm used to provide:**

  | Swarm feature | Dockflow without Swarm |
  |---|---|
  | Rolling update and rollback | The switch, with old containers kept until the deploy commits ([ADR-0010](0010-rollout-health-jobs.md), [ADR-0011](0011-switch-and-edge.md)) |
  | Health-gated updates | Docker's `HEALTHCHECK` status, from the event stream |
  | Replicas | Several containers per service |
  | Jobs | One-off containers |
  | Secrets and configs | Files mounted read-only |
  | Replacing unhealthy tasks | An optional watchdog |
  | State store | Files on the server ([ADR-0007](0007-state-on-the-server.md)) |

- **Behind a port.** The code that knows Docker sits behind an `Engine` port, defined in terms of the domain model. The planner never imports Docker types.
- **Compose loading and conversion.** Compose files are loaded with compose-go and converted to container, network and volume specs by Dockflow's converter. Every Compose key that Docker supports on one host is supported, and the few that make no sense for Dockflow are listed in the [config spec](../spec/config-v1.md#compose-support).
- **Several servers** are a later extension, as independent servers with no orchestrator ([ADR-0023](0023-several-servers-later.md)).

## Consequences

- Compose files behave on the server as they do on a laptop.
- Whole subsystems of the Swarm design disappear:
  - the Raft state;
  - the cluster registry and multi-node image distribution;
  - overlay networks and Swarm's ports;
  - manager failover;
  - jobs pinned to nodes.
- Dockflow owns its rollout logic. It is the core of the product, and the main body of tests ([ADR-0019](0019-testing.md)).
- There is no high availability. A server is a single point of failure, which makes off-site backups essential ([ADR-0015](0015-backups-restic.md)).
- Docker Engine on one host is the most stable base available. Podman as the server's engine becomes possible later, behind the same port.

## Alternatives considered

- **Swarm, even on one node.** It gives rolling updates and rollback for free. Rejected:
  - it breaks the promise of Compose as written;
  - the port filter exists mostly to work around its port binding;
  - the product would sit on a technology in maintenance.
- **Kubernetes (k3s) as the backend, Compose translated to manifests.** Rejected:
  - translation is a commodity (Docker's Compose Bridge, Kompose, Score);
  - it is heavy on one server;
  - its abstraction leaks the day something breaks;
  - the 1.x branch measured its cost.
- **Two orchestrators selectable by configuration.** Rejected for the same reason the `k8s-rewrite` branch stopped: too much to maintain without bugs.

## Open questions

- The minimum Docker Engine version. Target: Docker 27 and later. Decided in M1.
