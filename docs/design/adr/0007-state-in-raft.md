# ADR-0007: Cluster state lives in the Swarm Raft store

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x keeps its lock, releases, audit log and metrics in files under `/var/lib/dockflow`, on one manager. Releases are never replicated, so after a failover the next version and rollbacks read an empty history. The lock sits on "the first manager that answers", so two runners on different networks can both hold it. Audit and metrics are replicated by appending over SSH (about 870 lines).

Swarm already runs a replicated, consistent store: the Raft log of the managers. Configs and secrets are stored in it. Their labels can be updated, and an update must name the object's current version, otherwise it is refused. That gives a compare-and-swap (Engine API, `POST /configs/{id}/update` with `version`). A config holds up to 1000 KB of data, a secret up to 500 KB.

## Decision

All of Dockflow's state on a cluster is stored as Swarm objects, mostly configs, with `dockflow.*` labels:

| State | Object |
|---|---|
| Deploy lock, per environment and per cluster | A config whose labels are updated by compare-and-swap |
| Releases | One immutable config per release, holding the compressed release record; its status is a label |
| Current and previous release | Labels on a per-environment record config |
| Routes of an environment | A content-addressed config read by the proxy reconciler |
| Cluster metadata (system service versions, registry port) | Labels on a cluster record config |

Nothing is written to a server's file system as state. Run logs kept for `dockflow attach` live in the agent containers ([ADR-0004](0004-ephemeral-agent.md)); they are not state, and losing them loses nothing.

The exact object names, labels, data formats and the lock algorithm are in the [state spec](../spec/state-v1.md).

## Consequences

- Every manager sees the same state; failover needs no special code.
- No history synchronisation and no file layout to manage.
- Anyone in the `docker` group can read the release records, which hold the service specs, including environment variables. That is exactly what `docker service inspect` already shows them. Secret values that go through Compose `secrets:` are Swarm secrets and are not readable ([ADR-0012](0012-secrets-sops.md)).
- Retention matters, because the Raft store is kept in memory by every manager. Releases are pruned to `keep` per environment (default 10).
- The audit history is the list of releases and their labels; there is no separate audit log in v1.

## Alternatives considered

- **Files on a manager (1.x).** Rejected for the reasons in Context.
- **Labels on running services only (as Kamal does).** No history and no whole-app rollback.
- **An external store (an S3 bucket, like a Terraform state).** Independent of the orchestrator, but one more thing to configure for every user. It stays an option for a second `Engine` adapter.
