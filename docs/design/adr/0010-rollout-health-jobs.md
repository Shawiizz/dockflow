# ADR-0010: Rollout, health and jobs are delegated to Swarm

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x polls task states every 5 seconds with a fixed 300-second timeout, which a 10-replica service with the default update settings cannot meet. It runs a separate "internal health" pass that repeats the convergence check. It runs migrations as hooks on the manager, non-fatal by default. When an update pauses, it removes the whole stack, accessories included.

Swarm already holds tasks until their `HEALTHCHECK` passes, rolls a service back by itself (`failure_action: rollback`) and runs one-off jobs (`replicated-job`).

## Decision

### Rollout

- Each service is updated by the Engine API with its `update_config` and `rollback_config`. A service that doesn't set them gets Dockflow's defaults:

  | Setting | Stateless service | Stateful service |
  |---|---|---|
  | `parallelism` | 1 | 1 |
  | `order` | `start-first` | `stop-first` |
  | `failure_action` | `rollback` | `rollback` |
  | `monitor` | 30s | 30s |

- **Waiting** follows the event stream until one of these happens:
  - the update completes and every task is running and healthy;
  - Swarm rolls back or pauses the update;
  - the timeout expires.

  A paused update is a failure of the run, never a reason to remove anything.
- **The timeout is computed per service:** `ceil(replicas / parallelism) × (delay + monitor + start period) × 2 + 2 minutes`. It can be overridden per environment (`deploy.timeout`).
- **Crash loops** are detected by counting failed tasks across the whole wait, a technique kept from 1.x, because Swarm prunes task history.

### Health

- **The container `HEALTHCHECK` is the primary signal**, and Swarm gates tasks on it. A routed service without one gets a warning in the plan.
- **HTTP checks** (`x-dockflow.health.http`) are a post-condition, run after the service has converged. The agent attaches to the app's network and requests the service by its internal name, so the check tests the service itself, not DNS or the proxy. A failed check fails the run and triggers the whole-app rollback ([ADR-0008](0008-plan-apply-releases.md)).

### Jobs

- A service with `x-dockflow.run: before` or `after` is a job. It is created as a Swarm `replicated-job` on the new image and forced to run again on every deploy that reaches it. It must exit 0.
- `before` jobs run after networks, volumes, secrets and configs exist and before any service changes. Their failure stops the run with nothing else changed.
- `after` jobs run once every service is healthy. Their failure triggers the rollback.
- Job logs are streamed as events.
- Database migrations are `before` jobs. The documentation shows the expand/contract pattern, which keeps them safe to roll back.

### Stateful services

`x-dockflow.stateful: true` marks databases and other single-instance services:

- replicas must be 1;
- the placement constraints must pin exactly one node (or the cluster has one node);
- `order` is `stop-first`;
- `restart_policy` is `condition: any` with no limit on attempts.

The planner refuses a stateful service that breaks these rules.

### Hooks

Hooks in `dockflow.yml` run only on the CLI's machine (`before_build`, `after_deploy`, `after_failure`). Anything that has to run in the cluster is a job.

## Consequences

- No fixed polling loop, no fixed timeout, no stack removal on a stuck update.
- Migrations run in the cluster, on the new image, and their exit code gates the deploy.
- Accessories as a separate stack disappear: a database is a stateful service of the app, in the same Compose file.
