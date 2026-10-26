# CLI, version 1

The command names, options and exit codes of Dockflow v2 ([ADR-0016](../adr/0016-interfaces.md)). Every 1.x command has an equivalent here ([parity](../parity.md#commands)), but nothing is kept for compatibility: names follow v2's model.

## Conventions

- **`<env>`** is required, except in three cases:
  - `dockflow.yml` defines exactly one environment;
  - in CI, `deploy` and `build` derive it from the tag, as in 1.x. A tag `1.2.0` selects the environment whose `ci.tag_suffix` is empty (production by default), and `1.2.0-staging` the one whose suffix is `staging`. A suffix that names no environment is an error.
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

- **Prompts:** a command that changes a cluster shows its plan and asks for confirmation on a terminal. Without a terminal it never prompts.
- **`--json`:** operations print [events](events-v1.md) as JSON Lines. Read commands print one JSON document.

## Project and deploy

| Command | What it does |
|---|---|
| `dockflow init` | Writes `dockflow.yml` (and a `compose.yml` if there is none), adds `.env.dockflow` to `.gitignore`, and with `--ci github\|gitlab` a CI workflow: build on branches, deploy on tags, scheduled backups |
| `dockflow validate [<env>]` | Loads and checks everything that can be checked without a cluster |
| `dockflow config show [<env>] [--json]` | The resolved configuration, secrets masked |
| `dockflow build [<env>] [--only <services>] [--push] [--skip-hooks]` | Builds images, without deploying |
| `dockflow plan [<env>] [--out <file>] [--no-build] [--render] [--only <services>]` | Prints the plan. `--render` prints the service specs that would be sent |
| `dockflow deploy [<env>] [--plan <file>] [--version <label>] [--only <services>] [--skip-build] [--no-rollback] [--detach] [--force] [--no-wait] [--branch <name>] [--manager <node>]` | Plans, confirms, applies |
| `dockflow rollback [<env>] [--to <seq\|version>] [--service <name>]` | Re-applies a recorded release, by default the previous one. `--service` restores one service only |
| `dockflow attach [<env>] [<run-id>]` | Follows a run in progress, or replays a finished one |
| `dockflow cancel [<env>]` | Asks the running agent to stop and roll back |
| `dockflow destroy [<env>] [--only <services>] [--volumes]` | Removes an environment, or some of its services, from the cluster. `--volumes` also deletes their data and asks to type the environment's name |

## Day-2

| Command | What it does |
|---|---|
| `dockflow status [<env>]` | Without `<env>`: every environment. With it: current release, services and task counts, degraded flag, lock |
| `dockflow ps [<env>] [--tasks]` | Containers or tasks, on every node |
| `dockflow details [<env>]` | Full view of services: image, ports, networks, mounts, placement, resources |
| `dockflow diagnose [<env>]` | Why tasks don't run: pending reasons, crash loops, failed health checks, node state |
| `dockflow releases [<env>] [-n <count>] [--stats]` | Release history; `--stats` adds durations and success rate |
| `dockflow version [<env>]` | The deployed version; without `<env>`, the CLI's |
| `dockflow logs [<env>] [<service>] [-f] [-n <lines>\|all] [--since <time>] [--timestamps] [--all-tasks] [--pick] [--no-prefix]` | Service logs from every node |
| `dockflow exec [<env>] <service> [-e K=V]… [-u <user>] [-w <dir>] [--sh] [-T] [--pick] [-- <cmd…>]` | A command in a running container on any node; a shell by default |
| `dockflow run [<env>] <service> [-e K=V]… -- <cmd…>` | A one-off job with the service's spec (a console, a script) |
| `dockflow cp [<env>] <src> <dest> [--pick]` | Copies files between the local machine and a container, in either direction (`service:/path`) |
| `dockflow ssh [<env>] [<node>] [<command>]` | A shell, or a command, on a node |
| `dockflow restart [<env>] [<service>]` | Restarts services, as a rolling update |
| `dockflow stop [<env>] [<service>]` | Scales services to 0; `deploy` or `restart` brings them back |
| `dockflow scale [<env>] <service> <replicas>` | Changes replicas until the next deploy, which restores Compose's count and says so in its plan |
| `dockflow prune [<env>] [--images] [--containers] [--volumes] [--networks] [-a]` | Cleans unused Docker objects on every node |
| `dockflow list envs\|services [<env>]\|images [<env>] [-a]` | Lists |
| `dockflow lock status\|acquire\|release [<env>] [-m <message>] [--force]` | `acquire` holds the lock by hand (a maintenance window) until `release`; a manual lock never expires. `--force` releases or takes over someone else's |

Commands that change services (`restart`, `stop`, `scale`, `rollback`, `destroy`, `backup restore`) take the environment's lock.

## Secrets and backups

| Command | What it does |
|---|---|
| `dockflow secrets list [<env>]` | Keys and where each comes from (CI variable, `.env.dockflow`, SOPS), never values |
| `dockflow secrets set\|edit [<env>] [<KEY>]` | Changes the SOPS file, when the environment uses one; the value is read from stdin |
| `dockflow secrets revoke [<env>] <KEY>` | Removes every old Swarm secret of that key at once |
| `dockflow backup run [<env>] [<service>]` | Backs up the services that declare `backup` |
| `dockflow backup list [<env>] [<service>] [--node <node>]` | Lists snapshots |
| `dockflow backup restore [<env>] <service> [--snapshot <id or date>] [--from <env>]` | Restores a snapshot |
| `dockflow backup prune [<env>] [<service>] [--keep …]` | Applies a retention now |

## Servers and clusters

`<target>` is `user@host[:port]`, or `--env <env>` to use an environment's nodes.

| Command | What it does |
|---|---|
| `dockflow server init [<user@host[:port]>] [-k <key>] [--host <ip>] [--user <name>] [--password-file <path>] [--deploy-key <file.pub> \| --generate-key] [--host-key <SHA256:…>] [--from <cidr>…] [--skip-docker-install] [--no-port-filter]` | Provisions a server. Interactive when options are missing; runs locally when no host is given. Prints the connection string at the end |
| `dockflow server cloud-init [--deploy-key <file.pub>] [--from <cidr>…]` | Prints cloud-init user-data that does the same on first boot |
| `dockflow server check [<target>]` | Checks a server's prerequisites: OS, Docker, user, filter, ports |
| `dockflow server connection [<env>]` | Prints the environment's connection string, rebuilt from the cluster's nodes |
| `dockflow cluster init <target> [--acme-email <email>] [--edge direct\|cloudflare\|proxy] [--trusted-proxy <cidr>…] [--private-cidr <cidr>…] [--no-overlay-encryption] [--no-proxy]` | Creates the Swarm and its system services |
| `dockflow cluster join <target> <user@new-host> --role manager\|worker` | Adds a provisioned server |
| `dockflow cluster label <target> <node> <key>=<value>…` | Sets node labels |
| `dockflow cluster network create\|list\|remove <target> [<name>]` | Shared networks between apps |
| `dockflow cluster plugin install\|list\|remove <target> [<plugin>] [--alias <name>] [<key>=<value>…]` | Volume plugins on every node |
| `dockflow cluster status <target>` | Nodes, system services, apps and their environments |
| `dockflow cluster upgrade <target>` | Upgrades the system services to this CLI's version |
| `dockflow cluster proxy sync <target>` | Rebuilds the proxy's configuration from the route records |

## Interfaces

| Command | What it does |
|---|---|
| `dockflow ui [-p <port>] [--no-open]` | The local web UI ([ADR-0016](../adr/0016-interfaces.md)) |
| `dockflow mcp [--allow-apply]` | MCP server over stdio |
| `dockflow completion <shell>` | Shell completion script |

Internal commands are hidden from help: `agent`, `provision` and `filter apply`.

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
| 7 | Build or push failed; nothing was changed on the cluster |
| 8 | The run failed and was rolled back: the previous release is running |
| 9 | The run failed and was not rolled back (`on_failure: fail`, `--no-rollback`, or the rollback failed): the environment is degraded |
| 10 | The lock was lost during the run |
| 11 | A fatal hook failed before anything changed |
| 130 | Interrupted: the run was cancelled and rolled back |

`exec`, `run` and `ssh` exit with the command's own exit code. When they cannot start it, they use the codes above.
