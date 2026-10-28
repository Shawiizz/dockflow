# ADR-0008: Plan and apply; whole-app releases and rollback

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-28 (env.json is the commit point; a release that cannot be recorded rolls back; the watchdog recovers a dead run; a failed release left in place is restored by the next run)

## Context

Dockflow 1.x runs an imperative pipeline and undoes it by hand on failure: restore uploads, choose between forget, keep and rollback, redeploy the previous stack file. Nothing shows the user what a deploy will change before it does, and a deploy killed outright leaves only a stale lock behind.

Docker has no notion of a release: an application is several services that must move together, and roll back together.

## Decision

### Plan

`plan = f(desired, actual)`, a pure function in the planner package.

- **Desired state:** `dockflow.yml` + the environment's Compose files + variables + secrets digests + built image digests, converted to the domain model.
- **Actual state:** the environment's services, jobs, networks, volumes, secrets, configs and routes, read from the Engine, plus its current release from the state store ([ADR-0007](0007-state-on-the-server.md)).
- **The plan:** an ordered list of actions, each with the reason for it (the fields that differ):
  1. create networks and volumes, create secrets and configs (content-addressed, so never updated in place)
  2. run `before` jobs
  3. create or update services: stateful ones first, then the others
  4. run `after` jobs
  5. switch routes
  6. remove services that are no longer in the desired state
  7. prune unreferenced objects
- **Identity:** a plan records a fingerprint of the actual state it was computed from (the release it was planned against and the IDs of the containers, networks and volumes it read). Applying a saved plan (`dockflow deploy --plan plan.json`) is refused if the actual state has changed since, as in Terraform.
- **No-op:** an empty plan creates no release and exits 0.

### Apply

The agent ([ADR-0004](0004-ephemeral-agent.md)) applies the plan under the environment's lock:

1. It allocates the next release sequence number and writes the release record with status `applying`.
2. It executes the actions in order, waiting on each as described in [ADR-0010](0010-rollout-health-jobs.md).
3. On success, the release becomes `active` and the previous active one `superseded`.

**The commit point** is one atomic write: `env.json`, written by rename, naming the release as current. The statuses of the release records follow it, and are written after it. Before that write, any failure rolls back, including a failure to write the commit itself (a full disk): the run reports the deploy failed only once the previous release serves again. After it, the release is live: a failure to write the statuses or to remove the old containers is a warning, and the next run completes them. So a release is never reported failed while it serves, and never undone after it was reported live.

### Rollback is a plan

On any failure after the first change, the agent rolls back the **whole app**. The desired state of the rollback is the previous active release record:

- every touched service gets back the exact spec recorded in that release;
- services the failed run created are removed;
- services it removed are recreated.

The failed release ends `rolled_back`. If the rollback itself fails, it ends `failed`, the environment record is labelled `dockflow.degraded=true`, and the run exits with a code of its own. The next plan shows the environment as degraded until a run succeeds.

`dockflow rollback [--to <release>]` uses the same machinery: it plans from the recorded release and applies it as a new release, labelled `dockflow.rollback-of=<seq>`. A rollback is always a forward move in the history.

`--no-rollback` leaves a failed run in place for debugging and marks the environment degraded.

**What a failure triggers** is set by `on_failure` in `dockflow.yml`, as in 1.x:

| Value | Effect |
|---|---|
| `rollback` | The default |
| `fail` | The failed release stays in place, marked failed, and the environment is degraded. It stays only until the next run that takes the lock, whatever it is (a deploy, a rollback, a restart, a scale): that run restores the current release first, and plans from it. `dockflow plan` says so. Adopting the failed release as the base of the next run would build on a release known to fail |
| `ignore` | A failed HTTP check or `after_*` hook is reported as a warning, and the release becomes active |

Webhooks are sent in every case ([config spec](../spec/config-v1.md)). A failure of the rollout itself (a crash loop, an unhealthy container, a timeout) always rolls back, because leaving a service half-switched is never a useful state.

### Recovery from a dead run

If an agent dies (the server reboots, Docker restarts, or its container is killed), its release stays `applying` and the kernel releases its lock ([state spec](../spec/state-v1.md#lock)). Recovery then follows the commit point: a release `env.json` already names is completed; one it does not is rolled back. Recovery restores the current release (containers, names, routes, uploads), then marks the dead run's release `abandoned`, and the plan is computed from the actual state as usual. Because the plan is computed from what is really running, it converges whatever the dead run had done.

Two things run that recovery, under the lock, with the same code:

- **the watchdog** ([ADR-0010](0010-rollout-health-jobs.md)), as soon as the dead run's agent container no longer runs: a run that died in a `stop-first` rollout had stopped the old container on purpose, so Docker does not start it again, and the app would stay down until someone ran a command;
- **the next run** that takes the lock, before its plan, for whatever is left: it is the only one on a server without a watchdog.

### Versions

- A release is identified by its sequence number, monotonic per environment.
- It also carries a free label `version`: `--version`, or the short git commit (suffixed `-dirty` when the tree is not clean).
- Images are referenced by digest in every service spec, never by tag alone.

## Consequences

- `dockflow plan` can be posted on a pull request, and a reviewed plan is exactly what gets applied.
- Rollback restores the whole app to a state that is known to have worked, never a mix of versions.
- No separate journal is needed: the release status plus the actual state are enough to recover.
- `on_failure` keeps the three 1.x behaviours that matter (`rollback`, `fail`, `ignore`). The 1.x `notify` value is covered by webhooks, which fire whatever the outcome.

## Alternatives considered

- **Per-service rollback only (as Swarm's `PreviousSpec`).** Rejected: one step deep, per service.
- **A detailed step journal for resuming a dead run.** Rejected as unnecessary: re-planning from the actual state is simpler and always correct.
