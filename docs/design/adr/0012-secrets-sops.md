# ADR-0012: Secrets: SOPS and age, delivered as Swarm secrets

- Status: Accepted
- Date: 2026-10-25

## Context

In Dockflow 1.x, secrets reach the CLI through `.env.dockflow`, a JSON variable or process variables whose names derive from server names. A server named `web-1` therefore needs a variable that GitHub and GitLab refuse. They reach containers as plain text in the rendered Compose file, which is stored in the release directory on the manager.

## Decision

### Where secrets are kept

- **A SOPS file per environment:** `secrets/<env>.sops.yaml` by default, holding a flat map of `KEY: value`.
  - It is encrypted with age, and the recipients are declared in the repository's standard `.sops.yaml`.
  - It is committed: secret changes are versioned and reviewed like code.
  - The CLI decrypts it in memory with the SOPS Go library, using SOPS's own locations for the age identity (`SOPS_AGE_KEY`, `SOPS_AGE_KEY_FILE`, the default key file). In CI that is one repository secret per environment, or one for all.
- **Declared process variables:** for teams that keep secrets in their CI only, an environment can list keys under `secrets.env`. Each listed key is read from `DOCKFLOW_SECRET_<KEY>`. Only listed keys are read.
- `dockflow secrets set <env> <KEY>` (value read from stdin) and `dockflow secrets list <env>` manage the file. `dockflow secrets edit <env>` delegates to the `sops` binary when it is installed.

### How they reach containers

1. **Compose `secrets:` (preferred).** A Compose secret whose source is `environment: KEY` becomes a Swarm secret named `<stack>_<name>_<hash8>`, where the hash covers the value. It is mounted at `/run/secrets/<name>`, encrypted in Raft and not readable through the API. Locally, `docker compose` reads the same `KEY` from the shell, so the file works on a laptop as is.
2. **Interpolation.** `${KEY}` anywhere in Compose resolves to the secret value. The value then sits in the service spec, readable by anyone with Docker access, and in the release record. This is allowed because many images only read environment variables, and the documentation says what it exposes.

The same file holds the credentials Dockflow itself needs: the registry, restic, webhook signing.

### Rotation

Changing a value changes its hash, so a new Swarm secret is created, services move to it in the normal rollout, and the old one is removed once no retained release references it. `dockflow secrets revoke <env> <KEY>` removes old versions at once, at the cost of making older releases impossible to roll back to.

## Consequences

- Secret names never depend on server or environment names.
- Secrets never touch a server's file system outside Swarm's own encrypted store.
- Teams need age keys. The docs cover creating one and storing it in CI.
- Values in `${…}` are as visible as any environment variable. The documentation recommends Compose `secrets:` for anything sensitive.

## Alternatives considered

- **CI variables only.** Kept as the declared-keys fallback, not as the main path.
- **External managers (1Password, Infisical, Vault).** Deferred. SOPS supports cloud KMS keys already. Direct integrations may come behind their own ADR.
