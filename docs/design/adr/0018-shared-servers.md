# ADR-0018: Servers shared by several apps

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: a shared server instead of a shared cluster)

## Context

Agencies, and many solo developers, run several apps on the same server. One real deployment runs a frontend, a backend and a game server on one machine; another runs a frontend, a backend and a large file repository side by side. They share ports 80 and 443, the switch, the local registry and the port filter.

Their apps also talk to each other:
- the game server writes to the backend's Postgres;
- the backend reads the game server's map;
- an admin panel reaches the game server over RCON.

In 1.x they do it by joining networks that belong to another project, by their internal names (`backend-production-accessories_default`), or through external networks created by hand.

Some apps need host-level storage: one backend mounts S3 with rclone and a remote directory with SSHFS, through systemd units written by hand.

## Decision

### Two scopes

| Scope | Managed by | Contents |
|---|---|---|
| **Server** | `dockflow server …` | `dockflow-system`, the switch and its edge, the local registry, the watchdog, the port filter, shared networks, volume plugins, `server.json` |
| **App environment** | Whoever deploys the app | One Compose project `<app>-<env>`: its containers, networks, volumes, secrets, releases, routes, uploads and lock |

- **An app deploy never changes server-scoped objects** beyond its own routes. Routes are merged with every other app's into the switch's configuration ([ADR-0011](0011-switch-and-edge.md)).
- **Names are unique per server:** the plan refuses an `<app>-<env>` project that belongs to another app, and a (domain, path) route claimed by another project.

### Shared networks

- **Creating one:** `dockflow server network create <name>` creates a bridge network owned by the server.
- **Joining it:** apps join it in Compose as an external network, and give their services stable aliases on it:

  ```yaml
  # compose.yml of the backend
  services:
    postgres:
      networks:
        default: {}
        shared: { aliases: [backend-db] }
  networks:
    shared: { external: true }
  ```

  The game server reaches `backend-db:5432` on `shared`, without knowing the backend's project name.
- **A plan that needs one which doesn't exist** fails with the command that creates it.

### Volume plugins

- **Installing one:** `dockflow server plugin install <plugin> [--alias <name>] [<key>=<value>…]` installs a Docker managed plugin, such as rclone's, which mounts S3, SFTP and dozens of other backends as volumes. `server plugin list` and `remove` complete it.
- **Using one:** apps use it with Compose's `driver` and `driver_opts` on a volume. The rclone and SSHFS mounts become volumes, with no systemd unit. Their credentials come from secrets through interpolation.

### Isolation between apps

- Each app has its own networks. Apps reach each other only through shared networks that both join explicitly.
- The switch joins each routed app's network separately, so routed services of different apps cannot reach each other through it. This is stricter than the Swarm design, where every routed service shared one ingress network.
- `deploy.resources` limits are applied, and the plan warns about services without limits on a shared server.

## Implementation (M3)

- **Commands.** `server network` and `server plugin` take an environment, whose server they act on, and hold the server lock (`server.lock`). Shared networks are labelled `dockflow.shared=true` and managed (`dockflow.managed=true`), so `prune` leaves them alone; `remove` refuses a network that containers use, or that is not shared.
- **Plans.** A missing external network fails with `plan.network_missing` and the `server network create` command; a volume whose driver is not an enabled volume plugin fails with `plan.volume_driver` and the `server plugin install` command.
- **Plugins.** `install` grants the privileges the plugin asks for, prints them, and refuses a name already installed. Docker keeps the settings in the plugin's configuration: Dockflow masks their values in its output and lists their names only.
- **Limits.** The warning about services without `deploy.resources.limits` (`plan.no_limits`) appears when another app environment of the server has a current release.

## Consequences

- One switch, one registry and one filter per server, managed in one place.
- Cross-app communication is declared, named and survives renaming a project.
- Host-level mounts become volumes managed like any other.
- On a shared server, apps are separated by project and network, not by a security boundary. Anyone who can deploy one app is root on the server ([ADR-0013](0013-servers-access-security.md)). Agencies that need a hard boundary between clients give each client its own server.
