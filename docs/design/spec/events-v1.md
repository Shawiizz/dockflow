# Events, version 1

Every operation reports its progress as a stream of events ([ADR-0016](../adr/0016-interfaces.md)). The agent writes them to its stdout. The CLI renders them for humans, or prints them as they are with `--json`, one JSON object per line (JSON Lines). The web UI, the MCP server and the GitHub Action read the same stream.

## Envelope

```json
{
  "v": 1,
  "ts": "2026-10-25T14:03:11.123Z",
  "run": "01jbx6k3m8w0v7c9q2r5t4y6z8",
  "seq": 17,
  "type": "service.converged",
  "level": "info",
  "msg": "web converged: 2/2 tasks running",
  "data": { "service": "web", "running": 2, "desired": 2 }
}
```

| Field | Meaning |
|---|---|
| `v` | The schema version, `1` |
| `ts` | When the event was emitted, UTC, millisecond precision, by the emitter's clock |
| `run` | The run id |
| `seq` | 1, 2, 3, … within a stream. A gap means lost events, for example after `attach` |
| `type` | One of the types below |
| `level` | `debug`, `info`, `warn` or `error` |
| `msg` | A human-readable sentence. Renderers may show it as is |
| `data` | The fields of the type |

## Secrets

No event carries a secret value. Text fields (`msg`, `line`, `error.message`) are masked by the emitter before they are written: every occurrence of a secret's value becomes `***`.

## Compatibility rules

- Within version 1, fields and types are only added, never renamed or removed, and their meaning doesn't change.
- Consumers ignore unknown types and unknown fields.
- The last event of every stream is `run.finished`. A stream that ends without it was cut off. The run may still be going on: `dockflow attach` follows it.

## Types

| Type | `data` |
|---|---|
| `run.started` | `app`, `env`, `op` (`deploy`, `rollback`, `backup`, `restore`, `run`, `cluster.*`), `dockflow_version`, `manager` |
| `config.loaded` | `files` (paths of the Compose files, `dockflow.yml` and the secrets file), `services` |
| `warning` | `code` (stable, for example `compose.depends_on_ignored`), `detail`, `service?` |
| `lock.waiting` | `holder`, `op`, `by`, `since` |
| `lock.acquired` | `scope` |
| `lock.taken_over` | `scope`, `previous_holder` |
| `lock.lost` | `scope`, `new_holder` |
| `lock.released` | `scope` |
| `build.started` | `services`, `platforms` |
| `build.log` | `service`, `line` |
| `build.finished` | `service`, `digest` |
| `push.progress` | `image`, `bytes_sent`, `bytes_total` |
| `push.finished` | `image`, `digest`, `blobs_skipped`, `blobs_sent` |
| `plan.computed` | `fingerprint`, `summary` (`create`, `update`, `remove`), `actions` (list of `id`, `kind`, `target`, `reason`) |
| `plan.empty` | – |
| `release.created` | `seq`, `version` |
| `action.started` | `action` (id) |
| `action.finished` | `action`, `duration_ms` |
| `action.failed` | `action`, `error` |
| `service.task` | `service`, `task`, `node`, `state`, `desired_state`, `error?` |
| `service.converged` | `service`, `running`, `desired` |
| `service.failed` | `service`, `reason` (`crash_loop`, `update_paused`, `rolled_back_by_swarm`, `timeout`) |
| `job.log` | `service`, `line` |
| `job.finished` | `service`, `exit_code` |
| `health.check` | `service`, `url`, `attempt`, `status?`, `ok` |
| `routes.applied` | `domains`, `proxy_tasks` |
| `filter.applied` | `nodes`, `ports` |
| `hook.started` | `phase`, `name`, `kind` (`local`, `host`, `exec`), `target` |
| `hook.log` | `name`, `target`, `line` |
| `hook.finished` | `name`, `target`, `exit_code`, `fatal` |
| `upload.progress` | `dest`, `files_sent`, `files_total`, `bytes_sent`, `bytes_total` |
| `upload.finished` | `dest`, `nodes`, `files_changed`, `files_deleted` |
| `backup.finished` | `service`, `snapshot`, `bytes_added`, `duration_ms` |
| `rollback.started` | `reason`, `target_seq` |
| `rollback.finished` | `ok` |
| `cancel.requested` | `by` (`signal`, `cancel`) |
| `log` | `line` (anything else worth showing) |
| `run.finished` | `outcome`, `exit_code`, `release_seq?`, `duration_ms`, `error?` |

`outcome` is one of: `success`, `noop`, `rolled_back`, `failed`, `cancelled`, `lock_lost`, `hook_failed`. `exit_code` is the [CLI's exit code](cli-v1.md#exit-codes) for that outcome.

`error` is `{ "code": "…", "message": "…", "hint": "…" }`. `code` is stable and dotted (`config.invalid`, `ssh.host_key_mismatch`, `plan.stale`, `plan.domain_conflict`, `build.failed`, `health.failed`, …). `hint` says what to do about it.
