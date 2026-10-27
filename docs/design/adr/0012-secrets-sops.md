# ADR-0012: Secrets: CI variables, a local file, optionally SOPS; delivered by interpolation or as secret files

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (CI secrets as in 1.x, after review by the project owner), revised 2026-10-27 (root-only copies of secret files, by decision of the project owner)

## Context

Dockflow 1.x reads secrets from three places:

- process variables in CI, usually all the repository's secrets at once through `DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}`;
- a local `.env.dockflow`;
- a JSON variable.

A secret named `PRODUCTION_X` overrides the value `X` of the production environment. Its values can be used anywhere a template can, in particular in the `environment:` of a Compose service. Real projects rely on this (ValientRP, MohistMC), and the project owner wants it kept.

Its weak points:

- variable names are derived from server names, so `web-1` gives a name CI providers refuse;
- an undefined variable renders as an empty string;
- values reach containers only as plain text in the rendered Compose file, which is kept in a file on the server.

## Decision

### Where secrets come from

From highest to lowest priority:

1. **Process variables:** the variables prefixed with the environment's name (`PRODUCTION_*` for `production`), and the content of `DOCKFLOW_SECRETS`, a JSON object (typically `${{ toJSON(secrets) }}` in GitHub Actions). Other process variables (`PATH`, `HOME`, …) are never read.
2. **`.env.dockflow`** at the project root, for local use. `dockflow init` adds it to `.gitignore`.
3. **An optional SOPS file per environment** (`secrets/<env>.sops.yaml`, encrypted with age), for teams that want their secrets versioned and reviewed in git. The CLI decrypts it in memory with the SOPS library.

**Scoping.** For environment `production`, the key `X` resolves to `PRODUCTION_X` when it exists, otherwise to `X`. One repository can therefore hold `DB_PASSWORD` for every environment and `PRODUCTION_DB_PASSWORD` for production only, as in 1.x. Per-server scoping (`PRODUCTION_<SERVER>_X`) returns with several servers ([ADR-0023](0023-several-servers-later.md)).

**Override.** Secrets override the environment's `vars` in `dockflow.yml`, so a non-secret default in `vars` (`RCON_PASSWORD: changeme`) is replaced by the CI secret of the same name.

**Names.** Keys are `^[A-Z][A-Z0-9_]*$`. Secret names never depend on server names, so they are always valid in GitHub and GitLab.

### Where secrets can be used

Everywhere interpolation applies ([ADR-0006](0006-compose-as-written.md)):

- in Compose (`environment:`, `build.args`, labels, …), as in 1.x;
- in `dockflow.yml`;
- in the files listed under `templates:`;
- in hooks.

There are two ways to hand a secret to a container:

1. **Interpolation**, `${DB_PASSWORD}` in `environment:`. This is what 1.x does and what most images expect. The value sits in the container's configuration, readable by anyone with Docker access, and in the release record under `/var/lib/dockflow`, readable by root only.
2. **Compose `secrets:`**, with source `environment: DB_PASSWORD`. The value is written to a file on a tmpfs, `/run/dockflow/secrets/<stack>/<name>-<hash12>`, readable by root only, and mounted read-only at `/run/secrets/<name>`, as Compose itself does. It does not appear in `docker inspect`, nor in the container's environment. A copy is kept in the app's state directory, `0600`, readable by root only like the release records that hold interpolated values: without it, a reboot would leave the services that mount a secret stopped until the next deploy, since the values exist only in the CI. The documentation recommends it for anything sensitive, and shows the `*_FILE` variables that official images (Postgres, MySQL, …) support.

**At build time**, Compose `build.secrets` (handled by bake) pass a secret to a build without leaving it in the image history. `build.args` still work, as in 1.x.

### Masking

Every output Dockflow shows or stores masks the values of the environment's secrets, as GitHub Actions does: events, build and hook output, job logs, errors and `config show`. This covers the cases 1.x's e2e suite checks (no secret in the CLI's output or in the nodes' process lists), plus everything the agent emits. Secrets never appear in a command line.

### Rotation

Changing a secret used through Compose `secrets:` changes its hash: a new secret file is written, the services move to it in the normal rollout, and the old one is removed once no retained release references it. `dockflow secrets revoke <env> <KEY>` removes old versions at once. The tmpfs is emptied by a reboot: the watchdog writes the files of the current releases again from their copies, and a rollback finds the files of its release the same way. Revoking or pruning a file deletes its copy.

### Commands

`dockflow secrets list <env>` lists keys with their source, never their values. `dockflow secrets set` and `dockflow secrets edit` work on the SOPS file when the environment uses one.

### Implementation (M3)

The CLI reads and writes the SOPS format itself, for age recipients, on age's library (`filippo.io/age`), instead of linking the SOPS library: with its key services for AWS, GCP, Azure, Vault and PGP, the library takes the binary from 28 MB to 64 MB and adds 341 modules, and the same binary is the agent every server downloads ([ADR-0002](0002-go.md), [ADR-0020](0020-releasing-dockflow.md)). The files stay those of the `sops` command, which reads what Dockflow writes and the reverse (checked against `sops` 3.13 in `internal/sopsfile`):

- a flat map of scalar values: the values are AES-256-GCM `ENC[…]` strings with the key's path as additional data, the data key is age-encrypted for each recipient, and the MAC (SHA-512 over the values, encrypted with `lastmodified`) is checked on every read; `unencrypted_suffix`, `encrypted_suffix` and the two regexes are honoured;
- refused: nested values, key groups (Shamir) and files without an age recipient;
- the age keys are those `sops` uses: `SOPS_AGE_KEY`, `SOPS_AGE_KEY_FILE`, then the user's `sops/age/keys.txt`;
- a new file's recipients come from `--age` or `.sops.yaml`'s `creation_rules`; `secrets set` and `secrets edit` drop the file's comments.

`dockflow secrets revoke <env> <name>` names a Compose secret: it deletes the files of that secret that the current release does not use.

## Consequences

- The 1.x workflow is unchanged: `DOCKFLOW_SECRETS: ${{ toJSON(secrets) }}` in CI, `.env.dockflow` locally, `${KEY}` in Compose.
- A missing secret is an error, not an empty string ([ADR-0006](0006-compose-as-written.md)). An optional value is written `${KEY:-}`.
- Secrets used through `${…}` are as visible as any environment variable. Compose `secrets:` are not.

## Alternatives considered

- **SOPS only, with process variables declared one by one (first draft of this ADR).** Rejected by the project owner: it breaks the 1.x workflow of passing all CI secrets at once.
- **External managers (1Password, Infisical, Vault).** Deferred.
