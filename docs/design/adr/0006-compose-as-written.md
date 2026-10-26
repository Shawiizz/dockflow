# ADR-0006: Compose plus `dockflow.yml`; Compose interpolation in Compose, Jinja in files

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (interpolation in `dockflow.yml`; `templates:` kept, rendered with Jinja through gonja; values per node; after review by the project owner)

## Context

Dockflow 1.x uses five kinds of files (`config.yml`, `servers.yml`, a flat `dockflow.yml` alternative, `.env.dockflow`, compose files). It renders every file under `.dockflow/` with Nunjucks, which breaks Go templates, Prometheus rules and bash, and renders an undefined variable as an empty string. Values per environment can be set four different ways.

Eight real projects use templating for:
- values in Compose, health check URLs, hook scripts, nginx vhosts, an entrypoint script, a page and a script of the docs site;
- defaults (`| default('4326')`);
- the environment name;
- `{% raw %}` around a Go template.

Nginx vhosts and shell scripts are full of `$` (`$host`, `$http_upgrade`, `$1`). Compose-style `${VAR}` interpolation would collide with them, and Jinja's `{{ }}` doesn't.

**gonja** (`github.com/nikolalohinski/gonja/v2`) is a maintained, pure Go implementation of Jinja, close to Nunjucks:
- v2.9.1 was released in September 2026, and it powers a Terraform provider;
- it has conditions, loops, filters, macros and includes;
- it has a `StrictUndefined` mode that makes an undefined variable an error.

## Decision

### Files

A project has:

1. **Compose files**, with Dockflow's per-service settings in `x-dockflow` keys, which Compose ignores. They may live anywhere in the repository.
2. **One `dockflow.yml`**: the app, its environments, their variables, and every Dockflow setting ([config spec](../spec/config-v1.md)).
3. **Secrets** from CI, `.env.dockflow` or a SOPS file ([ADR-0012](0012-secrets-sops.md)).

### Two syntaxes, each where it is native

| Where | Syntax | Engine |
|---|---|---|
| Compose files and `dockflow.yml` (string values, except names) | `${VAR}`, `${VAR:-default}`, `${VAR:?message}`, `$$` | compose-go, Compose's own |
| Files listed under `templates:`, in uploads and plugins | Jinja: `{{ VAR }}`, `{% if %}`, `{% for %}`, filters (`default`, …), `{% raw %}` | gonja, `StrictUndefined` on |

Compose keeps its own syntax, so a Compose file stays valid for `docker compose up`. Every other file gets a real template language that doesn't collide with `$`.

**Hook commands** are not interpolated at all. They get their values as environment variables ([ADR-0022](0022-hooks.md)), and a hook script that needs templating is listed under `templates:`.

### Values

| Variable | Value |
|---|---|
| `DOCKFLOW_APP`, `DOCKFLOW_ENV`, `DOCKFLOW_STACK` | the app, the environment, `<app>-<env>` |
| `DOCKFLOW_VERSION` | the release's version label |
| `DOCKFLOW_GIT_SHA`, `DOCKFLOW_GIT_BRANCH` | the commit and the branch |
| `DOCKFLOW_NODE` | the node, in values rendered per node |
| Secrets | scoped by node, then environment ([ADR-0012](0012-secrets-sops.md)) |
| `vars` | of the node, then of the environment |

The lookup takes built-ins first, then secrets, then `vars`. In Jinja, the same names are top-level variables (`{{ DOMAIN }}`, `{{ DOCKFLOW_ENV }}`).

**Values per node**, as 1.x had per server. An environment's `vars` can be overridden per node (`node_vars`), and secrets per node (`PRODUCTION_<NODE>_<KEY>`). Values are resolved per node wherever something runs or lands on one node:

- templates rendered for uploads to host paths;
- plugins;
- `host` and `exec` hooks.

Compose is rendered once for the whole cluster, because a Swarm service is not bound to one node, so it sees the environment's values. A service that needs a node's value takes it through a placement constraint and a variable named for that node.

### `templates:`

- **What gets rendered:** only the files listed under `templates:` (as `src` → `dest`, or in place). Nothing is rendered implicitly.
- **Where:** in a temporary copy of the project, and bake builds from that copy, so a rendered file can be part of an image (Dockflow's docs render a page and a build script this way). Templates are also rendered before uploads ([ADR-0021](0021-uploads-and-templates.md)), per node when the upload's values differ by node. The source tree is never modified.
- **Errors:** a listed template that doesn't exist, or that uses an undefined variable, is an error.

## Consequences

- Real templates keep everything they need: conditions, loops, filters, `raw`. 1.x's Nunjucks templates port with small changes, because Jinja and Nunjucks share their syntax.
- Compose files stay valid Compose.
- Templating is delegated to gonja: Dockflow writes no template engine.
- A typo in a variable name fails `dockflow plan` instead of deploying an empty value.
- Two syntaxes to know. Each is the native one of its file type, and the documentation states the rule in one line.

## Alternatives considered

- **`${VAR}` everywhere (first draft of this ADR).** Rejected: it collides with `$` in nginx vhosts and shell scripts, and has no conditions or loops.
- **Jinja everywhere, Compose included (as 1.x did with Nunjucks).** Rejected: Compose files would no longer be valid Compose.
- **pongo2.** Rejected: Django syntax, not Jinja.
- **A configuration language (TypeScript, CUE, Pkl).** Rejected: the UI and the MCP server need to read and check the configuration as data.
