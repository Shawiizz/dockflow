# ADR-0001: Clean break, no backward compatibility

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x (about 30,000 lines of TypeScript, plus a WebUI, an MCP server and a docs site) stores its state in files under `/var/lib/dockflow` on one Swarm manager, has five kinds of configuration files rendered with Nunjucks, and reimplements several things Docker and Swarm already do. Its review found design problems that cannot be fixed without changing the configuration format, the CLI and the server state at the same time.

Keeping compatibility would mean reading the old configuration, understanding the old server state and keeping the old command names, which would carry the old design into the new one.

## Decision

Dockflow v2 is a new project on an orphan branch, `v2`:

- It shares no code with 1.x.
- It does not read 1.x's `.dockflow/config.yml` or `servers.yml`. The file names v2 shares with 1.x (`dockflow.yml`, `.env.dockflow`) hold v2 formats only.
- It does not read or clean anything under `/var/lib/dockflow`, and does not know 1.x stacks, networks, Traefik or the 1.x port filter.
- Command names, options and exit codes are chosen fresh, with no aliases.
- There is no `migrate` command. Moving a project or a server is done by hand.
- The tool never detects, reads or reports a 1.x format, file or layout, not even to suggest a fix. Migration notes exist only in the user documentation.

## Consequences

- Every design choice is made for v2 alone.
- Users of 1.x migrate by hand. The cleanest path is a fresh server; on an existing one, the 1.x stacks and its Traefik must be removed first, because Traefik holds ports 80 and 443 that v2's proxy needs.
- If v2 is published under the same npm package or the same repository tags, its first public version must be a major version above the last 1.x release, so no 1.x user receives it through a minor or patch update.

## Alternatives considered

- **Evolve 1.x in place.** Rejected: the state model, the configuration model and the execution model all change.
- **A `migrate` command.** Rejected by the project owner: migration is manual.
