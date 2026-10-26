# Dockflow v2

Dockflow deploys your Docker Compose applications, as written, to your own server: zero downtime, a plan before every change, a rollback that always finishes. From your laptop or your CI.

This branch is a rewrite from scratch. It shares no code, no configuration format and no server state with Dockflow 1.x, and offers no migration path: moving a project or a server to v2 is done by hand.

## Status

Milestone M1 (walking skeleton) is done: a Compose app that uses public images deploys to one server, with zero downtime, a plan, releases and rollbacks. Not for production use yet: building images, secrets files, hooks, uploads and server provisioning come in the next milestones ([roadmap](docs/design/roadmap.md)).

## Try it

You need a Linux server with Docker 27 or later, reachable over SSH by a user that may use Docker, with ports 80 and 443 free.

```sh
make build                              # a static ./dockflow binary
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
