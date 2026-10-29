# Dockflow

Dockflow deploys a Docker Compose app to your own server over SSH. You keep your `compose.yml`, add a short `dockflow.yml`, and run `dockflow deploy` from your laptop or from CI. Dockflow shows a plan, starts the new containers next to the old ones, moves the traffic once they are healthy, and rolls back on its own when something fails. There is no orchestrator and no daemon on the server: only Docker, and a few containers Dockflow runs there.

Documentation: [dockflow.shawiizz.dev](https://dockflow.shawiizz.dev)

## What it does

- Deploys standard Compose files to one Linux server per environment, with zero-downtime rollouts and automatic rollback.
- Shows a plan of every change, computed from what the server runs, before applying it.
- Keeps releases on the server: `dockflow rollback` restores the previous one in one command.
- Serves HTTPS through a proxy on the server (Caddy) with automatic certificates, or sits behind your own nginx or Cloudflare.
- Builds images locally or on the server and sends them to a registry on the server.
- Prepares a server in one command: Docker, a deploy user, the proxy and the registry.
- Reads secrets from CI variables or SOPS files, runs jobs and hooks, uploads files, and backs up databases and volumes with restic.
- Works the same from a laptop and from any CI. Comes with a GitHub Action and an MCP server for AI assistants.

## Install

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.sh | sh
```

Homebrew:

```sh
brew tap shawiizz/dockflow https://github.com/Shawiizz/dockflow
brew install dockflow
```

npm:

```sh
npm install -g @dockflow-tools/cli
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Shawiizz/dockflow/main/install.ps1 | iex
```

Options, version pinning and server requirements are in the [installation guide](https://dockflow.shawiizz.dev/start/installation/).

## Example

Prepare a server (Linux, reachable over SSH as root or as a user with passwordless sudo, ports 80 and 443 free; Dockflow installs Docker on Debian and Ubuntu):

```sh
dockflow server init root@203.0.113.10
```

It prints a connection string. Store it as `PRODUCTION_CONNECTION` in a `.env.dockflow` file kept out of git, or as a CI secret.

In your project, write `dockflow.yml`:

```yaml
version: 1
app: hello

environments:
  production:
    vars:
      DOMAIN: hello.example.com
```

and `compose.yml`:

```yaml
services:
  web:
    image: nginx:1.27-alpine
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1/"]
      interval: 5s
      timeout: 3s
      retries: 3
    x-dockflow:
      routes:
        - domains: ["${DOMAIN}"]
          port: 80
```

Then deploy:

```sh
dockflow deploy production
```

The [quickstart](https://dockflow.shawiizz.dev/start/quickstart/) walks through the same example, then a second deploy and a rollback.

## Status

Dockflow is in alpha. The current release is **1.0.0-alpha.5**.

Deploys, builds, secrets, server provisioning, backups, the MCP server and the GitHub Action work today. The configuration (`version: 1`), server state and event formats are specified and stable. They are frozen at 1.0.0; after that, they change only by additions.

What is left before 1.0.0 is on the [roadmap](https://dockflow.shawiizz.dev/project/roadmap/).

This version is a rewrite in Go. It shares nothing with the earlier Dockflow built on Docker Swarm: see [migrating](https://dockflow.shawiizz.dev/start/migrating/).

## Contributing

The design is written down before the code. Start with:

- [Vision](docs/design/vision.md): goals, non-goals and principles
- [Architecture decisions](docs/design/adr/README.md): one record per decision
- [Specifications](docs/design/README.md#specifications): configuration, server state, events, CLI
- [Roadmap](docs/design/roadmap.md): milestones and their exit criteria
- [CLAUDE.md](CLAUDE.md): the working rules (vertical slices, architecture, tests)

Build with `make build` and run the unit tests with `make test`.

## License

MIT
