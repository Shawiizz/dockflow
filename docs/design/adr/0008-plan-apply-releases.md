# ADR-0008: Plan and apply; whole-app releases and rollback

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x runs an imperative pipeline and undoes it by hand on failure: restore uploads, choose between forget, keep and rollback, redeploy the previous stack file. Nothing shows the user what a deploy will change before it does, and a deploy killed outright leaves only a stale lock behind.

Swarm rolls back one service at a time, to its previous spec only. An application is several services that must move together.

## Decision

### Plan

`plan = f(desired, actual)`, a pure function in the planner package.

- **Desired state:** `dockflow.yml` + the environment's Compose files + variables + secrets digests + built image digests, converted to the domain model.
- **Actual state:** the environment's services, jobs, networks, volumes, secrets, configs and routes, read from the Engine, plus its current release from the state store ([ADR-0007](0007-state-in-raft.md)).
- **The plan:** an ordered list of actions, each with the reason for it (the fields that differ):
  1. create networks and volumes, create secrets and configs (content-addressed, so never updated in place)
  2. run `before` jobs
  3. create or update services: stateful ones first, then the others
  4. run `after` jobs
  5. switch routes
  6. remove services that are no longer in the desired state
  7. prune unreferenced objects
- **Identity:** a plan records a fingerprint of the actual state it was computed from (each object's Swarm version index). Applying a saved plan (`dockflow deploy --plan plan.json`) is refused if the actual state has changed since, as in Terraform.
- **No-op:** an empty plan creates no release and exits 0.

### Apply

The agent ([ADR-0004](0004-ephemeral-agent.md)) applies the plan under the environment's lock:

1. It allocates the next release sequence number and writes the release record with status `applying`.
2. It executes the actions in order, waiting on each as described in [ADR-0010](0010-rollout-health-jobs.md).
3. On success, the release becomes `active` and the previous active one `superseded`.

### Rollback is a plan

On any failure after the first change, the agent rolls back the **whole app**. The desired state of the rollback is the previous active release record:

- every touched service gets back the exact spec recorded in that release;
- services the failed run created are removed;
- services it removed are recreated.

The failed release ends `rolled-back`. If the rollback itself fails, it ends `failed`, the environment record is labelled `dockflow.degraded=true`, and the run exits with a code of its own. The next plan shows the environment as degraded until a run succeeds.

`dockflow rollback [--to <release>]` uses the same machinery: it plans from the recorded release and applies it as a new release, labelled `dockflow.rollback-of=<seq>`. A rollback is always a forward move in the history.

`--no-rollback` leaves a failed run in place for debugging and marks the environment degraded.

### Recovery from a dead run

If an agent dies (its manager fails or is rebooted), its release stays `applying` and its lock lease expires ([state spec](../spec/state-v1.md#lock)). The next run that takes the lock marks that release `abandoned` and plans from the actual state as usual. Because the plan is computed from what is really running, it converges whatever the dead run had done.

### Versions

- A release is identified by its sequence number, monotonic per environment.
- It also carries a free label `version`: `--version`, or the short git commit (suffixed `-dirty` when the tree is not clean).
- Images are referenced by digest in every service spec, never by tag alone.

## Consequences

- `dockflow plan` can be posted on a pull request, and a reviewed plan is exactly what gets applied.
- Rollback restores the whole app to a state that is known to have worked, never a mix of versions.
- No separate journal is needed: the release status plus the actual state are enough to recover.
- There is no `on_failure` option and no "keep the failed deploy" mode beyond `--no-rollback`.

## Alternatives considered

- **Swarm's per-service `PreviousSpec` rollback only.** Rejected: one step deep, per service.
- **A detailed step journal for resuming a dead run.** Rejected as unnecessary: re-planning from the actual state is simpler and always correct.
