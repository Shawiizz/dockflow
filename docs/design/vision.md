# Vision

## In one sentence

The only multi-server Compose deployer that leaves nothing running on your machines, shows you a plan before it acts, and always finishes its rollback, even when the CI runner dies.

## Who it is for

| User | Typical setup | What they need from Dockflow |
|---|---|---|
| A solo developer | 1 server, 1 to 5 apps | `deploy` that just works, HTTPS, backups that leave the server |
| A small team | 2 to 10 servers, a few apps, CI | Plans reviewed in pull requests, safe concurrent deploys, rollback |
| An agency | Several clusters, many client apps sharing them | Apps isolated from each other on a shared cluster, one proxy, repeatable setup |

All three are first-class. A feature that only one of them needs must not make the tool harder for the other two.

## Why it exists

The author uses it, and it should be good enough for others to adopt. That rules out anything that only works on the author's setup, and anything that needs the author to operate it.

Next to the alternatives:

- **Kamal** is agentless too, but has its own configuration format instead of Compose, and no multi-node orchestration.
- **Uncloud** runs Compose across machines, but installs a daemon on each one and builds its own mesh network.
- **Dokploy, Coolify, CapRover** are platforms that run on the server, with a web UI and a database to operate.

Dockflow keeps the user's Compose file as the source of truth, uses Docker Swarm for scheduling, and runs on the servers only for the duration of a deploy.

## Goals

1. **Compose as written.** A project's `compose.yml` stays valid for `docker compose up` on a laptop. Dockflow adds a small `dockflow.yml` and `x-dockflow` keys, nothing else.
2. **Plan, then apply.** Every change to a cluster is computed as a plan the user can read, save and review, then applied exactly.
3. **Finish what was started.** A deploy runs on the cluster itself. Losing the CLI, the network or the CI runner never leaves an app half-deployed: the run completes or rolls back on its own.
4. **The cluster is the database.** Locks, releases and the current version live in the Swarm Raft store. Any manager can answer, nothing needs syncing, nothing is stored in files on one server.
5. **Delegate.** Swarm schedules, rolls out and rolls back. buildx builds. A registry distributes images. Caddy terminates TLS. restic stores backups. SOPS encrypts secrets. Dockflow composes them.
6. **One core, several faces.** The CLI, the local web UI, the MCP server and the GitHub Action call the same functions and read the same event stream.
7. **Fail loudly.** A missing variable, an unknown key, an unsupported Compose feature or an unverified host key is an error, never a silent default.
8. **Honest security.** Access to the Docker socket is root. Dockflow says so, limits who holds the keys, and does not pretend otherwise.
9. **Nothing lost from 1.x.** Every feature of Dockflow 1.x has an equivalent in v2, often built differently. [parity.md](parity.md) maps each one, and a feature leaves that table only by a decision of the project owner.

## Non-goals

Dockflow v2 will not:

- be backward compatible with Dockflow 1.x in any way (configuration, CLI, server state)
- run a permanent agent, a database or a web dashboard on the servers in v1
- support Kubernetes, Nomad, plain Compose hosts or any orchestrator other than Swarm in v1
- schedule containers, build a mesh network or implement its own reverse proxy
- create servers through cloud provider APIs
- store metrics or logs; it streams them and documents integrations
- offer a plugin system in v1
- provide multi-user access control; whoever holds an environment's SSH key can deploy it

## Principles for the code

- The domain model and the planner are pure: no I/O, no Docker types leaking in, tested without mocks.
- Every interaction with the outside world goes through a port with one adapter in v1.
- No shell strings in the deploy path. Docker is reached through its API; shell is used only to provision servers and to run the `host` hooks the user writes.
- Output is events, rendered by the interface. No package prints.
- No line budget: completeness and parity with 1.x come first. Code stays simple because each concern is delegated to the tool that already does it well, not because of a count.
