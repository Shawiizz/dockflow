# CLI, version 1

The command names, options and exit codes of Dockflow v2 ([ADR-0016](../adr/0016-interfaces.md)). Every 1.x command has an equivalent here ([parity](../parity.md#commands)), but nothing is kept for compatibility: names follow v2's model.

## Conventions

- **`<env>`** is required, except in three cases:
  - `dockflow.yml` defines exactly one environment;
  - in CI, `deploy` and `build` derive it from the tag, as in 1.x. A tag `1.2.0` selects the environment whose `ci.tag_suffix` is empty (production by default), and `1.2.0-staging` the one whose suffix is `staging`. A suffix that names no environment is an error.
- **Prefixes:** typed on the command line, an environment may be abbreviated to a unique prefix (`pr` for `production`), as in 1.x. An ambiguous prefix lists the candidates. Prefixes never apply to environments derived from CI tags.
- **Version:** in CI, `deploy` takes it from the tag, or from the branch and commit, unless `--version` is given.
- **Global options:**

  | Option | Effect |
  |---|---|
  | `-C, --dir <path>` | The project directory |
  | `--json` | Machine-readable output |
  | `-v, --verbose` | Show `debug` events |
  | `--no-color` | No colours |
  | `-y, --yes` | Never prompt |
  | `--connection <string>` | Use this connection string instead of the environment's secret |

- **Prompts:** a command that changes a server shows its plan and asks for confirmation on a terminal. Without a terminal it never prompts.
- **`--json`:** operations print [events](events-v1.md) as JSON Lines. Read commands print one JSON document.

## Project and deploy

| Command | What it does |
|---|---|
| `dockflow init` | Writes `dockflow.yml` (and a `compose.yml` if there is none), adds `.env.dockflow` to `.gitignore`, and with `--ci github\|gitlab` a CI workflow: build on branches, deploy on tags, scheduled backups |
| `dockflow validate [<env>]` | Loads and checks everything that can be checked without a server |
| `dockflow config show [<env>] [--json]` | The resolved configuration, plugins expanded, secrets masked: YAML, or JSON with `--json` |
| `dockflow plugins list` | Built-in and project plugins, with their inputs ([ADR-0017](../adr/0017-plugins.md)) |
| `dockflow build [<env>] [--only <services>] [--push] [--platform <os/arch>] [--skip-hooks]` | Builds images, without deploying. Without `--push`, for `--platform` (default: this machine's architecture); with it, for the server's, and pushes them where a deploy would. With `build.builder: remote`, the build runs on the server and `--push` is implied |
| `dockflow plan [<env>] [--out <file>] [--no-build] [--render] [--only <services>]` | Prints the plan. `--render` prints the service specs that would be sent; `--only` plans as `deploy --only` |
| `dockflow deploy [<env>] [--plan <file>] [--version <label>] [--only <services>] [--skip-build] [--no-rollback] [--detach] [--force] [--wait-lock [<duration>]] [--branch <name>]` | Plans, confirms, applies. `--wait-lock` queues behind a running deploy instead of failing with code 5, for CI runs that may overlap (a push to `main` and a release). `--only` moves those services to the new version and keeps every other service as the current release has it (the release still records the whole app; jobs come from the new version). `--skip-build` builds nothing and uses the images `build --push` pushed for the same version. `--plan` applies a saved plan (below) or fails with `plan.stale`. `--detach` returns once the run started; `attach` follows it. `--branch` replaces the branch recorded in the release |
| `dockflow rollback [<env>] [--to <seq\|version>] [--service <name>]` | Re-applies a recorded release, by default the previous one. `--to` takes a release number, or a version label for the newest release of it that went live. `--service` restores one service only, the others staying as they are |
| `dockflow attach [<env>] [<run-id>]` | Follows a run in progress, or replays a finished one |
| `dockflow cancel [<env>]` | Asks the running agent to stop and roll back |
| `dockflow destroy [<env>] [--only <services>] [--volumes]` | Removes an environment (its containers, routes, networks and state), or some of its services, from the server. Asks for confirmation on a terminal; `--volumes` also deletes their data and asks to type the environment's name, or needs `--yes` without a terminal |

## Day-2

| Command | What it does |
|---|---|
| `dockflow status [<env>]` | Without `<env>`: every environment. With it: current release, services and container counts, degraded flag, lock, watchdog restarts |
| `dockflow ps [<env>] [-a]` | The app's containers; `-a` includes stopped ones and jobs |
| `dockflow details [<env>]` | Full view of services: image, ports, networks, mounts, placement, resources |
| `dockflow diagnose [<env>]` | Why containers don't run: exit codes, crash loops, failed health checks with their last output, OOM kills, ports in use, missing containers, disk space. Exits with code 9 when it finds a problem |
| `dockflow releases [<env>] [-n <count>] [--stats]` | Release history; `--stats` adds durations and success rate |
| `dockflow version [<env>]` | The deployed version; without `<env>`, the CLI's |
| `dockflow logs [<env>] [<service>] [-f] [-n <lines>\|all] [--since <time>] [--timestamps] [--all] [--pick] [--no-prefix]` | Service logs; `--all` includes the previous release's and stopped containers |
| `dockflow exec [<env>] <service> [-e K=V]… [-u <user>] [-w <dir>] [--sh] [-T] [--pick] [-- <cmd…>]` | A command in a running container; a shell by default |
| `dockflow run [<env>] <service> [-e K=V]… -- <cmd…>` | A one-off job with the service's spec (a console, a script) |
| `dockflow cp [<env>] <src> <dest> [--pick]` | Copies files between the local machine and a container, in either direction (`service:/path`) |
| `dockflow ssh [<env>] [-- <command>…]` | A shell, or a command, on the server |
| `dockflow restart [<env>] [<service>…]` | Restarts services with their rollout strategy, so routed services restart without downtime |
| `dockflow stop [<env>] [<service>…]` | Scales services to 0; `deploy` or `restart` brings them back |
| `dockflow scale [<env>] <service> <replicas>` | Changes replicas until the next deploy, which restores Compose's count and says so in its plan |
| `dockflow prune [<env>] [--images] [--containers] [--volumes] [--networks] [-a]` | Cleans unused Docker objects on the server. Without a kind: stopped containers, untagged images and networks. `-a` removes every unused image, not only untagged ones. Never removes what Dockflow manages, app volumes, or the images of releases in retention; `--volumes` removes unused anonymous volumes only |
| `dockflow list envs\|services [<env>]\|images [<env>] [-a]` | Lists |
| `dockflow lock status\|acquire\|release [<env>] [-m <message>] [--force]` | `acquire` holds the lock by hand (a maintenance window) until `release`; a manual lock never expires, and it refuses every run that changes the environment except `deploy --force`. `--force` releases or takes over someone else's |

Commands that change services (`restart`, `stop`, `scale`, `rollback`, `destroy`, `backup restore`) take the environment's lock.

## Secrets and backups

| Command | What it does |
|---|---|
| `dockflow secrets list [<env>]` | Keys and where each comes from (CI variable, `.env.dockflow`, SOPS), never values |
| `dockflow secrets set\|edit [<env>] [<KEY>] [--age <recipient>…]` | Changes the environment's SOPS file (`secrets_file`, default `secrets/<env>.sops.yaml`), creating it for `--age` or `.sops.yaml`'s recipients; `set` reads the value from stdin (without echo on a terminal), `edit` opens the decrypted values in `$VISUAL` or `$EDITOR` |
| `dockflow secrets revoke [<env>] <name>` | Removes from the server every file of the Compose secret `<name>` that the current release does not use |
| `dockflow backup run [<env>] [<service>]` | Backs up the services that declare `backup` |
| `dockflow backup list [<env>] [<service>]` | Lists snapshots |
| `dockflow backup restore [<env>] <service> [--snapshot <id or date>] [--from <env>]` | Restores a snapshot |
| `dockflow backup prune [<env>] [<service>] [--keep …]` | Applies a retention now |

## Servers

`<target>` is `user@host[:port]`, or `--env <env>` to use an environment's server.

| Command | What it does |
|---|---|
| `dockflow server init [<admin>@<host[:port]>] [-k <key>] [--password-file <path>] [--user <name>] [--deploy-key <private key file>] [--host-key <SHA256:…>] [--name <name>] [--skip-docker-install] [--host <address>] [--port <port>] [--edge builtin\|cloudflare\|external\|none] [--switch-listen <addr:port>] [--switch-image <image>] [--trusted-proxy <cidr>…] [--no-registry] [--registry-image <image>] [--no-port-filter] [--no-watchdog]` | Provisions a server ([ADR-0013](../adr/0013-servers-access-security.md)) from an administrator's account (root, or passwordless sudo): installs Docker when missing (Debian, Ubuntu), creates the deploy user with a key generated on the CLI's machine, then installs the switch, the registry, the published-port filter ([ADR-0014](../adr/0014-networking-port-filter.md), unless `--no-port-filter`) and the watchdog ([ADR-0010](../adr/0010-rollout-health-jobs.md), unless `--no-watchdog`) as that user, and prints the connection string. Without an argument, outside a project (no `dockflow.yml` in the directory), it does the same on the server it runs on, as root: the script runs locally, the connection string takes the public address (or `--host`), the SSH port of `sshd_config` (or `--port`) and the local host key, and the deploy user is checked through the SSH server on 127.0.0.1. With `[<env>]` instead, updates the switch and the registry of that environment's server. An option not given keeps what `server.json` records (edge, switch address and trusted proxies, images, registry, filter, watchdog), so running it again only updates; `--no-…=false` turns back on what an earlier run left out. Coming in M3: interactive mode, `--from`, `--acme-email`, `--nginx`, hardening |
| `dockflow server cloud-init [same options]` | Prints cloud-init user-data that does the same on first boot |
| `dockflow server check [<target>]` | Checks a server's prerequisites: OS, Docker, user, filter, ports 80 and 443 |
| `dockflow server connection [<target>] [-k <key>] [--host-key <SHA256:…>] [--name <name>]` | Prints the connection string, after connecting: the host key it holds is the one SSH verified, against `--host-key` or known_hosts, never trusted on first use; the user must be able to use Docker |
| `dockflow server status [<target>]` | The switch, the registry, the watchdog, the edge, the filter, the apps and their environments, disk usage |
| `dockflow server edge <target> <mode> […]` | Changes the edge mode ([ADR-0011](../adr/0011-switch-and-edge.md)) |
| `dockflow server network create\|list\|remove [<env>] [<name>]` | Shared networks between apps ([ADR-0018](../adr/0018-shared-servers.md)): bridge networks labelled `dockflow.shared=true`, which apps join as external networks; `remove` refuses while containers use one |
| `dockflow server plugin install\|list\|remove [<env>] [<plugin>] [--alias <name>] [<key>=<value>…]` | Docker volume plugins (not to be confused with Dockflow plugins): `install` grants the privileges the plugin asks for and prints them; setting values are masked, and `list` shows their names only; `remove` refuses while volumes use one |
| `dockflow server upgrade <target>` | Upgrades the switch, the registry and the watchdog to this CLI's version |
| `dockflow server uninstall [<target>] [--volumes] [--yes]` | Removes Dockflow from a server: every app environment (with `--volumes`, their data), the switch, the registry, the watchdog, the port filter, `/var/lib/dockflow`; the deploy user and Docker stay |
| `dockflow server proxy sync <target>` | Rebuilds the switch's configuration from the current releases |

## Interfaces

| Command | What it does |
|---|---|
| `dockflow ui [-p <port>] [--no-open]` | The local web UI ([ADR-0016](../adr/0016-interfaces.md)) |
| `dockflow mcp [--allow-apply]` | MCP server over stdio |
| `dockflow completion <shell>` | Shell completion script |
| `dockflow help [<command>]` | Help, also as `-h` on every command |

Internal commands are hidden from help: `agent` (the agent's entry point in its container) and `upload-helper` (the helper container of uploads), `watchdog` (the watchdog's container, which writes events on its stdout) and `filter apply` (the helper container of the port filter, which reads the rules from `DOCKFLOW_FILTER`). Provisioning runs as a shell script over SSH, with no command of its own ([ADR-0013](../adr/0013-servers-access-security.md#implementation-status-m2)).

## Saved plans

`dockflow plan --out <file>` writes the plan as JSON, mode 0600, for `dockflow deploy --plan <file>`:

| Field | Description |
|---|---|
| `schema` | `1` |
| `app`, `env`, `server`, `version` | What the plan is for; `deploy --plan` uses this version label and refuses another environment |
| `only` | The plan's `--only`, applied again by the deploy |
| `images` | The built services' images, pinned by digest: the deploy builds nothing |
| `fingerprint` | The plan's fingerprint ([ADR-0008](../adr/0008-plan-apply-releases.md)): the desired state, secrets included, and the actual state it was computed from. The agent refuses the deploy with `plan.stale` when the plan it computes has another one |
| `plan` | The plan itself, for review, masked as every output is |
| `created_at`, `dockflow_version` | When and by which CLI |

The file holds no secret value: a changed secret changes the fingerprint, so the plan goes stale.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including a plan with nothing to do |
| 1 | Unexpected error (a bug: please report it) |
| 2 | Wrong usage: unknown command or option, bad argument |
| 3 | Invalid configuration: `dockflow.yml`, Compose, secrets, a missing variable |
| 4 | Cannot connect: SSH, host key mismatch, Docker API unreachable |
| 5 | Another run holds the lock |
| 6 | Plan refused: conflict, stale saved plan, missing image, unsupported Compose key |
| 7 | Build or push failed; nothing was changed on the server |
| 8 | The run failed and was rolled back: the previous release is running |
| 9 | The run failed and was not rolled back (`on_failure: fail`, `--no-rollback`, or the rollback failed): the environment is degraded |
| 10 | The lock was lost during the run |
| 11 | A fatal hook failed before anything changed |
| 130 | Interrupted: the run was cancelled and rolled back |

`exec`, `run` and `ssh` exit with the command's own exit code. When they cannot start it, they use the codes above. They connect the terminal to the command, so their output is the command's own, not masked: the user runs it.

**Ctrl+C** cancels a command, except during an agent's run: then the first one asks the agent to stop and roll back, and a second one detaches ([ADR-0004](../adr/0004-ephemeral-agent.md)).
