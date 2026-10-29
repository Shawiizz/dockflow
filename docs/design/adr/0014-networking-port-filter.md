# ADR-0014: Networking and the published-port filter

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (single server: bridge networks, the filter becomes a safety net), 2026-10-29 (IPv6 through docker-proxy, routed container addresses, inert filter)

## Context

Docker publishes ports with NAT rules that bypass the host firewall (ufw, firewalld), so a port published by mistake is open to the internet.

Under Swarm this was severe: Swarm cannot bind a port to `127.0.0.1`, so every published port was public. That is why Dockflow 1.x built a filter: its own chain jumped to from `DOCKER-USER`, matching the original destination port with conntrack, installed by a systemd unit ordered before Docker, with per-port source restrictions.

Without Swarm, Compose's `127.0.0.1:5432:5432` works and solves the problem at its source. Mistakes remain possible: `5432:5432`, written out of habit, still binds every interface.

Real projects also restrict HTTP to Cloudflare's ranges, refreshed weekly by a script of their own.

## Decision

### Networks

| Network | Type | Members |
|---|---|---|
| `dockflow-system` | bridge, internal | agents and the watchdog. The switch's admin API is a unix socket ([ADR-0011](0011-switch-and-edge.md)) |
| The app's networks (`<stack>_default` and those its Compose file declares) | bridge | the app's containers; the switch joins those of routed services, and agents join them for health checks |
| Shared networks ([ADR-0018](0018-shared-servers.md)) | bridge | services of several apps that must talk to each other |

### The filter

The filter is kept as a safety net, with 1.x's mechanism (a `DOCKER-USER` chain, conntrack on the original port, a systemd unit before Docker, `iptables-restore --noflush`).

- **What it lets in from outside:**
  - the ports apps list under `firewall.public_ports` in `dockflow.yml`, as in 1.x. Each is open to everyone, or only to the CIDRs in its `from`;
  - 80 and 443 for the switch;
  - SSH.

  Every other port Docker publishes on a public address is dropped. The plan warns about ports published on `0.0.0.0` that are not listed, and suggests `127.0.0.1:`.
- **Where it applies:** every interface except loopback and Docker's bridges, over IPv4 and IPv6 alike.
- **Edge restrictions:** with the `cloudflare` edge ([ADR-0011](0011-switch-and-edge.md#the-edge)), 80 and 443 are open to Cloudflare's ranges only. A systemd timer installed by provisioning downloads and checks those ranges weekly, and keeps the previous list when a download fails. With the `external` edge and the host's nginx, the same restriction applies to the host's own ports 80 and 443.
- **How it is updated:** the agent runs a short helper container (the Dockflow binary, host network, `NET_ADMIN`) whenever the allowed ports change. The helper writes the state to `/etc/dockflow/` and applies the chain atomically. The systemd unit reapplies that state at boot.
- **Backend:** iptables (including iptables-nft) in v1.
- **Opting out:** `server init --no-port-filter` leaves the filter out.

## Implementation (M3)

- **Rules.** The chain `DOCKFLOW-FILTER` returns for traffic from `docker0` and `br-+` and for `RELATED,ESTABLISHED`, drops `NEW` connections to `docker0` and `br-+` without `--ctstate DNAT` (routed straight to a container's address), returns for each allowed port matched with `--ctorigdstport` (and `-s` for each `from` range of the family), then drops `--ctstate NEW` connections with `--ctstate DNAT`: only connections Docker translated to a published port are affected, never the host's own services. `iptables-restore --noflush` declares only the filter's chains, so the jump from `DOCKER-USER` and Docker's own rules stay; the jump is added once, first.
- **IPv6 and docker-proxy.** A port published without a host address is bound on `0.0.0.0` and `[::]`. On a network without IPv6, docker-proxy, a host process, takes the `[::]` connections: they go through `INPUT`, never `DOCKER-USER`, and bypassed the filter, the `cloudflare` edge's restriction included. The chain `DOCKFLOW-INPUT`, jumped to first from `INPUT`, returns for loopback, the bridges and the allowed ports (`--dport`, with their `from` ranges), then drops `NEW` connections to the host ports the switch and the current releases publish on a non-loopback address of the family. Ports the host's own services listen on are never in that list: docker-proxy holds them. A port published without a host port (a random one) cannot be listed in advance, so the agent binds it to `0.0.0.0` when the filter is on: it is never under `firewall.public_ports`, so the filter dropped it from outside anyway. The alternatives were refused: binding every port to `0.0.0.0` loses IPv6 for the ports apps list; changing Docker's `userland-proxy` or `ip6tables` settings is the administrator's ([ADR-0024](0024-provisioning-scope.md)); and asking the Engine for the live bindings ties the rules to containers' restarts, while the releases' ports are fixed. Over IPv6, containers Dockflow did not deploy are not filtered.
- **Helper.** `dockflow filter apply`, in the agent image, on the host's network with `NET_ADMIN`, `NET_RAW` and `SYS_CHROOT`, with the host's `/` mounted: it chroots into the host and runs the host's `iptables`, so the backend (legacy or nft) is the host's. IPv4 rules that drop something fail with `filter.inert` when `FORWARD` does not jump to `DOCKER-USER`: Docker's `nftables` firewall backend and `"iptables": false` would leave them inert. IPv6 failures fail the run when the host has a global IPv6 address (`filter.ipv6`), and are warnings otherwise.
- **When.** After `server init`, and after a deploy, rollback or destroy, when the digest of the rules differs from `server.json`'s `filter_rules`. `server init --no-port-filter` on a server that had the filter empties the chain.
- **Cloudflare.** With the `cloudflare` edge, 80/tcp and 443 are allowed from `server.json`'s `cloudflare_ranges` only. The agent downloads `ips-v4` and `ips-v6` at `server init`; a list is refused unless every line is a range of its family. Provisioning installs `dockflow-cloudflare.timer` (weekly, persistent, randomised by 6 hours), whose script runs the newest agent image of the server with `server.cloudflare.refresh`: it downloads the lists again, keeps the previous ranges when that fails, and applies new ones to the switch and the filter. Without any download, the binary's own list is used.
- **Not yet:** the `INPUT` rules for the host's own nginx behind Cloudflare; the `nginx` plugin's `cloudflare` input restricts the real IP header instead.

## Consequences

- Binding to `127.0.0.1` is the normal way to keep a port private, as with Compose on a laptop.
- The filter catches the mistakes, and gives Cloudflare-only origins without a hand-written script.
- No Swarm ports, no overlay encryption, no inter-node rules.

## Open questions

- A native nftables backend. After v1.
