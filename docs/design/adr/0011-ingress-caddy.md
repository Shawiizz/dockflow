# ADR-0011: Ingress: Caddy, configured by Dockflow

- Status: Accepted
- Date: 2026-10-25

## Context

Dockflow 1.x runs Traefik as one replica on a manager, discovering routes from service labels through a read-only socket proxy. Its certificates sit in a local volume, so moving Traefik reissues them. Routing is keyed on `ports:`, which also publishes those ports on every node. Traefik OSS cannot share certificate storage between instances. Several apps on one cluster ([ADR-0018](0018-shared-clusters.md)) must share the same ports 80 and 443.

## Decision

### The proxy

- `dockflow cluster init` deploys `dockflow-proxy`, the official Caddy image pinned by digest.
- It runs in global mode on nodes labelled `dockflow.ingress=true`. **v1 supports exactly one ingress node per cluster.**
- Ports 80 and 443 are published in host mode, so client IPs are preserved.
- Its data (certificates, autosaved configuration) is in a volume on that node, and it starts with `--resume`.
- It has **no access to the Docker socket.**

### Routes

- Routes are declared per service in Compose (`x-dockflow.routes`: domains, port, optional path prefix).
- A deploy stores them as the environment's route record ([state spec](../spec/state-v1.md)).
- Routed services join the `dockflow-ingress` network and are reached by their Swarm service name. Routing never depends on `ports:`.

### Configuration

- The agent builds the complete Caddy JSON configuration from the route records of every app on the cluster, plus the cluster's ACME email.
- It sends that configuration to each proxy task's admin API (`/load`), found through `tasks.dockflow-proxy` on the `dockflow-system` network ([ADR-0014](0014-networking-port-filter.md)). Caddy swaps configurations gracefully: no restart, no dropped connection.
- The admin API listens only on the proxy's `dockflow-system` address.
- Routes switch after the new services are healthy, and routes that were removed are taken out after the switch.
- The plan refuses a domain claimed by another app or environment on the same cluster.
- `dockflow cluster proxy sync` rebuilds the proxy's configuration from the route records, for repairs.

### TLS

Caddy's automatic HTTPS (HTTP-01 and TLS-ALPN-01). Plain-HTTP routes are allowed per route for tests.

## Consequences

- Routing is explicit, per service and per domain, and independent of published ports.
- The proxy is reconfigured without being restarted, which matters on a cluster shared by many apps.
- The proxy cannot read the Docker socket, which removes the socket proxy of 1.x.
- One ingress node is a single point of failure for HTTP traffic in v1. DNS points at that node.

## Alternatives considered

- **Traefik with label discovery (1.x).** Rejected for socket access and the lack of shared certificate storage in OSS.
- **caddy-docker-proxy.** Rejected: it discovers routes through the Docker socket, which puts it back in the proxy.
- **A Caddy configuration file delivered as a Swarm config.** Rejected: changing a config mounted in a service restarts the service, and with host-mode ports that is downtime for every app.
- **A proxy written for Dockflow (as kamal-proxy).** Rejected: out of scope.

## Open questions

- High availability with several ingress nodes: a shared certificate storage module (which needs a custom Caddy build) or DNS-01. After v1.
- Per-route basic auth and security headers. Decided in M3.
