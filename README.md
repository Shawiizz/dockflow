# Dockflow

Dockflow deploys your Docker Compose applications, as written, to your own server: zero downtime, a plan before every change, a rollback that always finishes. From your laptop or your CI.

Documentation: [dockflow.shawiizz.dev](https://dockflow.shawiizz.dev).

## Status

Milestones M1 (walking skeleton) and M2 (shipping real apps) are implemented: a Compose app deploys to one server with zero downtime, a plan, releases and rollbacks; its images are built (buildx bake, Podman, or on the server) and sent through an SSH tunnel to a registry on the server; jobs, health checks, hooks, templates, uploads and the day-2 commands work, from a laptop or any CI. Not for general production use yet: secrets files, server provisioning and backups come in the next milestones ([roadmap](docs/design/roadmap.md)).

## Try it

You need a Linux server with Docker 27 or later, reachable over SSH by a user that may use Docker, with ports 80 and 443 free (or another web server in front: see the `external` edge in the [configuration](docs/design/spec/config-v1.md)).

```sh
curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | sh # from a release
make build                                                                            # or from source: ./dockflow
```

`dockflow.yml`, next to your `compose.yml`:

```yaml
version: 1
app: shop
environments:
  production:
    server:
      host: 203.0.113.10
      user: deploy
      host_key: SHA256:…                # ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub, on the server
```

Route a service through the switch in `compose.yml`:

```yaml
services:
  web:
    image: ghcr.io/acme/web:1.4
    deploy:
      replicas: 2
    x-dockflow:
      routes:
        - domains: [shop.example.com]
          port: 3000
```

Then:

```sh
dockflow server init production         # installs the switch (Caddy) on the server
dockflow plan production
dockflow deploy production
dockflow status production
dockflow releases production
dockflow rollback production
```

The SSH key comes from `DOCKFLOW_SSH_KEY`, ssh-agent or `~/.ssh`. In CI, a single `PRODUCTION_CONNECTION` secret replaces the `server` block.

## Design

Start with:

- [Vision](docs/design/vision.md): what Dockflow is, who it is for, what it will not do
- [Architecture decisions](docs/design/adr/README.md): one record per decision
- [Specifications](docs/design/README.md#specifications): configuration, server state, events, CLI
- [Roadmap](docs/design/roadmap.md): milestones and their exit criteria
- [Parity with 1.x](docs/design/parity.md): every 1.x feature and its v2 equivalent

## License

MIT
