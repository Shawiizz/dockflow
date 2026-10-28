# ADR-0016: One core, a JSON event stream; CLI, local web UI and MCP on top

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (the local web UI is kept and the TUI dropped, so 1.x loses nothing), revised 2026-10-28 (the local web UI is deferred after v1.0 by decision of the project owner: none of the projects that shaped v2 needs it; its design below stands for when it comes), revised 2026-10-28 (the MCP server: `rollback` takes a release number, as it has no plan), revised 2026-10-28 (the GitHub Action deploys the merged code, not the reviewed plan)

## Context

Dockflow 1.x has a local Angular WebUI (`dockflow ui`, about 8,000 lines, no tests) behind a local API (about 4,000 lines). Part of that API reimplements day-2 commands with its own raw `docker` commands, and some of its behaviour already differs from the CLI's. The UI has no authentication and accepts any page served from any `localhost` port. The MCP server reimplements the configuration schemas by hand (450 lines) and has no operational tools.

The project owner wants no regression from 1.x, and the web UI is a 1.x feature.

## Decision

### One core

Every operation is a function of the `app` package. It takes typed inputs and emits [events](../spec/events-v1.md). No package below the interfaces prints anything. Each interface is thin:

| Interface | What it is |
|---|---|
| **CLI** | Commands that call the core and render its events: human-readable by default, JSON Lines with `--json`. Exit codes are part of the contract ([CLI spec](../spec/cli-v1.md)) |
| **Local web UI** | `dockflow ui`, served by the CLI on loopback, embedded in the binary. It calls an HTTP API that is a thin layer over the same core functions; operations stream the same events over Server-Sent Events. Pages: dashboard, environments, services and tasks, logs, terminal (`exec`), releases and rollback, plan and deploy, backups, routes, locks, configuration (read and validate) |
| **MCP** | `dockflow mcp`, an MCP server over stdio. Read tools: `status`, `releases`, `logs`, `plan`, `validate`. Write tools (`deploy`, `rollback`) are off unless the server is started with `--allow-apply`. `deploy` needs a plan fingerprint that the client got from `plan` in the same session; `rollback`, which has no plan, the number of a release that `releases` lists. Each tool runs the CLI command of the same name, in the process, with `--json`; its events are progress notifications, and a cancelled call stops the command as Ctrl+C does. The protocol is the official Go SDK's, which follows the specification's versions |
| **GitHub Action** | `Shawiizz/dockflow`, an `action.yml` at the repository's root, versioned with the CLI. It posts `dockflow plan --markdown` as a comment on pull requests, updated on each push, and otherwise runs a command, `deploy` by default. A merge changes the commit the review saw, so the merged code is planned again at deploy time rather than the reviewed plan applied |

### The web UI's security

- **A random token per launch.** The UI opens with it in the URL and swaps it for an HttpOnly, SameSite=Strict cookie. Every API and WebSocket request needs it, so another page on `localhost`, whatever its port, cannot drive the API.
- **Origin checks.** Host and Origin must be loopback with the UI's own port.
- **No write-back of Compose files.** The UI does not rewrite Compose files or `dockflow.yml`. 1.x's write-back lost comments and broke templates. Configuration is edited in the editor and checked in the UI.
- **The frontend stack** is chosen in M5. Criteria: a small dependency tree and tests from the start.

### No TUI

The first draft of this ADR replaced the web UI with a terminal UI. That would lose a 1.x feature, so the web UI is kept and the TUI dropped. Keeping both would double the work.

## Consequences

- The CLI, the UI, the MCP server and the Action call the same functions and cannot drift apart.
- Agents and scripts get a stable, versioned JSON contract.
- The UI is the largest piece outside the core, and has its own tests.
