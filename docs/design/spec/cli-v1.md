# CLI, version 1

The command names, options and exit codes of Dockflow v2 ([ADR-0016](../adr/0016-interfaces.md)). Nothing here is shared with Dockflow 1.x ([ADR-0001](../adr/0001-clean-break.md)).

## Conventions

- `<env>` is required unless `dockflow.yml` defines exactly one environment.
- **Global options:**

  | Option | Effect |
  |---|---|
  | `-C, --dir <path>` | The project directory |
  | `--json` | Machine-readable output |
  | `-v, --verbose` | Show `debug` events |
  | `--no-color` | No colours |
  | `-y, --yes` | Never prompt |

- **Prompts:** a command that changes a cluster shows its plan and asks for confirmation on a terminal. Without a terminal it never prompts and proceeds, as in CI.
- **`--json`:** operations (`deploy`, `rollback`, `backup run`, `backup restore`, `run`, `cluster …` writes) print [events](events-v1.md) as JSON Lines. Read commands print one JSON document.

## Project commands

| Command | What it does |
|---|---|
| `dockflow init` | Writes `dockflow.yml` (and a `compose.yml` if there is none). With `--github`, also a GitHub workflow for plan, deploy and scheduled backups |
| `dockflow validate [<env>]` | Loads and checks everything that can be checked without a cluster. Decrypts secrets when a key is available, otherwise checks only their keys |
| `dockflow plan <env> [--out <file>] [--no-build]` | Builds and pushes images, reads the cluster and prints the plan. `--no-build` previews without building, and shows built services as "updated if their image changes" |
| `dockflow deploy <env> [--plan <file>] [--version <label>] [--no-rollback] [--detach]` | Plans (or loads a saved plan), confirms, applies. `--detach` returns once the agent has started |
| `dockflow rollback <env> [--to <seq\|version>]` | Re-applies a recorded release, by default the previous one |
| `dockflow status <env>` | Current release, services and task counts, degraded flag, lock holder |
| `dockflow releases <env>` | Release history with status, version, author and time |
| `dockflow logs <env> [<service>] [-f] [--since <dur>] [--tail <n>]` | Service logs, from every node |
| `dockflow exec <env> <service> [--task <id>] -- <cmd…>` | Runs a command in a running container. Interactive on a terminal |
| `dockflow run <env> <service> -- <cmd…>` | Runs a one-off job with the service's spec (a console, a script) |
| `dockflow attach <env> [<run-id>]` | Follows a run in progress, or replays a finished one |
| `dockflow cancel <env>` | Asks the running agent to stop and roll back |
| `dockflow lock <env>` | Shows the lock |
| `dockflow secrets list <env>` | Lists secret keys, never their values |
| `dockflow secrets set <env> <KEY>` | Sets a key; the value is read from stdin |
| `dockflow secrets edit <env>` | Opens the file in `sops` |
| `dockflow secrets revoke <env> <KEY>` | Removes every old Swarm secret of that key at once, so releases that used them can no longer be rolled back to ([ADR-0012](../adr/0012-secrets-sops.md)) |
| `dockflow backup run <env> [<service>]` | Backs up the services that declare `backup` |
| `dockflow backup list <env> [<service>]` | Lists snapshots |
| `dockflow backup restore <env> <service> [--snapshot <id>] [--from <env>]` | Restores a snapshot |

There is no command that force-releases a lock. A dead holder's lock is taken over automatically after its lease, and a live holder is stopped with `cancel`.

## Server and cluster commands

These are run by an administrator. `<target>` is `user@host[:port]`, or `--env <env>` to use an environment's managers.

| Command | What it does |
|---|---|
| `dockflow server init <user@host> --deploy-key <file.pub> [--from <cidr>…]` | Provisions a server ([ADR-0013](../adr/0013-servers-access-security.md)) |
| `dockflow server cloud-init --deploy-key <file.pub> [--from <cidr>…]` | Prints cloud-init user-data that does the same on first boot |
| `dockflow cluster init <target> --acme-email <email> [--private-cidr <cidr>…] [--no-overlay-encryption]` | Creates the Swarm and its system services |
| `dockflow cluster join <target> <user@new-host> --role manager\|worker` | Adds a provisioned server |
| `dockflow cluster label <target> <node> <key>=<value>…` | Sets node labels |
| `dockflow cluster status <target>` | Nodes, system services, apps and their environments |
| `dockflow cluster upgrade <target>` | Upgrades the system services to this CLI's version |
| `dockflow cluster proxy sync <target>` | Rebuilds the proxy's configuration from the route records |

## Other commands

| Command | What it does |
|---|---|
| `dockflow tui` | The terminal console |
| `dockflow mcp [--allow-apply]` | MCP server over stdio |
| `dockflow version` | CLI version, and with `<env>`, the cluster's system version |
| `dockflow completion <shell>` | Shell completion script |

Internal commands are hidden from help: `agent` (the agent's entrypoint), `provision` (run on a host as root) and `filter apply` (the port filter job).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including a plan with nothing to do |
| 1 | Unexpected error (a bug: please report it) |
| 2 | Wrong usage: unknown command or option, bad argument |
| 3 | Invalid configuration: `dockflow.yml`, Compose, secrets |
| 4 | Cannot connect: SSH, host key mismatch, Docker API unreachable |
| 5 | Another run holds the lock |
| 6 | Plan refused: conflict, stale saved plan, missing image, unsupported Compose key |
| 7 | Build or push failed; nothing was changed on the cluster |
| 8 | The run failed and was rolled back: the previous release is running |
| 9 | The run failed and so did the rollback: the environment is degraded |
| 10 | The lock was lost during the run |
| 130 | Interrupted: the run was cancelled and rolled back |

`exec` and `run` exit with the command's own exit code. When they cannot start it, they use the codes above.
