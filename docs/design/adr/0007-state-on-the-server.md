# ADR-0007: State lives on the server, under `/var/lib/dockflow`

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: files on the server replace the Swarm Raft store)

## Context

Dockflow 1.x keeps its lock, releases, audit log and metrics in files under `/var/lib/dockflow`, on one manager of a Swarm cluster. With several managers, that was its weakness: releases were not replicated, and the lock could exist twice. A draft of this ADR moved the state into Swarm's Raft store to fix that.

With one server per environment ([ADR-0003](0003-single-host-docker.md)), there is nothing to replicate. The server is the single source of truth, and files on it are the simplest correct store. What 1.x got wrong was not files, but:

- non-atomic writes;
- a lock that relied on file contents and clocks;
- an audit log synced by appending over SSH.

## Decision

All of Dockflow's state for a server lives under `/var/lib/dockflow` on that server. It is written only by agent containers ([ADR-0004](0004-ephemeral-agent.md)), as root.

| State | Where |
|---|---|
| Lock of an environment | A `flock` on `apps/<stack>/lock`, held by the agent for the whole run |
| Lock holder, for display | `apps/<stack>/lock.json`, written after the lock is taken |
| Manual lock | `apps/<stack>/manual-lock.json` |
| Releases | `apps/<stack>/releases/<seq>.json.gz`, one immutable file per release |
| Current and previous release, degraded flag, last sequence number | `apps/<stack>/env.json` |
| Routes of an environment | Inside its release record; the switch configuration is rebuilt from the current releases ([ADR-0011](0011-switch-and-edge.md)) |
| Server settings (edge mode, switch port, filter state) | `server.json` |

Rules:

- **Atomic writes.** Every file is written to a temporary name, then renamed.
- **Cheap lookups.** The containers of a release carry `dockflow.release=<seq>`, so "what is running" can be read from Docker itself.
- **The kernel holds the lock.** When the agent dies, the lock is released. There is no lease, no heartbeat and no clock comparison.
- **Manual locks block runs.** A manual lock (`dockflow lock acquire`) makes every run fail with "locked" until it is released or `--force` is given.

The exact layout and the record formats are in the [state spec](../spec/state-v1.md).

## Consequences

- The lock is exact on one server: two runs can never both hold it, and a dead run never leaves it stuck.
- No history to synchronise, no replication.
- Losing the server loses the release history along with the apps. Backups of `/var/lib/dockflow` are part of the documented backup setup ([ADR-0015](0015-backups-restic.md)).
- Retention keeps the files small: `releases.keep` per environment (default 10).

## Alternatives considered

- **Labels on containers only (as Kamal does).** No history and no whole-app rollback. Labels are used as an index, not as the store.
- **SQLite.** More than needed for a handful of small files written by one process at a time.
