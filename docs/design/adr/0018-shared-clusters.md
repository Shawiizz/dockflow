# ADR-0018: Clusters shared by several apps

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (shared networks and volume plugins, from real projects)

## Context

Agencies, and many solo developers, run several apps on the same servers. ValientRP runs its frontend, backend and Minecraft server on one machine. MohistMC runs its frontend, backend and Maven repository side by side. They share ports 80 and 443, the registry and the port filter.

Their apps also talk to each other:
- the Minecraft server writes to the backend's Postgres;
- the backend reads the Minecraft server's map;
- the RCON panel reaches the game server.

In 1.x they do it by joining networks that belong to another project's stack, by their internal names (`valientrp-backend-production-accessories_default`), or through external networks created by hand (`mohistmc-shared`).

Some apps need host-level storage: the MohistMC backend mounts S3 with rclone and a remote directory with SSHFS, through systemd units written by hand.

## Decision

### Two scopes

| Scope | Owned by | Contents |
|---|---|---|
| **Cluster** | The administrator, through `dockflow cluster …` | Swarm, nodes and their labels, system networks, `dockflow-proxy`, `dockflow-registry`, the port filter, the edge mode, shared networks, volume plugins, the cluster record |
| **App environment** | Whoever deploys the app | One stack namespace `<app>-<env>`, its services, networks, volumes, secrets, configs, releases, routes, uploads and lock |

- **An app deploy never changes cluster-scoped objects.** It only adds or removes its own route record, which the proxy reconciler merges with every other app's ([ADR-0011](0011-ingress-caddy.md)).
- **System services are upgraded only by `dockflow cluster upgrade`**, under the cluster lock.
- **Names are unique per cluster:** the plan refuses an `<app>-<env>` namespace that belongs to another app, and a (domain, path) route claimed by another namespace.

### Shared networks

- **Creating one:** `dockflow cluster network create <name>` creates an overlay network (attachable, encrypted) owned by the cluster.
- **Joining it:** apps join it in Compose as an external network, and give their services stable aliases on it:

  ```yaml
  # compose.yml of the backend
  services:
    postgres:
      networks:
        default: {}
        valientrp: { aliases: [valientrp-db] }
  networks:
    valientrp: { external: true }
  ```

  The Minecraft server reaches `valientrp-db:5432` on `valientrp`, without knowing the backend's stack name.
- **A plan that needs one which doesn't exist** fails with the command that creates it.

### Volume plugins

- **Installing one:** `dockflow cluster plugin install <plugin> [--alias <name>] [<key>=<value>…]` installs a Docker managed plugin on every node, through a global job. An example is rclone's, which mounts S3, SFTP and dozens of other backends as volumes. `dockflow cluster plugin list` and `remove` complete it.
- **Using one:** apps use it with Compose's `driver` and `driver_opts` on a volume. The MohistMC mounts become volumes, with no systemd unit on the host. Their credentials come from secrets through interpolation.

### Isolation between apps

- Each app environment has its own overlay networks. Services of different apps reach each other only through shared networks that both join explicitly.
- Routed services also join `dockflow-ingress`, where they can reach the routed services of other apps. **This is a known limit of v1**, documented.
- `deploy.resources` are passed through from Compose, and the plan warns about services without limits on a shared cluster.

## Consequences

- One proxy, one registry and one filter per cluster, managed in one place.
- Cross-app communication is declared, named and survives renaming a stack.
- Host-level mounts become volumes managed like any other.
- On a shared cluster, apps are separated by namespace and network, not by a security boundary. Anyone who can deploy one app is root on the cluster ([ADR-0013](0013-servers-access-security.md)). Agencies that need a hard boundary between clients give each client its own cluster.

## Open questions

- Strict isolation of routed services, with one ingress network per app. After v1.
