# Roadmap

Each milestone ends with a usable tool, and its exit criteria are checked by tests, not by reading code. Dates are not fixed. There is no migration milestone: moving from Dockflow 1.x is manual ([ADR-0001](adr/0001-clean-break.md)). v1.0 ships only when every row of [parity.md](parity.md) is provided.

## M0: Design (this branch, now)

- [x] Vision, non-goals, principles
- [x] ADR-0001 to ADR-0022
- [x] Specifications: configuration, cluster state, events, CLI
- [x] Parity table with 1.x, from its CLI reference, its schema, its e2e fixtures and eight real projects
- [ ] Review by the project owner. Any change of mind becomes an edit before M1 starts, while nothing depends on it yet.

## M1: Walking skeleton

Deploy a Compose app that uses public images to a one-node cluster.

- Go module, CI (lint, unit tests, contract tests in Docker-in-Docker), release workflow producing unsigned snapshot builds
- Loading `dockflow.yml`, Compose (compose-go) and secrets (CI variables, `DOCKFLOW_SECRETS`, `.env.dockflow`), interpolation, the domain model, the converter, golden tests
- Connection strings, SSH with host key verification, Engine API through stream-local forwarding with the `dial-stdio` fallback
- The agent: image import, container run, stdin input, event stream, `attach`
- The state store: the environment record, the lock (with the contention tests and manual locks), releases
- `plan`, `deploy`, `status`, `releases`, `version`, `lock`, `validate`, `config show`, `completion`, `--json`
- A temporary `dockflow cluster init` that only creates the Swarm and `dockflow-system`

Exit criteria:

- deploying twice gives `plan.empty` the second time;
- changing an image tag updates only that service;
- two concurrent deploys get exit code 5 for one of them;
- killing the agent mid-run lets the next run take over the lock after the lease and converge.

Also answered in M1: the minimum Docker version ([ADR-0003](adr/0003-swarm-behind-an-engine-port.md)), stdin vs secret for the agent input ([ADR-0004](adr/0004-ephemeral-agent.md)), the `authorized_keys` options ([ADR-0013](adr/0013-servers-access-security.md)), embedding or downloading the agent binary ([ADR-0020](adr/0020-releasing-dockflow.md)).

## M2: Shipping real apps

- `build`; builds with buildx bake or Podman; the cluster registry and the push through an SSH tunnel; external registries and additional tags
- Rollout waiting on events, computed timeouts, crash-loop detection
- Internal and public health checks, `on_failure`
- Whole-app and per-service rollback, `rollback`, `cancel`, Ctrl+C semantics, `--no-rollback`
- Jobs (`before`, `after`); hooks: local, `host`, `exec` ([ADR-0022](adr/0022-hooks.md))
- Templates with gonja (Jinja), values per node, and uploads, incremental with `mirror` ([ADR-0021](adr/0021-uploads-and-templates.md))
- Day-2: `logs`, `exec`, `run`, `cp`, `ssh`, `ps`, `details`, `diagnose`, `restart`, `stop`, `scale`, `prune`, `list`, `destroy`, `releases --stats`
- CI detection of environment and version (GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket)
- Webhooks
- Retention and pruning (releases, objects, registry manifests, previous uploads)
- e2e suite on a three-node Docker-in-Docker cluster

Exit criteria: the e2e journeys of [ADR-0019](adr/0019-testing.md) that don't involve ingress or backups pass on the release binary, including a 1 GB upload where the second deploy sends only the changed files.

## M3: Production-ready

- `server init` (interactive, local and remote, `--nginx`), `server cloud-init`, `server check`, `server connection`
- Plugins: the project's own and the built-in `nginx` and `systemd`, `plugins list` ([ADR-0017](adr/0017-plugins.md))
- `cluster init`, `join`, `label`, `network`, `plugin`, `status`, `upgrade`
- Caddy ingress: routes and their options, `redirect`/`proxy`/`files` routes, raw Caddy blocks, (domain, path) uniqueness, edge modes (`direct`, `cloudflare`, `proxy`)
- The published-port filter with `public_ports` and `from`, its global job, the Cloudflare ranges timer
- Compose `secrets:` and `configs:`; the SOPS file and the `secrets` commands
- Shared clusters: two apps from two projects on one cluster, talking through a shared network
- `init` with CI workflows
- Real-cluster tests on fresh DigitalOcean droplets: provisioning, cloud-init, Let's Encrypt staging, Cloudflare edge, the filter on real interfaces

Exit criteria: a new DigitalOcean droplet goes from blank to serving an app over HTTPS with `server init`, `cluster init` and `deploy` only, and a second project deploys next to it without touching the first. **Each of the eight real projects (MohistMC ×3, ValientRP ×3, shawiizz.dev, Dockflow's own docs) has a working v2 configuration in the e2e fixtures**, the Minecraft server included (TCP and UDP ports, graceful stop through an `exec` hook).

## M4: Data

- Stateful services: rules and placement checks
- Backups with restic: every type, local repository by default, off-site repositories, application-aware quiesce, retention, `check`
- `backup run`, `list`, `restore` (including `--from` another environment), `prune`
- Scheduled backups in the generated CI workflows

Exit criteria: a Postgres app is backed up to S3-compatible storage, restored into staging from production, and a failing restore stops at the first error. A Minecraft world is backed up with `save-off`/`save-on` without stopping the server.

## M5: Interfaces

- `dockflow ui`, the local web UI, on the same core ([ADR-0016](adr/0016-interfaces.md)), with its frontend stack chosen here
- `dockflow mcp`, with gated write tools
- The GitHub Action: plan comment on pull requests, apply of the reviewed plan
- Preview environments per pull request (a namespace and a subdomain per PR, removed when it closes)

## v1.0

- Every row of [parity.md](parity.md) is provided
- The configuration (`version: 1`), state (`schema: 1`) and event (`v: 1`) formats are frozen
- Signed releases, installers, Homebrew, the npm package with per-platform dependencies
- User documentation complete: every command, every key, the recipes, the security model, the manual migration from 1.x

## After v1.0 (not committed)

- A permanent agent for scheduled jobs and a server-side dashboard
- Several ingress nodes with shared certificate storage; DNS-01 through Cloudflare
- Strict network isolation of routed services between apps
- Postgres point-in-time recovery
- A native nftables backend for the filter
- A second `Engine` adapter, if Swarm declines
