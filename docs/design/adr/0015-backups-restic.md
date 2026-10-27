# ADR-0015: Backups with restic, run in one-off containers

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (local repository by default, custom commands, application-aware quiesce, prune: nothing 1.x did is lost)

## Context

Dockflow 1.x backs up databases (`pg_dump`, `mysqldump`, `mongodump`, Redis), volumes and bind mounts, or runs custom dump and restore commands. It writes them to the same disk as the data, compressed with gzip, with a count-based retention and `backup prune`. It has no off-site copy, no encryption, no deduplication and no scheduling. It archives live database volumes, swaps volumes under a running service on restore, and runs `psql` without stopping on errors.

The Minecraft project shows what an application-aware backup needs. The server must stop writing during the copy (`save-off`, `save-all flush`, then `save-on`), not stop altogether. Its restic repository sits on the same disk as the world.

restic stores encrypted, deduplicated snapshots locally or in S3, B2, SFTP and other backends, with retention policies and integrity checks.

## Decision

### Where backups go

- **By default**, a restic repository on the server, in a dedicated volume. Like 1.x, it works with no configuration, but it is now deduplicated and encrypted.
- **Off-site** (recommended): `backups.repository` in `dockflow.yml`, with storage credentials from the environment's secrets ([ADR-0012](0012-secrets-sops.md)).
- **In both cases** the repository password comes from the secrets. Without one, Dockflow generates it, stores it under `/var/lib/dockflow` (root only) and tells the user to save it, since a lost password makes the backups unreadable.
- Snapshots are tagged with `app`, `env`, `service` and the release sequence.

### What is backed up

A stateful service opts in with `x-dockflow.backup`:

| `type` | How it is captured |
|---|---|
| `postgres` | `pg_dump --format=custom` over the network, from a job on the database's own image |
| `mysql` | `mysqldump --single-transaction --routines --events` |
| `mongo` | `mongodump --archive`; credentials read from a mounted secret, never in argv |
| `redis` | `redis-cli --rdb` |
| `volume` | The listed volumes and bind mounts, read-only |
| `command` | A `dump` command run in the service's container, whose stdout is the backup, and a `restore` command fed the backup on stdin (1.x's `raw` type) |

Options:

| Option | Effect |
|---|---|
| `dump_options`, `restore_options` | Extra arguments for the dump types, as in 1.x |
| `quiesce` | For `volume`, how writes stop during the copy: `stop` (default: stop the containers, then start them again), `none`, or `exec` with `pre` and `post` commands run in the running container ([ADR-0022](0022-hooks.md)). `exec` is how a Minecraft world is backed up without stopping the server |
| `keep` | Retention: `{ last, hourly, daily, weekly, monthly }`, applied by `restic forget` after each backup. `--prune` reclaims space at most once a day |

### How it runs

`dockflow backup run <env> [service]` starts the agent, which runs, in one-off containers:

1. a dump job on the service's own image, so the dump tool matches the server's version, writing to a temporary volume; or the quiesce `pre` commands for `volume` and `command`;
2. a restic job (official image, pinned by digest) that backs that up, then applies the retention;
3. the cleanup: temporary volume, `post` commands, start the service again.

`restic check` runs on a sample of the data after each backup.

### Restoring

- `dockflow backup restore <env> <service> [--snapshot <id or date>] [--from <env>]` runs the reverse, under the environment's lock.
- **Dumps** are restored with the strictest options: `pg_restore --single-transaction --exit-on-error`, `mysql` with errors fatal.
- **Volumes** are restored with the service stopped.
- **`/var/lib/dockflow`** (release history, state) is part of what `backup run --server` backs up, so a lost server can be rebuilt with its history.
- `--from` restores another environment's snapshot, given access to its repository.
- `dockflow backup list` lists snapshots. `dockflow backup prune <env> [service] [--keep …]` applies a retention on demand.

### Scheduling

There is no scheduler on the server in v1. Backups are triggered by the user's CI on a schedule (the generated workflow includes one) or by any cron that runs the CLI. A container that schedules its own backups, as the Minecraft server does, keeps doing so. A cluster scheduler may come with a permanent agent, behind its own ADR.

### Implementation (M4)

- **Dumps stream** from an `exec` in the service's running container (`pg_dump` is that image's, so the server's version) into `restic backup --stdin`, rather than a job writing to a temporary volume: no copy on disk, the same tool version. A dump that fails after restic started keeps no snapshot: it is forgotten.
- **restic** runs in one-off containers of `restic/restic:0.18.0`, pinned by digest when pulled. The repository's location, its password and the storage's credentials are written to a file on the secrets' tmpfs (`/run/dockflow/backup-<run>/env`, 0600), which the container sources: never in a command line or in a container's configuration. The file is removed at the end of the run.
- **The local repository** is the `dockflow-backups` volume; restic's cache is `dockflow-backups-cache`. Generated passwords are in `/var/lib/dockflow/backups/<repository>.password`, generated on the first `backup run`, never by `backup list`. `server uninstall` keeps the repository and its password unless `--volumes`.
- **Retention:** without `keep`, `{ last: 7, daily: 14, weekly: 8, monthly: 6 }`. Snapshots are grouped by restic's default, host and paths, within the service's tags. `--prune` joins the first `forget` of a day.
- **check** reads 1% of the data after each `backup run` that made a snapshot.
- A failed backup exits with code 12, a new code, after the other services are backed up.
- **Restore** streams `restic dump` into the restore command in the running container; volumes are restored one by one, `restic restore <id>:/data<target> --target /data<target> --delete`, with the service stopped. `--from` is resolved by the CLI, which sends the other environment's repository and secrets.
- **The repository is created** by `restic init` at the start of each `backup run`, which stops at once when it exists ("config file already exists"): reading the config of a missing S3 bucket would retry for minutes instead, and `init` creates the bucket.
- **`--server`** backs up `/var/lib/dockflow`, mounted read-only, to the environment's repository, tagged `server=<name>`, with the default retention and no lock: its files are written atomically. `backups/` stays out, since a snapshot holding its own repository's password protects nothing. There is no `restore --server`: a lost server is rebuilt with `server install`, then `restic restore` of the latest snapshot.
- **mysql, mongo, redis** dump and restore with small shell scripts run in the service's container, which read the credentials from the image's variables (`MYSQL_ROOT_PASSWORD`, `MARIADB_*`, `MONGO_INITDB_ROOT_*`, `REDIS_PASSWORD`) and give them to the tool in a temporary file (`--defaults-extra-file`, `--config`) or `REDISCLI_AUTH`, never in argv. Redis is restored by writing the RDB into the stopped container's `/data`, through the Engine API's archive endpoint, since Redis loads it at start.

## Consequences

- Every 1.x backup type has an equivalent, and the default needs no configuration, as in 1.x.
- Backups can leave the server, encrypted and deduplicated, with real retention.
- Application-aware quiesce makes consistent backups possible without downtime.
- Without CI or cron, nothing runs on a schedule. 1.x had no scheduler either.

## Open questions

- Point-in-time recovery for Postgres (pgBackRest or WAL-G). After v1.
