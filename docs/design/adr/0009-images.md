# ADR-0009: Images: buildx bake, sent to the server through a server-local registry

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: no cluster registry; the bake definition written by Dockflow; remote and Podman builds)

## Context

Dockflow 1.x builds from an in-memory tar of the context and honours only `context`, `dockerfile` and `args`. It sends images with `docker save | ssh | docker load`, which sends every layer, changed or not. It hashes layers to skip a transfer when nothing changed.

On one server, the problem is simpler than on a cluster: images must reach one Docker daemon, sending only the layers it lacks, and stay available for rollbacks.

## Decision

### Build

- Services with `build:` are built with `docker buildx bake`, from a bake definition Dockflow writes from the Compose build keys it has already interpolated. So `${VAR}` in build keys takes its value from Dockflow's variables and secrets, as in the rest of the Compose file, and every build key bake supports is honoured (target, ssh, cache, args, labels, contexts, network).
- Bake writes each image as an OCI image layout, so the image never has to be loaded into the local daemon. When the default builder cannot export one (the `docker` driver without the containerd image store), Dockflow creates a `docker-container` builder named `dockflow` and uses it.
- The target platform is the server's architecture, read from the Engine at plan time.
- **Where builds run:**
  - on the machine running the CLI (a laptop or a CI runner), by default;
  - on the server, with `build.builder: remote`. The CLI opens a unix socket in a directory only its user can enter, forwards each connection to the server's Docker socket over SSH, and runs bake with `DOCKER_HOST` pointing at it, on the builder of that daemon. Bake loads the images into the server's daemon (`type=docker`) under a name of that build only, then each is named after its content, `localhost/<app>/<service>:<image ID prefix>`, a name that is never pulled: services run them by image ID. A name per version would not do: two builds of one commit share a version, and the daemon drops an image whose only name moves to another. Nothing is transferred after such a build. With an external registry, the images are named for it instead, and the server's daemon pushes them there;
  - with `build.engine: podman`, services are built one by one with `podman build` from the same Compose keys, each image exported as an OCI layout (`podman push <id> oci:<dir>`) and pushed like a bake build. Short image names resolve as Podman's `registries.conf` says.
- Bake runs without default attestations (`BUILDX_NO_DEFAULT_ATTESTATIONS=1`): a provenance attestation records when the image was built, so the same code would make a new image, and a deploy that changes nothing would replace the containers.
- Images are `127.0.0.1:5959/<app>/<service>:<version>` in the server-local registry, or `<registry.url>/<app>/<service>:<version>` plus `registry.additional_tags` in an external one. Services run them pinned by digest.
- `dockflow build [<env>] [--only <services>] [--push]` builds without deploying, as in 1.x.

### Getting images to the server

| Mode | How |
|---|---|
| **Server-local registry** (default) | `server init` runs `dockflow-registry`, the CNCF distribution registry pinned by digest, published on `127.0.0.1:5959` only, with its storage in a volume. The CLI opens an SSH tunnel to that port and pushes with go-containerregistry, reading the image from the local daemon or the bake output; blobs the registry already has are skipped. The agent then pulls `127.0.0.1:5959/<app>/<service>@sha256:…` into the daemon. This works with Docker Desktop too, because the push is made by the CLI process |
| **External registry** | `registry.url` is set (ghcr.io, Docker Hub, a private registry): bake pushes there, and the agent pulls with the credentials from the environment's secrets ([ADR-0012](0012-secrets-sops.md)) |
| **Remote build** | The image is already in the server's daemon, run by image ID; with `registry.url`, the server's daemon also pushes it there, and services run it by digest |

### Retention

- The images of the releases in retention stay in the daemon, so a rollback never needs a transfer.
- Older images and their registry manifests are deleted after a successful run. The registry's garbage collection, which frees the layers, runs with `dockflow prune`, outside deploys.

## Consequences

- An image travels once, and only its missing layers do.
- Rollbacks work offline: their images are on the server.
- The registry listens on loopback only: it is never reachable from outside, and needs no authentication.
- Builds need buildx, or Podman; the in-memory build path of 1.x is gone.

## Alternatives considered

- **`docker save | load` over SSH (1.x).** Rejected: every layer every time.
- **Pushing straight into the daemon's image store (as unregistry's `docker pussh` does).** Close to what the local registry gives, but it depends on the containerd image store being enabled, and leaves no cache when images are pruned.
