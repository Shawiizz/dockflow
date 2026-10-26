# ADR-0010: Rollout, health, jobs and self-healing, without an orchestrator

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (Swarm's rolling update replaced by Dockflow's own rollout)

## Context

Swarm gave Dockflow 1.x rolling updates (`start-first`), health-gated tasks, automatic rollback, replacement of unhealthy tasks and `replicated-job`s. Without an orchestrator ([ADR-0003](0003-single-host-docker.md)), Dockflow does these itself, on one Docker host.

Dockflow 1.x's own logic around Swarm had weak points:
- polling every 5 seconds with a fixed 300-second timeout;
- a stack removed when an update paused;
- migrations as non-fatal hooks.

## Decision

### Rollout strategies

Each service gets one of three strategies, chosen automatically and overridable with `x-dockflow.rollout`:

| Strategy | Default for | Steps | Downtime |
|---|---|---|---|
| `switch` | Services with routes ([ADR-0011](0011-switch-and-edge.md)) | Start the new containers next to the old ones, wait until healthy, switch the traffic, drain the old ones (default 30 s), stop them | None |
| `start-first` | Other stateless services (workers, consumers) | Start the new containers, wait until healthy, stop the old ones | None. Both versions run briefly: workers must tolerate it |
| `stop-first` | Stateful services, services with `container_name`, services publishing fixed host ports | Stop the old containers (with their `stop_grace_period`), start the new ones, wait until healthy | Brief. This is what a database or a game server needs |

`deploy.update_config.order` (`start-first`/`stop-first`) from Compose is honoured when set.

### Naming and replicas

- **Names.** A container is named `<stack>-<service>-<seq>-<n>`, so a release's containers never collide with the previous release's.
- **Compose labels.** Each container carries the Compose labels (project, service, container number) and `dockflow.release=<seq>`.
- **Replicas.** `deploy.replicas` gives n containers per service.
- **Service names.** Inside the app's networks, every container also carries its service name as an alias, so other services keep reaching `db` or `api` by name, as with Compose.

### Health

- **The container `HEALTHCHECK` is the primary signal.** It is followed through the Engine API's `health_status` events.
- **A service without a healthcheck** counts as healthy once its container has been running for `x-dockflow.health.grace` (default 10 s). The plan warns about routed services without a healthcheck.
- **Internal HTTP checks** (`x-dockflow.health.http`) run from the agent inside the app's network, after the new containers are healthy and before the switch.
- **Public checks** (`health.endpoints` in `dockflow.yml`, as in 1.x) run after the switch, on full URLs through DNS, the edge and TLS.
- **The timeout** is computed per service from its healthcheck (`start_period + interval × retries`, plus a margin). It can be overridden per environment with `deploy.timeout`.
- **Crash loops** are detected by counting restarts during the wait.

### Rollback

- **Old containers are kept until the run commits.** They are stopped after the switch, never removed.
- **On a failure before the commit**, the agent switches back to them, starts them if they were stopped, and removes the new ones. For `switch` services, that takes about a second.
- **What a failure triggers** follows `on_failure` ([ADR-0008](0008-plan-apply-releases.md)).
- **After the commit**, the old containers are removed. Their images are kept for the releases in retention. A later rollback starts containers from the recorded release, with the same strategies.

### Jobs

- **Before jobs:** a service that other services depend on with `condition: service_completed_successfully` is a job run before them, exactly as `docker compose up` does. That is the Compose-native way to run migrations.
- **Explicit jobs:** `x-dockflow.run: before` or `after` declares a job without a dependency.
- **How a job runs:** as a one-off container (`com.docker.compose.oneoff=True`) on the new image, which must exit 0.
- **On failure:** a failed `before` job stops the run with nothing switched. A failed `after` job triggers the rollback.
- **Logs:** job output is streamed as events.
- **Ordering:** `depends_on` with `condition: service_healthy` or `service_started` orders the rollout, as Compose orders startup.

### Stateful services

`x-dockflow.stateful: true` marks databases and other single-instance services:
- replicas must be 1;
- the strategy is `stop-first`;
- the restart policy is `unless-stopped`.

### Restart and self-healing

- **Restart policies.** Services without a `restart` policy get `unless-stopped`, so they come back after a crash or a reboot. Compose's default, `no`, is never what a server wants.
- **Unhealthy containers.** Docker restarts a container that exits, but not one that keeps running while unhealthy. An optional watchdog does that:
  - it is a container named `dockflow-watchdog`, running the Dockflow binary;
  - `server init` installs it, and `--no-watchdog` leaves it out;
  - it restarts a Dockflow-managed container that stays unhealthy for `x-dockflow.health.restart_after` (default 2 minutes);
  - it reports each restart in `dockflow status`.

### Hooks

Hooks run locally, on the server or inside running containers ([ADR-0022](0022-hooks.md)). Work that needs the new image runs as a job.

## Consequences

- Zero downtime for web services, without an orchestrator, and a rollback that is a switch rather than a redeploy.
- Compose's own `depends_on` conditions drive ordering and migrations, so the same file works with `docker compose up`.
- Rollout logic is Dockflow's code. It gets the most tests of any part ([ADR-0019](0019-testing.md)).
- The watchdog is the one permanent Dockflow process besides the switch. It is small, optional and stateless.
