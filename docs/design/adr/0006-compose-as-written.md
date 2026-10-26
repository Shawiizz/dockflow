# ADR-0006: Compose plus `dockflow.yml`, with Compose-style interpolation instead of a template engine

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (interpolation in `dockflow.yml`, `templates:` kept, after review by the project owner)

## Context

Dockflow 1.x uses five kinds of files (`config.yml`, `servers.yml`, a flat `dockflow.yml` alternative, `.env.dockflow`, compose files). It renders every file under `.dockflow/` with Nunjucks, which breaks Go templates, Prometheus rules and bash, and renders an undefined variable as an empty string. Values per environment can be set four different ways.

Seven real projects (MohistMC, ValientRP, shawiizz.dev) use templating for:

- substituting values in Compose, health check URLs, hook scripts, nginx vhosts and an entrypoint script;
- defaults (`| default('4326')`);
- the environment name (`{{ env }}`).

None of them uses conditions or loops.

## Decision

### Files

A project has:

1. **Compose files.** Dockflow's per-service settings live in `x-dockflow` keys, which Compose ignores. Variation between environments uses `vars`, interpolation, several Compose files merged in order, and profiles. They may live anywhere in the repository (`.dockflow/docker/` as in 1.x, or the root).
2. **One `dockflow.yml`**: the app, its environments, their variables, and every Dockflow setting ([config spec](../spec/config-v1.md)).
3. **Secrets** from CI, `.env.dockflow` or a SOPS file ([ADR-0012](0012-secrets-sops.md)).

### Interpolation

One syntax everywhere, Compose's:

| Form | Meaning |
|---|---|
| `${VAR}` | The value |
| `${VAR:-default}` | The value, or a default |
| `${VAR:?message}` | The value, or an error with that message |
| `$$` | A literal `$` |

It applies to:

- the Compose files (resolved by compose-go);
- the string values of `dockflow.yml`, except names: the app, the environments and the keys themselves;
- the files listed under `templates:`;
- hook commands and scripts.

**Lookup, first match wins:**

1. built-in variables (`DOCKFLOW_APP`, `DOCKFLOW_ENV`, `DOCKFLOW_STACK`, `DOCKFLOW_VERSION`, `DOCKFLOW_GIT_SHA`);
2. secrets, scoped by environment;
3. the environment's `vars`.

A variable with no value and no default is an error.

### `templates:`

Files outside Compose are rendered only when listed under `templates:` (as `src` → `dest`, or in place). Rendering happens in a temporary copy of the project, and bake builds from that copy, so a rendered file can be part of an image: Dockflow's own docs render a page and a build script this way. Templates are also rendered before uploads ([ADR-0021](0021-uploads-and-templates.md)). The source tree is never modified. A listed template that does not exist is an error. In 1.x it was skipped silently, which shipped an unrendered page of the docs. Nothing is rendered implicitly.

## Consequences

- One syntax, the one Compose and the shell already use; the 1.x usages map one to one:

  | 1.x (Nunjucks) | v2 |
  |---|---|
  | `{{ current.env.app_port }}` | `${APP_PORT}` |
  | `{{ x \| default('4326') }}` | `${X:-4326}` |
  | `{{ env }}` | `${DOCKFLOW_ENV}` |

- Nunjucks conditions, loops and filters are gone. If a real need appears, it gets its own ADR.
- A typo in a variable name fails `dockflow plan` instead of deploying an empty value.
- Files under `.dockflow/` are no longer rendered implicitly, so scripts with `${#var}` or Go templates are safe.

## Alternatives considered

- **Keeping Nunjucks.** Rejected: a second syntax next to Compose's, and its silent empty values caused real bugs.
- **No interpolation in `dockflow.yml` and no `templates:` (first draft of this ADR).** Rejected by the project owner as a regression.
- **A configuration language (TypeScript, CUE, Pkl).** Rejected: the UI and the MCP server need to read and check the configuration as data.
