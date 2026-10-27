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
├── server.json                     server settings: edge, switch and registry images, filter state, versions
├── server.lock                     empty file, held with flock while the switch's configuration changes
├── switch/routes/<stack>.json      the routes the switch serves for each app environment
├── apps/<stack>/
│   ├── lock                        empty file, held with flock by the running agent
│   ├── lock.json                   who holds the lock (informational)
│   ├── manual-lock.json            present while a manual lock is held
│   ├── env.json                    last_seq, current, previous, degraded
│   ├── releases/<seq>.json.gz      one immutable release record per release
│   ├── configs/<name>-<hash12>     Compose configs, named after their content and permissions
│   ├── secrets/<name>-<hash12>     copies of the Compose secret files, 0600 (ADR-0012)
│   ├── watchdog.json               the watchdog's latest restarts (ADR-0010)
│   └── uploads/
│       ├── blobs/<sha256>          the uploaded files, and those uploads overwrote, by content
│       └── manifests/<digest>.json the manifests of uploads, and of what they replaced
└── runs/                           nothing: run logs live in the agent containers

/etc/dockflow/
├── filter.rules                    the port filter's IPv4 rules, iptables-restore input (ADR-0014)
└── filter6.rules                   its IPv6 rules
/etc/systemd/system/dockflow-filter.service   loads them at boot, before docker.service
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
| `dockflow.kind` | `service`, `job`, `run` (agent), `oneoff` (`dockflow run`), `switch`, `registry`, `watchdog` or `helper` |

**Naming:**

| Object | Name |
|---|---|
| Service containers | `<stack>-<service>-<seq>-<n>` |
| Job containers | `<stack>-<service>-<seq>-job` |
| Agent containers | `dockflow-run-<run-id>` |
| Networks and volumes | Compose's own names (`<stack>_default`, `<stack>_<volume>`) |

A service with `container_name` keeps that name and uses the `stop-first` strategy.

**Secrets** used through Compose `secrets:` are files on a tmpfs, `/run/dockflow/secrets/<stack>/<name>-<hash12>`, in a `0700` directory, with the `uid`, `gid` and `mode` the service asks for (`0:0`, `0444` by default), mounted read-only at `/run/secrets/<name>` or the reference's `target` ([ADR-0012](../adr/0012-secrets-sops.md)). `<hash12>` is the start of the sha256 of the uid, gid, mode and content: a new value is a new file. The agent refuses to write a secret when `/run/dockflow` is not a tmpfs (`secret.not_tmpfs`). It keeps a copy of each secret file, `0600`, in `apps/<stack>/secrets/` under the same name: a rollback, and the watchdog after a reboot, write the tmpfs again from it; pruning, `secrets revoke` and `destroy` delete a copy with its file. **Configs** are the same files, under the app's state directory. The agent mounts `/run/dockflow` from the host.

**The watchdog** ([ADR-0010](../adr/0010-rollout-health-jobs.md)) is the container `dockflow-watchdog` (kind `watchdog`), whose image `server.json` records in `watchdog_image`. It takes an environment's lock, as `watchdog`, only to restart containers, and records each restart in `apps/<stack>/watchdog.json`: `{"schema": 1, "restarts": [{"service", "container", "at", "reason"}]}`, the 20 most recent, `reason` being `unhealthy` or `boot`.

**The port filter** ([ADR-0014](../adr/0014-networking-port-filter.md)) is recorded in `server.json`: `filter` (true unless `server init --no-port-filter`), `ssh_port` (the port it always lets in, from the connection string) and `filter_rules` (the hex sha256 of the rules last applied). A release records the app's `firewall.public_ports` in `desired.public_ports`; the filter lets in those of each app environment's current release.

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
  "created_by": { "user": "shawiizz", "machine": "laptop", "ci": "github" },
  "source": { "git_sha": "a1b2c3d4e5…", "branch": "main", "dirty": false },
  "dockflow_version": "2.0.0",
  "rollback_of": 40,
  "op": "rollback",
  "desired": {
    "name": "shop", "env": "production", "stack": "shop-production",
    "services": [
      {
        "name": "web", "strategy": "switch", "replicas": 2, "pull_policy": "missing",
        "spec": { "image": "ghcr.io/acme/web:1.4@sha256:…", "env": ["…"], "networks": [ { "network": "shop-production_default", "aliases": ["web"] } ], "restart": "unless-stopped", "…": "…" },
        "routes": [ { "domains": ["shop.example.com"], "path": "/", "port": 3000, "tls": true } ],
        "drain": "30s", "health_grace": "10s"
      }
    ],
    "networks": [ { "key": "default", "name": "shop-production_default" } ],
    "volumes": [ { "key": "pgdata", "name": "shop-production_pgdata" } ]
  },
  "serving": { "web": 42, "db": 37 },
  "hashes": { "web": "5d0c1e9a7b3f2c4d", "db": "9e8f7a6b5c4d3e2f" },
  "plan_fingerprint": "sha256:…",
  "error": null
}
```

**What a record contains:**
- **`desired`** is the app as it was deployed: every service with its container spec, the input of the Engine's create call, with images pinned by digest. A rollback recreates the same containers from it.
- **`op`** is what made the release: `deploy`, `rollback`, `restart`, `stop`, `scale` or `destroy` (of some services).
- **`serving`** says, per service, which release's containers serve it: a service a deploy left unchanged keeps the containers of an older release.
- **`hashes`** identify each service's containers: an unchanged hash means unchanged containers.
- **`error`** is set on a release that is `rolled-back`, `failed` or `abandoned`: `{ "code": "…", "message": "…" }`.
- **Interpolated values.** Values interpolated into environment variables are part of the spec, as they are of `docker inspect`. The file is readable by root only.
- **Jobs** are services of `desired` with `"job": "before"` or `"after"`; they have no containers once the run is over.
- **Uploads** are in `desired.uploads`: each destination with the digest of its manifest, and `plugin`, the id of the plugin that added it.
- **Secrets and configs** are in `desired.files`: `name`, `secret`, `hash`, `path`, `uid`, `gid`, `mode`, never the value. The CLI sends the values with each run, on the agent's stdin; a rollback to a release whose file is gone (a reboot empties the tmpfs) and whose value the run does not have fails with `secret.missing`.
