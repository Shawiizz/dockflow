# Vision

## In one sentence

Kamal, for people who already have a `docker-compose.yml`: your Compose file, as written, deployed to your own server with zero downtime, a plan before every change, and a rollback that always finishes, even when the CI runner dies.

## Who it is for

| User | Typical setup | What they need from Dockflow |
|---|---|---|
| A solo developer | 1 server, 1 to 5 apps | `deploy` that just works, HTTPS, backups that leave the server |
| A small team | A server per environment, a few apps, CI | Plans reviewed in pull requests, safe concurrent deploys, instant rollback |
| An agency | Several servers, many client apps sharing them | Apps isolated from each other on a shared server, one proxy, repeatable setup |

All three are first-class. A feature that only one of them needs must not make the tool harder for the other two.

## Why it exists

The author uses it for eight real projects, and it should be good enough for others to adopt.

**Why one server.** Every one of those projects runs on one server, and so do most self-hosted apps. Scaling usually means a bigger server first. When one server is no longer enough, the next step is several independent servers ([ADR-0023](adr/0023-several-servers-later.md)), not a cluster orchestrator:
- Docker Swarm is in maintenance;
- Kubernetes is too heavy for this audience. Dockflow 1.x's own Kubernetes branch showed the cost of supporting two orchestrators side by side.

Next to the alternatives:

| Tool | How it differs from Dockflow |
|---|---|
| **Kamal** | Does what Dockflow does, but with its own configuration format, a single-image app model and a registry requirement |
| **`docker compose` over SSH** | Comes with Docker, but has no zero-downtime deploys, no releases, no rollback, no secrets from CI, no TLS, no backups |
| **Dokploy, Coolify, CapRover** | Platforms that run on the server, with a database and a web UI to operate |

Dockflow keeps the Compose file as the source of truth. On the server, an app is a real Compose project that `docker compose ps` can read.

## Goals

1. **Compose as written.** A project's Compose file runs as is with `docker compose up` on a laptop and with `dockflow deploy` on a server. Dockflow adds a small `dockflow.yml` and `x-dockflow` keys, nothing else. Every Compose feature Docker supports on one host is supported, including the ones Swarm refused (`depends_on`, `127.0.0.1:` ports, `devices`, `network_mode`).
2. **Zero downtime by default.** Routed services switch from old to new containers behind Dockflow's switch, only once the new ones are healthy. A failed deploy switches back in a second.
3. **Plan, then apply.** Every change to a server is computed as a plan the user can read, save and review, then applied exactly.
4. **Finish what was started.** A deploy runs on the server itself. Losing the CLI, the network or the CI runner never leaves an app half-deployed: the run completes or rolls back on its own.
5. **Delegate.** Docker runs containers. buildx builds. Caddy terminates TLS and switches traffic. gonja renders templates. restic stores backups. SOPS encrypts secrets. Dockflow composes them.
6. **One core, several faces.** The CLI, the local web UI, the MCP server and the GitHub Action call the same functions and read the same event stream.
7. **Fail loudly.** A missing variable, an unknown key, an unsupported Compose feature or an unverified host key is an error, never a silent default.
8. **Honest security.** Access to the Docker socket is root. Dockflow says so, limits who holds the keys, and does not pretend otherwise.
9. **Nothing lost from 1.x.** Every feature of Dockflow 1.x has an equivalent in v2, often built differently. [parity.md](parity.md) maps each one. A feature leaves that table only by a decision of the project owner; the only one so far is multi-node Swarm clustering.

## Non-goals

Dockflow v2 will not:

- be backward compatible with Dockflow 1.x in any way (configuration, CLI, server state)
- use or support a cluster orchestrator: no Swarm, no Kubernetes, no Nomad
- schedule containers across servers or build a network between them
- create servers through cloud provider APIs
- store metrics or logs; it streams them and documents integrations
- provide multi-user access control; whoever holds an environment's SSH key can deploy it

## Principles for the code

- The domain model and the planner are pure: no I/O, no Docker types leaking in, tested without mocks.
- Every interaction with the outside world goes through a port, with one adapter in v1.
- No shell strings in the deploy path. Docker is reached through its API. Shell is used only to provision servers and to run the `host` hooks the user writes.
- Output is events, rendered by the interface. No package prints.
- No line budget: completeness and parity with 1.x come first. Code stays simple because each concern is delegated to the tool that already does it well, not because of a count.
