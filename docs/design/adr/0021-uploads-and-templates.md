# ADR-0021: Uploads: files to servers and volumes, incremental and atomic

- Status: Accepted
- Date: 2026-10-26

## Context

Dockflow 1.x sends files to every node of the cluster (`uploads:`), with permissions, owner, excludes and per-service targeting, and backs them up for rollback. Real projects use it for:

- **a 2.7 GB static Maven repository** (`MohistMC/maven`), served by the host's nginx, with a hook that empties the destination before each upload so deleted files disappear;
- **systemd units** (`mohistmc-backend`: an rclone S3 mount and an SSHFS mount).

1.x tars the whole source on every deploy, merges it into the destination (deleted files stay), and has two data-loss bugs in its rollback. Putting 2.7 GB in an image on every deploy is not an option.

## Decision

`uploads:` in `dockflow.yml` sends local files or directories, after `templates:` rendering when listed there ([ADR-0006](0006-compose-as-written.md)), to one of two kinds of destination:

| Destination | Example | Use |
|---|---|---|
| A path on the server | `dest: /etc/systemd/system/x.service` | Host configuration, with `mode` and `owner` |
| A named volume of the app | `dest: volume:site` | Content served by a container (a static site behind a Caddy or nginx service) |

Options:

| Option | Effect |
|---|---|
| `exclude` | Glob patterns, plus the `.dockerignore`-style `!` negation |
| `mirror` | `true` deletes, at the destination, the files that no longer exist locally (what the Maven hook did by hand) |
| `mode`, `owner` | For host paths; the deploy user must be able to write there, or the path belongs to a sudo rule installed by `server init` |

### How it works

1. **Templates are rendered** ([ADR-0006](0006-compose-as-written.md)).
2. **The CLI describes each source by a manifest**: every file's path, sha256 and mode, after `exclude`. A manifest is identified by its digest, which the release records for each destination, so the plan shows an upload exactly when its files changed.
3. **The server keeps a content-addressed store** of the app's files (`uploads/blobs/<sha256>`). The CLI asks the agent which blobs it lacks and sends only those, as a tar following the request on the agent's stdin ([ADR-0004](0004-ephemeral-agent.md)). Each blob is checked against its hash on arrival.
4. **A helper container applies the manifest.** It runs the agent's own image, mounts the destination (the volume, or the parent directory of a host path) and the store, and makes the destination match the manifest: each changed file is written to a temporary file next to it and renamed over it, and with `mirror` the files the manifest does not list are deleted. A volume is the root of what its containers serve and cannot be swapped as a whole, so the swap is per file.
5. **Nothing is lost.** Every file the helper overwrites or deletes is first saved into the store, and the helper returns the manifest that restores the destination as it was. A failed run applies it; a later rollback applies the manifest of the release it restores, whose blobs stay in the store while that release is in retention.
6. **An interrupted run** is repaired by the next one, which applies the current release's manifests again before planning.

Uploads run in the plan after the networks and volumes and before the jobs, so a job can read what was uploaded.

An app may have no services at all and consist only of uploads (`no_services` in 1.x): an empty Compose file, or none, is valid.

## Consequences

- A 2.7 GB tree is sent once. Later deploys send only what changed, and deleted files are removed with `mirror: true`.
- Host files are replaced atomically and restored exactly on failure.
- Writing to host paths keeps a sudo rule or ownership requirement, documented per destination.
- The previous versions of uploaded content take disk space until they leave retention.

## Alternatives considered

- **An image holding the files.** Rejected for large trees: every change ships a new layer of the whole tree, unless the tree is split by hand.
- **rsync over SSH.** Rejected: it needs rsync on both sides, and does not give the atomic swap and the exact rollback.
