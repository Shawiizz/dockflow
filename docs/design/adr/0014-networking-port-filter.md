# ADR-0014: Networking and the published-port filter

- Status: Accepted
- Date: 2026-10-25, revised 2026-10-26 (per-port source ranges and the Cloudflare edge, as 1.x and real projects need)

## Context

Docker publishes ports by writing NAT rules that bypass the host firewall (ufw, firewalld), so a port published by mistake is open to the internet.

Dockflow 1.x has a filter for this, the best part of its provisioning:
- its own chain, jumped to from `DOCKER-USER`, matching the original destination port with conntrack;
- installed by a systemd unit ordered before Docker;
- per-port source restrictions (`firewall.public_ports[].from`).

Its weak points:
- it filters only interfaces that carry a default route;
- it fails open on nodes where it is missing;
- it is updated over SSH on every node.

It also opens Swarm's own ports (2377, 7946, 4789) to everyone, and leaves overlay traffic unencrypted.

Real projects add, by hand: HTTP accepted only from Cloudflare's ranges, refreshed weekly (ValientRP's `ufw-cloudflare-sync`).

## Decision

### Networks

| Network | Type | Members |
|---|---|---|
| `dockflow-system` | overlay, attachable, internal, encrypted | agents, the proxy's admin API, upload jobs |
| `dockflow-ingress` | overlay, attachable, encrypted | the proxy, routed services |
| `<stack>_default` and the networks a Compose file declares | overlay, attachable, encrypted | the app's services; the agent joins them for health checks |
| Shared networks ([ADR-0018](0018-shared-clusters.md)) | overlay, attachable, encrypted | services of several apps that must talk to each other |

Overlay encryption is on by default. A cluster can turn it off at `cluster init` when its nodes share a private network and the cost matters.

### The filter

The filter keeps 1.x's design, with these changes:

- **What it allows from outside:**
  - the ports an app lists under `firewall.public_ports` in `dockflow.yml`, as in 1.x. Each is open to everyone, or only to the CIDRs given in its `from`. A port that is published in Compose but not listed stays reachable from the cluster's nodes and private networks only, and the plan says so;
  - 80 and 443 on ingress nodes, restricted to the edge's ranges when the edge is `cloudflare` or `proxy` ([ADR-0011](0011-ingress-caddy.md#edge)). With `--no-proxy` and the host's nginx, the same restriction applies to the host's own ports 80 and 443, the one case where the filter also writes `INPUT` rules;
  - SSH.

  Every other port Docker has DNATed is dropped.
- **Where it applies:** to every interface except loopback, Docker's bridges and the private interfaces or CIDRs declared at `cluster init`. No guessing from the default route.
- **Swarm ports:** 2377/tcp, 7946/tcp and udp, 4789/udp and ESP (IP protocol 50) are accepted only from the cluster's node addresses.
- **How it is updated:** by a global job, `dockflow-filter`, that the agent runs on every node when the allowed ports change. It runs on the host network with `NET_ADMIN`, writes the state to `/etc/dockflow/` and applies the chain atomically with `iptables-restore --noflush`. The systemd unit reapplies that state at boot, before Docker starts.
- **Cloudflare's ranges** are downloaded and checked (enough entries, valid CIDRs) by a weekly systemd timer installed by provisioning. A failed download keeps the previous list, as ValientRP's script does.
- **It fails closed:** a node where the job fails is reported, and the run fails before routes switch.
- **It can be left out:** `server init --no-port-filter` skips it, as 1.x's option did.
- **Backend:** iptables (including iptables-nft) in v1.

The filter does not manage the rest of the host's `INPUT` chain. Provisioning adds fail2ban for SSH ([ADR-0013](0013-servers-access-security.md)). The documentation recommends the provider's firewall as the outer layer.

## Consequences

- The CLI never connects to workers to update the filter.
- A published port that Dockflow did not create stays closed to the internet.
- Behind Cloudflare, the origin answers only Cloudflare, without a hand-written script.
- Swarm's control and data planes are closed to anything outside the cluster.

## Open questions

- A native nftables backend. After v1.
