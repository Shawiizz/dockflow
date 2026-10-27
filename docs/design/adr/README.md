# Architecture decision records

Each record states one decision, why it was taken and what it costs. A record is never edited to change its decision: a new record supersedes it, and the old one is marked `Superseded by ADR-NNNN`.

Until M1 starts, records are still edited in place when the project owner changes a decision during the design review; each revised record says so in its date line.

Records use this layout: Status, Context, Decision, Consequences, Alternatives considered, Open questions. An open question is answered in the milestone named next to it, by amending the record (an answer is not a change of decision) or, when the answer changes the decision, by a new record.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-clean-break.md) | Clean break: no backward compatibility with Dockflow 1.x | Accepted |
| [0002](0002-go.md) | Go as the implementation language | Accepted |
| [0003](0003-single-host-docker.md) | One server per environment, Docker Engine only, no orchestrator | Accepted |
| [0004](0004-ephemeral-agent.md) | Deploys run in an ephemeral agent container on the server | Accepted |
| [0005](0005-engine-api.md) | Docker is reached through the Engine API, never the `docker` CLI | Accepted |
| [0006](0006-compose-as-written.md) | Compose plus `dockflow.yml`; Compose interpolation in Compose, Jinja in files | Accepted |
| [0007](0007-state-on-the-server.md) | State lives on the server, under `/var/lib/dockflow` | Accepted |
| [0008](0008-plan-apply-releases.md) | Plan and apply; whole-app releases and rollback | Accepted |
| [0009](0009-images.md) | Images: buildx bake, sent to the server through a server-local registry | Accepted |
| [0010](0010-rollout-health-jobs.md) | Rollout, health, jobs and self-healing, without an orchestrator | Accepted |
| [0011](0011-switch-and-edge.md) | The switch and the edge: a Dockflow-managed Caddy in front of every app, any proxy in front of it | Accepted |
| [0012](0012-secrets-sops.md) | Secrets: CI variables, a local file, optionally SOPS; delivered by interpolation or as secret files | Accepted |
| [0013](0013-servers-access-security.md) | Servers: connection strings, provisioning and an honest security model | Accepted |
| [0014](0014-networking-port-filter.md) | Networking and the published-port filter | Accepted |
| [0015](0015-backups-restic.md) | Backups with restic, run in one-off containers | Accepted |
| [0016](0016-interfaces.md) | One core, a JSON event stream; CLI, local web UI and MCP on top | Accepted |
| [0017](0017-plugins.md) | Plugins: reusable bundles of uploads, templates and hooks | Accepted |
| [0018](0018-shared-servers.md) | Servers shared by several apps | Accepted |
| [0019](0019-testing.md) | Testing strategy | Accepted |
| [0020](0020-releasing-dockflow.md) | Releasing Dockflow itself: signed binaries, version-pinned agent | Accepted |
| [0021](0021-uploads-and-templates.md) | Uploads: files to servers and volumes, incremental and atomic | Accepted |
| [0022](0022-hooks.md) | Hooks: local, on hosts, and inside running containers | Accepted |
| [0023](0023-several-servers-later.md) | Several servers, later: independent servers, no orchestrator | Proposed |
| [0024](0024-provisioning-scope.md) | Provisioning stays within what Dockflow needs | Accepted |
