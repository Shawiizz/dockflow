# ADR-0017: No plugin system in v1

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x has a plugin system: manifests with inputs, uploads and hooks, expanded by about 530 lines, with strict templating rules opposite to the project's own. It has two built-in plugins of about 20 lines each (`nginx`, `systemd`) and no third-party ecosystem. The `nginx` plugin competes with the built-in proxy.

## Decision

v1 has no plugin system:

- What 1.x plugins did is covered by Compose itself (services, `configs:`), by jobs ([ADR-0010](0010-rollout-health-jobs.md)) and by local hooks.
- Common setups are documented **recipes**: Compose snippets with their `x-dockflow` keys, for example a Postgres with backups, a worker with a migration job, a static site, a monitoring stack.

If extension becomes necessary after v1, it takes the form of executables named `dockflow-<name>` on the `PATH`, called with the environment's resolved context as JSON on stdin, the way git and kubectl find their plugins. That needs its own ADR.

## Consequences

- No plugin manifest format, no second templating system, no plugin loader to maintain.
- Users copy recipes instead of declaring plugins.
