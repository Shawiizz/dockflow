# Configuration, version 1

A project is configured by three things, all in its repository ([ADR-0006](../adr/0006-compose-as-written.md)):

- **Compose files.** Standard Compose, with Dockflow's per-service settings under `x-dockflow`.
- **`dockflow.yml`.** At the project root.
- **One SOPS secrets file per environment.** Optional ([ADR-0012](../adr/0012-secrets-sops.md)).

Nothing else is read: no `.env` (that file is `docker compose`'s), no process variables except the declared `DOCKFLOW_SECRET_*` ones and the CLI's own settings (`DOCKFLOW_SSH_KEY*`, `SOPS_AGE_*`, `DOCKFLOW_AGENT_BINARY`).

## Names

| Name | Rule | Why |
|---|---|---|
| app | `^[a-z][a-z0-9-]{0,22}[a-z0-9]$` (at most 24) | Part of every Swarm object name |
| environment | `^[a-z][a-z0-9]{0,11}$` (at most 12, no hyphen or underscore) | Part of object names and of `DOCKFLOW_SSH_KEY_<ENV>` |
| stack | `<app>-<env>` (at most 37) | The Swarm namespace of an environment |
| service | `^[a-z][a-z0-9-]*$`, with `<stack>_<service>` at most 63 | Swarm service names are DNS labels |

## `dockflow.yml`

Every key is listed here. An unknown key is an error. There is no interpolation in this file.

```yaml
# dockflow.yml
version: 1                          # required; the format version
app: shop                           # required

compose: [compose.yml]              # optional; default: the first that exists of compose.yaml,
                                    # compose.yml, docker-compose.yaml, docker-compose.yml

registry:                           # optional; absent means the cluster registry (ADR-0009)
  url: ghcr.io/acme                 # host and namespace; images are <url>/<app>/<service>
  username: acme-bot
  password_secret: GHCR_TOKEN       # a key of the environment's secrets

build:
  builder: local                    # local (default) or remote (on a manager, ADR-0009)

hooks:                              # commands run on the CLI's machine, in the project directory
  before_build: ["npm run build:assets"]
  after_deploy: []
  after_failure: []

notify:                             # the agent POSTs the run.finished event to each URL
  - url: https://hooks.example.com/dockflow
    secret: WEBHOOK_SECRET          # HMAC-SHA256 key; signature in X-Dockflow-Signature

releases:
  keep: 10                          # releases kept per environment (default 10, minimum 2)

environments:                       # required; at least one
  production:
    managers:                       # required; at least one; tried in order
      - host: 203.0.113.10
        port: 22                    # default 22
        user: dockflow              # default dockflow
        host_key: "SHA256:Xq…"      # optional when the host is in known_hosts
      - host: 203.0.113.11
        host_key: "SHA256:Lm…"
    compose: [compose.yml, compose.prod.yml]   # optional; replaces the top-level list
    profiles: [web]                 # optional; Compose profiles to enable
    vars:                           # interpolation variables (strings)
      DOMAIN: shop.example.com
    secrets:
      file: secrets/production.sops.yaml   # default: secrets/<env>.sops.yaml when it exists
      env: [STRIPE_KEY]             # also read DOCKFLOW_SECRET_STRIPE_KEY from the process
    deploy:
      timeout: 20m                  # optional; replaces the computed timeout (ADR-0010)
    backups:                        # optional (ADR-0015)
      repository: s3:s3.eu-west-1.amazonaws.com/acme-backups/shop
      password_secret: RESTIC_PASSWORD
      env_secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]   # passed to restic as variables
      keep: { daily: 7, weekly: 4, monthly: 6 }

  staging:
    managers:
      - host: 10.0.0.9
    vars:
      DOMAIN: staging.shop.example.com
```

## Interpolation

Compose interpolation (`${VAR}`, `${VAR:-default}`, `${VAR:?message}`, `$$` for a literal `$`) is resolved by compose-go with this lookup, first match wins:

1. **Built-in variables:**

   | Variable | Value |
   |---|---|
   | `DOCKFLOW_APP` | the app name |
   | `DOCKFLOW_ENV` | the environment name |
   | `DOCKFLOW_STACK` | `<app>-<env>` |
   | `DOCKFLOW_VERSION` | the release's version label |
   | `DOCKFLOW_GIT_SHA` | the full commit |

2. **The environment's `vars`.**
3. **The environment's secrets** (the file, then the declared `env` keys).

The same key defined in both `vars` and secrets is an error.

A variable with no value and no default is an error, with or without `:?`.

> Interpolating `DOCKFLOW_VERSION` or `DOCKFLOW_GIT_SHA` into a service changes its spec on every commit, so that service is restarted by every deploy.

## Secrets file

```yaml
# secrets/production.sops.yaml, decrypted view (the committed file is encrypted by SOPS)
DB_PASSWORD: "…"
GHCR_TOKEN: "…"
RESTIC_PASSWORD: "…"
```

A flat map of keys matching `^[A-Z][A-Z0-9_]*$` to string values. Anything else is an error.

## `x-dockflow` on a service

```yaml
services:
  web:
    x-dockflow:
      routes:                        # ADR-0011
        - domains: [shop.example.com, www.shop.example.com]
          port: 3000                 # container port
          path: /                    # path prefix; default /
          tls: true                  # default true; false serves plain HTTP
      health:                        # ADR-0010; post-deploy check from inside the cluster
        http:
          path: /healthz
          port: 3000
          status: 200-399            # default 200-399
          timeout: 5s
          retries: 10
          interval: 3s
      stateful: false                # true for databases (ADR-0010)
      run: before                    # before or after: this service is a job run on each deploy
      backup:                        # ADR-0015
        type: postgres               # postgres, mysql, mongo, redis or volume
        database: shop               # dump types; default: the image's usual variable (POSTGRES_DB…)
        volumes: [pgdata]            # type volume only
        quiesce: true                # type volume only; default true
```

These combinations are refused:

| Combination | Why |
|---|---|
| `routes` or `health` with `run` | A job serves no traffic |
| `stateful` with `run` | A job is not a long-running service |
| `stateful` without a single-node placement on a multi-node cluster | A stateful service must not move between nodes |
| `backup` without `stateful` | Only stateful services hold data to back up |

## Compose support

Swarm and Compose don't cover the same ground. Every Compose key is in one of three groups.

**Supported:**

| Key | Handling |
|---|---|
| `image` | Required unless `build` is set. Built services get `<registry>/<app>/<service>`, and the plan pins the digest |
| `build` | buildx bake, every key ([ADR-0009](../adr/0009-images.md)) |
| `deploy` | Swarm: `mode`, `replicas`, `placement`, `resources`, `update_config`, `rollback_config`, `restart_policy`, `labels`, `endpoint_mode` |
| `healthcheck` | Swarm |
| `environment`, `env_file` | `env_file` paths are read by the CLI, relative to the Compose file |
| `secrets` | Swarm secrets, with `environment:` or `file:` sources ([ADR-0012](../adr/0012-secrets-sops.md)) |
| `configs` | Swarm configs, with `file:`, `content:` or `environment:` sources |
| `networks` | Overlay networks, attachable and encrypted ([ADR-0014](../adr/0014-networking-port-filter.md)). An `external: true` network must already exist |
| `volumes` | Named volumes become local volumes on the node that runs the task. Bind mounts are allowed with a warning, because the path must exist on that node |
| `ports` | Published in the routing mesh, or in `mode: host`. Recorded as public ports for the filter |
| `restart` | Converted to `deploy.restart_policy` when that is not set |
| `profiles`, `extends`, `include`, several files merged | Resolved by compose-go |
| `command`, `entrypoint`, `user`, `working_dir`, `labels`, `stop_grace_period`, `stop_signal`, `sysctls`, `ulimits`, `cap_add`, `cap_drop`, `tmpfs`, `init`, `hostname`, `extra_hosts`, `dns`, `dns_search`, `logging`, `read_only` | Passed to the service spec |

**Ignored, with a warning:**

| Key | Note |
|---|---|
| `depends_on` | Use health checks and jobs |
| `expose` | Informational in Compose |
| `name` | The stack name is always `<app>-<env>` |
| `x-*` other than `x-dockflow` | – |

**Refused, as an error:**

`container_name`, `links`, `network_mode`, `privileged`, `devices`, `pid`, `ipc`, `cgroup_parent`, `volumes_from`, `scale`, a port with `host_ip`.

## A complete example

```yaml
# compose.yml — runs as is with `docker compose up`
services:
  web:
    build: .
    environment:
      DATABASE_HOST: db
    secrets: [db_password]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 5s
    deploy:
      replicas: 2
    x-dockflow:
      routes: [{ domains: ["${DOMAIN}"], port: 3000 }]

  migrate:
    build: .
    command: ["npm", "run", "migrate"]
    secrets: [db_password]
    x-dockflow: { run: before }

  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
      POSTGRES_DB: shop
    secrets: [db_password]
    volumes: [pgdata:/var/lib/postgresql/data]
    deploy:
      placement: { constraints: ["node.labels.db == true"] }
    x-dockflow:
      stateful: true
      backup: { type: postgres }

secrets:
  db_password:
    environment: DB_PASSWORD        # from the shell locally, from the secrets file in Dockflow

volumes:
  pgdata: {}
```

```yaml
# dockflow.yml
version: 1
app: shop
environments:
  production:
    managers:
      - { host: 203.0.113.10, host_key: "SHA256:Xq…" }
    vars: { DOMAIN: shop.example.com }
    backups:
      repository: s3:s3.eu-west-1.amazonaws.com/acme-backups/shop
      password_secret: RESTIC_PASSWORD
      env_secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
      keep: { daily: 7, weekly: 4 }
```
