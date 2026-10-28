# Configuration, version 1

A project is configured by three things, all in its repository ([ADR-0006](../adr/0006-compose-as-written.md)):

- **`dockflow.yml`** at the project root.
- **Compose files**, standard Compose with Dockflow's per-service settings under `x-dockflow`, wherever the project keeps them.
- **Secrets** from CI variables, a local `.env.dockflow` or an optional SOPS file ([ADR-0012](../adr/0012-secrets-sops.md)).

## Names

| Name | Rule | Why |
|---|---|---|
| app | `^[a-z][a-z0-9-]{0,22}[a-z0-9]$` (at most 24) | Part of every container, network and volume name |
| environment | `^[a-z][a-z0-9]{0,11}$` (at most 12, no hyphen or underscore) | Part of object names and of variable names (`PRODUCTION_…`) |
| stack | `<app>-<env>` (at most 37) | The Compose project name of an environment |
| service | `^[a-z0-9][a-z0-9_.-]{0,62}$`, Compose's own rule | Compose files are used as written; a service is reached by its name inside the app's networks |
| secret and variable keys | `^[A-Z][A-Z0-9_]*$` | Valid in every CI provider |

## Variables and templating

Two syntaxes, each where it is native ([ADR-0006](../adr/0006-compose-as-written.md)):

| Where | Syntax |
|---|---|
| Compose files, and the string values of `dockflow.yml` except names and `vars` | Compose interpolation: `${VAR}`, `${VAR:-default}`, `${VAR:?message}`, `$$` for a literal `$`. The values of `vars` are literal: a variable is never defined from another |
| Files listed under `templates:`, upload sources rendered as templates, plugin templates | Jinja (gonja), with undefined variables as errors: `{{ VAR }}`, `{{ VAR \| default('x') }}`, `{% if %}`, `{% for %}`, `{% raw %}` |
| Hook commands | Not interpolated: values arrive as environment variables |

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
   | `DOCKFLOW_SERVER` | the server's name |

2. **Secrets.** For environment `production`, the key `X` is looked up as `PRODUCTION_X`, then `X`, in each source in turn:
   1. process variables (only `PRODUCTION_*` ones) and the JSON in `DOCKFLOW_SECRETS`;
   2. `.env.dockflow`;
   3. the SOPS file.
3. **The environment's `vars`.**

An environment is one server in v1, so its values are that server's. Per-server overrides come with several servers ([ADR-0023](../adr/0023-several-servers-later.md)).

A variable with no value and no default is an error, in both syntaxes. In `dockflow.yml`, only what the environment uses is interpolated: other environments' sections, and the top-level keys the environment overrides, may use variables it does not define.

> Interpolating `DOCKFLOW_VERSION` or `DOCKFLOW_GIT_SHA` into a service changes its spec on every commit, so that service is restarted by every deploy.

## `dockflow.yml`

Every key is listed here. An unknown key is an error.

```yaml
# dockflow.yml
version: 1                          # required; the format version
requires: "1.2"                     # optional; the oldest Dockflow that reads this file, as
                                    # major.minor or major.minor.patch: an older one stops
                                    # with config.newer and asks for an upgrade
app: shop                           # required

compose: [compose.yml]              # optional; default: the first that exists of compose.yaml,
                                    # compose.yml, docker-compose.yaml, docker-compose.yml.
                                    # Several files are merged in order; an app with none is valid.

templates:                          # files rendered with Jinja before build and uploads
  - src: config/app.conf.tpl
    dest: config/app.conf           # relative to the project; a temporary copy, never the source tree
  - docker/entrypoint.sh            # rendered in place, in the temporary copy

registry:                           # optional; absent means the server-local registry (ADR-0009)
  url: ghcr.io/acme                 # images are <url>/<app>/<service>
  username: acme-bot
  password: ${GHCR_TOKEN}
  additional_tags: ["${DOCKFLOW_ENV}-latest"]

build:
  builder: local                    # local (default) or remote (on the server)
  engine: docker                    # docker (default) or podman; podman builds locally only

releases:
  keep: 10                          # releases kept per environment (default 10, minimum 2)

on_failure: rollback                # rollback (default), fail or ignore (ADR-0008)

health:                             # public checks, run by the agent after the switch (ADR-0010)
  startup_delay: 15s                # default 0
  endpoints:
    - name: site
      url: https://${DOMAIN}/
      method: GET                   # default GET
      expected_status: 200          # default 200
      timeout: 30s                  # default 30s
      retries: 3                    # default 3
      retry_delay: 5s               # default 5s
      validate_certs: true          # default true

firewall:                           # ADR-0014
  public_ports:
    - 25565                         # tcp and udp, from anywhere
    - { port: 4326, protocol: tcp, from: [203.0.113.0/24] }

routes:                             # routes that don't target a service of this app (ADR-0011):
                                    # exactly one of redirect (with status, default 308), proxy
                                    # (an http(s) URL without a path; network: a shared network to
                                    # join) and files (host_path or volume, browse; the path is
                                    # stripped); name: for error_pages; and every route option
  - domains: [mohistmc.com]
    path: /maven
    redirect: https://maven.mohistmc.com/
  - domains: [mohistmc.com]
    path: /builds-raw
    files: { host_path: /mnt/mohist-archives, browse: true }

uploads:                            # ADR-0021
  - src: .
    dest: volume:site
    mirror: true
    exclude: [.git, .github, .dockflow]
  - src: deploy/rclone.service
    dest: /etc/systemd/system/rclone.service
    mode: "644"                     # owner: "1000" or "1000:1000", numeric

plugins:                            # ADR-0017
  - use: nginx                      # built-in; needs `server init --nginx --edge external`
    with: { domain: "${DOMAIN}", cloudflare: true }   # proxies to the switch; or template: deploy/nginx/api.conf
  - use: ./deploy/plugins/rclone    # the project's own
    id: archives
    with: { remote: "ovhs3:archives" }

hooks:                              # ADR-0022; commands (run, host, exec) are not interpolated
  before_build:
    - run: ./scripts/generate-keys.sh   # gets JWT_PRIVATE_KEY as an environment variable
      secrets: [JWT_PRIVATE_KEY]
  before_deploy:
    - service: minecraft
      exec: ["/server/backup.sh", "deploy"]
      timeout: 10m
    - host: sudo systemctl daemon-reload
  after_build: []                    # also: name, timeout (default 5m), fatal (default true for before_*),
  after_deploy: []                   # script: <file> instead of run, run locally; rendered first when
                                     # templates: lists it
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
    # The server: the PRODUCTION_CONNECTION secret (ADR-0013), or described here
    server:                         # optional when the connection string exists
      { name: main, host: 203.0.113.10, port: 22, user: dockflow, host_key: "SHA256:Xq…" }
                                    # host may be a Host alias of ~/.ssh/config: its HostName, and
                                    # its Port, User and IdentityFile where server: sets none;
                                    # then port 22 and user dockflow
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

Durations are written as Go durations: `30s`, `2m`, `1h30m`. File modes are octal strings: `"0644"` or `"644"`.

`version` and `requires` are read before any other key. A file in a format version other than 1, or that requires a later Dockflow, stops with `config.newer` (exit 3) and the hint to upgrade, rather than with an unknown key. A development build (`dev`) does not check `requires`.

Every top-level key except `version`, `requires`, `app`, `compose` and `environments` can also be set inside an environment, where it replaces the top-level value for that environment.

## `plugin.yml`

A plugin ([ADR-0017](../adr/0017-plugins.md)) is a directory with a `plugin.yml`; `use:` names a built-in plugin (`nginx`, `systemd`) or a directory of the project (a path, with a `/`). Unknown keys are refused.

```yaml
name: rclone                        # default: the directory's name; the default id of a use
description: An rclone mount
inputs:
  - name: remote                    # ^[a-z][a-z0-9_]*$; id is reserved
    description: the rclone remote
    type: string                    # string (default), boolean, list, or file
    required: true                  # or required_unless: <another input>, required when that one is not given
  - name: mount
    default: /mnt/archives
templates:                          # files of the plugin, rendered with Jinja
  - rclone.service                  # in place; or { src, dest }
uploads:                            # as in dockflow.yml; src is a path of the plugin
  - src: rclone.service
    dest: "/etc/systemd/system/rclone-{{ id }}.service"
hooks:                              # as in dockflow.yml, without script
  after_deploy:
    - host: sudo systemctl restart rclone-{{ id }}
      if_changed: "/etc/systemd/system/rclone-{{ id }}.service"   # after_deploy only: runs when
                                    # the deploy changed that upload of the plugin
```

- **Values.** A `string` input takes a scalar (empty when not given), a `boolean` `true` or `false` (also as a string; `false` when not given), a `list` a list of scalars or one scalar (empty when not given). A `file` input names a file of the project, copied into the plugin at `inputs/<input>/<file name>`, which is the input's value.
- **Rendering.** The string values of `templates`, `uploads` and `hooks` are Jinja templates rendered with the inputs, `id`, the built-in variables and `vars`; a value that renders to `true` is a boolean again. Template files also see the secrets. Undefined variables are errors.
- **Expansion.** At load time, in the order of `plugins:`, before the project's own: uploads keep their plugin (`plugin` in the release record's uploads, and in the plan), hooks are named `<id>: <name>`.

## `x-dockflow` on a service

Its keys are matched exactly, lowercase as below: an unknown key, or one in another case (`Stateful`), is an error.

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
      rollout:                       # ADR-0010; default: switch if routed, start-first otherwise,
        strategy: switch             # stop-first if stateful; switch, start-first or stop-first
        drain: 30s                   # switch only: time given to requests in flight
      health:                        # ADR-0010
        grace: 10s                   # without a HEALTHCHECK: running this long counts as healthy
        restart_after: 2m            # the watchdog restarts the container after this long unhealthy; 0 never
        http:                        # internal check, before the switch
          path: /healthz             # default /
          port: 3000                 # default: the first route's port
          status: 200-399            # default 200-399; or one status
          timeout: 5s                # defaults: 5s, 10 retries, 3s apart
          retries: 10
          interval: 3s
      stateful: false                # true for databases (ADR-0010)
      run: before                    # before or after: this service is a job (or use Compose's
                                     # depends_on with condition: service_completed_successfully)
      backup:                        # ADR-0015; stateful services only
        type: postgres               # postgres, mysql, mongo, redis, volume or command
        database: shop
        dump_options: "--no-owner"   # split on spaces
        volumes: [pgdata]            # volume type
        quiesce: { exec: { pre: ["rcon-cli", "save-off"], post: ["rcon-cli", "save-on"] } }
        dump: ["sh", "-c", "my-dump"]       # command type
        restore: ["sh", "-c", "my-restore"] # command type
        keep: { last: 24, daily: 30, weekly: 26 }
```

These combinations are refused:

| Combination | Why |
|---|---|
| `routes` or `health.http` with `run` | A job serves no traffic |
| `stateful` with `run` | A job is not a long-running service |
| `stateful` with `deploy.replicas` above 1 | A stateful service runs once |
| `rollout.strategy: switch` without `routes` | Nothing to switch |
| `backup` without `stateful` | Only stateful services hold data to back up |

## Compose support

Docker runs Compose on one host, and so does Dockflow ([ADR-0003](../adr/0003-single-host-docker.md)): every key `docker compose up` supports is supported, with these specifics. Keys that would break when a release replaces the containers are refused, with the reason; the few keys not supported yet are listed at the end of the table.

| Key | Handling |
|---|---|
| `image` | Required unless `build` is set. Built services get `<app>/<service>` (or the external registry's name), and the plan pins the digest |
| `build` | buildx bake, every key bake supports, interpolated by Dockflow. `secrets` are mounted with `RUN --mount=type=secret`, their values handed to the builder through its environment; `isolation`, `ulimits`, `provenance` and `sbom` are refused; `platforms` and `tags` are ignored with a warning, because images are built for the server and tagged by Dockflow. Podman builds use `context`, `dockerfile`, `dockerfile_inline`, `args`, `labels`, `additional_contexts`, `target`, `cache_from`, `cache_to`, `no_cache`, `pull`, `network`, `extra_hosts`, `ssh` and `shm_size` ([ADR-0009](../adr/0009-images.md)) |
| `deploy.replicas` | n containers per service |
| `deploy.resources`, `deploy.restart_policy` | Container limits and restart policy, as Compose applies them |
| `deploy.update_config.order` | `start-first` or `stop-first` strategy ([ADR-0010](../adr/0010-rollout-health-jobs.md)) |
| `deploy.placement`, `deploy.endpoint_mode`, `deploy.rollback_config` | Ignored with a warning: one server, and Dockflow rolls back the whole app |
| `deploy.mode: global` | One container, with a warning |
| `deploy.resources.reservations` | `memory` applied; `devices` as device requests; `cpus` ignored with a warning, since Docker reserves no CPU outside Swarm |
| `pull_policy` | `missing`, `if_not_present`, `build`, `always`, `never`; `daily`, `weekly` and `every_<duration>` pull at every deploy, with a warning |
| `restart` | Honoured. A service without `restart` or `deploy.restart_policy` gets `unless-stopped` |
| `depends_on` | Honoured, with its conditions: ordering, and jobs for `service_completed_successfully` |
| `healthcheck` | Gates every strategy |
| `container_name` | Honoured; forces `stop-first` and a single replica |
| `ports` | Honoured, host IP included (`127.0.0.1:5432:5432`). Open to the internet only when listed in `firewall.public_ports` ([ADR-0014](../adr/0014-networking-port-filter.md)). A service publishing fixed host ports uses `stop-first`, since two containers cannot hold the same port |
| `secrets` | Files on a tmpfs mounted at `/run/secrets/<name>` (or `target`, with `uid`, `gid`, `mode`), with `environment:` or `file:` sources ([ADR-0012](../adr/0012-secrets-sops.md), [state-v1](state-v1.md)). External secrets and drivers belong to Swarm: refused |
| `configs` | Files mounted read-only at `/<name>` (or `target`), with `file:`, `content:` or `environment:` sources |
| `networks` | Bridge networks, aliases included. `external: true` for the server's shared networks ([ADR-0018](../adr/0018-shared-servers.md)) |
| `network_mode` | `host`, `none`, `bridge`. A service on the host network cannot be routed by the switch and uses `stop-first`. `service:…` and `container:…` are refused: each release replaces the containers, and a container joined to another's network namespace would lose it at the other's next deploy |
| `volumes_from` | Refused, for the same reason |
| `links` | Orders the services, as `depends_on`; a link with an alias is refused (aliases go under `networks`) |
| `volumes` | Named volumes (`nocopy`, `subpath`), `driver` and `driver_opts` for volume plugins, bind mounts of an absolute path on the server (`create_host_path`, `propagation`; `selinux` is refused, since the Engine API's mounts cannot relabel). A relative bind source (`./data`) is a path of the machine running the CLI and is refused: use a named volume or `uploads` |
| `environment`, `env_file` | `env_file` paths are read by the CLI, relative to the Compose file |
| `profiles`, `extends`, `include`, several files merged | Resolved by compose-go. Relative paths (`build.context`, `env_file`) are relative to the first Compose file's folder, the project directory of `docker compose -f` |
| `privileged`, `devices`, `cap_add`, `cap_drop`, `pid`, `ipc`, `sysctls`, `ulimits`, `tmpfs`, `init`, `user`, `working_dir`, `hostname`, `extra_hosts`, `dns`, `logging`, `labels`, `stop_grace_period`, `stop_signal`, `command`, `entrypoint`, `read_only`, `shm_size`, `gpus`, `cpu_shares`, `cpu_period`, `cpu_quota`, `cpuset`, `memswap_limit`, `mem_swappiness`, `oom_kill_disable`, `oom_score_adj`, `runtime`, `userns_mode`, `cgroup`, `cgroup_parent`, `uts`, `annotations`, `storage_opt` | Passed to the container, as Compose does |
| `name` | Ignored with a warning: the project name is always `<app>-<env>` |
| `develop`, `x-*` other than `x-dockflow` | Ignored |
| `blkio_config`, `cpu_count`, `cpu_percent`, `cpu_rt_period`, `cpu_rt_runtime`, `device_cgroup_rules`, `mac_address`, `external_links`, `post_start`, `pre_stop`, `credential_spec`, `isolation`, `use_api_socket`, `models`, `provider` | Not supported yet: refused |

## Migrating a 1.x project by hand

| 1.x | v2 |
|---|---|
| `.dockflow/config.yml` + `servers.yml` | `dockflow.yml` |
| `accessories.yml` deployed as a separate Swarm stack | A Compose file listed under `compose:`; its services are part of the app's project, marked `stateful` |
| `{{ current.env.x }}` | `${X}` in Compose and `dockflow.yml`; `{{ X }}` in templates |
| `{{ x \| default('y') }}` | `${X:-y}` in Compose; unchanged in templates |
| `{{ env }}`, `{{ project_name }}` | `${DOCKFLOW_ENV}`, `${DOCKFLOW_APP}` (`{{ DOCKFLOW_ENV }}` in templates) |
| The `nginx` plugin and its vhost proxying to a published port | `x-dockflow.routes`, with either the switch as the TLS edge, or the host's nginx in front of it (`--edge external` and the `nginx` plugin) |
| `<ENV>_<SERVER>_CONNECTION` | `dockflow server connection`, stored as `<ENV>_CONNECTION` |
| `health_checks.endpoints` with `remote: true` | `x-dockflow.health.http` |
| `health_checks.endpoints` with a public URL | `health.endpoints` |
| `hooks.pre-deploy` running `docker exec` | `hooks.before_deploy` with `exec` |
| Secrets in CI | Unchanged; per-server prefixes (`PRODUCTION_MANAGER_X`) become `PRODUCTION_X`, an environment being one server |
| `build.dockerfile` relative to the Compose file's folder (a 1.x quirk every real project relies on: `context: ../..` with `dockerfile: Dockerfile.app` in `.dockflow/docker/`) | Relative to the build context, as Compose defines it: `dockerfile: .dockflow/docker/Dockerfile.app`. |
| `deploy` failing on a held lock in CI, worked around with a concurrency group | `deploy --wait-lock` |

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
  valientrp: { external: true }   # dockflow server network create valientrp

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
