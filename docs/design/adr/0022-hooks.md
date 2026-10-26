# ADR-0022: Hooks: local, on hosts, and inside running containers

- Status: Accepted
- Date: 2026-10-26

## Context

Dockflow 1.x runs hooks at seven moments (pre and post build, upload, deploy, and on failure), locally or on the manager over SSH. Real projects use them to:

- **generate files from secrets before the build**: a JWT key pair (`valientrp-backend`);
- **write a key on the host and run `sudo systemctl`** to enable FUSE mounts (`mohistmc-backend`);
- **stop a game server gracefully before a deploy** (`minecraft-server`): warn players over RCON, back the world up inside the running container, save, stop. Its script calls `docker exec` on the manager, which only works on a single-node cluster;
- **truncate a container's log file after the deploy.** Log rotation in provisioning makes this unnecessary ([ADR-0013](0013-servers-access-security.md)).

## Decision

Hooks are declared in `dockflow.yml`, per phase:

| Phase | When |
|---|---|
| `before_build` | Before images are built |
| `after_build` | After images are built and pushed |
| `before_deploy` | After `before` jobs, before any service changes |
| `after_deploy` | After every service is healthy and routes are switched |
| `after_failure` | After a failed run, once the rollback is done |

Each entry runs in one of three places:

| Kind | Where | Typical use |
|---|---|---|
| `run: <command>` or `script: <file>` | **Locally**, on the CLI's machine, in the project directory | Generating files, notifying a chat |
| `host: <command>` | **On nodes**, over SSH as the deploy user. `nodes: managers` (default) or `all` | `sudo systemctl …`, host maintenance |
| `exec: [<argv>]` with `service: <name>` | **Inside every running task of that service**, as `docker exec` would | Warning players, flushing a cache, a backup that only the app knows how to make |

Entry options: `name`, `timeout` (default 5 minutes), and `fatal` (default `true` for `before_*` phases, `false` for the others). A fatal `before_*` hook stops the run with nothing changed. A fatal `after_deploy` hook triggers the rollback.

**Variables:**

- Hook commands and scripts are interpolated like any template ([ADR-0006](0006-compose-as-written.md)).
- Local and host hooks also get, as environment variables, `DOCKFLOW_APP`, `DOCKFLOW_ENV`, `DOCKFLOW_STACK`, `DOCKFLOW_VERSION`, and the secrets they list under `secrets:`.

### Running inside containers

**`exec` hooks.** The Engine API on a manager can only exec into containers on that manager. So for each node running a task of the service, the agent starts a short job pinned to that node:

- the job uses the agent image and mounts that node's Docker socket;
- it runs the command in the local container and streams its output back as events.

**`dockflow exec` uses the same mechanism** for a container on a worker, so the CLI never needs SSH to workers for it.

## Consequences

- The Minecraft sequence (warn, back up, stop) becomes an `exec` hook in `before_deploy`, and works on any node.
- Host-level actions remain possible, explicitly, through `host` hooks.
- `host` hooks need SSH to the targeted nodes: the connection string lists them ([ADR-0013](0013-servers-access-security.md)).
- `exec` hooks are run by the agent, so they survive a lost CLI.
- `host` hooks are run by the CLI, which is the only one holding SSH access:
  - those of `before_deploy` run just before the agent starts, so before the `before` jobs rather than after them;
  - those of `after_deploy` and `after_failure` run once the agent has finished. If the CLI was lost meanwhile, they don't run, and `dockflow attach` reports it.
