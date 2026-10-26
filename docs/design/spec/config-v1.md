# Configuration, version 1

A project is configured by three things, all in its repository ([ADR-0006](../adr/0006-compose-as-written.md)):

- **`dockflow.yml`** at the project root.
- **Compose files**, standard Compose with Dockflow's per-service settings under `x-dockflow`, wherever the project keeps them.
- **Secrets** from CI variables, a local `.env.dockflow` or an optional SOPS file ([ADR-0012](../adr/0012-secrets-sops.md)).

## Names

| Name | Rule | Why |
|---|---|---|
| app | `^[a-z][a-z0-9-]{0,22}[a-z0-9]$` (at most 24) | Part of every Swarm object name |
| environment | `^[a-z][a-z0-9]{0,11}$` (at most 12, no hyphen or underscore) | Part of object names and of variable names (`PRODUCTION_…`) |
| stack | `<app>-<env>` (at most 37) | The Swarm namespace of an environment |
| service | `^[a-z][a-z0-9-]*$`, with `<stack>_<service>` at most 63 | Swarm service names are DNS labels |
| secret and variable keys | `^[A-Z][A-Z0-9_]*$` | Valid in every CI provider |

## Interpolation

`${VAR}`, `${VAR:-default}`, `${VAR:?message}`, and `$$` for a literal `$`. It applies to:

- the Compose files;
- the string values of `dockflow.yml`, except names;
- the files listed under `templates:`;
- hook commands and scripts.

**Lookup**, first match wins:

1. **Built-in variables:**

   | Variable | Value |
   |---|---|
   | `DOCKFLOW_APP` | the app name |
   | `DOCKFLOW_ENV` | the environment name |
   | `DOCKFLOW_STACK` | `<app>-<env>` |
   | `DOCKFLOW_VERSION` | the release's version label |
   | `DOCKFLOW_GIT_SHA` | the full commit |
   | `DOCKFLOW_GIT_BRANCH` | the branch |

2. **Secrets.** For environment `production`, the key `X` is looked up as `PRODUCTION_X`, then as `X`, in each source in turn:
   1. process variables (only `PRODUCTION_*` ones) and the JSON in `DOCKFLOW_SECRETS`;
   2. `.env.dockflow`;
   3. the SOPS file.
3. **The environment's `vars`.**

A variable with no value and no default is an error.

> Interpolating `DOCKFLOW_VERSION` or `DOCKFLOW_GIT_SHA` into a service changes its spec on every commit, so that service is restarted by every deploy.

## `dockflow.yml`

Every key is listed here. An unknown key is an error.

```yaml
# dockflow.yml
version: 1                          # required; the format version
app: shop                           # required

compose: [compose.yml]              # optional; default: the first that exists of compose.yaml,
                                    # compose.yml, docker-compose.yaml, docker-compose.yml.
                                    # Several files are merged in order; an app with none is valid.

templates:                          # files rendered with interpolation before build and uploads
  - src: config/app.conf.tpl
    dest: config/app.conf           # relative to the project; a temporary copy, never the source tree
  - docker/entrypoint.sh            # rendered in place, in the temporary copy

registry:                           # optional; absent means the cluster registry (ADR-0009)
  url: ghcr.io/acme                 # images are <url>/<app>/<service>
  username: acme-bot
  password: ${GHCR_TOKEN}
  additional_tags: ["${DOCKFLOW_ENV}-latest"]

build:
  builder: local                    # local (default) or remote (on a manager)
  engine: docker                    # docker (default) or podman

releases:
  keep: 10                          # releases kept per environment (default 10, minimum 2)

on_failure: rollback                # rollback (default), fail or ignore (ADR-0008)

health:                             # public checks, after routes switch (ADR-0010)
  startup_delay: 15s
  endpoints:
    - name: site
      url: https://${DOMAIN}/
      method: GET                   # default GET
      expected_status: 200          # default 200
      timeout: 30s
      retries: 3
      retry_delay: 5s
      validate_certs: true

firewall:                           # ADR-0014
  public_ports:
    - 25565                         # tcp and udp, from anywhere
    - { port: 4326, protocol: tcp, from: [203.0.113.0/24] }

routes:                             # routes that don't target a service of this app (ADR-0011)
  - domains: [mohistmc.com]
    path: /maven
    redirect: https://maven.mohistmc.com/
  - domains: [mohistmc.com]
    path: /builds-raw
    files: { host_path: /mnt/mohist-archives, browse: true, node: main }

uploads:                            # ADR-0021
  - src: .
    dest: volume:site
    mirror: true
    exclude: [.git, .github, .dockflow]
  - src: deploy/rclone.service
    dest: /etc/systemd/system/rclone.service
    mode: "644"
    nodes: managers

hooks:                              # ADR-0022
  before_build:
    - run: ./scripts/generate-keys.sh
      secrets: [JWT_PRIVATE_KEY]
  before_deploy:
    - service: minecraft
      exec: ["/server/backup.sh", "deploy"]
      timeout: 10m
    - host: sudo systemctl daemon-reload
  after_deploy: []
  after_failure: []

notify:                             # webhooks, signed with HMAC-SHA256
  - url: https://hooks.example.com/dockflow
    on: [failure]                   # success, failure; default both
    secret: ${WEBHOOK_SECRET}
    headers: { X-Team: shop }
    timeout: 10s

backups:                            # ADR-0015; optional: without it, a local restic repository
  repository: s3:s3.eu-west-1.amazonaws.com/acme-backups/${DOCKFLOW_APP}
  password: ${RESTIC_PASSWORD}
  env:                              # passed to restic
    AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
    AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}

environments:                       # required; at least one
  production:
    # Servers: the PRODUCTION_CONNECTION secret (ADR-0013), or nodes listed here
    nodes:                          # optional when the connection string exists
      - { host: 203.0.113.10, port: 22, user: dockflow, role: manager, host_key: "SHA256:Xq…" }
    compose: [compose.yml, compose.prod.yml]   # optional; replaces the top-level list
    profiles: [web]                 # optional Compose profiles
    vars:
      DOMAIN: shop.example.com
    secrets_file: secrets/production.sops.yaml # default: that path when it exists
    deploy:
      timeout: 20m                  # optional; replaces the computed timeout
    ci:
      tag_suffix: ""                # tags selecting this environment: "" = bare versions (1.2.0),
                                    # "staging" = 1.2.0-staging. Default: "" for production,
                                    # the environment's name for the others
  staging:
    vars:
      DOMAIN: staging.shop.example.com
```

Every top-level key except `version`, `app`, `compose` and `environments` can also be set inside an environment, where it replaces the top-level value for that environment.

## `x-dockflow` on a service

```yaml
services:
  web:
    x-dockflow:
      routes:                        # ADR-0011
        - domains: [shop.example.com, www.shop.example.com]
          port: 3000                 # container port
          path: /                    # default /
          strip_prefix: false
          tls: true                  # default true
          headers:
            X-Frame-Options: DENY
            -Server: ""              # a leading "-" removes a header
          encode: [zstd, gzip]
          max_body: 25MB
          timeouts: { read: 90s, dial: 10s }
          error_pages: { "502,503,504": { route: maintenance } }
          auth: { user: admin, password: ${PANEL_PASSWORD} }
          caddy: |                   # raw Caddyfile directives, the escape hatch
            @ws header Connection *Upgrade*
            reverse_proxy @ws {upstream}:4327
      health:                        # internal check, after convergence (ADR-0010)
        http:
          path: /healthz
          port: 3000
          status: 200-399
          timeout: 5s
          retries: 10
          interval: 3s
      stateful: false                # true for databases (ADR-0010)
      run: before                    # before or after: this service is a job
      backup:                        # ADR-0015; stateful services only
        type: postgres               # postgres, mysql, mongo, redis, volume or command
        database: shop
        dump_options: "--no-owner"
        volumes: [pgdata]            # volume type
        quiesce: { exec: { pre: ["rcon-cli", "save-off"], post: ["rcon-cli", "save-on"] } }
        dump: ["sh", "-c", "my-dump"]       # command type
        restore: ["sh", "-c", "my-restore"] # command type
        keep: { last: 24, daily: 30, weekly: 26 }
```

These combinations are refused:

| Combination | Why |
|---|---|
| `routes` or `health` with `run` | A job serves no traffic |
| `stateful` with `run` | A job is not a long-running service |
| `stateful` without a single-node placement on a multi-node cluster | A stateful service must not move between nodes |
| `backup` without `stateful` | Only stateful services hold data to back up |

## Compose support

Every Compose key falls in one of three groups.

**Supported:**

| Key | Handling |
|---|---|
| `image` | Required unless `build` is set. Built services get `<registry>/<app>/<service>`, and the plan pins the digest |
| `build` | buildx bake, every key; Podman builds use `context`, `dockerfile`, `args`, `target` and `secrets` ([ADR-0009](../adr/0009-images.md)) |
| `deploy` | Swarm: `mode`, `replicas`, `placement`, `resources`, `update_config`, `rollback_config`, `restart_policy`, `labels`, `endpoint_mode` |
| `healthcheck` | Swarm |
| `environment`, `env_file` | `env_file` paths are read by the CLI, relative to the Compose file |
| `secrets` | Swarm secrets, with `environment:` or `file:` sources ([ADR-0012](../adr/0012-secrets-sops.md)) |
| `configs` | Swarm configs, with `file:`, `content:` or `environment:` sources |
| `networks` | Overlay networks, attachable and encrypted. `external: true` for the cluster's shared networks ([ADR-0018](../adr/0018-shared-clusters.md)); `aliases` supported |
| `volumes` | Named volumes, with `driver` and `driver_opts` for volume plugins. Bind mounts are allowed with a warning, because the path must exist on the node |
| `ports` | Published in the routing mesh, or `mode: host` (preferred for game servers: client IP, UDP). Open to the internet only when listed in `firewall.public_ports` |
| `restart` | Converted to `deploy.restart_policy` when that is not set |
| `profiles`, `extends`, `include`, several files merged | Resolved by compose-go |
| `command`, `entrypoint`, `user`, `working_dir`, `labels`, `stop_grace_period`, `stop_signal`, `sysctls`, `ulimits`, `cap_add`, `cap_drop`, `tmpfs`, `init`, `hostname`, `extra_hosts`, `dns`, `dns_search`, `logging`, `read_only` | Passed to the service spec |

**Ignored, with a warning:**

| Key | Note |
|---|---|
| `depends_on` | Use health checks and jobs |
| `expose` | Informational in Compose |
| `container_name` | Swarm names containers itself |
| `name` | The stack name is always `<app>-<env>` |
| `x-*` other than `x-dockflow` | – |

**Refused, as an error:**

`links`, `network_mode`, `privileged`, `devices`, `pid`, `ipc`, `cgroup_parent`, `volumes_from`, `scale`, a port with `host_ip`.

## Migrating a 1.x project by hand

| 1.x | v2 |
|---|---|
| `.dockflow/config.yml` + `servers.yml` | `dockflow.yml` |
| `{{ current.env.x }}` | `${X}` |
| `{{ x \| default('y') }}` | `${X:-y}` |
| `{{ env }}`, `{{ project_name }}` | `${DOCKFLOW_ENV}`, `${DOCKFLOW_APP}` |
| `accessories.yml` | A Compose file listed under `compose:`, its services marked `stateful` |
| The `nginx` plugin and its vhost | `x-dockflow.routes` and `routes:` |
| `<ENV>_<SERVER>_CONNECTION` | `dockflow server connection <env>`, stored as `<ENV>_CONNECTION` |
| `health_checks.endpoints` with `remote: true` | `x-dockflow.health.http` |
| `health_checks.endpoints` with a public URL | `health.endpoints` |
| `hooks.pre-deploy` running `docker exec` | `hooks.before_deploy` with `exec` |
| Secrets in CI | Unchanged; per-server prefixes (`PRODUCTION_MANAGER_X`) become `PRODUCTION_X` |

## A complete example

The ValientRP backend in v2:

```yaml
# compose.yml
services:
  backend:
    build: .
    environment:
      QUARKUS_DATASOURCE_JDBC_URL: jdbc:postgresql://postgres:5432/valientrp
      QUARKUS_DATASOURCE_USERNAME: valientrp
      QUARKUS_DATASOURCE_PASSWORD: ${DB_PASSWORD}
      GAME_SERVER_API_KEY: ${GAME_SERVER_API_KEY}
      BLUEMAP_URL: http://valientrp-minecraft:8100
    networks: [default, valientrp]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/q/health"]
      start_period: 40s
    x-dockflow:
      routes:
        - domains: [api-valientrp.shawiizz.dev]
          port: 8081
          max_body: 25MB
          headers: { X-Frame-Options: DENY, X-Content-Type-Options: nosniff }

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: valientrp
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: valientrp
    volumes: [postgres_data:/var/lib/postgresql/data]
    networks:
      default: {}
      valientrp: { aliases: [valientrp-db] }
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U valientrp -d valientrp"]
    x-dockflow:
      stateful: true
      backup: { type: postgres, keep: { daily: 14, weekly: 8 } }

networks:
  valientrp: { external: true }   # dockflow cluster network create valientrp

volumes:
  postgres_data: {}
```

```yaml
# dockflow.yml
version: 1
app: valientrp-backend
hooks:
  before_build:
    - script: .dockflow/hooks/pre-build.sh
      secrets: [JWT_PRIVATE_KEY]
environments:
  production: {}       # servers in PRODUCTION_CONNECTION, secrets in CI
```
