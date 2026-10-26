# ADR-0022: Hooks: local, on hosts, and inside running containers

- Status: Accepted
- Date: 2026-10-26

## Context

Dockflow 1.x runs hooks at seven moments (pre and post build, upload, deploy, and on failure), locally or on the Swarm manager over SSH. Real projects use them to:

- **generate files from secrets before the build**: a JWT key pair (`valientrp-backend`);
- **write a key on the host and run `sudo systemctl`** to enable FUSE mounts (`mohistmc-backend`);
- **stop a game server gracefully before a deploy** (`minecraft-server`): warn players over RCON, back the world up inside the running container, save, stop. Its script calls `docker exec` by hand and finds the container by name;
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
| `host: <command>` | **On the server**, over SSH as the deploy user | `sudo systemctl …`, host maintenance |
| `exec: [<argv>]` with `service: <name>` | **Inside every running container of that service**, through the Engine API's exec | Warning players, flushing a cache, a backup that only the app knows how to make |

Entry options: `name`, `timeout` (default 5 minutes), and `fatal` (default `true` for `before_*` phases, `false` for the others). A fatal `before_*` hook stops the run with nothing changed. A fatal `after_deploy` hook triggers the rollback.

**Variables:**

- Hook commands are not interpolated: their `$` belongs to the shell.
- Every hook gets, as environment variables, the built-in `DOCKFLOW_*` values, the environment's `vars`, and the secrets it lists under `secrets:`.
- A script that needs a real template is listed under `templates:` and rendered with Jinja ([ADR-0006](0006-compose-as-written.md)).

### Who runs them

A deploy must survive the CLI's death ([ADR-0004](0004-ephemeral-agent.md)), so the agent never waits on the CLI's connection in the middle of a run:

- **`exec` hooks run in the agent**, at the points above: `before_deploy` right before the first service changes, `after_deploy` after the public checks and before the old containers are drained, in the containers of the new release, so a fatal one rolls back like a failed check, and `after_failure` after the rollback.
- **Local and `host` hooks run in the CLI**, around the agent's run: `before_deploy` before the agent starts (so before the `before` jobs), `after_deploy` once the release is committed, and `after_failure` once the agent reports the failure. A fatal `after_deploy` hook there rolls back with a rollback run to the previous release.
- **A `host` hook's script travels on stdin** to `sh -s`, its environment exported in it, so no value appears in a command line on the server.

A fatal `before_*` hook exits with code 11, before any release is created; a fatal `after_deploy` hook with code 8, once the previous release is back; a fatal `after_build` hook with code 11, nothing having changed. A `before_deploy` `exec` hook is skipped, with a notice, when its service has no container yet (its first deploy).

### Running inside containers

`exec` hooks use the Engine API's exec on the server's containers, as `docker exec` does: the agent finds the service's current containers by their Compose labels. `dockflow exec` uses the same path.

## Consequences

- The Minecraft sequence (warn, back up, stop) becomes an `exec` hook in `before_deploy`, with no container name to look up.
- Host-level actions remain possible, explicitly, through `host` hooks.
- `host` hooks use the environment's SSH access ([ADR-0013](0013-servers-access-security.md)).
- `exec` hooks are run by the agent, so they survive a lost CLI.
- `host` hooks are run by the CLI, which is the only one holding SSH access:
  - those of `before_deploy` run just before the agent starts, so before the `before` jobs rather than after them;
  - those of `after_deploy` and `after_failure` run once the agent has finished. If the CLI was lost meanwhile, they don't run, and `dockflow attach` reports it.
