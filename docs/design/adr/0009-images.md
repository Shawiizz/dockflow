# ADR-0009: Images: buildx bake, distribution through a registry only

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x builds from an in-memory tar of the context and honours only `context`, `dockerfile` and `args`. It sends images to every node with `docker save | ssh | docker load`, from the CLI's machine, with no layer deduplication. In remote-build mode the bytes go down to the CLI and back up. It hashes layers to skip nodes that already have an image, which helps only when nothing changed.

A registry deduplicates layers, lets every node pull in parallel and is how Swarm expects images to arrive.

## Decision

### Build

- Services with `build:` are built with `docker buildx bake` reading the environment's Compose files, so every Compose build key is honoured (target, secrets, ssh, cache, args, labels).
- The platforms are the architectures of the cluster's nodes, read from the Engine at plan time. A mixed-architecture cluster gets a multi-platform image.
- **Where builds run:**
  - by default, on the machine running the CLI (a laptop or a CI runner), which needs Docker with buildx;
  - with `build.builder: remote` in `dockflow.yml`, on a manager, through a buildx builder that reaches the manager's Docker over SSH. The CLI's machine then needs only the `docker` CLI and buildx, not a daemon.
- With `build.engine: podman`, services are built one by one with `podman build`, from the same Compose build keys, as 1.x's `container_engine: podman` did. The CLI reads the result through Podman's Docker-compatible API.
- Tags are `<registry>/<app>/<service>:<version>`, plus any `registry.additional_tags` (for example `${DOCKFLOW_ENV}-latest`). The plan pins the resulting digests.
- `dockflow build [<env>] [--only <services>] [--push]` builds without deploying, as in 1.x. CI runs it on every branch push.

### Distribution

Images always reach nodes through a registry, in one of two modes.

**1. External registry.** `registry.url` is set in `dockflow.yml` (ghcr.io, Docker Hub, a private registry):

- bake pushes directly;
- the services carry the registry credentials from the environment's secrets ([ADR-0012](0012-secrets-sops.md)), so every node can pull.

**2. Cluster registry, the default.**

- **The service:** `dockflow cluster init` deploys `dockflow-registry`, the CNCF distribution registry pinned by digest. It runs as one replica on a manager, with its storage in a volume. It is published in the routing mesh on a fixed port recorded in the cluster record (default 5959).
- **Authentication:** basic auth, with credentials generated at cluster init.
- **Pushing:** the CLI opens an SSH tunnel to the manager's `127.0.0.1:<port>` and pushes with go-containerregistry, reading the image from the local daemon or the bake output. Blobs the registry already has are skipped, so an unchanged layer is never sent twice. This works with Docker Desktop too, because the push is made by the CLI process, not by a daemon in a VM.
- **Remote builds** push from the manager to `127.0.0.1:<port>` directly.
- **Pulling:** nodes pull `127.0.0.1:<port>/<app>/<service>@sha256:…`. Plain HTTP to localhost is allowed by Docker, and the routing mesh delivers it to the registry wherever it runs.
- **Exposure:** the port filter ([ADR-0014](0014-networking-port-filter.md)) blocks that port from outside, so the registry is never public. Authentication still applies as a second layer.
- **Single-node environments** use the same path. There is no special case.

### Image retention

Manifests of releases outside the retention window are deleted through the registry API. The registry's garbage collection runs as a Swarm job.

## Consequences

- No `docker save` / `docker load`, no per-node streaming and no content-key bookkeeping.
- An image travels from the build machine once. Nodes fetch only the layers they lack, from inside the cluster.
- The cluster registry is a stateful service on one manager; losing its volume loses cached images but not the ability to deploy, since the next deploy pushes again. Rollback to an older release needs its images, so the planner checks that every image digest a plan references is present before applying.
- Builds need buildx; the old in-memory build path is gone.

## Alternatives considered

- **`docker save | load` over SSH (1.x).** Rejected for the reasons in Context.
- **An unregistry-style temporary registry on each push.** Rejected in favour of a permanent cluster registry, which also serves rollbacks and pulls on new nodes.
- **A local registry on the developer's machine with a reverse tunnel (as Kamal does).** Rejected: every node would have to reach the developer's machine.

## Open questions

- How registry garbage collection runs without blocking concurrent pushes (the distribution registry needs read-only mode while it collects). Decided in M2.
