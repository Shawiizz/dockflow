# Events, version 1

> **Status: frozen from Dockflow 1.0.0.** Version 1 of this format changes only as its Compatibility section allows: additions in a minor release; anything else in a major one.

Every operation reports its progress as a stream of events ([ADR-0016](../adr/0016-interfaces.md)). The agent writes them to its stdout. The CLI renders them for humans, or prints them as they are with `--json`, one JSON object per line (JSON Lines). The web UI, the MCP server and the GitHub Action read the same stream.

## Envelope

```json
{
  "v": 1,
  "ts": "2026-10-25T14:03:11.123Z",
  "run": "01jbx6k3m8w0v7c9q2r5t4y6z8",
  "seq": 17,
  "type": "service.healthy",
  "level": "info",
  "msg": "web: 2/2 containers healthy",
  "data": { "service": "web", "healthy": 2, "desired": 2 }
}
```

| Field | Meaning |
|---|---|
| `v` | The schema version, `1` |
| `ts` | When the event was emitted, UTC, millisecond precision, by the emitter's clock |
| `run` | The run id; `watchdog` for the watchdog's events |
| `seq` | 1, 2, 3, … within a stream. A gap means lost events, for example after `attach` |
| `type` | One of the types below |
| `level` | `debug`, `info`, `warn` or `error` |
| `msg` | A human-readable sentence. Renderers may show it as is |
| `data` | The fields of the type |

Durations in `data` are integers of milliseconds, named `*_ms`; sizes are integers of bytes.

## Secrets

No event carries a secret value. Text fields (`msg`, `line`, `error.message`) are masked by the emitter before they are written: every occurrence of a secret's value becomes `***`.

## Compatibility rules

- Within version 1, fields and types are only added, never renamed or removed, and their meaning doesn't change.
- Consumers ignore unknown types and unknown fields.
- **Enumerations are open.** A minor release may add values to an enumerated field: `level`, `outcome`, `container.state`'s `state`, `service.failed`'s `reason`, an action's `kind`, `run.started`'s `op`, `error.code` and `warning`'s `code`. A consumer treats a value it does not know as opaque: it shows it and does not act on it. An unknown `level` counts as `info`. A new `outcome` comes with an `exit_code` that already exists ([cli-v1](cli-v1.md#exit-codes)): a new exit code needs a major release.
- The last event of every stream is `run.finished`. A stream that ends without it was cut off. The run may still be going on: `dockflow attach` follows it.
- **One stream per server.** Several servers per environment come later ([ADR-0023](../adr/0023-several-servers-later.md)). A deploy to several servers will be one run, and one stream, per server, each `run.started` naming its `server`; version 1's events stay as they are.

The stream is the only machine-readable output covered by this version. The documents that read commands print with `--json` (`result`, below) are not: see [cli-v1](cli-v1.md#compatibility).

## Types

| Type | `data` |
|---|---|
| `run.started` | `app`, `env`, `op` (below), `dockflow_version`, `server` |
| `config.loaded` | `files` (paths of the Compose files, `dockflow.yml` and the secrets file), `services`; emitted (`debug`) once connected, by the operations that reach the server |
| `warning` | `code` (stable, for example `compose.warning`), `detail`, `service?` |
| `lock.waiting` | `holder`, `op`, `by`, `since` |
| `lock.acquired` | `scope` |
| `lock.taken_over` | `scope` (`manual`), `previous_holder`: `lock acquire --force` took over someone else's manual lock |
| `lock.lost` | `scope`, `new_holder`. Reserved: the kernel lock of [state-v1](state-v1.md#lock) is never lost while its holder lives, so no version-1 agent emits it, nor the outcome `lock_lost` |
| `lock.released` | `scope` |
| `build.started` | `services`, `platforms` |
| `build.log` | `service`, `line` |
| `build.finished` | `service`, `digest` |
| `push.progress` | `image`, `bytes_sent`, `bytes_total`; at most once a second per image, and once at the end (`debug`) |
| `push.finished` | `image`, `digest`, `blobs_skipped`, `blobs_sent` |
| `plan.computed` | `fingerprint`, `summary` (`create`, `update`, `remove`), `actions` (list of `id`, `kind`, `target`, `reason`) |
| `plan.empty` | – |
| `release.created` | `seq`, `version` |
| `action.started` | `action` (id) |
| `action.finished` | `action`, `duration_ms` |
| `action.failed` | `action`, `error` |
| `container.state` | `service`, `container`, `release`, `state` (`created`, `running`, `healthy`, `unhealthy`, `exited`, `restarting`), `exit_code?`, `error?` |
| `service.healthy` | `service`, `healthy`, `desired` |
| `switch.changed` | `service`, `from_release`, `to_release`, `routes` |
| `drain.started` | `service`, `release`, `timeout_ms` |
| `service.failed` | `service`, `reason` (`crash_loop`, `unhealthy`, `exited`, `timeout`, `port_in_use`) |
| `job.log` | `service`, `line` |
| `job.finished` | `service`, `exit_code` |
| `health.check` | `service`, `url`, `attempt`, `status?`, `ok` |
| `routes.applied` | `domains` |
| `watchdog.restarted` | `stack`, `service`, `container`, `reason` (`unhealthy`, `boot`); `warn`, in the watchdog's own output |
| `filter.applied` | `ports`: what the filter lets in, each `{port, protocol?, from?, why}`; `why` is `SSH`, `the switch` or the stack that lists it |
| `hook.started` | `phase`, `name`, `kind` (`local`, `host`, `exec`), `target` |
| `hook.log` | `name`, `target`, `line` |
| `hook.finished` | `name`, `target`, `exit_code`, `fatal` |
| `upload.progress` | `dest?`, `files_sent`, `files_total`, `bytes_sent`, `bytes_total`; at most once a second, and once at the end (`debug`). Without `dest`, it counts the files of every destination, sent together: only those the server lacks |
| `upload.finished` | `dest`, `files_changed`, `files_deleted` |
| `backup.finished` | `service`, or `server` for `backup run --server`, `snapshot` (restic's short id), `bytes_added`, `duration_ms` |
| `rollback.started` | `reason`, `target_seq?` |
| `rollback.finished` | `ok` |
| `cancel.requested` | `by` (`signal`, `cancel`) |
| `log` | `line` (anything else worth showing) |
| `result` | The document a read operation returns (`status`, `releases`, `lock`), as its data. The CLI prints it, alone, with `--json`. Its content is not covered by version 1 ([cli-v1](cli-v1.md#compatibility)) |
| `run.finished` | `outcome`, `exit_code`, `release_seq?`, `duration_ms`, `error?` |

`outcome` is one of: `success`, `noop`, `rolled_back`, `failed`, `cancelled`, `lock_lost`, `hook_failed`. `exit_code` is the [CLI's exit code](cli-v1.md#exit-codes) for that outcome.

`op` names the operation the agent runs, dotted. Version 1's agents emit:

| Group | `op` |
|---|---|
| An environment | `plan`, `deploy`, `rollback`, `restart`, `stop`, `scale`, `destroy`, `prune`, `details`, `status`, `releases`, `upload.have`, `secrets.revoke` |
| Its lock | `lock.acquire`, `lock.release`, `lock.status` |
| Backups | `backup.run`, `backup.list`, `backup.restore`, `backup.prune` |
| The server | `server.init`, `server.status`, `server.check`, `server.uninstall`, `server.cloudflare.refresh`, `server.network.create`, `server.network.list`, `server.network.remove`, `server.plugin.install`, `server.plugin.list`, `server.plugin.remove` |

The set is open: a minor release may add operations. `server upgrade` and `server edge` run `server.init`; `upload.have` asks which upload contents the server lacks, before a deploy.

`error` is `{ "code": "…", "message": "…", "hint": "…" }`. `code` is stable and dotted (`config.invalid`, `ssh.host_key_mismatch`, `plan.stale`, `plan.domain_conflict`, `build.failed`, `health.failed`, …); the [error codes](cli-v1.md#error-codes) list them. `hint` says what to do about it.
