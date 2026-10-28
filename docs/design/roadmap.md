# Roadmap

Each milestone ends with a usable tool and **one or more real projects migrated to it**, by hand ([ADR-0001](adr/0001-clean-break.md)). Exit criteria are checked by tests, not by reading code. Dates are not fixed. v1.0 ships when every row of [parity.md](parity.md) is provided, deferred or dropped by decision.

## M0: Design (this branch, now)

- [x] Vision, non-goals, principles
- [x] ADR-0001 to ADR-0023
- [x] Specifications: configuration, server state, events, CLI
- [x] Parity table with 1.x, from its CLI reference, its schema, its e2e fixtures and eight real projects
- [x] Single-server design, without an orchestrator (2026-10-26)
- [ ] Review by the project owner. Any change of mind becomes an edit before M1 starts, while nothing depends on it yet.

## M1: Walking skeleton

Deploy a Compose app that uses public images to one server, with zero downtime.

**Status: done (2026-10-26).** Every exit criterion below is an e2e test (`test/e2e/`), run in CI on Docker 27 and on the latest Docker. Left for later milestones: the download and signature check of the agent binary needs a published release (M1 sends the CLI's own binary, or `DOCKFLOW_AGENT_BINARY`), and `server init` installs the switch on a server that is already reachable; provisioning is M3.

- **Foundations:** the Go module and its CI (lint, unit tests, contract tests in Docker-in-Docker), and a release workflow producing unsigned snapshot builds.
- **Loading the project:**
  - `dockflow.yml`, Compose (compose-go) and secrets (CI variables, `DOCKFLOW_SECRETS`, `.env.dockflow`);
  - Compose interpolation;
  - the domain model and the converter, with golden tests.
- **Reaching the server:** connection strings, SSH with host key verification, and the Engine API through stream-local forwarding, with the `dial-stdio` fallback.
- **The agent:** image import, container run, stdin input, event stream, `attach`.
- **The state:** `/var/lib/dockflow`, the `flock` lock and manual locks, releases.
- **The rollout:** the three strategies, health gating, rollback by switching back.
- **The switch:** Caddy with the `builtin` edge, installed by a minimal `server init`.
- **Commands:** `plan`, `deploy`, `rollback`, `status`, `releases`, `version`, `lock`, `validate`, `config show`, `completion`, `--json`.

Exit criteria:

- deploying twice gives `plan.empty` the second time;
- changing an image updates only that service;
- **a client sending requests in a loop during a deploy and a rollback sees no failed request;**
- two concurrent deploys get exit code 5 for one of them;
- killing the agent mid-run leaves the previous release serving, and the next run converges.

Also answered in M1:
- the minimum Docker version: Docker 27 ([ADR-0003](adr/0003-single-host-docker.md));
- stdin vs a file for the agent input: stdin for the run document; uploads in M2 confirm it for large payloads ([ADR-0004](adr/0004-ephemeral-agent.md));
- the `authorized_keys` options: moved to M3, with provisioning ([ADR-0013](adr/0013-servers-access-security.md));
- embedding or downloading the agent binary: downloading ([ADR-0020](adr/0020-releasing-dockflow.md)).

## M2: Shipping real apps — shawiizz.dev and Dockflow's docs

**Status: done (2026-10-26).** The exit criterion is met: shawiizz.dev and the documentation site (dockflow.shawiizz.dev) deploy with v4.0.0-alpha.5 from GitHub Actions, behind the host's nginx (`--edge external`). The items below are covered by e2e journeys (`test/e2e/`), run in CI on Docker 27 and on the latest Docker (Podman builds where Podman is installed), except CI detection, covered by unit tests, and pushes to an external registry, which no test exercises yet. Also delivered: `server connection` and the first part of provisioning, `server init <admin>@<host>` and `server init` run on the server itself (Docker, the deploy user and its key, the connection string), moved here from M3 so that preparing a server takes one command; the release workflow, the install script and the download of the agent binary, checked against the release's checksums ([ADR-0020](adr/0020-releasing-dockflow.md)); the CLI's check of the signature waits for v1.0.

- **The `external` edge**, moved here from M3: both projects of this milestone sit behind the host's nginx, which keeps ports 80 and 443.
- **Images:** `build`; builds with buildx bake or Podman; the server-local registry and the push through an SSH tunnel; external registries and additional tags; remote builds.
- **Jobs and checks:** `depends_on` conditions and jobs; internal and public health checks; `on_failure`.
- **Hooks and files:** local, `host` and `exec` hooks; templates with gonja; uploads, incremental, with `mirror`.
- **Day-2 commands:** `logs`, `exec`, `run`, `cp`, `ssh`, `ps`, `details`, `diagnose`, `restart`, `stop`, `scale`, `prune`, `list`, `destroy`, `releases --stats`, `cancel`.
- **CI:** detection of environment and version (GitHub Actions, GitLab CI, Jenkins, Buildkite, Bitbucket), and webhooks.
- **Cleanup:** retention and pruning.
- **Tests:** the e2e suite on a Docker-in-Docker server reached over SSH.

Exit criteria: **shawiizz.dev and Dockflow's docs site deploy with v2 in production**, from their CI.

## M3: Production-ready — ValientRP

**Status: done (2026-10-27).** The exit criteria are met: a blank DigitalOcean droplet serves an app over HTTPS with `server init` and `deploy` only (`test/real/`), and ValientRP's frontend, backend with its Postgres, Minecraft server and RCON panel run on one server with v4.0.0-alpha.6, deployed from GitHub Actions: the shared network `valientrp`, ports 25565 TCP and UDP open by the filter and every other port closed, the graceful stop through an `exec` hook, Cloudflare in front with the `cloudflare` edge. The server was moved in place from Dockflow 1.x, its Postgres volume and world directory reused. Cloudflare stays in its Flexible SSL mode, so the routes are served over HTTP (`tls: false`).

- **Provisioning:** the full `server init` (interactive, hardening, `--nginx`, `--acme-email`) and `server cloud-init`; `check`, `connection`, `status`, `edge`, `upgrade`, `uninstall` (done).
- **Edges:** `cloudflare`, route options, `redirect`, `proxy` and `files` routes, raw Caddy blocks, (domain, path) uniqueness (done; `none` shipped with M2).
- **Plugins:** the project's own and the built-in `nginx` and `systemd`, plus `plugins list` (done; `server init --nginx` comes with provisioning).
- **Security:** the published-port filter with `public_ports` and `from` (done), and the Cloudflare ranges timer (done).
- **Secrets:** Compose `secrets:` and `configs:`, the SOPS file and the `secrets` commands (done).
- **Self-healing:** the watchdog (done).
- **Shared servers:** shared networks and volume plugins (done).
- **`init`** with CI workflows (done).
- **Real-server tests** on fresh DigitalOcean droplets: provisioning, cloud-init, Let's Encrypt staging, the Cloudflare edge, nginx in front of the switch, the filter (done: `test/real/`, run by hand with the "Real servers" workflow; green on 2026-10-27).

Exit criteria:
- a new DigitalOcean droplet goes from blank to serving an app over HTTPS with `server init` and `deploy` only (met: `TestProvisionAndDeploy`, with Let's Encrypt's staging);
- **ValientRP's frontend, backend and Minecraft server run on one server with v2**: the shared network to Postgres, TCP and UDP ports, the graceful stop through an `exec` hook, Cloudflare in front.

## M4: Data — MohistMC

**Status: done (2026-10-28).** The items below are done and covered by e2e journeys (`test/e2e/backup*_test.go`) and unit tests. The first exit criterion is an e2e test, against `rclone serve s3` as the S3-compatible storage (`TestOffsiteBackup`). The second is met: ValientRP's 14 GB world is backed up by v4.0.0-alpha.8 from a scheduled GitHub Actions workflow, with `save-off`/`save-all flush` before the copy and `save-on` after, while the server runs (2026-10-28). The third is met: MohistMC's website, API with its Postgres, and Maven repository run with v4.0.0-alpha.8 on the server they share with other apps, behind its nginx, deployed from GitHub Actions. The second deploy of the 2.7 GB Maven repository sent 0 of its 1,961 files. The SSHFS mount of the builds stays the host's, set up outside Dockflow ([ADR-0024](adr/0024-provisioning-scope.md)). The rclone mount of the archives has no reader left: nginx proxies `/builds-raw` to the S3 bucket, and a host timer lists the bucket with rclone to write its index.

- **Stateful services:** their rules: one container, `stop-first`, updated before the other services, the only ones backed up (done).
- **Backups with restic:**
  - every type: `postgres`, `mysql`, `mongo`, `redis`, `volume`, `command` (done);
  - a local repository by default, off-site repositories (done);
  - application-aware quiesce (done);
  - retention, `check` (done);
  - the backup of `/var/lib/dockflow`: `backup run --server` (done).
- **Commands:** `backup run`, `list`, `restore` (including `--from` another environment) and `prune`, plus scheduled backups in the generated CI workflows (done).

Exit criteria:
- a Postgres app is backed up to S3-compatible storage, restored into staging from production, and a failing restore stops at the first error;
- a Minecraft world is backed up with `save-off`/`save-on` without stopping the server;
- **MohistMC's three projects run with v2**: the 2.7 GB Maven upload, where the second deploy sends only changed files, and the API's Postgres kept on its volume.

## M5: Interfaces

- `dockflow mcp`, with gated write tools.
- The GitHub Action: plan comment on pull requests, apply of the reviewed plan.

The local web UI and preview environments per pull request are deferred after v1.0 by decision of the project owner (2026-10-28): none of the eight projects that shaped v2 needs them, and the web UI alone is a frontend stack to build and maintain.

## v1.0 (released as 4.0.0)

Until then, milestones ship as pre-releases `v4.0.0-alpha.N` ([ADR-0020](adr/0020-releasing-dockflow.md)).


- Every row of [parity.md](parity.md) is provided, deferred or dropped by decision.
- The configuration (`version: 1`), state (`schema: 1`) and event (`v: 1`) formats are frozen.
- Signed releases, installers, Homebrew, the npm package with per-platform dependencies.
- User documentation complete: every command, every key, the recipes, the security model, the manual migration from 1.x.

## After v1.0 (not committed)

- `dockflow ui`, the local web UI, on the same core ([ADR-0016](adr/0016-interfaces.md)), with its frontend stack chosen then.
- Preview environments per pull request: a project and a subdomain per PR, removed when it closes.
- Several independent servers per environment ([ADR-0023](adr/0023-several-servers-later.md)), with per-server values.
- Podman as the server's engine, rootless.
- DNS-01 through Cloudflare, wildcard certificates.
- Postgres point-in-time recovery.
- A native nftables backend for the filter.
