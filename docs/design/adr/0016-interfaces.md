# ADR-0016: One core, a JSON event stream, CLI/TUI/MCP; no web UI in v1

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x has a local Angular WebUI (about 8,000 lines, no tests, about 940 lockfile entries) behind a local API (about 4,000 lines). Part of that API reimplements day-2 commands with its own raw `docker` commands, and some of its behaviour already differs from the CLI's. The UI has no authentication and accepts any page served from any `localhost` port. The MCP server reimplements the configuration schemas by hand (450 lines) and has no operational tools.

## Decision

### One core

Every operation is a function of the `app` package. It takes typed inputs and emits [events](../spec/events-v1.md). No package below the interfaces prints anything. Each interface is thin:

| Interface | What it is |
|---|---|
| CLI | Commands that call the core and render its events: human-readable by default, JSON Lines with `--json`. Exit codes are part of the contract ([CLI spec](../spec/cli-v1.md)) |
| TUI | `dockflow tui`, a terminal console (Bubble Tea): environments, services, tasks, logs, releases, plan and apply with confirmation. Read-mostly |
| MCP | `dockflow mcp`, an MCP server over stdio. Read tools: `status`, `releases`, `logs`, `plan`, `validate`. Write tools (`deploy`, `rollback`) are off unless the server is started with `--allow-apply`, and each one requires a plan fingerprint the client obtained from `plan` first |
| GitHub Action | `dockflow/action`. It runs `dockflow plan` on pull requests and posts the plan as a comment, and runs `deploy` with the reviewed plan on merge or tag |

### No web UI in v1

A browser UI makes sense for a team dashboard that runs on the server, which v1 excludes ([vision](../vision.md#non-goals)). For a single user on their own machine, the TUI covers the same need at a fraction of the cost and the attack surface.

## Consequences

- The CLI, the TUI, the MCP server and the Action cannot drift apart: they call the same functions.
- Agents and scripts get a stable, versioned JSON contract instead of scraping text.
- The MCP server validates configuration with the real loader, not a copy.
- Users who want a web dashboard will not find one in v1.

## Alternatives considered

- **A local web UI with a per-launch token.** Rejected for v1: same functions as the TUI, much more code.
- **A server-side web UI.** Needs a permanent agent; deferred with it.
