# Parity with Dockflow 1.x

v2 is a clean break ([ADR-0001](adr/0001-clean-break.md)), but it loses no feature ([vision, goal 9](vision.md#goals)). This table maps every feature of 1.x (its last release, 2.5.x) to its v2 equivalent. It was built from 1.x's CLI reference, its configuration schema, its e2e fixtures and eight real projects: MohistMC (maven, frontend, backend), ValientRP (frontend, backend, minecraft-server), shawiizz.dev and Dockflow's own docs.

**Status** says how v2 provides it:

| Status | Meaning |
|---|---|
| **same** | Equivalent, with a new syntax |
| **better** | Equivalent, and it also fixes a 1.x problem |
| **replaced** | The need is covered by another mechanism |
| **dropped** | Only by decision of the project owner (none so far) |

## Commands

| 1.x | v2 | Status | Milestone |
|---|---|---|---|
| `deploy [env] [version]` | `deploy [<env>] [--version]`; environment and version still detected from CI | better: plan, agent, whole-app rollback | M1–M2 |
| `deploy --dry-run [--render]` | `plan [--render]` | better | M1 |
| `deploy --only`, `--skip-build`, `--force`, `--no-wait`, `--branch`, `-s/--server`, `--no-failover` | Same options on `deploy` (`--force` takes over a manual lock) | same | M2 |
| `deploy --accessories`, `--all`, `--skip-accessories` | `deploy --only <services>`: accessories are services ([ADR-0010](adr/0010-rollout-health-jobs.md)) | replaced | M2 |
| `build [env] [--only] [--push] [--skip-hooks]` | `build` with the same options | same | M2 |
| `init` (scaffolding, CI workflows for GitHub and GitLab) | `init`, same, plus scheduled backups in the workflow | same | M3 |
| `config`, `config show/validate/check/path`, `validate [env]` | `config show [--json]`, `validate [<env>]` | same | M1 |
| `ui` | `ui` (local web UI, token-protected) | better ([ADR-0016](adr/0016-interfaces.md)) | M5 |
| `completion`, `help` | `completion`, `help` | same | M1 |
| Environment prefixes (`pr` for `production`) | Same on the command line; never for CI tags | same | M1 |
| `logs` (`-f`, `-n`, `--since`, `--timestamps`, `--all-tasks`, `--pick`, `--no-prefix`) | `logs` with the same options | same | M2 |
| `exec`/`shell` (`-e`, `-u`, `-w`, `--sh`, `-T`, `--pick`) | `exec` with the same options, on any node without SSH to workers | better | M2 |
| `cp` (files to and from containers) | `cp` | same | M2 |
| `restart [service] [--force]` | `restart` | same | M2 |
| `stop` | `stop [<service>]` | same | M2 |
| `scale` | `scale` (the next deploy restores Compose's replicas, and the plan says so) | same | M2 |
| `rollback [service]` | `rollback [--to] [--service]` | better: whole app by default | M2 |
| `ps [--tasks]`, `details`, `list services`, `list images` | `ps`, `details`, `list services`, `list images` | same | M2 |
| `status [env]`, `list env` | `status [<env>]`, `list envs` | same | M1 |
| `version <env>` | `version <env>` | same | M1 |
| `history`, `history-sync` | `releases` (state in Raft, nothing to sync) | better | M1 |
| `metrics` | `releases --stats` (durations, success rate) | replaced | M2 |
| `diagnose` | `diagnose` | same | M2 |
| `ssh [command]` | `ssh [<node>] [<command>]` | same | M2 |
| `prune` (`--images`, `--containers`, `--volumes`, `--networks`, `-a`) | `prune` with the same options, on every node through a job | same | M2 |
| `lock acquire/status/release` (`-m`, `--force`) | `lock acquire/status/release` (a manual lock never expires) | same | M1 |
| `accessories deploy/list/logs/exec/restart/stop/remove` | `deploy --only`, `ps`, `logs`, `exec`, `restart`, `stop`, `destroy --only <services> [--volumes]` on stateful services | replaced | M2 |
| `backup create/list/restore/prune` (`--from` date, `--keep`, `--node`, `--json`) | `backup run/list/restore/prune` with the same options | better: restic ([ADR-0015](adr/0015-backups-restic.md)) | M4 |
| `plugins list` | none: the plugin system is replaced ([ADR-0017](adr/0017-no-plugins.md)) | replaced | – |
| `setup` (interactive, local) | `server init` (interactive, local) | better: hardening | M3 |
| `setup user@host` (`-k`, `--port`, `--user`, `--deploy-password`, `--host-key`, `--skip-docker-install`, `--no-port-filter`, `--nginx`) | `server init user@host` with the same options; `--nginx` is replaced by the proxy | better | M3 |
| `setup --host --user --password --generate-key` (non-interactive) | `server init --host --user --password-file --generate-key` | same | M3 |
| `setup swarm` | `cluster init`, `cluster join` | better | M1–M3 |
| `setup check` | `server check` | same | M3 |
| `setup connection`, `--connection` | `server connection <env>`, `--connection` | same ([ADR-0013](adr/0013-servers-access-security.md)) | M3 |
| (none) | `cancel`, `attach`, `destroy`, `secrets`, `cluster network`, `cluster plugin`, `mcp` | new | – |

## Configuration

| 1.x | v2 | Status |
|---|---|---|
| `project_name` | `app` | same |
| `.dockflow/` layout, flat `dockflow.yml` layout | One `dockflow.yml`; Compose files anywhere (`.dockflow/docker/` still works when listed) | replaced |
| `servers.yml`: servers, roles, tags (environments), `defaults` | `environments.<env>` with `nodes` or a connection string | replaced |
| `servers.yml` `env` per tag | `environments.<env>.vars` | same |
| `servers.yml` `env` per server (`PRODUCTION_MANAGER_X`) | `vars` per environment. Per-server values were only ever rendered for the manager | replaced |
| Connection string per server (`<ENV>_<SERVER>_CONNECTION`) or shared (`<ENV>_CONNECTION`), with `privateKey` or `password` | Connection string per environment (`<ENV>_CONNECTION`), with host keys, key or password | better |
| `servers.yml` `private_host` (Swarm on a private network) | `cluster init/join --advertise-addr` | same |
| `DOCKFLOW_SECRETS`, `.env.dockflow`, `<ENV>_<VAR>` overrides | Same, plus an optional SOPS file ([ADR-0012](adr/0012-secrets-sops.md)) | same |
| Nunjucks in every `.dockflow/` file, `templates:` (including files baked into images, as the docs do) | `${VAR}` interpolation in Compose, `dockflow.yml`, listed templates (rendered in a copy that bake builds from) and hooks ([ADR-0006](adr/0006-compose-as-written.md)) | replaced: conditions and loops are gone, unused in real projects; a missing template is now an error |
| `container_engine: podman` | `build.engine: podman` | same |
| `registry` (`type`, `url`, `username`, `password`, `token`, `namespace`, `additional_tags`, `enabled`) | `registry` (`url`, `username`, `password`, `additional_tags`); none means the cluster registry | same |
| `options.remote_build` | `build.builder: remote` | same |
| `options.image_auto_tag` | Always: images are tagged with the version and pinned by digest | replaced |
| `options.enable_debug_logs` | `--verbose` | replaced |
| `health_checks` (`endpoints` with `url`, `method`, `expected_status`, `timeout`, `retries`, `retry_delay`, `validate_certs`, `remote`; `startup_delay`, `on_failure`, `enabled`) | `health.endpoints` (public checks), `x-dockflow.health.http` (internal checks), `startup_delay`, `on_failure` ([ADR-0010](adr/0010-rollout-health-jobs.md)) | better |
| `health_checks.on_failure: notify` | Webhooks fire on every outcome | replaced |
| `health_checks.wait_for_internal`, `timeout`, `interval` | Swarm's own health gating, computed timeouts | replaced |
| `hooks` (7 phases, `run`/`script`, `fatal`, `timeout`, local or on the manager) | `hooks` (5 phases; `run`/`script` locally, `host` on nodes, `exec` in containers) ([ADR-0022](adr/0022-hooks.md)) | better |
| `stack_management.keep_releases` | `releases.keep` | same |
| `stack_management.cleanup_on_failure` | Always: failed images are removed | same |
| `lock.stale_threshold_minutes` | A 60-second lease, renewed by the holder ([state spec](spec/state-v1.md#lock)) | better |
| `backup` (`retention_count`, `compression`, per accessory or service: `type`, `dump_command`, `restore_command`, `dump_options`, `restore_options`, `exclude_volumes`, `include_bind_mounts`) | `backups` and `x-dockflow.backup` with the same capabilities ([ADR-0015](adr/0015-backups-restic.md)) | better |
| `proxy` (Traefik: `enabled`, `email`, `acme`, `domains`, `routes`, `trusted_ips`, `dashboard`) | Caddy: `cluster init --acme-email --edge`, `x-dockflow.routes`, `routes:` ([ADR-0011](adr/0011-ingress-caddy.md)); the dashboard is replaced by the web UI's routes page | better |
| `firewall.public_ports` (with `from`) | `firewall.public_ports` (with `from`), plus Cloudflare-only 80/443 ([ADR-0014](adr/0014-networking-port-filter.md)) | better |
| `notifications.webhooks` (`url`, `on`, `secret`, `headers`, `timeout`) | `notify` with the same fields | same |
| `plugins` (`nginx`, `systemd`, the project's own) | Routes, uploads, `host` hooks, volume plugins ([ADR-0017](adr/0017-no-plugins.md)) | replaced |
| `uploads` (`src`, `dest`, `service`, `permissions`, `owner`, `exclude`, `compress`) | `uploads` with the same fields, plus `mirror` and volume destinations ([ADR-0021](adr/0021-uploads-and-templates.md)) | better |
| `no_services` | An app with no Compose file or no services | same |
| `accessories.yml` | A second Compose file listed under `compose:`, with `stateful` services | replaced |

## Behaviour

| 1.x | v2 | Status |
|---|---|---|
| Single binary, npm wrapper, install scripts | Same, signed ([ADR-0020](adr/0020-releasing-dockflow.md)) | better |
| Secrets kept out of the CLI's output and the nodes' process lists (checked by 1.x's e2e suite) | Same, plus masking of every output, hooks and builds included ([ADR-0012](adr/0012-secrets-sops.md)) | better |
| BuildKit features (`# syntax`, `RUN --mount=type=cache`, multi-stage) | All of BuildKit through bake; `cache_from`/`cache_to` in Compose keep the cache across CI runs | better |
| A held lock fails the deploy | Same by default; `deploy --wait-lock` queues instead | better |
| CI detection: GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket; environment and version from the tag | Same providers. A tag suffix selects an environment only when it names one exactly, so `1.0.0-pre-prod` can no longer reach production | better |
| Multi-manager failover | Any manager: state in Raft | better |
| Image distribution by `docker save \| load` or registry | Registry only: the cluster registry by default ([ADR-0009](adr/0009-images.md)) | better |
| Accessories redeployed when their hash changes | The plan touches only what changed | better |
| Audit log and metrics replicated to every node | Release records in Raft | better |
| Host nginx installed by `setup --nginx` | Caddy proxy in the cluster | replaced |
| MCP server (docs and validation) | `dockflow mcp` (validation with the real loader, plus status, logs, plan, gated deploy) | better |
| Ctrl+C releases the lock and undoes the deploy | Ctrl+C rolls back on the cluster, and the CLI can detach | better |
