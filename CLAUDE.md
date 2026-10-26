# CLAUDE.md

Guidance for Claude Code (and any other agent) working on this branch.

## What this branch is

Dockflow v2, a rewrite from scratch in Go. It shares nothing with Dockflow 1.x (the `main` branch): no code, no configuration format, no server state, no compatibility. Never port code from `main` and never add anything to read 1.x files or state.

## Read before changing anything

- `docs/design/vision.md`: goals, non-goals, principles
- `docs/design/adr/`: the decisions. Code that contradicts an ADR is a bug, unless a new ADR supersedes it first.
- `docs/design/spec/`: the formats (configuration, state, events, CLI) are contracts. Changing them means changing the spec in the same pull request.
- `docs/design/roadmap.md`: work belongs to the current milestone. Anything else goes to the roadmap, not into the code.

## How to work

- **Vertical slices.** One user-visible capability per pull request, end to end: code, tests, docs. No horizontal "add all the types first" changes.
- **No sweeping refactors** before v1.0. Fix what a change touches, nothing more.
- **No regression from 1.x.** `docs/design/parity.md` maps every 1.x feature to its v2 equivalent. A milestone that ships a row's replacement updates the row; removing a row needs the project owner's decision.
- **Dependencies.** Each new module needs a sentence in the pull request on why the standard library or an existing dependency is not enough (ADR-0002).

## Architecture rules

- `internal/domain` and `internal/planner` are pure: no I/O, no Moby or Swarm types, no clock or randomness except through parameters.
- The outside world (Docker, SSH, registries, SOPS, Caddy, restic) is reached only through ports, each implemented by an adapter.
- Docker is reached only through the Engine API (ADR-0005). No `docker` CLI invocations in the deploy path. Shell commands exist only in provisioning, built with the typed command builder.
- No package prints. Operations emit events (`docs/design/spec/events-v1.md`). The CLI, the web UI and the MCP server render them.
- Errors carry a stable dotted code and a hint, and map to the exit codes in `docs/design/spec/cli-v1.md`.
- Secrets never go into logs, events, command lines, container environments of the agent, or files on servers. Any output that is shown or stored (events, hook and build output, errors) masks secret values.

## Tests

- Planner and converter: golden files (`testdata/`, regenerated with `go test ./... -update`), no mocks.
- Adapters: contract tests against a real Docker Engine (Docker-in-Docker).
- e2e: the compiled binary against a three-node Docker-in-Docker cluster, one test per user journey.
- Never assert on the text of a command sent to a server.

## Language

Code, comments, docs, commit messages: English. Commit messages follow Conventional Commits with a plain description of the change.
