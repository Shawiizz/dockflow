# ADR-0012: Secrets: CI variables, a local file, optionally SOPS; delivered by interpolation or as Swarm secrets

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (CI secrets as in 1.x, after review by the project owner)

## Context

Dockflow 1.x reads secrets from three places:

- process variables in CI, usually all the repository's secrets at once through `DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}`;
- a local `.env.dockflow`;
- a JSON variable.

A secret named `PRODUCTION_X` overrides the value `X` of the production environment. Its values can be used anywhere a template can, in particular in the `environment:` of a Compose service. Real projects rely on this (ValientRP, MohistMC), and the project owner wants it kept.

Its weak points:

- variable names are derived from server names, so `web-1` gives a name CI providers refuse;
- an undefined variable renders as an empty string;
- values reach containers only as plain text in the rendered Compose file, which is kept in a file on the manager.

## Decision

### Where secrets come from

From highest to lowest priority:

1. **Process variables:** the variables prefixed with the environment's name (`PRODUCTION_*` for `production`), and the content of `DOCKFLOW_SECRETS`, a JSON object (typically `${{ toJSON(secrets) }}` in GitHub Actions). Other process variables (`PATH`, `HOME`, …) are never read.
2. **`.env.dockflow`** at the project root, for local use. `dockflow init` adds it to `.gitignore`.
3. **An optional SOPS file per environment** (`secrets/<env>.sops.yaml`, encrypted with age), for teams that want their secrets versioned and reviewed in git. The CLI decrypts it in memory with the SOPS library.

**Scoping.** For environment `production`, the key `X` resolves to `PRODUCTION_X` when it exists, otherwise to `X`. One repository can therefore hold `DB_PASSWORD` for every environment and `PRODUCTION_DB_PASSWORD` for production only, as in 1.x.

**Override.** Secrets override the environment's `vars` in `dockflow.yml`, so a non-secret default in `vars` (`RCON_PASSWORD: changeme`) is replaced by the CI secret of the same name.

**Names.** Keys are `^[A-Z][A-Z0-9_]*$`. Secret names never depend on server names, so they are always valid in GitHub and GitLab.

### Where secrets can be used

Everywhere interpolation applies ([ADR-0006](0006-compose-as-written.md)):

- in Compose (`environment:`, `build.args`, labels, …), as in 1.x;
- in `dockflow.yml`;
- in the files listed under `templates:`;
- in hooks.

There are two ways to hand a secret to a container:

1. **Interpolation**, `${DB_PASSWORD}` in `environment:`. This is what 1.x does and what most images expect. The value sits in the service spec, readable by anyone with Docker access, and in the release record (Swarm Raft, encrypted at rest).
2. **Compose `secrets:`**, with source `environment: DB_PASSWORD`. The value becomes a Swarm secret named `<stack>_secret_<hash12>`, mounted at `/run/secrets/<name>`, encrypted in Raft and not readable through the API. The documentation recommends it for anything sensitive, and shows the `*_FILE` variables that official images (Postgres, MySQL, …) support.

**At build time**, Compose `build.secrets` (handled by bake) pass a secret to a build without leaving it in the image history. `build.args` still work, as in 1.x.

### Rotation

Changing a secret used through Compose `secrets:` changes its hash: a new Swarm secret is created, the services move to it in the normal rollout, and the old one is removed once no retained release references it. `dockflow secrets revoke <env> <KEY>` removes old versions at once.

### Commands

`dockflow secrets list <env>` lists keys with their source, never their values. `dockflow secrets set` and `dockflow secrets edit` work on the SOPS file when the environment uses one.

## Consequences

- The 1.x workflow is unchanged: `DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}` in CI, `.env.dockflow` locally, `${KEY}` in Compose.
- A missing secret is an error, not an empty string ([ADR-0006](0006-compose-as-written.md)). An optional value is written `${KEY:-}`.
- Secrets used through `${…}` are as visible as any environment variable. Compose `secrets:` are not.

## Alternatives considered

- **SOPS only, with process variables declared one by one (first draft of this ADR).** Rejected by the project owner: it breaks the 1.x workflow of passing all CI secrets at once.
- **External managers (1Password, Infisical, Vault).** Deferred.
