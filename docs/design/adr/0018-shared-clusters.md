# ADR-0018: Clusters shared by several apps

- Status: Accepted
- Date: 2026-10-25

## Context

Agencies, and many solo developers, run several apps (often from different repositories, sometimes for different clients) on the same servers. They share ports 80 and 443, the registry and the port filter. In Dockflow 1.x each project manages "its" Traefik, which the next project may redeploy with other settings.

## Decision

### Two scopes

| Scope | Owned by | Contents |
|---|---|---|
| **Cluster** | The administrator, through `dockflow cluster …` | Swarm, nodes and their labels, `dockflow-system` and `dockflow-ingress`, `dockflow-proxy`, `dockflow-registry`, the port filter, the cluster record (ACME email, registry port, private networks, system service versions) |
| **App environment** | Whoever deploys the app | One stack namespace `<app>-<env>`, its services, networks, volumes, secrets, configs, releases, routes and lock |

- **An app deploy never changes cluster-scoped objects.** It only adds or removes its own route record, which the proxy reconciler merges with every other app's ([ADR-0011](0011-ingress-caddy.md)).
- **System services are upgraded only by `dockflow cluster upgrade`**, under the cluster lock. An app deployed with a newer Dockflow than the cluster's system services gets a warning, not an upgrade.
- **Names are unique per cluster.** The plan refuses an `<app>-<env>` namespace that already exists with another app's identity, and a domain already routed by another namespace.

### Isolation between apps

- Each app environment has its own overlay networks; services of different apps cannot reach each other on them.
- Routed services also join the shared `dockflow-ingress` network, where they can reach the routed services of other apps. **This is a known limit of v1**, stated in the documentation.
- Resource limits (`deploy.resources`) are passed through from Compose, and the plan warns when a service has none on a shared cluster.

## Consequences

- One proxy, one registry and one filter per cluster, managed in one place.
- A client app cannot break another client's routing or TLS.
- On a shared cluster, apps are separated by namespace and network, not by security boundary. Anyone who can deploy one app is root on the cluster ([ADR-0013](0013-servers-access-security.md)). Agencies that need a hard boundary between clients give each client its own cluster.

## Open questions

- Strict isolation of routed services, with one ingress network per app joined by the proxy. That changes the proxy's networks, which restarts it. After v1.
