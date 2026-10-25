# Roadmap

Each milestone ends with a usable tool, and its exit criteria are checked by tests, not by reading code. Dates are not fixed. There is no migration milestone: moving from Dockflow 1.x is manual ([ADR-0001](adr/0001-clean-break.md)).

## M0: Design (this branch, now)

- [x] Vision, non-goals, budget
- [x] ADR-0001 to ADR-0020
- [x] Specifications: configuration, cluster state, events, CLI
- [ ] Review by the project owner. Any change of mind becomes an edit before M1 starts, while nothing depends on it yet.

## M1: Walking skeleton

Deploy a Compose app that uses public images to a one-node cluster.

- Go module, CI (lint, unit tests, contract tests in Docker-in-Docker), release workflow producing unsigned snapshot builds
- Loading `dockflow.yml` and Compose (compose-go), the domain model, the converter for the supported keys, golden tests
- SSH with host key verification, Engine API through stream-local forwarding, with the `dial-stdio` fallback
- The agent: image import, container run, stdin input, event stream, `attach`
- The state store: the environment record, the lock (with the contention tests), releases
- `plan`, `deploy`, `status`, `releases`, `--json`
- A temporary `dockflow cluster init` that only creates the Swarm and `dockflow-system`

Exit criteria:

- deploying twice gives `plan.empty` the second time;
- changing an image tag updates only that service;
- two concurrent deploys get exit code 5 for one of them;
- killing the agent mid-run lets the next run take over the lock after the lease and converge.

Also answered in M1: the minimum Docker version ([ADR-0003](adr/0003-swarm-behind-an-engine-port.md)), stdin vs secret for the agent input ([ADR-0004](adr/0004-ephemeral-agent.md)), the `authorized_keys` options ([ADR-0013](adr/0013-servers-access-security.md)), embedding or downloading the agent binary ([ADR-0020](adr/0020-releasing-dockflow.md)).

## M2: Shipping real apps

- Builds with buildx bake; the cluster registry and the push through an SSH tunnel; external registries
- Rollout waiting on events, computed timeouts, crash-loop detection
- HTTP health checks from inside the cluster
- Whole-app rollback, `rollback`, `cancel`, Ctrl+C semantics, `--no-rollback`
- Jobs (`before`, `after`), `run`, `exec` (including on workers through the manager), `logs`
- Retention and pruning (releases, objects, registry manifests)
- e2e suite on a three-node Docker-in-Docker cluster

Exit criteria: the e2e journeys of [ADR-0019](adr/0019-testing.md) that don't involve ingress, secrets or backups pass on the release binary.

## M3: Production-ready

- `server init`, `server cloud-init`, `cluster init`, `join`, `label`, `status`, `upgrade`
- Caddy ingress, route records, the proxy reconciler, automatic HTTPS, domain conflicts
- The published-port filter and its global job
- SOPS secrets, Compose `secrets:` and `configs:`, `secrets` commands
- Shared clusters: two apps from two projects on one cluster
- Real-cluster tests on fresh DigitalOcean droplets: provisioning, cloud-init, Let's Encrypt staging, the filter on real interfaces

Exit criteria: a new DigitalOcean droplet goes from blank to serving an app over HTTPS with `server init`, `cluster init` and `deploy` only, and a second project deploys next to it without touching the first.

## M4: Data

- Stateful services: rules and placement checks
- Backups with restic: dump jobs, volume backups with quiesce, retention, `check`
- `backup list` and `backup restore`, including `--from` another environment
- The generated GitHub workflow with scheduled backups

Exit criteria: a Postgres app is backed up to S3-compatible storage, restored into staging from production, and a failing restore stops at the first error.

## M5: Interfaces

- `dockflow tui`
- `dockflow mcp`, with gated write tools
- The GitHub Action: plan comment on pull requests, apply of the reviewed plan
- Preview environments per pull request (a namespace and a subdomain per PR, removed when it closes)

## v1.0

- The configuration (`version: 1`), state (`schema: 1`) and event (`v: 1`) formats are frozen
- Signed releases, installers, Homebrew, the npm package with per-platform dependencies
- User documentation complete: every command, every key, the recipes, the security model

## After v1.0 (not committed)

- A permanent agent for scheduled jobs and a server-side dashboard
- Several ingress nodes with shared certificate storage
- Strict network isolation of routed services between apps
- Postgres point-in-time recovery
- A native nftables backend for the filter
- A second `Engine` adapter, if Swarm declines
