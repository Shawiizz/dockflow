# ADR-0023: Several servers, later: independent servers, no orchestrator

- Status: Proposed (direction for after v1.0; nothing of it is built in v1)
- Date: 2026-10-26

## Context

v1 deploys an environment to one server ([ADR-0003](0003-single-host-docker.md)). Some users will outgrow one server, or want the same app in two regions, or apps of one environment spread over two machines. The project owner wants that door kept open, without Swarm or Kubernetes.

## Decision

The design keeps room for **several independent servers per environment**, the model Kamal uses:

- **Each server is a complete v1 target:** its own switch, its own state, its own lock, its own releases.
- **No network between servers.** Services on different servers talk through public or private addresses the user configures, never through an overlay.
- **Placement is declared, not scheduled.** A service runs on the servers listed for it (`x-dockflow.servers: [web1, web2]`), or on all of the environment's servers by default. Stateful services must name exactly one server.
- **Traffic is spread outside Dockflow** (a load balancer, DNS, Cloudflare) across the servers that run a routed service.
- **A deploy is one plan per server**, applied in order (one server at a time, so a failed health check stops the rollout before it reaches the others) or in parallel when the user asks for it.
- **Per-server values return:** `server_vars` and secrets scoped as `<ENV>_<SERVER>_<KEY>`, resolved wherever something runs on one server.

### What v1 does now to keep this door open

- The connection string holds a list of servers with names ([ADR-0013](0013-servers-access-security.md)). In v1 it must hold exactly one.
- Events and release records carry the server's name.
- Nothing in the state, the plan or the CLI assumes there is only one server per environment beyond the check that refuses a second one.

## Consequences

- Growing past one server needs no orchestrator and no new concepts beyond placement.
- Cross-server concerns (a database used from several servers, sessions, shared files) remain the application's, as they are with Kamal.
