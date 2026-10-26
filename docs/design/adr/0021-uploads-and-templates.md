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
2. **The CLI hashes every file** and asks the agent for the manifest of what each destination holds (the hashes recorded by the previous upload).
3. **Only new or changed files are sent**, over the agent's stdin ([ADR-0004](0004-ephemeral-agent.md)).
4. **The agent writes them**, through a helper container that mounts the destination's parent directory (or the volume), to a staging directory next to the destination, then swaps them in:
   - a directory by rename;
   - a file by atomic replace.

   The previous content is moved aside, not deleted.
5. **On success**, the previous content is kept until the release leaves retention, then removed. **On failure**, the agent swaps it back.
   - A backup that fails is fatal *before* anything is overwritten, which fixes the 1.x bug.
   - The plan of what was written is kept even when the upload fails halfway, which fixes the other one.
6. **The release record lists each destination with its manifest.** Rollback re-applies the previous manifest.

An app may have no services at all and consist only of uploads (`no_services` in 1.x): an empty Compose file, or none, is valid.

## Consequences

- A 2.7 GB tree is sent once. Later deploys send only what changed, and deleted files are removed with `mirror: true`.
- Host files are replaced atomically and restored exactly on failure.
- Writing to host paths keeps a sudo rule or ownership requirement, documented per destination.
- The previous versions of uploaded content take disk space until they leave retention.

## Alternatives considered

- **An image holding the files.** Rejected for large trees: every change ships a new layer of the whole tree, unless the tree is split by hand.
- **rsync over SSH.** Rejected: it needs rsync on both sides, and does not give the atomic swap and the exact rollback.
