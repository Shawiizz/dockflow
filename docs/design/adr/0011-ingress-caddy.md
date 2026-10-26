# ADR-0011: Ingress: Caddy, configured by Dockflow

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (route options, raw Caddy, paths shared between apps, Cloudflare edge, after reviewing real projects)

## Context

Dockflow 1.x has two ways to route HTTP.

**Traefik**, which it runs itself:
- one replica on a manager, discovering routes from service labels through a read-only socket proxy;
- certificates in a local volume, so moving Traefik reissues them;
- routing keyed on `ports:`, which also publishes those ports on every node.

**The host's nginx**, through the `nginx` plugin. This is what every real project uses (MohistMC, ValientRP, shawiizz.dev). Their vhosts need:

| Need | Seen in |
|---|---|
| Several domains, with `www` | Several projects |
| Security and CORS headers, gzip | Several projects |
| An upload limit | `valientrp-backend` (25 MB) |
| WebSockets, long timeouts | Several projects |
| A maintenance page on 502/503/504 | `mohistmc-frontend` |
| A path proxied to another site | `mohistmc-frontend` (`/maven`) |
| A path of one domain served by another app | `mohistmc-frontend` (`/api/v2`) |
| A host directory listed | `mohistmc-frontend` (`/builds-raw`) |
| An upstream port chosen by the `Upgrade` header | `minecraft-server` (RCON panel) |
| Unknown hosts refused | `minecraft-server` (nginx `return 444`) |

Every one of them sits behind Cloudflare: HTTP on port 80 accepted only from Cloudflare's ranges, and the real client IP read from `CF-Connecting-IP`.

Several apps on one cluster ([ADR-0018](0018-shared-clusters.md)) must share ports 80 and 443.

## Decision

### The proxy

- `dockflow cluster init` deploys `dockflow-proxy`, the official Caddy image pinned by digest.
- It runs on nodes labelled `dockflow.ingress=true`, global mode. **v1 supports one ingress node per cluster.**
- Ports 80 and 443 are published in host mode, so client IPs are preserved.
- Its data (certificates, autosaved configuration) is in a volume on that node, and it starts with `--resume`.
- It has **no access to the Docker socket**.
- `--no-proxy` at `cluster init` leaves ingress to the user, who can then publish ports and run their own proxy, as 1.x allowed.

### Routes

A route is declared on the service that serves it, in `x-dockflow.routes`. Routes don't depend on `ports:`. Routed services join the `dockflow-ingress` network and are reached by their Swarm service name.

| Option | Effect |
|---|---|
| `domains` | Host names; `www.` variants are listed explicitly |
| `path` | A path prefix (default `/`); `strip_prefix: true` removes it before proxying |
| `port` | The container port |
| `tls` | `true` by default; see [Edge](#edge) |
| `headers` | Response headers to set or remove (security headers, CORS) |
| `encode` | `gzip`/`zstd` compression |
| `max_body` | The upload size limit |
| `timeouts` | `read`, `write`, `dial` |
| `error_pages` | Status codes mapped to another route, for example a `files` route serving the maintenance page, or to an inline body |
| `auth` | Basic auth, with the password from a secret |

WebSockets work without configuration.

**Route kinds that don't target a service of the app,** declared in `dockflow.yml` under `routes:`:

| Kind | Effect |
|---|---|
| `redirect` | Redirect to a URL (`/maven` → `https://maven.mohistmc.com/`) |
| `proxy` | Proxy to any URL, including another app's service on a shared network |
| `files` | Serve a volume of the app or a host directory, with optional directory listing (the Maven repository, `/builds-raw`). Dockflow adds a small file-server service to the app (Caddy's `file_server`), placed on the node that holds the data, because the proxy itself mounts nothing |

**Escape hatch.** Any route may carry `caddy:` with raw Caddyfile directives, placed inside the route's handler. Dockflow adapts them with Caddy's own Caddyfile adapter and rejects them at plan time when they don't parse. The RCON panel's switch on the `Upgrade` header is written this way.

**Uniqueness.** Routes are unique per (domain, path) across the cluster. Two apps may share a domain on different paths (`mohistmc.com/` and `mohistmc.com/api/v2`), and the longest path wins. A (domain, path) pair claimed by two namespaces is refused at plan time.

**Unknown hosts.** Requests for unknown host names are refused (closed connection), like nginx's `return 444`.

### Configuration

- **Storage.** A deploy stores the environment's routes as its route record ([state spec](../spec/state-v1.md)).
- **Building and sending.** The agent builds the complete Caddy JSON configuration from the route records of every app on the cluster plus the cluster's settings. It sends it to each proxy task's admin API (`/load`), found through `tasks.dockflow-proxy` on the `dockflow-system` network ([ADR-0014](0014-networking-port-filter.md)). Caddy swaps configurations gracefully, without restarting or dropping connections.
- **The admin API** listens only on the proxy's `dockflow-system` address.
- **Order.** Routes switch after the new services are healthy, and removed routes are taken out after the switch.
- **Repair.** `dockflow cluster proxy sync` rebuilds the proxy's configuration from the route records.

### Edge

`dockflow cluster init --edge <mode>` sets how traffic reaches the proxy:

| Mode | TLS | Who may connect to 80/443 | Client IP |
|---|---|---|---|
| `direct` (default) | Caddy's automatic HTTPS (HTTP-01, TLS-ALPN-01) | Everyone | The connection's |
| `cloudflare` | Caddy's automatic HTTPS, which works behind Cloudflare's proxy in Full (strict) mode, or `tls: false` per route for Flexible mode | Cloudflare's published ranges only, enforced by the port filter ([ADR-0014](0014-networking-port-filter.md)) and refreshed weekly | `CF-Connecting-IP`, trusted only from those ranges |
| `proxy` | Off: TLS ends upstream | The CIDRs given with `--trusted-proxy` | `X-Forwarded-For`, trusted only from those CIDRs |

## Consequences

- Every vhost of the real projects maps to routes, route options or, for the one exotic case, a raw Caddy block.
- Routing is explicit, per service and per path, and independent of published ports.
- The proxy is reconfigured without restarting, which matters on a cluster shared by many apps.
- The proxy cannot read the Docker socket, which removes the socket proxy of 1.x.
- 1.x's Traefik dashboard has no equivalent: the web UI lists routes and their status instead ([ADR-0016](0016-interfaces.md)).
- One ingress node is a single point of failure for HTTP traffic in v1.

## Alternatives considered

- **Traefik with label discovery (1.x).** Rejected: it needs the socket, and Traefik OSS cannot share certificate storage.
- **Keeping the host's nginx.** Rejected: it needs files and sudo on the host for every route, and cannot serve several nodes.
- **caddy-docker-proxy.** Rejected: it discovers routes through the Docker socket.
- **A Caddy configuration file delivered as a Swarm config.** Rejected: changing it restarts the proxy, and with host-mode ports that is downtime for every app.

## Open questions

- High availability with several ingress nodes: shared certificate storage or DNS-01. After v1.
- DNS-01 through the Cloudflare API, for wildcard certificates. After v1.
