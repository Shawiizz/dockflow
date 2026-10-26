# Server state, version 1

All of Dockflow's state for a server lives on that server ([ADR-0007](../adr/0007-state-on-the-server.md)): files under `/var/lib/dockflow`, plus labels on the Docker objects Dockflow creates. This document fixes their layout and formats. Its version, `schema: 1`, changes only in a major release of Dockflow.

## Conventions

- **Writers.** Only agent containers write under `/var/lib/dockflow`, as root. The directory is `0700`.
- **Atomicity.** Every file is written to `<name>.tmp-<run-id>`, synced, then renamed.
- **JSON documents** carry `"schema": 1`.
- **Clocks.** No decision depends on time. Timestamps are informational, in UTC, from the server's clock.

## Layout

```
/var/lib/dockflow/
├── server.json                     server settings: edge, switch address, filter state, versions
├── apps/<stack>/
│   ├── lock                        empty file, held with flock by the running agent
│   ├── lock.json                   who holds the lock (informational)
│   ├── manual-lock.json            present while a manual lock is held
│   ├── env.json                    last_seq, current, previous, degraded
│   ├── releases/<seq>.json.gz      one immutable release record per release
│   └── uploads/<dest-hash>/        previous contents and manifests of uploads
└── runs/                           nothing: run logs live in the agent containers
```

`<stack>` is `<app>-<env>`. `<seq>` is written with 6 digits.

## Docker objects

Every container, network and volume of an app carries Compose's own labels, so `docker compose -p <stack>` sees the app as a Compose project:

| Label | Value |
|---|---|
| `com.docker.compose.project` | `<stack>` |
| `com.docker.compose.service` | The service name |
| `com.docker.compose.container-number` | 1…n |
| `com.docker.compose.oneoff` | `True` for jobs and `dockflow run`, `False` otherwise |

Dockflow's own labels:

| Label | Value |
|---|---|
| `dockflow.schema` | `1` |
| `dockflow.release` | The release sequence number the container belongs to |
| `dockflow.kind` | `service`, `job`, `run` (agent), `switch`, `registry`, `watchdog` or `helper` |

**Naming:**

| Object | Name |
|---|---|
| Service containers | `<stack>-<service>-<seq>-<n>` |
| Job containers | `<stack>-<service>-<seq>-job` |
| Agent containers | `dockflow-run-<run-id>` |
| Networks and volumes | Compose's own names (`<stack>_default`, `<stack>_<volume>`) |

A service with `container_name` keeps that name and uses the `stop-first` strategy.

**Secrets** used through Compose `secrets:` are files on a tmpfs, `/run/dockflow/secrets/<stack>/<name>-<hash12>`, mode `0400`, mounted read-only at `/run/secrets/<name>` ([ADR-0012](../adr/0012-secrets-sops.md)).

## Lock

- **Acquiring.** A run takes `apps/<stack>/lock` with `flock(LOCK_EX | LOCK_NB)` and holds it until it exits. Then it writes `lock.json`:

  ```json
  { "schema": 1, "run": "01jbx6k3…", "op": "deploy", "by": "shawiizz@laptop", "ci": null, "since": "2026-10-26T14:03:11Z" }
  ```

- **When it is held.** A run that cannot take it reads `lock.json` and fails with `LockHeld`, exit code 5. With `--wait-lock`, it retries until the lock is free or the given duration has passed.
- **When the holder dies.** The kernel releases the lock. There is no lease and no takeover.
- **Manual locks.** `dockflow lock acquire` writes `manual-lock.json` (who, why, when). Every run refuses to start while it exists, unless given `--force`. `dockflow lock release` removes it.

**Which commands take the lock:**

| Takes the environment's lock | Takes no lock |
|---|---|
| `deploy`, `rollback`, `restart`, `stop`, `scale`, `destroy`, `backup run`, `backup restore` | Read-only commands, and `run`. A `run` container carries `com.docker.compose.oneoff=True`, which the planner ignores |

Server-wide operations (`server upgrade`, `server proxy sync`, `server network`, `server plugin`) take `/var/lib/dockflow/server.lock` in the same way.

## Release lifecycle

```
applying ──► active ──► superseded
   │
   ├──► rolled-back     the run failed and the previous release was restored
   ├──► failed          the run failed and was left in place (on_failure: fail, --no-rollback), or its rollback failed
   └──► abandoned       the agent died; found by the next run
```

**`env.json`:**

```json
{ "schema": 1, "last_seq": 42, "current": 42, "previous": 41, "degraded": false }
```

**A run**, under the lock:
1. It reads `env.json` and writes `releases/<last_seq+1>.json.gz` with `status: applying`, then `env.json` with the new `last_seq`.
2. On success, it rewrites the release with `status: active`, the previous one with `status: superseded`, then `env.json` with `current` and `previous`.
3. A run that finds the latest release still `applying` marks it `abandoned`, then plans from what is actually running ([ADR-0008](../adr/0008-plan-apply-releases.md)).

**Retention.** After a successful run, the agent keeps:
- the newest `releases.keep` releases with status `active` or `superseded`;
- every release newer than the oldest of those.

It deletes the other release files, then the images, registry manifests, secret files and previous upload contents that no kept release references.

## Release record

`releases/<seq>.json.gz` is a gzipped JSON document:

```json
{
  "schema": 1,
  "app": "shop",
  "env": "production",
  "server": "main",
  "seq": 42,
  "version": "a1b2c3d",
  "status": "active",
  "run": "01jbx6k3m8w0v7c9q2r5t4y6z8",
  "created_at": "2026-10-26T14:03:11Z",
  "finished_at": "2026-10-26T14:04:02Z",
  "created_by": { "user": "shawiizz", "machine": "laptop", "ci": null },
  "source": { "git_sha": "a1b2c3d4e5…", "dirty": false },
  "dockflow_version": "2.0.0",
  "rollback_of": null,
  "services": {
    "web": {
      "strategy": "switch",
      "replicas": 2,
      "container": { "…": "the container create spec sent to the Engine, without secret values" },
      "image": "127.0.0.1:5959/shop/web@sha256:…"
    }
  },
  "jobs": { "migrate": { "when": "before", "container": { "…": "…" }, "image": "…" } },
  "networks": ["shop-production_default"],
  "volumes": ["shop-production_pgdata"],
  "secrets": { "db_password": "9f2c1ab3e4d5" },
  "routes": [ { "service": "web", "domains": ["shop.example.com"], "path": "/", "port": 3000, "options": {} } ],
  "published_ports": [],
  "uploads": [ { "dest": "volume:site", "manifest": "sha256:…", "files": 12873 } ],
  "plan_fingerprint": "sha256:…"
}
```

**What a record contains:**
- **Container specs.** Each `container` is exactly what was sent to the Engine, so a rollback recreates the same containers.
- **Interpolated values.** Values interpolated into environment variables are part of the spec, as they are of `docker inspect`. The file is readable by root only.
- **Secrets.** Secret values are never stored: `secrets` maps each name to the hash of its value, and a rollback needs the same values to still be available from the environment's secrets.
