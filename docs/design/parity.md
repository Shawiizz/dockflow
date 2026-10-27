# Parity with Dockflow 1.x

v2 is a clean break ([ADR-0001](adr/0001-clean-break.md)), but it loses no feature ([vision, goal 9](vision.md#goals)). This table maps every feature of 1.x (its last release, 2.5.x) to its v2 equivalent. It was built from 1.x's CLI reference, its configuration schema, its e2e fixtures and eight real projects: MohistMC (maven, frontend, backend), ValientRP (frontend, backend, minecraft-server), shawiizz.dev and Dockflow's own docs.

**Status** says how v2 provides it:

| Status | Meaning |
|---|---|
| **same** | Equivalent, with a new syntax |
| **better** | Equivalent, and it also fixes a 1.x problem |
| **replaced** | The need is covered by another mechanism |
| **deferred** | Comes back with a later extension, by decision of the project owner |
| **dropped** | Only by decision of the project owner: Swarm and multi-node clustering, on 2026-10-26 |

## Commands

| 1.x | v2 | Status | Milestone |
|---|---|---|---|
| `deploy [env] [version]` | `deploy [<env>] [--version]`; environment and version still detected from CI | better: plan, agent, whole-app rollback | M1–M2 |
| `deploy --dry-run [--render]` | `plan [--render]` | better | M1 |
| `deploy --only`, `--skip-build`, `--force`, `--branch`, `-s/--server`, `--no-failover`, `--dry-run`, `--render` | `deploy --only`, `--skip-build`, `--force` (takes over a manual lock), `--branch`; `--dry-run` and `--render` are `plan` and `plan --render`; `-s` and `--no-failover` have no use with one server per environment ([ADR-0023](adr/0023-several-servers-later.md)) | same | M2 |
| `deploy --accessories`, `--all`, `--skip-accessories` | `deploy --only <services>`: accessories are services ([ADR-0010](adr/0010-rollout-health-jobs.md)) | replaced | M2 |
| `build [env] [--only] [--push] [--skip-hooks]` | `build` with the same options | same | M2 |
| `init` (scaffolding, CI workflows for GitHub and GitLab) | `init`, same, plus scheduled backups in the workflow | same | M3 |
| `config`, `config show/validate/check/path`, `validate [env]` | `config show [--json]`, `validate [<env>]` | same | M1 |
| `ui` | `ui` (local web UI, token-protected) | better ([ADR-0016](adr/0016-interfaces.md)) | M5 |
| `completion`, `help` | `completion`, `help` | same | M1 |
| Environment prefixes (`pr` for `production`) | Same on the command line; never for CI tags | same | M1 |
| `logs` (`-f`, `-n`, `--since`, `--timestamps`, `--all-tasks`, `--pick`, `--no-prefix`) | `logs` with the same options | same | M2 |
| `exec`/`shell` (`-e`, `-u`, `-w`, `--sh`, `-T`, `--pick`) | `exec` with the same options | same | M2 |
| `cp` (files to and from containers) | `cp` | same | M2 |
| `restart [service] [--force]` | `restart` | same | M2 |
| `stop` | `stop [<service>]` | same | M2 |
| `scale` | `scale` (the next deploy restores Compose's replicas, and the plan says so) | same | M2 |
| `rollback [service]` | `rollback [--to] [--service]` | better: whole app by default | M2 |
| `ps [--tasks]`, `details`, `list services`, `list images` | `ps`, `details`, `list services`, `list images` | same | M2 |
| `status [env]`, `list env` | `status [<env>]`, `list envs` | same | M1 |
| `version <env>` | `version <env>` | same | M1 |
| `history`, `history-sync` | `releases` (one server, nothing to sync) | better | M1 |
| `metrics` | `releases --stats` (durations, success rate) | replaced | M2 |
| `diagnose` | `diagnose` | same | M2 |
| `ssh [command]` | `ssh [<command>]` | same | M2 |
| `prune` (`--images`, `--containers`, `--volumes`, `--networks`, `-a`) | `prune` with the same options | same | M2 |
| `lock acquire/status/release` (`-m`, `--force`) | `lock acquire/status/release` (a manual lock never expires) | same | M1 |
| `accessories deploy/list/logs/exec/restart/stop/remove` | `deploy --only`, `ps`, `logs`, `exec`, `restart`, `stop`, `destroy --only <services> [--volumes]` on stateful services | replaced | M2 |
| `backup create/list/restore/prune` (`--from` date, `--keep`, `--node`, `--json`) | `backup run/list/restore/prune` with the same options (`--node` has no use on one server) | better: restic ([ADR-0015](adr/0015-backups-restic.md)) | M4 |
| `plugins list` | `plugins list` ([ADR-0017](adr/0017-plugins.md)) | same | M3 |
| `setup` (interactive, local) | `server init` (interactive, local): local in M2, interactive in M3 | better: hardening | M3 |
| `setup user@host` (`-k`, `--port`, `--user`, `--deploy-password`, `--host-key`, `--skip-docker-install`, `--no-port-filter`, `--nginx`) | `server init user@host` with the same options, `--nginx` included | better | M3 |
| `setup --host --user --password --generate-key` (non-interactive) | `server init --host --user --password-file --generate-key` | same | M3 |
| `setup swarm` | None: no Swarm ([ADR-0003](adr/0003-single-host-docker.md)) | dropped by decision of the project owner | – |
| `setup check` | `server check` | same | M3 |
| `setup connection`, `--connection` | `server connection <env>`, `--connection` | same ([ADR-0013](adr/0013-servers-access-security.md)) | M3 |
| (none) | `plan`, `cancel`, `attach`, `destroy`, `secrets`, `server status`, `server edge`, `server network`, `server plugin`, `server upgrade`, `server uninstall`, `mcp` | new | – |

## Configuration

| 1.x | v2 | Status |
|---|---|---|
| `project_name` | `app` | same |
| `.dockflow/` layout, flat `dockflow.yml` layout | One `dockflow.yml`; Compose files anywhere (`.dockflow/docker/` still works when listed) | replaced |
| `servers.yml`: servers, roles, tags (environments), `defaults` | `environments.<env>` with a connection string or `server:` | replaced |
| `servers.yml` `env` per tag | `environments.<env>.vars` | same |
| `servers.yml` `env` per server, `<ENV>_<SERVER>_<VAR>` secrets | An environment is one server, so its `vars` and `<ENV>_<KEY>` secrets are the server's. Per-server overrides return with several servers ([ADR-0023](adr/0023-several-servers-later.md)) | deferred with several servers |
| Connection string per server (`<ENV>_<SERVER>_CONNECTION`) or shared (`<ENV>_CONNECTION`), with `privateKey` or `password` | Connection string per environment (`<ENV>_CONNECTION`), with host keys, key or password | better |
| `servers.yml` `private_host` (Swarm on a private network) | None: no Swarm traffic between servers | dropped with Swarm |
| `DOCKFLOW_SECRETS`, `.env.dockflow`, `<ENV>_<VAR>` overrides | Same, plus an optional SOPS file ([ADR-0012](adr/0012-secrets-sops.md)) | same |
| Nunjucks in every `.dockflow/` file, `templates:` (including files baked into images, as the docs do) | Jinja through gonja for listed templates (rendered in a copy that bake builds from), uploads and plugins, with conditions, loops, filters and `raw`; Compose interpolation `${VAR}` in Compose and `dockflow.yml` ([ADR-0006](adr/0006-compose-as-written.md)) | better: undefined variables and missing templates are errors |
| `container_engine: podman` | `build.engine: podman` | same |
| `registry` (`type`, `url`, `username`, `password`, `token`, `namespace`, `additional_tags`, `enabled`) | `registry` (`url`, `username`, `password`, `additional_tags`); none means the server-local registry | same |
| `options.remote_build` | `build.builder: remote` | same |
| `options.image_auto_tag` | Always: images are tagged with the version and pinned by digest | replaced |
| `options.enable_debug_logs` | `--verbose` | replaced |
| `health_checks` (`endpoints` with `url`, `method`, `expected_status`, `timeout`, `retries`, `retry_delay`, `validate_certs`, `remote`; `startup_delay`, `on_failure`, `enabled`) | `health.endpoints` (public checks), `x-dockflow.health.http` (internal checks), `startup_delay`, `on_failure` ([ADR-0010](adr/0010-rollout-health-jobs.md)) | better |
| `health_checks.on_failure: notify` | Webhooks fire on every outcome | replaced |
| `health_checks.wait_for_internal`, `timeout`, `interval` | Docker healthchecks gating every rollout strategy, computed timeouts ([ADR-0010](adr/0010-rollout-health-jobs.md)) | replaced |
| `hooks` (7 phases, `run`/`script`, `fatal`, `timeout`, local or on the manager) | `hooks` (5 phases; `run`/`script` locally, `host` on the server, `exec` in containers) ([ADR-0022](adr/0022-hooks.md)) | better |
| `stack_management.keep_releases` | `releases.keep` | same |
| `stack_management.cleanup_on_failure` | Always: failed images are removed | same |
| `lock.stale_threshold_minutes` | A `flock` held by the running agent: released by the kernel when it dies, no threshold to tune ([state spec](spec/state-v1.md#lock)) | better |
| `backup` (`retention_count`, `compression`, per accessory or service: `type`, `dump_command`, `restore_command`, `dump_options`, `restore_options`, `exclude_volumes`, `include_bind_mounts`) | `backups` and `x-dockflow.backup` with the same capabilities ([ADR-0015](adr/0015-backups-restic.md)) | better |
| `proxy` (Traefik: `enabled`, `email`, `acme`, `domains`, `routes`, `trusted_ips`, `dashboard`) | The switch (Caddy): `server init --edge --acme-email --trusted-proxy`, `x-dockflow.routes`, `routes:` ([ADR-0011](adr/0011-switch-and-edge.md)); the dashboard is replaced by the web UI's routes page | better |
| `firewall.public_ports` (with `from`) | `firewall.public_ports` (with `from`), plus Cloudflare-only 80/443 ([ADR-0014](adr/0014-networking-port-filter.md)) | better |
| `notifications.webhooks` (`url`, `on`, `secret`, `headers`, `timeout`) | `notify` with the same fields | same |
| `plugins` (`nginx`, `systemd`, the project's own; inputs, uploads, hooks) | `plugins`, same model, expanded into v2's uploads, templates and hooks; built-in `nginx` and `systemd` ([ADR-0017](adr/0017-plugins.md)) | same |
| `uploads` (`src`, `dest`, `service`, `permissions`, `owner`, `exclude`, `compress`) | `uploads` with the same fields, plus `mirror` and volume destinations ([ADR-0021](adr/0021-uploads-and-templates.md)) | better |
| `no_services` | An app with no Compose file or no services | same |
| `accessories.yml` | A second Compose file listed under `compose:`, with `stateful` services | replaced |

## Behaviour

| 1.x | v2 | Status |
|---|---|---|
| Single binary, npm wrapper, install scripts | Same, signed ([ADR-0020](adr/0020-releasing-dockflow.md)) | better |
| Secrets kept out of the CLI's output and the server's process lists (checked by 1.x's e2e suite) | Same, plus masking of every output, hooks and builds included ([ADR-0012](adr/0012-secrets-sops.md)) | better |
| BuildKit features (`# syntax`, `RUN --mount=type=cache`, multi-stage) | All of BuildKit through bake; `cache_from`/`cache_to` in Compose keep the cache across CI runs | better |
| A held lock fails the deploy | Same by default; `deploy --wait-lock` queues instead | better |
| CI detection: GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket; environment and version from the tag | Same providers. A tag suffix selects an environment only when it names one exactly, so `1.0.0-pre-prod` can no longer reach production | better |
| Multi-node Swarm clusters: workers, multi-manager failover, placement constraints, routing mesh | One server per environment; several independent servers later ([ADR-0023](adr/0023-several-servers-later.md)) | dropped by decision of the project owner (2026-10-26) |
| Image distribution by `docker save \| load` or registry | Server-local registry, only missing layers sent; or an external registry; or a build on the server ([ADR-0009](adr/0009-images.md)) | better |
| Swarm stacks (one per app environment, plus one for accessories) | One Compose project per app environment, readable with `docker compose ps` ([ADR-0003](adr/0003-single-host-docker.md)) | better |
| Swarm rolling updates (`start-first`), automatic rollback | The switch for routed services, `start-first` and `stop-first` for the others, rollback by switching back ([ADR-0010](adr/0010-rollout-health-jobs.md)) | better |
| Swarm restarting failed and unhealthy tasks | Restart policies, plus the watchdog for unhealthy containers | same |
| Replicas | `deploy.replicas`, on one server | same |
| Accessories redeployed when their hash changes | The plan touches only what changed | better |
| Audit log and metrics replicated to every node | Release records on the server | better |
| Host nginx installed by `setup --nginx` | `server init --nginx --edge external` and the `nginx` plugin, in front of the switch; or the switch as the TLS edge ([ADR-0011](adr/0011-switch-and-edge.md)) | same |
| MCP server (docs and validation) | `dockflow mcp` (validation with the real loader, plus status, logs, plan, gated deploy) | better |
| Ctrl+C releases the lock and undoes the deploy | Ctrl+C rolls back on the server, and the CLI can detach | better |
