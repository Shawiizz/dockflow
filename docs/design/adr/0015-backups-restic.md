# ADR-0015: Backups with restic, run as Swarm jobs

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x writes `pg_dump | gzip` and volume tarballs to the same disk as the data, on the node that runs the database. It has no off-site copy, no encryption, no deduplication and no scheduling. Its retention is a count. It archives live database volumes, swaps volumes under a running service on restore, and runs `psql` without stopping on errors. It is about 2,600 lines.

restic stores encrypted, deduplicated snapshots in S3, B2, SFTP and other backends, with retention policies and integrity checks.

## Decision

### Where backups go

- An environment declares one restic repository in `dockflow.yml` (`backups.repository`).
- Its password and storage credentials come from the environment's secrets ([ADR-0012](0012-secrets-sops.md)).
- Snapshots are tagged with `app`, `env`, `service` and the release sequence.

### What is backed up

A service opts in with `x-dockflow.backup`:

| `type` | How it is captured |
|---|---|
| `postgres` | `pg_dump --format=custom` over the network, from a job on the database's own image |
| `mysql` | `mysqldump --single-transaction --routines --events` |
| `mongo` | `mongodump --archive`, with credentials read from a mounted secret, never in argv |
| `redis` | `redis-cli --rdb` |
| `volume` | the listed volumes, read-only, after scaling the service to 0, unless `quiesce: false` |

### How a backup runs

`dockflow backup run <env> [service]` starts the agent, which runs, on the node the stateful service is pinned to ([ADR-0010](0010-rollout-health-jobs.md)):

1. a dump job on the service's own image, so the dump tool matches the server's version, writing to a temporary volume;
2. a restic job (official image, pinned by digest) that backs up that volume, or the service's volumes for `type: volume`, then applies the retention policy (`keep: { daily, weekly, monthly }`);
3. cleanup of the temporary volume, and scaling the service back up if it was quiesced.

`restic check` runs on a sample of the data after each backup.

### Restoring

- `dockflow backup restore <env> <service> [--snapshot <id>] [--from <env>]` runs the reverse under the environment's lock.
- **Dumps** are restored into the running database with the strictest options: `pg_restore --single-transaction --exit-on-error`, `mysql` with errors fatal.
- **Volumes** are restored with the service scaled to 0, never under a running process.
- `--from` restores another environment's snapshot (for example production into staging), given access to its repository.
- `dockflow backup list <env>` lists snapshots.

### Scheduling

There is no scheduler on the cluster in v1. Backups are triggered by the user's CI on a schedule (the generated GitHub workflow includes one) or by any cron that can run the CLI. A cluster scheduler may come with a permanent agent, behind its own ADR.

## Consequences

- Backups leave the server, encrypted and deduplicated, with real retention.
- Dump tools always match the database's version.
- Volume backups are consistent, at the price of a short stop of the service, which can be turned off per service.
- Without CI or cron, nothing runs on a schedule in v1. The documentation says so in its first paragraph.

## Open questions

- Point-in-time recovery for Postgres (pgBackRest or WAL-G). After v1.
