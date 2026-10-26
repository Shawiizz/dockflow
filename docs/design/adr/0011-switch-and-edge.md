# ADR-0011: The switch and the edge: a Dockflow-managed Caddy in front of every app, any proxy in front of it

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: the switch handles zero-downtime transitions; any front proxy, nginx included, points at it once)

## Context

Zero-downtime deploys without an orchestrator ([ADR-0010](0010-rollout-health-jobs.md)) need something that moves traffic from old containers to new ones at the right moment, and drains the old ones.

Users front their apps in different ways:
- **The host's nginx**, through 1.x's `nginx` plugin. This is what all eight real projects use, with security headers, CORS, upload limits, WebSockets, maintenance pages, paths routed to other apps, and Cloudflare in front.
- **The proxy Dockflow ran** (Traefik in 1.x).
- **Anything else:** Traefik, HAProxy, a Cloudflare Tunnel, a cloud load balancer.

The project owner asked how proxies should be handled. There are three options:

1. **Code each proxy into Dockflow.** Every supported proxy needs its own logic to rewrite upstreams and reload on every deploy, and every new proxy is new code.
2. **One plugin per proxy that performs the switch.** The same problem, moved into plugins: each must reload correctly on every deploy, and their bugs become deployment bugs.
3. **A pre-proxy owned by Dockflow** in front of the apps. It handles every transition, and the user's proxy, whatever it is, points at it once, at an address that never changes.

## Decision

**Option 3.** Every server runs one **switch**: `dockflow-switch`, the official Caddy image pinned by digest.

### The switch

- It is installed by `server init` and upgraded by `dockflow server upgrade`.
- It runs on bridge networks. The agent connects it live (`docker network connect`, no restart) to the network of each app that has routes.
- Upstreams are the current release's container names, which Docker's DNS resolves inside those networks, so a container restarted by Docker keeps working.
- Its admin API listens only on the internal `dockflow-system` network, which the agent joins.

**During a deploy** (`switch` strategy):
1. The new containers become healthy.
2. The agent loads the new configuration through the admin API. Caddy swaps it gracefully, with no restart and no dropped connection.
3. Requests in flight on the old containers finish within the drain time (default 30 s, `x-dockflow.rollout.drain`). WebSocket connections still open after that are closed.
4. The old containers are stopped.

**Configuration.** It is rebuilt from the routes of the current release of every app on the server ([ADR-0007](0007-state-on-the-server.md)). `dockflow server proxy sync` rebuilds it by hand.

### The edge

How traffic reaches the switch is a server setting, `server init --edge <mode>`:

| Mode | TLS | What the switch publishes | Client IP |
|---|---|---|---|
| `builtin` (default) | Caddy's automatic HTTPS (Let's Encrypt) | 80 and 443 | The connection's |
| `cloudflare` | As `builtin`; Cloudflare's Full (strict) mode works, Flexible with `tls: false` per route | 80 and 443, open to Cloudflare's published ranges only, refreshed weekly ([ADR-0014](0014-networking-port-filter.md)) | `CF-Connecting-IP`, trusted from those ranges only |
| `external` | The user's front proxy | One address, `127.0.0.1:8080` by default (`--switch-listen`), routing by `Host` and path | `X-Forwarded-For`, trusted from `--trusted-proxy` CIDRs (loopback by default) |
| `none` | – | Nothing: no switch is installed | – |

**With `external`, any front proxy works.** It sends every routed domain to the switch's one address and keeps the `Host` header. For nginx, that is a vhost written once:

```nginx
# /etc/nginx/sites-enabled/shop.conf: written by the nginx plugin, unchanged by deploys
server {
    listen 80;
    server_name shop.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

The built-in `nginx` plugin ([ADR-0017](0017-plugins.md)) writes it, and reloads nginx only when the list of domains changes, never on an ordinary deploy. Traefik, HAProxy, a Cloudflare Tunnel or a load balancer are configured the same way, once.

**With `none`**, apps publish their own ports, routes are refused at plan time, and services that publish fixed host ports use `stop-first`, with a brief downtime. It exists for setups that want no Dockflow process on the server besides the agent.

### Routes

A route is declared on the service that serves it, in `x-dockflow.routes`:

| Option | Effect |
|---|---|
| `domains` | Host names; `www.` variants are listed explicitly |
| `path` | A path prefix (default `/`); `strip_prefix: true` removes it before proxying |
| `port` | The container port |
| `tls` | `true` by default, `builtin` and `cloudflare` edges only |
| `headers` | Response headers to set or remove (security headers, CORS) |
| `encode` | `gzip`/`zstd` compression |
| `max_body` | The upload size limit |
| `timeouts` | `read`, `write`, `dial` |
| `error_pages` | Status codes mapped to another route (a maintenance page) or to an inline body. They also cover the window where no healthy container exists, which happens with `stop-first` |
| `auth` | Basic auth, with the password from a secret |

These options are applied by the switch, so they work in every edge mode, behind nginx too. WebSockets work without configuration.

**Route kinds that don't target a service of the app**, declared in `dockflow.yml` under `routes:`:

| Kind | Effect |
|---|---|
| `redirect` | Redirect to a URL |
| `proxy` | Proxy to any URL, including another app's service on a shared network |
| `files` | Serve a volume of the app or a host directory, with optional directory listing. Dockflow adds a small file-server container to the app, because the switch mounts nothing |

**Escape hatch.** Any route may carry `caddy:` with raw Caddyfile directives, adapted by Caddy's own Caddyfile adapter and rejected at plan time when they don't parse.

**Uniqueness.** Routes are unique per (domain, path) on a server. Two apps may share a domain on different paths, and the longest path wins. In the `builtin` and `cloudflare` modes, requests for unknown host names are refused.

**Non-HTTP services** (a game server on TCP and UDP) don't go through the switch. They publish their ports and use `stop-first`.

## Consequences

- Zero downtime is a core feature, independent of the user's front proxy, and implemented once.
- Any front proxy works with no Dockflow code: it points at one stable address. The `nginx` plugin becomes a static vhost.
- With the default edge, the switch is also the TLS proxy, so a default server runs one proxy.
- Behind an external proxy, there are two hops on the server. The added latency is negligible.
- The switch and its admin API are a permanent component on every server that routes traffic.

## Alternatives considered

- **Upstream switching coded per proxy (options 1 and 2).** Rejected: per-proxy reload logic on every deploy, and every proxy a new source of bugs.
- **kamal-proxy as the switch.** It is built for exactly this: health-checked targets, draining, host and path routing, TLS. Rejected because the edge features real projects need (headers, error pages, raw configuration, listening on an internal address for an external proxy) would need a second proxy anyway, while Caddy covers both roles with one component.
- **Docker DNS aliases switched between containers.** Rejected: proxies cache DNS, so the switch would not be immediate, and draining is impossible.
- **Traefik with label discovery (1.x).** Rejected: it needs the Docker socket, and label changes take effect on Traefik's schedule, not Dockflow's.

## Open questions

- DNS-01 challenges through Cloudflare's API, for wildcard certificates. After v1.
