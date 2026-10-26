# ADR-0009: Images: buildx bake, sent to the server through a server-local registry

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: no cluster registry)

## Context

Dockflow 1.x builds from an in-memory tar of the context and honours only `context`, `dockerfile` and `args`. It sends images with `docker save | ssh | docker load`, which sends every layer, changed or not. It hashes layers to skip a transfer when nothing changed.

On one server, the problem is simpler than on a cluster: images must reach one Docker daemon, sending only the layers it lacks, and stay available for rollbacks.

## Decision

### Build

- Services with `build:` are built with `docker buildx bake` reading the environment's Compose files, so every Compose build key is honoured (target, secrets, ssh, cache, args, labels, platforms).
- The target platform is the server's architecture, read from the Engine at plan time.
- **Where builds run:**
  - on the machine running the CLI (a laptop or a CI runner), by default;
  - on the server, with `build.builder: remote`, through a buildx builder that reaches the server's Docker over SSH. Nothing is transferred after such a build;
  - with `build.engine: podman`, services are built one by one with `podman build`, from the same Compose keys.
- Tags are `<app>/<service>:<version>` (or `<registry>/<app>/<service>:<version>` with an external registry), plus `registry.additional_tags`. The plan pins digests.
- `dockflow build [<env>] [--only <services>] [--push]` builds without deploying, as in 1.x.

### Getting images to the server

| Mode | How |
|---|---|
| **Server-local registry** (default) | `server init` runs `dockflow-registry`, the CNCF distribution registry pinned by digest, published on `127.0.0.1:5959` only, with its storage in a volume. The CLI opens an SSH tunnel to that port and pushes with go-containerregistry, reading the image from the local daemon or the bake output; blobs the registry already has are skipped. The agent then pulls `127.0.0.1:5959/<app>/<service>@sha256:…` into the daemon. This works with Docker Desktop too, because the push is made by the CLI process |
| **External registry** | `registry.url` is set (ghcr.io, Docker Hub, a private registry): bake pushes there, and the agent pulls with the credentials from the environment's secrets ([ADR-0012](0012-secrets-sops.md)) |
| **Remote build** | The image is already in the server's daemon |

### Retention

- The images of the releases in retention stay in the daemon, so a rollback never needs a transfer.
- Older images and their registry manifests are deleted after a successful run, and the registry's garbage collection runs as a one-off container.

## Consequences

- An image travels once, and only its missing layers do.
- Rollbacks work offline: their images are on the server.
- The registry listens on loopback only: it is never reachable from outside, and needs no authentication.
- Builds need buildx, or Podman; the in-memory build path of 1.x is gone.

## Alternatives considered

- **`docker save | load` over SSH (1.x).** Rejected: every layer every time.
- **Pushing straight into the daemon's image store (as unregistry's `docker pussh` does).** Close to what the local registry gives, but it depends on the containerd image store being enabled, and leaves no cache when images are pruned.
